import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { runInNewContext } from "node:vm";
import { createIphone12306AuthPortal } from "../runner/12306-iphone-auth-portal.ts";
import { IPHONE_AUTH_APP_JS } from "../runner/12306-iphone-auth-app.ts";

const ACCESS = "test-access-code-1234567890-safe";
const ACCESS_HASH = createHash("sha256").update(ACCESS).digest("hex");

async function listen(portal: ReturnType<typeof createIphone12306AuthPortal>): Promise<{ server: Server; base: string }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://test.invalid").pathname;
    if (await portal.handle(req, res, path)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function makePortal(options: {
  restored?: "READY" | "AUTH_REQUIRED";
  wait?: "READY" | "TIMEOUT" | "EXPIRED";
} = {}) {
  const calls: string[] = [];
  const portal = createIphone12306AuthPortal({
    accessCodeHash: ACCESS_HASH,
    async restoreSession() {
      calls.push("restore");
      return options.restored ?? "AUTH_REQUIRED";
    },
    async beginQrLogin(timeoutMs) {
      calls.push(`begin:${timeoutMs}`);
      return {
        challenge_id: "qrc_opaque",
        qr_image_base64: Buffer.from("png-bytes").toString("base64"),
        expires_at: "2099-01-01T00:00:00.000Z",
      };
    },
    async waitForQrConfirmation(challengeId, waitOptions) {
      calls.push(`wait:${challengeId}:${waitOptions?.timeoutMs}:${waitOptions?.pollMs}`);
      if (options.wait === "TIMEOUT") throw new Error("RAIL12306_QR_TIMEOUT");
      if (options.wait === "EXPIRED") throw new Error("RAIL12306_QR_EXPIRED");
      return "READY";
    },
    async readPassengers() {
      calls.push("passengers");
      return [{ passenger_ref: "opaque-1" }, { passenger_ref: "opaque-2" }];
    },
    async readPendingOrders() {
      calls.push("orders");
      return [{ order_id: "opaque-order", status: "WAITING_FOR_PAYMENT", redacted: true }];
    },
  });
  return { portal, calls };
}

test("iPhone auth page uses same-origin external script and contains no credential form", async () => {
  const { portal } = makePortal();
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /12306 扫码登录/);
    assert.match(text, /选择“相册”/);
    assert.match(text, /无需输入 12306 账号或密码/);
    assert.match(text, /<script src="\/auth\/app\.js" defer><\/script>/);
    assert.equal(text.includes('id="username"'), false);
    assert.equal(text.includes('id="password"'), false);
    assert.equal(text.includes('id="smsCode"'), false);
    assert.equal(response.headers.get("cache-control")?.includes("no-store"), true);
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src 'unsafe-inline'/);
    assert.match(csp, /img-src data: blob:/);

    const scriptResponse = await fetch(`${base}/auth/app.js`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type") ?? "", /^application\/javascript/);
    assert.equal(scriptResponse.headers.get("cache-control")?.includes("no-store"), true);
    assert.match(await scriptResponse.text(), /__RAIL12306_AUTH_APP_BOOT/);
  } finally {
    await close(server);
  }
});

test("auth app still boots from URL fragment when Safari storage and history APIs throw", async () => {
  type FakeElement = {
    textContent: string;
    className: string;
    value: string;
    src: string;
    onclick?: () => void;
    classList: { toggle(name: string, force?: boolean): void };
  };

  const fakeElement = (): FakeElement => ({
    textContent: "",
    className: "",
    value: "",
    src: "",
    classList: { toggle() {} },
  });
  const elements = new Map<string, FakeElement>([
    ["status", fakeElement()],
    ["accessBox", fakeElement()],
    ["access", fakeElement()],
    ["unlock", fakeElement()],
    ["qrArea", fakeElement()],
    ["qr", fakeElement()],
    ["share", fakeElement()],
    ["regen", fakeElement()],
  ]);

  let storageAccesses = 0;
  const windowObject: Record<string, unknown> = {
    location: { hash: `#code=${ACCESS}`, pathname: "/auth", search: "" },
    history: { replaceState() { throw new Error("HISTORY_BLOCKED"); } },
  };
  Object.defineProperty(windowObject, "sessionStorage", {
    configurable: true,
    get() {
      storageAccesses += 1;
      throw new Error("STORAGE_BLOCKED");
    },
  });

  const requests: string[] = [];
  const fetchMock = async (input: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> => {
    requests.push(input);
    if (input === "/auth/api/qr/start") {
      return {
        ok: true,
        status: 201,
        async json() {
          return {
            ok: true,
            state: "WAITING",
            challenge_id: "qrc_vm",
            qr_image_base64: Buffer.from("vm-png").toString("base64"),
            expires_at: "2099-01-01T00:00:00.000Z",
          };
        },
      };
    }
    if (input === "/auth/api/qr/poll") {
      return {
        ok: true,
        status: 202,
        async json() { return { ok: true, state: "WAITING", challenge_id: "qrc_vm" }; },
      };
    }
    throw new Error(`UNEXPECTED_FETCH:${input}`);
  };

  const scheduled: Array<() => void> = [];
  runInNewContext(IPHONE_AUTH_APP_JS, {
    window: windowObject,
    document: {
      readyState: "complete",
      getElementById(id: string) { return elements.get(id) ?? null; },
      addEventListener() {},
      createElement() { return { href: "", download: "", click() {}, remove() {} }; },
      body: { appendChild() {} },
    },
    URLSearchParams,
    AbortController,
    fetch: fetchMock,
    setTimeout(callback: () => void) { scheduled.push(callback); return scheduled.length; },
    clearTimeout() {},
    atob(value: string) { return Buffer.from(value, "base64").toString("binary"); },
    Uint8Array,
    navigator: {},
    File: class {},
    console,
  });

  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(windowObject.__RAIL12306_AUTH_APP_BOOT, true);
  assert.ok(storageAccesses >= 2);
  assert.equal(requests[0], "/auth/api/qr/start");
  assert.equal(elements.get("qr")?.src, `data:image/png;base64,${Buffer.from("vm-png").toString("base64")}`);
  assert.match(elements.get("status")?.textContent ?? "", /二维码已生成|等待你在 12306 App/);
});

test("QR API rejects an invalid access code before contacting 12306", async () => {
  const { portal, calls } = makePortal();
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth/api/qr/start`, jsonPost({ access_code: "wrong-access-code-but-long-enough" }));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test("QR start returns only opaque challenge and official image payload", async () => {
  const { portal, calls } = makePortal();
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth/api/qr/start`, jsonPost({ access_code: ACCESS }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      ok: true,
      state: "WAITING",
      challenge_id: "qrc_opaque",
      qr_image_base64: Buffer.from("png-bytes").toString("base64"),
      expires_at: "2099-01-01T00:00:00.000Z",
      submit_capability: false,
      payment_capability: false,
    });
    assert.deepEqual(calls, ["restore", "begin:180000"]);
  } finally {
    await close(server);
  }
});

test("confirmed QR session returns redacted counts only", async () => {
  const { portal, calls } = makePortal({ wait: "READY" });
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth/api/qr/poll`, jsonPost({
      access_code: ACCESS,
      challenge_id: "qrc_opaque",
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, {
      ok: true,
      challenge_id: "qrc_opaque",
      state: "READY",
      session_persisted: true,
      passenger_count: 2,
      pending_order_count: 1,
      submit_capability: false,
      payment_capability: false,
    });
    const emitted = JSON.stringify(body);
    assert.equal(emitted.includes("opaque-1"), false);
    assert.equal(emitted.includes("opaque-order"), false);
    assert.deepEqual(calls, ["wait:qrc_opaque:5000:500", "passengers", "orders"]);
  } finally {
    await close(server);
  }
});

test("QR polling timeout is WAITING and expiry is terminal", async () => {
  const waiting = makePortal({ wait: "TIMEOUT" });
  const waitingServer = await listen(waiting.portal);
  try {
    const response = await fetch(`${waitingServer.base}/auth/api/qr/poll`, jsonPost({ access_code: ACCESS, challenge_id: "qrc_opaque" }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, state: "WAITING", challenge_id: "qrc_opaque" });
  } finally {
    await close(waitingServer.server);
  }

  const expired = makePortal({ wait: "EXPIRED" });
  const expiredServer = await listen(expired.portal);
  try {
    const response = await fetch(`${expiredServer.base}/auth/api/qr/poll`, jsonPost({ access_code: ACCESS, challenge_id: "qrc_opaque" }));
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { ok: false, error: "RAIL12306_QR_EXPIRED" });
  } finally {
    await close(expiredServer.server);
  }
});

test("legacy password and SMS portal endpoints are no longer exposed", async () => {
  const { portal, calls } = makePortal();
  const { server, base } = await listen(portal);
  try {
    for (const path of ["/auth/api/start", "/auth/api/sms/request", "/auth/api/sms/submit"]) {
      const response = await fetch(`${base}${path}`, jsonPost({ access_code: ACCESS }));
      assert.equal(response.status, 404, path);
      assert.deepEqual(await response.json(), { ok: false, error: "NOT_FOUND" });
    }
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});
