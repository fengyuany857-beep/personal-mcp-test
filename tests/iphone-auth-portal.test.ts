import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createIphone12306AuthPortal } from "../runner/12306-iphone-auth-portal.ts";

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

test("iPhone auth page is QR-first and contains no 12306 credential form", async () => {
  const { portal } = makePortal();
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /12306 扫码登录/);
    assert.match(text, /选择“相册”/);
    assert.match(text, /无需输入 12306 账号或密码/);
    assert.equal(text.includes('id="username"'), false);
    assert.equal(text.includes('id="password"'), false);
    assert.equal(text.includes('id="smsCode"'), false);
    assert.equal(response.headers.get("cache-control")?.includes("no-store"), true);
    assert.match(response.headers.get("content-security-policy") ?? "", /img-src data: blob:/);
  } finally {
    await close(server);
  }
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
