import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Cloud12306SessionTransport,
  Rail12306CloudSessionController,
  SqliteEncrypted12306SessionStore,
  type PersistableLocalSessionTransport,
  type SessionCookieJar,
} from "../runner/12306-session-persistence.ts";
import {
  Rail12306LocalAuthenticatedProvider,
  type LocalSessionHttpResponse,
} from "../runner/12306-local-auth-readonly.ts";

type Queued = { method: "GET" | "POST"; path: string; response: LocalSessionHttpResponse };

class ScriptedPersistableTransport implements PersistableLocalSessionTransport {
  readonly calls: Array<{ method: string; path: string; form?: Record<string, string> }> = [];
  private readonly queue: Queued[];
  private readonly jar = new Map<string, string>();

  constructor(queue: Queued[] = []) { this.queue = [...queue]; }

  exportSessionCookies(): SessionCookieJar { return Object.fromEntries(this.jar); }
  clearSessionCookies(): void { this.jar.clear(); }
  importSessionCookies(cookies: SessionCookieJar): void {
    this.jar.clear();
    for (const [name, value] of Object.entries(cookies)) this.jar.set(name, value);
  }

  async request(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<LocalSessionHttpResponse> {
    this.calls.push({ method, path, ...(form ? { form: { ...form } } : {}) });
    const next = this.queue.shift();
    if (!next) throw new Error(`UNEXPECTED_HTTP_CALL:${method}:${path}`);
    assert.equal(method, next.method);
    assert.equal(path, next.path);
    const setCookie = next.response.headers?.["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : [];
    for (const raw of values) {
      const first = raw.split(";", 1)[0] ?? "";
      const split = first.indexOf("=");
      if (split > 0) this.jar.set(first.slice(0, split), first.slice(split + 1));
    }
    return next.response;
  }
}

function json(body: unknown, status = 200, headers?: LocalSessionHttpResponse["headers"]): LocalSessionHttpResponse {
  return { status, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
}
const ready = () => json({ status: true, data: { flag: true } });
const authRequired = () => json({ status: true, data: { flag: false } });

function allDatabaseBytes(path: string): Buffer {
  const parts: Buffer[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    const candidate = `${path}${suffix}`;
    if (existsSync(candidate)) parts.push(readFileSync(candidate));
  }
  return Buffer.concat(parts);
}

test("encrypted session store survives restart without writing plaintext cookies", () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-session-store-"));
  const path = join(directory, "session.sqlite");
  const key = Buffer.alloc(32, 7);
  const cookie = "SECRET-COOKIE-VALUE-NEVER-PLAINTEXT";
  try {
    const first = new SqliteEncrypted12306SessionStore(path, key);
    first.save("acct_opaque", { RAIL_SESSION: cookie, route: "opaque-route" });
    assert.equal(allDatabaseBytes(path).includes(Buffer.from(cookie)), false);
    first.close();

    const second = new SqliteEncrypted12306SessionStore(path, key);
    assert.deepEqual(second.load("acct_opaque"), { RAIL_SESSION: cookie, route: "opaque-route" });
    second.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("wrong key and cross-account ciphertext replay fail closed", () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-session-aad-"));
  const path = join(directory, "session.sqlite");
  const key = Buffer.alloc(32, 9);
  try {
    const store = new SqliteEncrypted12306SessionStore(path, key);
    store.save("acct_a", { RAIL_SESSION: "opaque-a" });
    store.close();

    const wrong = new SqliteEncrypted12306SessionStore(path, Buffer.alloc(32, 3));
    assert.throws(() => wrong.load("acct_a"), /RAIL12306_SESSION_DECRYPT_FAILED/);
    wrong.close();

    const db = new DatabaseSync(path);
    db.exec(`INSERT INTO ticket_encrypted_session(account_ref, cipher_version, iv_b64, ciphertext_b64, auth_tag_b64, updated_at)
      SELECT 'acct_b', cipher_version, iv_b64, ciphertext_b64, auth_tag_b64, updated_at
      FROM ticket_encrypted_session WHERE account_ref='acct_a'`);
    db.close();

    const rebound = new SqliteEncrypted12306SessionStore(path, key);
    assert.throws(() => rebound.load("acct_b"), /RAIL12306_SESSION_DECRYPT_FAILED/);
    rebound.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cloud QR confirmation persists session and a new process-facing controller restores it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-cloud-qr-"));
  const path = join(directory, "session.sqlite");
  const key = Buffer.alloc(32, 5);
  try {
    const transport = new ScriptedPersistableTransport([
      { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
      { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
      { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
      { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "RAW-12306-UUID" }) },
      { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2" }) },
      { method: "POST", path: "/passport/web/auth/uamtk", response: json({ result_code: "0", newapptk: "OPAQUE-TK" }) },
      { method: "POST", path: "/otn/uamauthclient", response: json({ result_code: "0" }, 200, { "set-cookie": ["RAIL_SESSION=SECRET-SESSION; Path=/; HttpOnly"] }) },
      { method: "POST", path: "/otn/login/checkUser", response: ready() },
    ]);
    const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "cloud-alias-key-123456789", transport });
    const store = new SqliteEncrypted12306SessionStore(path, key);
    const controller = new Rail12306CloudSessionController({ accountRef: "acct_cloud", transport, provider, store });

    const challenge = await controller.beginQrLogin(30_000);
    assert.match(challenge.challenge_id, /^qrc_/);
    assert.equal(challenge.qr_image_base64, Buffer.from("fake-png").toString("base64"));
    assert.equal(JSON.stringify(challenge).includes("RAW-12306-UUID"), false);
    assert.equal(await controller.waitForQrConfirmation(challenge.challenge_id, { timeoutMs: 5_000, pollMs: 500 }), "READY");
    assert.equal(store.has("acct_cloud"), true);
    store.close();

    const restoredTransport = new ScriptedPersistableTransport([
      { method: "POST", path: "/otn/login/checkUser", response: ready() },
    ]);
    const restoredProvider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "cloud-alias-key-123456789", transport: restoredTransport });
    const restoredStore = new SqliteEncrypted12306SessionStore(path, key);
    const restoredController = new Rail12306CloudSessionController({
      accountRef: "acct_cloud", transport: restoredTransport, provider: restoredProvider, store: restoredStore,
    });
    assert.equal(await restoredController.restore(), "READY");
    assert.equal(restoredTransport.exportSessionCookies().RAIL_SESSION, "SECRET-SESSION");
    restoredStore.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("expired server session is removed and returns AUTH_REQUIRED instead of pretending READY", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-expired-session-"));
  const path = join(directory, "session.sqlite");
  const key = Buffer.alloc(32, 11);
  try {
    const store = new SqliteEncrypted12306SessionStore(path, key);
    store.save("acct_expired", { RAIL_SESSION: "expired-secret" });
    const transport = new ScriptedPersistableTransport([
      { method: "POST", path: "/otn/login/checkUser", response: authRequired() },
    ]);
    const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "cloud-alias-key-123456789", transport });
    const controller = new Rail12306CloudSessionController({ accountRef: "acct_expired", transport, provider, store });

    assert.equal(await controller.restore(), "AUTH_REQUIRED");
    assert.equal(store.has("acct_expired"), false);
    assert.deepEqual(transport.exportSessionCookies(), {});
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cloud transport rejects cookie injection and consequential paths before fetch", async () => {
  let fetchCalled = false;
  const transport = new Cloud12306SessionTransport({
    fetchImpl: (async () => {
      fetchCalled = true;
      throw new Error("NETWORK_SHOULD_NOT_BE_CALLED");
    }) as typeof fetch,
  });
  assert.throws(() => transport.importSessionCookies({ "bad\r\nheader": "x" }), /RAIL12306_SESSION_COOKIE_INVALID/);
  await assert.rejects(() => transport.request("POST", "/otn/leftTicket/submitOrderRequest", {}), /RAIL12306_CLOUD_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/confirmPassenger/confirmSingleForQueue", {}), /RAIL12306_CLOUD_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/payOrder/init", {}), /RAIL12306_CLOUD_AUTH_PATH_BLOCKED/);
  assert.equal(fetchCalled, false);
});
