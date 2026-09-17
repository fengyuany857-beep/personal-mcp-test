import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  createIphone12306AuthPortal,
  SharedCookieMobileTransport,
} from "../runner/12306-iphone-auth-portal.ts";
import type { MobileAuthChallenge } from "../runner/12306-mobile-auth.ts";
import type { PersistableLocalSessionTransport, SessionCookieJar } from "../runner/12306-session-persistence.ts";

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

function challenge(state: MobileAuthChallenge["state"] = "PENDING", attempts = 0): MobileAuthChallenge {
  return { challenge_id: "challenge-opaque", expires_at: "2099-01-01T00:00:00.000Z", state, attempts };
}

test("iPhone auth page is public but credential API requires the high-entropy access code", async () => {
  let submitted = false;
  const portal = createIphone12306AuthPortal({
    accessCodeHash: ACCESS_HASH,
    mobileChallenges: {
      create: () => challenge(),
      status: () => challenge("READY", 1),
      async submitPassword() { submitted = true; return { state: "READY", session_state: "READY", retryable: false }; },
      async requestSms() { return { state: "SMS_CODE_SENT", retryable: false }; },
      async submitSms() { return { state: "READY", session_state: "READY", retryable: false }; },
      async refresh() { return challenge("READY", 1); },
    },
    async restoreSession() { return "AUTH_REQUIRED"; },
    async persistReadySession() { return "READY"; },
    async readPassengers() { return []; },
    async readPendingOrders() { return []; },
  });
  const { server, base } = await listen(portal);
  try {
    const page = await fetch(`${base}/auth`);
    assert.equal(page.status, 200);
    const text = await page.text();
    assert.match(text, /不发送给 ChatGPT/);
    assert.match(text, /不含下单或支付能力/);
    assert.equal(page.headers.get("cache-control")?.includes("no-store"), true);

    const denied = await fetch(`${base}/auth/api/start`, jsonPost({
      access_code: "wrong-access-code-but-long-enough",
      username: "SHOULD-NOT-BE-USED",
      password: "SHOULD-NOT-BE-USED",
    }));
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { ok: false, error: "UNAUTHORIZED" });
    assert.equal(submitted, false);
  } finally {
    await close(server);
  }
});

test("READY login persists the shared session then exposes counts only", async () => {
  let persisted = 0;
  let cleared = 0;
  let state: MobileAuthChallenge["state"] = "PENDING";
  const portal = createIphone12306AuthPortal({
    accessCodeHash: ACCESS_HASH,
    clearSession() { cleared += 1; },
    mobileChallenges: {
      create: () => challenge(),
      status: () => challenge(state, 1),
      async submitPassword(_id, username, password) {
        assert.equal(username, "PRIVATE-USER");
        assert.equal(password, "PRIVATE-PASSWORD");
        state = "READY";
        return { state: "READY", session_state: "READY", retryable: false };
      },
      async requestSms() { return { state: "SMS_CODE_SENT", retryable: false }; },
      async submitSms() { state = "READY"; return { state: "READY", session_state: "READY", retryable: false }; },
      async refresh() { return challenge(state, 1); },
    },
    async restoreSession() { return "AUTH_REQUIRED"; },
    async persistReadySession() { persisted += 1; return "READY"; },
    async readPassengers() { return [{ passenger_ref: "opaque-1" }, { passenger_ref: "opaque-2" }]; },
    async readPendingOrders() { return [{ order_id: "opaque-order", status: "WAITING_FOR_PAYMENT", redacted: true }]; },
  });
  const { server, base } = await listen(portal);
  try {
    const response = await fetch(`${base}/auth/api/start`, jsonPost({
      access_code: ACCESS,
      username: "PRIVATE-USER",
      password: "PRIVATE-PASSWORD",
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(body, {
      ok: true,
      challenge_id: "challenge-opaque",
      state: "READY",
      session_persisted: true,
      passenger_count: 2,
      pending_order_count: 1,
      submit_capability: false,
      payment_capability: false,
    });
    const emitted = JSON.stringify(body);
    assert.equal(emitted.includes("PRIVATE-USER"), false);
    assert.equal(emitted.includes("PRIVATE-PASSWORD"), false);
    assert.equal(emitted.includes("opaque-1"), false);
    assert.equal(emitted.includes("opaque-order"), false);
    assert.equal(cleared, 1);
    assert.equal(persisted, 1);
  } finally {
    await close(server);
  }
});

test("shared-cookie mobile transport structurally blocks submit, queue and payment paths before network", async () => {
  let networkCalls = 0;
  let cookies: SessionCookieJar = {};
  const shared: PersistableLocalSessionTransport = {
    exportSessionCookies: () => ({ ...cookies }),
    importSessionCookies: next => { cookies = { ...next }; },
    clearSessionCookies: () => { cookies = {}; },
    async request() { throw new Error("NOT_USED"); },
  };
  const transport = new SharedCookieMobileTransport(shared, async () => {
    networkCalls += 1;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(() => transport.request("POST", "/otn/leftTicket/submitOrderRequest"), /RAIL12306_IPHONE_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/confirmPassenger/confirmSingleForQueue"), /RAIL12306_IPHONE_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/payOrder/init"), /RAIL12306_IPHONE_AUTH_PATH_BLOCKED/);
  assert.equal(networkCalls, 0);
});
