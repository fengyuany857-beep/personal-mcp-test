import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rail12306LocalAuthenticatedProvider, type LocalSessionHttpResponse } from "../runner/12306-local-auth-readonly.ts";
import { Rail12306QrFirstCloudSessionController } from "../runner/12306-qr-first-session.ts";
import {
  SqliteEncrypted12306SessionStore,
  type PersistableLocalSessionTransport,
  type SessionCookieJar,
} from "../runner/12306-session-persistence.ts";

type Queued = { method: "GET" | "POST"; path: string; response?: LocalSessionHttpResponse; error?: Error };

class ScriptedTransport implements PersistableLocalSessionTransport {
  readonly calls: Array<{ method: string; path: string; form?: Record<string, string>; cookies: SessionCookieJar }> = [];
  private readonly queue: Queued[];
  private readonly jar = new Map<string, string>();

  constructor(queue: Queued[]) { this.queue = [...queue]; }
  exportSessionCookies(): SessionCookieJar { return Object.fromEntries(this.jar); }
  clearSessionCookies(): void { this.jar.clear(); }
  importSessionCookies(cookies: SessionCookieJar): void {
    this.jar.clear();
    for (const [name, value] of Object.entries(cookies)) this.jar.set(name, value);
  }

  async request(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<LocalSessionHttpResponse> {
    this.calls.push({ method, path, ...(form ? { form: { ...form } } : {}), cookies: this.exportSessionCookies() });
    const next = this.queue.shift();
    if (!next) throw new Error(`UNEXPECTED_HTTP_CALL:${method}:${path}`);
    assert.equal(method, next.method);
    assert.equal(path, next.path);
    if (next.error) throw next.error;
    const response = next.response!;
    const setCookie = response.headers?.["set-cookie"];
    const values = Array.isArray(setCookie) ? setCookie : typeof setCookie === "string" ? [setCookie] : [];
    for (const raw of values) {
      const first = raw.split(";", 1)[0] ?? "";
      const split = first.indexOf("=");
      if (split > 0) this.jar.set(first.slice(0, split), first.slice(split + 1));
    }
    return response;
  }
}

function json(body: unknown, status = 200, headers?: LocalSessionHttpResponse["headers"]): LocalSessionHttpResponse {
  return { status, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
}

function makeController(transport: ScriptedTransport, path: string) {
  const store = new SqliteEncrypted12306SessionStore(path, Buffer.alloc(32, 19));
  const provider = new Rail12306LocalAuthenticatedProvider({
    aliasKey: "qr-first-alias-key-123456789",
    transport,
  });
  return {
    store,
    controller: new Rail12306QrFirstCloudSessionController({
      accountRef: "acct_qr_first",
      transport,
      provider,
      store,
    }),
  };
}

test("confirmed QR bridges checkqr uamtk through auth/uamtk before uamauthclient", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-first-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "RAW-UUID" }) },
    { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2", uamtk: "QR-CONFIRMED-UAMTK" }) },
    { method: "POST", path: "/passport/web/auth/uamtk", response: json({ result_code: "0", newapptk: "QR-NEWAPPTK" }) },
    { method: "POST", path: "/otn/uamauthclient", response: json({ result_code: "0", username: "redacted" }, 200, { "set-cookie": ["RAIL_SESSION=OPAQUE-SESSION; Path=/; HttpOnly"] }) },
    { method: "POST", path: "/otn/login/checkUser", response: json({ status: true, data: { flag: true } }) },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    const challenge = await controller.beginQrLogin(30_000);
    assert.equal(await controller.waitForQrConfirmation(challenge.challenge_id, { timeoutMs: 5_000, pollMs: 500 }), "READY");
    assert.equal(store.has("acct_qr_first"), true);

    const uamtkExchange = transport.calls.find(call => call.path === "/passport/web/auth/uamtk");
    assert.deepEqual(uamtkExchange?.form, { appid: "otn" });
    assert.equal(uamtkExchange?.cookies.uamtk, "QR-CONFIRMED-UAMTK");

    const authClient = transport.calls.find(call => call.path === "/otn/uamauthclient");
    assert.deepEqual(authClient?.form, { tk: "QR-NEWAPPTK" });
    assert.equal(authClient?.cookies.uamtk, "QR-CONFIRMED-UAMTK");
    assert.equal(authClient?.cookies.tk, "QR-NEWAPPTK");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("confirmed QR without official uamtk fails closed instead of falling back to password-style token exchange", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-no-tk-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "RAW-UUID" }) },
    { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2" }) },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    const challenge = await controller.beginQrLogin(30_000);
    await assert.rejects(
      () => controller.waitForQrConfirmation(challenge.challenge_id, { timeoutMs: 5_000, pollMs: 500 }),
      /RAIL12306_QR_UAMTK_MISSING/,
    );
    assert.equal(transport.calls.some(call => call.path === "/passport/web/auth/uamtk"), false);
    assert.equal(store.has("acct_qr_first"), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("auth/uamtk redirect remains blocked with QR-specific context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-uamtk-redirect-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "RAW-UUID" }) },
    { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2", uamtk: "QR-UAMTK" }) },
    { method: "POST", path: "/passport/web/auth/uamtk", error: new Error("RAIL12306_CLOUD_AUTH_UNEXPECTED_REDIRECT_BLOCKED") },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    const challenge = await controller.beginQrLogin(30_000);
    await assert.rejects(
      () => controller.waitForQrConfirmation(challenge.challenge_id, { timeoutMs: 5_000, pollMs: 500 }),
      /RAIL12306_QR_UAMTK_REDIRECT_BLOCKED/,
    );
    const exchange = transport.calls.find(call => call.path === "/passport/web/auth/uamtk");
    assert.equal(exchange?.cookies.uamtk, "QR-UAMTK");
    assert.equal(store.has("acct_qr_first"), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("uamauthclient redirect remains blocked and is reported with QR-specific context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-uamauth-redirect-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "RAW-UUID" }) },
    { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2", uamtk: "QR-UAMTK" }) },
    { method: "POST", path: "/passport/web/auth/uamtk", response: json({ result_code: "0", newapptk: "NEW-APP-TK" }) },
    { method: "POST", path: "/otn/uamauthclient", error: new Error("RAIL12306_CLOUD_AUTH_UNEXPECTED_REDIRECT_BLOCKED") },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    const challenge = await controller.beginQrLogin(30_000);
    await assert.rejects(
      () => controller.waitForQrConfirmation(challenge.challenge_id, { timeoutMs: 5_000, pollMs: 500 }),
      /RAIL12306_QR_UAMAUTH_REDIRECT_BLOCKED/,
    );
    const authClient = transport.calls.find(call => call.path === "/otn/uamauthclient");
    assert.deepEqual(authClient?.form, { tk: "NEW-APP-TK" });
    assert.equal(authClient?.cookies.uamtk, "QR-UAMTK");
    assert.equal(authClient?.cookies.tk, "NEW-APP-TK");
    assert.equal(store.has("acct_qr_first"), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("QR bootstrap bounds warm-up and retries one transient create network failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-retry-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", error: new Error("RAIL12306_CLOUD_AUTH_NETWORK_ERROR:ETIMEDOUT") },
    { method: "POST", path: "/passport/web/create-qr64", response: json({
      result_code: "0",
      image: Buffer.from("retry-png").toString("base64"),
      uuid: "RETRY-UUID",
    }) },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    const challenge = await controller.beginQrLogin(30_000);
    assert.match(challenge.challenge_id, /^qrc_/);
    assert.equal(challenge.qr_image_base64, Buffer.from("retry-png").toString("base64"));
    assert.equal(transport.calls.filter(call => call.path === "/passport/web/create-qr64").length, 2);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("QR bootstrap does not retry non-network create failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-no-retry-"));
  const path = join(directory, "session.sqlite");
  const transport = new ScriptedTransport([
    { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
    { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
    { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
    { method: "POST", path: "/passport/web/create-qr64", error: new Error("RAIL12306_CLOUD_AUTH_PATH_BLOCKED") },
  ]);

  const { controller, store } = makeController(transport, path);
  try {
    await assert.rejects(() => controller.beginQrLogin(30_000), /RAIL12306_CLOUD_AUTH_PATH_BLOCKED/);
    assert.equal(transport.calls.filter(call => call.path === "/passport/web/create-qr64").length, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
