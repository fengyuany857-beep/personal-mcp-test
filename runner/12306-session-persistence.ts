import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ReadOnlySessionState } from "./real12306-readonly.ts";
import {
  Rail12306LocalAuthenticatedProvider,
  type LocalSessionHttpResponse,
  type LocalSessionHttpTransport,
} from "./12306-local-auth-readonly.ts";

const KYFW_ORIGIN = "https://kyfw.12306.cn";
const REFERER = `${KYFW_ORIGIN}/otn/leftTicket/init?linktypeid=dc`;
const SESSION_AAD_PREFIX = "personal-mcp:12306-session:v1";
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/;
const DEFAULT_NETWORK_TIMEOUT_MS = 12_000;

const CLOUD_AUTH_GET_PATHS = new Set([
  "/otn/login/conf",
  "/otn/index12306/getLoginBanner",
  "/passport/web/auth/uamtk-static",
]);

const CLOUD_AUTH_POST_PATHS = new Set([
  "/otn/login/checkUser",
  "/passport/web/create-qr64",
  "/passport/web/checkqr",
  "/passport/web/auth/uamtk",
  "/otn/uamauthclient",
  "/otn/confirmPassenger/getPassengerDTOs",
  "/otn/queryOrder/queryMyOrderNoComplete",
]);

export type SessionCookieJar = Record<string, string>;

export interface PersistableLocalSessionTransport extends LocalSessionHttpTransport {
  exportSessionCookies(): SessionCookieJar;
  importSessionCookies(cookies: SessionCookieJar): void;
  clearSessionCookies(): void;
}

function validateCookie(name: string, value: string): void {
  if (!COOKIE_NAME.test(name)) throw new Error("RAIL12306_SESSION_COOKIE_INVALID");
  if (value.length > 4096 || /[;\r\n]/.test(value) || /[^\x20-\x7e]/.test(value)) {
    throw new Error("RAIL12306_SESSION_COOKIE_INVALID");
  }
}

function normalizeCookieJar(input: SessionCookieJar): SessionCookieJar {
  const entries = Object.entries(input);
  if (entries.length > 64) throw new Error("RAIL12306_SESSION_COOKIE_JAR_TOO_LARGE");
  const output: SessionCookieJar = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string") throw new Error("RAIL12306_SESSION_COOKIE_INVALID");
    validateCookie(name, value);
    output[name] = value;
  }
  return output;
}

function setCookieValues(headers: LocalSessionHttpResponse["headers"]): string[] {
  const value = headers?.["set-cookie"];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

/**
 * Cloud/runtime transport for the existing authenticated read-only provider.
 * The cookie jar stays process-private and can only be exported to the encrypted
 * session store. Consequential order/payment endpoints are absent from the
 * allowlist and are rejected before any network request is attempted.
 */
export class Cloud12306SessionTransport implements PersistableLocalSessionTransport {
  private readonly cookies = new Map<string, string>();
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 100 || this.requestTimeoutMs > 30_000) {
      throw new Error("RAIL12306_CLOUD_AUTH_TIMEOUT_INVALID");
    }
  }

  exportSessionCookies(): SessionCookieJar {
    return Object.fromEntries(this.cookies.entries());
  }

  importSessionCookies(cookies: SessionCookieJar): void {
    const normalized = normalizeCookieJar(cookies);
    this.cookies.clear();
    for (const [name, value] of Object.entries(normalized)) this.cookies.set(name, value);
  }

  clearSessionCookies(): void {
    this.cookies.clear();
  }

  async request(method: "GET" | "POST", path: string, form: Record<string, string> = {}): Promise<LocalSessionHttpResponse> {
    const allowed = method === "GET" ? CLOUD_AUTH_GET_PATHS : CLOUD_AUTH_POST_PATHS;
    if (!allowed.has(path)) throw new Error("RAIL12306_CLOUD_AUTH_PATH_BLOCKED");

    const url = new URL(path, KYFW_ORIGIN);
    if (url.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_CLOUD_AUTH_ORIGIN_BLOCKED");
    const cookie = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 PersonalMCP-CloudReadOnly/1.0",
      Accept: "application/json,text/javascript,*/*;q=0.8",
      Referer: REFERER,
      Origin: KYFW_ORIGIN,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
        ...(method === "POST" ? { body: new URLSearchParams(form) } : {}),
      });
    } catch (error) {
      const name = (error as { name?: unknown }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error("RAIL12306_CLOUD_AUTH_NETWORK_ERROR:TIMEOUT");
      }
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      throw new Error(`RAIL12306_CLOUD_AUTH_NETWORK_ERROR${typeof code === "string" ? `:${code}` : ""}`);
    }

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
    for (const raw of setCookies) this.captureCookie(raw);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("RAIL12306_CLOUD_AUTH_REDIRECT_WITHOUT_LOCATION");
      const redirected = new URL(location, url);
      if (redirected.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_CLOUD_AUTH_CROSS_ORIGIN_REDIRECT_BLOCKED");
      if (redirected.pathname !== path) throw new Error("RAIL12306_CLOUD_AUTH_UNEXPECTED_REDIRECT_BLOCKED");
    }

    return {
      status: response.status,
      headers: { "set-cookie": setCookies, date: response.headers.get("date") ?? undefined },
      body: await response.text(),
    };
  }

  private captureCookie(raw: string): void {
    const first = raw.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    validateCookie(name, value);
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(raw)) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}

function openSessionDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: 5_000 });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_encrypted_session (
      account_ref TEXT PRIMARY KEY,
      cipher_version INTEGER NOT NULL CHECK (cipher_version = 1),
      iv_b64 TEXT NOT NULL,
      ciphertext_b64 TEXT NOT NULL,
      auth_tag_b64 TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export class SqliteEncrypted12306SessionStore {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(path: string, encryptionKey: Buffer) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error("RAIL12306_SESSION_KEY_MUST_BE_32_BYTES");
    this.key = Buffer.from(encryptionKey);
    this.db = openSessionDatabase(path);
  }

  save(accountRef: string, cookies: SessionCookieJar): void {
    if (!accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
    const normalized = normalizeCookieJar(cookies);
    if (Object.keys(normalized).length === 0) throw new Error("RAIL12306_EMPTY_SESSION_NOT_PERSISTED");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${SESSION_AAD_PREFIX}:${accountRef}`, "utf8"));
    const plaintext = Buffer.from(JSON.stringify(normalized), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db.prepare(`INSERT INTO ticket_encrypted_session(account_ref, cipher_version, iv_b64, ciphertext_b64, auth_tag_b64, updated_at)
      VALUES (?, 1, ?, ?, ?, ?)
      ON CONFLICT(account_ref) DO UPDATE SET cipher_version=1, iv_b64=excluded.iv_b64,
        ciphertext_b64=excluded.ciphertext_b64, auth_tag_b64=excluded.auth_tag_b64, updated_at=excluded.updated_at`)
      .run(accountRef, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64"), new Date().toISOString());
  }

  load(accountRef: string): SessionCookieJar | undefined {
    if (!accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
    const row = this.db.prepare(`SELECT cipher_version, iv_b64, ciphertext_b64, auth_tag_b64
      FROM ticket_encrypted_session WHERE account_ref=?`).get(accountRef) as {
        cipher_version: number; iv_b64: string; ciphertext_b64: string; auth_tag_b64: string;
      } | undefined;
    if (!row) return undefined;
    if (Number(row.cipher_version) !== 1) throw new Error("RAIL12306_SESSION_CIPHER_VERSION_UNSUPPORTED");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.iv_b64, "base64"));
      decipher.setAAD(Buffer.from(`${SESSION_AAD_PREFIX}:${accountRef}`, "utf8"));
      decipher.setAuthTag(Buffer.from(row.auth_tag_b64, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext_b64, "base64")),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(plaintext) as SessionCookieJar;
      return normalizeCookieJar(parsed);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("RAIL12306_SESSION_COOKIE_")) throw error;
      throw new Error("RAIL12306_SESSION_DECRYPT_FAILED");
    }
  }

  clear(accountRef: string): void {
    if (!accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
    this.db.prepare("DELETE FROM ticket_encrypted_session WHERE account_ref=?").run(accountRef);
  }

  has(accountRef: string): boolean {
    return !!this.db.prepare("SELECT 1 AS present FROM ticket_encrypted_session WHERE account_ref=?").get(accountRef);
  }

  close(): void {
    this.key.fill(0);
    this.db.close();
  }
}

export type CloudQrLoginChallenge = {
  challenge_id: string;
  qr_image_base64: string;
  expires_at: string;
};

type InternalQrChallenge = { uuid: string; expires_at_ms: number };
type JsonObject = Record<string, unknown>;

function parseObject(body: string, code: string): JsonObject {
  try {
    const value = JSON.parse(body) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new Error(code);
  }
}

function requiredString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value.trim();
}

/**
 * Runner-internal lifecycle adapter. QR image data is intended for a trusted
 * first-party login surface, not for model-visible logs/state. Raw 12306 UUIDs
 * stay inside this object; callers receive an opaque challenge_id instead.
 */
export class Rail12306CloudSessionController {
  private readonly accountRef: string;
  private readonly transport: PersistableLocalSessionTransport;
  private readonly provider: Rail12306LocalAuthenticatedProvider;
  private readonly store: SqliteEncrypted12306SessionStore;
  private readonly challenges = new Map<string, InternalQrChallenge>();

  constructor(options: {
    accountRef: string;
    transport: PersistableLocalSessionTransport;
    provider: Rail12306LocalAuthenticatedProvider;
    store: SqliteEncrypted12306SessionStore;
  }) {
    if (!options.accountRef) throw new Error("ACCOUNT_REF_REQUIRED");
    this.accountRef = options.accountRef;
    this.transport = options.transport;
    this.provider = options.provider;
    this.store = options.store;
  }

  async restore(): Promise<ReadOnlySessionState> {
    this.transport.clearSessionCookies();
    const saved = this.store.load(this.accountRef);
    if (!saved) return "AUTH_REQUIRED";
    this.transport.importSessionCookies(saved);
    const state = await this.provider.sessionState();
    if (state === "READY") return "READY";
    this.transport.clearSessionCookies();
    this.store.clear(this.accountRef);
    return "AUTH_REQUIRED";
  }

  async persistCurrentReadySession(): Promise<"READY"> {
    if (await this.provider.sessionState() !== "READY") throw new Error("AUTH_REQUIRED");
    this.store.save(this.accountRef, this.transport.exportSessionCookies());
    return "READY";
  }

  async beginQrLogin(timeoutMs = 120_000): Promise<CloudQrLoginChallenge> {
    const boundedTimeout = Math.min(Math.max(timeoutMs, 5_000), 180_000);
    this.transport.clearSessionCookies();
    await Promise.allSettled(Array.from(CLOUD_AUTH_GET_PATHS, path => this.transport.request("GET", path)));
    const response = await this.transport.request("POST", "/passport/web/create-qr64", { appid: "otn" });
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_QR_HTTP_ERROR:${response.status}`);
    const payload = parseObject(response.body, "RAIL12306_QR_SCHEMA_DRIFT");
    if (String(payload.result_code ?? "") !== "0") throw new Error("RAIL12306_QR_CREATE_REJECTED");
    const image = requiredString(payload.image, "RAIL12306_QR_SCHEMA_DRIFT");
    const uuid = requiredString(payload.uuid, "RAIL12306_QR_SCHEMA_DRIFT");
    const bytes = Buffer.from(image, "base64");
    if (!bytes.length) throw new Error("RAIL12306_QR_IMAGE_INVALID");
    const challengeId = `qrc_${randomUUID()}`;
    const expiresAtMs = Date.now() + boundedTimeout;
    this.challenges.set(challengeId, { uuid, expires_at_ms: expiresAtMs });
    return { challenge_id: challengeId, qr_image_base64: image, expires_at: new Date(expiresAtMs).toISOString() };
  }

  async waitForQrConfirmation(challengeId: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<"READY"> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("RAIL12306_QR_CHALLENGE_NOT_FOUND");
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 180_000);
    const pollMs = Math.min(Math.max(options.pollMs ?? 2_000, 500), 5_000);
    const deadline = Math.min(Date.now() + timeoutMs, challenge.expires_at_ms);
    while (Date.now() < deadline) {
      const response = await this.transport.request("POST", "/passport/web/checkqr", { uuid: challenge.uuid, appid: "otn" });
      if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_QR_STATUS_HTTP_ERROR:${response.status}`);
      const payload = parseObject(response.body, "RAIL12306_QR_STATUS_SCHEMA_DRIFT");
      const code = String(payload.result_code ?? "");
      if (code === "3") {
        this.challenges.delete(challengeId);
        throw new Error("RAIL12306_QR_EXPIRED");
      }
      if (code === "2") {
        await this.completeLogin();
        if (await this.provider.sessionState() !== "READY") throw new Error("RAIL12306_LOGIN_NOT_READY");
        this.store.save(this.accountRef, this.transport.exportSessionCookies());
        this.challenges.delete(challengeId);
        return "READY";
      }
      if (code !== "0" && code !== "1") throw new Error("RAIL12306_QR_STATUS_UNKNOWN");
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    if (Date.now() >= challenge.expires_at_ms) this.challenges.delete(challengeId);
    throw new Error("RAIL12306_QR_TIMEOUT");
  }

  private async completeLogin(): Promise<void> {
    const tokenResponse = await this.transport.request("POST", "/passport/web/auth/uamtk", { appid: "otn" });
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) throw new Error(`RAIL12306_UAMTK_HTTP_ERROR:${tokenResponse.status}`);
    const tokenPayload = parseObject(tokenResponse.body, "RAIL12306_UAMTK_SCHEMA_DRIFT");
    if (String(tokenPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMTK_REJECTED");
    const token = requiredString(tokenPayload.newapptk, "RAIL12306_UAMTK_SCHEMA_DRIFT");
    const clientResponse = await this.transport.request("POST", "/otn/uamauthclient", { tk: token });
    if (clientResponse.status < 200 || clientResponse.status >= 300) throw new Error(`RAIL12306_UAMAUTH_HTTP_ERROR:${clientResponse.status}`);
    const clientPayload = parseObject(clientResponse.body, "RAIL12306_UAMAUTH_SCHEMA_DRIFT");
    if (String(clientPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMAUTH_REJECTED");
  }
}
