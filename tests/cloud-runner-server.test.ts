import test from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import {
  createCloudRunnerHttpServer,
  loadCloudRunnerEnv,
  type CloudRunnerRuntimeLike,
} from "../runner/12306-cloud-runner-server.ts";

const ADMIN_TOKEN = "runner-admin-token-1234567890-abcdef";

function makeRuntime(options: { qrTimeout?: boolean } = {}) {
  const calls: string[] = [];
  const runtime: CloudRunnerRuntimeLike = {
    controller: {
      async restore() {
        calls.push("restore");
        return "READY";
      },
      async beginQrLogin(timeoutMs = 120_000) {
        calls.push(`beginQrLogin:${timeoutMs}`);
        return {
          challenge_id: "qrc_test",
          qr_image_base64: Buffer.from("png").toString("base64"),
          expires_at: "2026-09-17T12:00:00.000Z",
        };
      },
      async waitForQrConfirmation(challengeId, waitOptions = {}) {
        calls.push(`waitForQrConfirmation:${challengeId}:${waitOptions.timeoutMs}:${waitOptions.pollMs}`);
        if (options.qrTimeout) throw new Error("RAIL12306_QR_TIMEOUT");
        return "READY";
      },
    },
    provider: {
      async sessionState() {
        calls.push("sessionState");
        return "READY";
      },
      async readPassengers() {
        calls.push("readPassengers");
        return [{ passenger_ref: "psg_opaque", passenger_type: "1" }];
      },
      async readPendingOrders() {
        calls.push("readPendingOrders");
        return [{ order_id: "ord_opaque", status: "WAITING_FOR_PAYMENT", redacted: true }];
      },
    },
    close() {
      calls.push("close");
    },
  };
  return { runtime, calls };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_UNAVAILABLE");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function authorized(method = "GET", body?: unknown): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test("healthcheck is public, side-effect free, and advertises read-only boundary", async () => {
  const { runtime, calls } = makeRuntime();
  const server = createCloudRunnerHttpServer({ adminToken: ADMIN_TOKEN, runtime });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "rail12306-cloud-readonly",
      mode: "READ_ONLY",
      submit_capability: false,
      payment_capability: false,
    });
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test("all account routes require the bearer token", async () => {
  const { runtime, calls } = makeRuntime();
  const server = createCloudRunnerHttpServer({ adminToken: ADMIN_TOKEN, runtime });
  const base = await listen(server);
  try {
    for (const path of ["/v1/session/status", "/v1/passengers", "/v1/pending-orders"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, path);
      assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
    }
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test("session restore and read-only account observations are exposed without raw identity data", async () => {
  const { runtime, calls } = makeRuntime();
  const server = createCloudRunnerHttpServer({ adminToken: ADMIN_TOKEN, runtime });
  const base = await listen(server);
  try {
    const restore = await fetch(`${base}/v1/session/restore`, authorized("POST"));
    assert.equal(restore.status, 200);
    assert.deepEqual(await restore.json(), { ok: true, state: "READY" });

    const passengers = await fetch(`${base}/v1/passengers`, authorized());
    assert.equal(passengers.status, 200);
    assert.deepEqual(await passengers.json(), {
      ok: true,
      passengers: [{ passenger_ref: "psg_opaque", passenger_type: "1" }],
    });

    const pending = await fetch(`${base}/v1/pending-orders`, authorized());
    assert.equal(pending.status, 200);
    assert.deepEqual(await pending.json(), {
      ok: true,
      orders: [{ order_id: "ord_opaque", status: "WAITING_FOR_PAYMENT", redacted: true }],
    });

    assert.deepEqual(calls, ["restore", "readPassengers", "readPendingOrders"]);
  } finally {
    await close(server);
  }
});

test("QR challenge stays bounded and polling does not add a submit capability", async () => {
  const { runtime, calls } = makeRuntime();
  const server = createCloudRunnerHttpServer({ adminToken: ADMIN_TOKEN, runtime });
  const base = await listen(server);
  try {
    const begin = await fetch(`${base}/v1/session/qr`, authorized("POST", { timeout_ms: 15_000 }));
    assert.equal(begin.status, 201);
    assert.deepEqual(await begin.json(), {
      ok: true,
      challenge_id: "qrc_test",
      qr_image_base64: Buffer.from("png").toString("base64"),
      expires_at: "2026-09-17T12:00:00.000Z",
    });

    const poll = await fetch(`${base}/v1/session/qr/poll`, authorized("POST", { challenge_id: "qrc_test" }));
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), { ok: true, state: "READY" });

    const submit = await fetch(`${base}/v1/submit`, authorized("POST", {}));
    assert.equal(submit.status, 404);
    assert.deepEqual(await submit.json(), { ok: false, error: "NOT_FOUND" });

    assert.deepEqual(calls, [
      "beginQrLogin:15000",
      "waitForQrConfirmation:qrc_test:5000:500",
    ]);
  } finally {
    await close(server);
  }
});

test("QR timeout is a waiting observation, not an automatic retry or failure", async () => {
  const { runtime } = makeRuntime({ qrTimeout: true });
  const server = createCloudRunnerHttpServer({ adminToken: ADMIN_TOKEN, runtime });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/v1/session/qr/poll`, authorized("POST", { challenge_id: "qrc_test" }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, state: "WAITING" });
  } finally {
    await close(server);
  }
});

test("environment loader prefers the Railway volume and rejects malformed session keys", () => {
  const sessionKey = Buffer.alloc(32, 7).toString("base64");
  const config = loadCloudRunnerEnv({
    RUNNER_ADMIN_TOKEN: ADMIN_TOKEN,
    RAIL12306_ACCOUNT_REF: "acct_cloud",
    RAIL12306_ALIAS_KEY: "opaque-alias-key-123456",
    RAIL12306_SESSION_KEY_B64: sessionKey,
    RAILWAY_VOLUME_MOUNT_PATH: "/railway-data",
    PORT: "4321",
  });
  assert.equal(config.databasePath, "/railway-data/12306-session.sqlite");
  assert.equal(config.port, 4321);
  assert.equal(config.sessionKey.length, 32);

  assert.throws(() => loadCloudRunnerEnv({
    RUNNER_ADMIN_TOKEN: ADMIN_TOKEN,
    RAIL12306_ACCOUNT_REF: "acct_cloud",
    RAIL12306_ALIAS_KEY: "opaque-alias-key-123456",
    RAIL12306_SESSION_KEY_B64: Buffer.alloc(8).toString("base64"),
  }), /RAIL12306_SESSION_KEY_B64_INVALID/);
});
