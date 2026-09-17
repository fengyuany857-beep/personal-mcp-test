import { randomUUID } from "node:crypto";
import type { ReadOnlySessionState } from "./real12306-readonly.ts";
import { Rail12306LocalAuthenticatedProvider } from "./12306-local-auth-readonly.ts";
import {
  SqliteEncrypted12306SessionStore,
  type CloudQrLoginChallenge,
  type PersistableLocalSessionTransport,
} from "./12306-session-persistence.ts";

const CLOUD_AUTH_GET_PATHS = new Set([
  "/otn/login/conf",
  "/otn/index12306/getLoginBanner",
  "/passport/web/auth/uamtk-static",
]);

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
 * QR-first cloud session controller.
 *
 * Important protocol detail: a confirmed /passport/web/checkqr response carries
 * the one-time uamtk produced by the user's official 12306 App confirmation.
 * Consume that token directly at /otn/uamauthclient instead of making a second
 * /passport/web/auth/uamtk request. The token is process-local only and is never
 * logged, returned to the browser, or persisted.
 */
export class Rail12306QrFirstCloudSessionController {
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
    return {
      challenge_id: challengeId,
      qr_image_base64: image,
      expires_at: new Date(expiresAtMs).toISOString(),
    };
  }

  async waitForQrConfirmation(
    challengeId: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<"READY"> {
    const challenge = this.challenges.get(challengeId);
    if (!challenge) throw new Error("RAIL12306_QR_CHALLENGE_NOT_FOUND");
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 180_000);
    const pollMs = Math.min(Math.max(options.pollMs ?? 2_000, 500), 5_000);
    const deadline = Math.min(Date.now() + timeoutMs, challenge.expires_at_ms);

    while (Date.now() < deadline) {
      const response = await this.transport.request("POST", "/passport/web/checkqr", {
        uuid: challenge.uuid,
        appid: "otn",
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`RAIL12306_QR_STATUS_HTTP_ERROR:${response.status}`);
      }
      const payload = parseObject(response.body, "RAIL12306_QR_STATUS_SCHEMA_DRIFT");
      const code = String(payload.result_code ?? "");
      if (code === "3") {
        this.challenges.delete(challengeId);
        throw new Error("RAIL12306_QR_EXPIRED");
      }
      if (code === "2") {
        const qrUamtk = requiredString(payload.uamtk, "RAIL12306_QR_UAMTK_MISSING");
        await this.completeLoginFromQrToken(qrUamtk);
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

  private async completeLoginFromQrToken(token: string): Promise<void> {
    let clientResponse;
    try {
      clientResponse = await this.transport.request("POST", "/otn/uamauthclient", { tk: token });
    } catch (error) {
      if (error instanceof Error && error.message === "RAIL12306_CLOUD_AUTH_UNEXPECTED_REDIRECT_BLOCKED") {
        throw new Error("RAIL12306_QR_UAMAUTH_REDIRECT_BLOCKED");
      }
      throw error;
    }
    if (clientResponse.status < 200 || clientResponse.status >= 300) {
      throw new Error(`RAIL12306_UAMAUTH_HTTP_ERROR:${clientResponse.status}`);
    }
    const clientPayload = parseObject(clientResponse.body, "RAIL12306_UAMAUTH_SCHEMA_DRIFT");
    if (String(clientPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMAUTH_REJECTED");
  }
}
