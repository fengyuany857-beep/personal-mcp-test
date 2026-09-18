import test from "node:test";
import assert from "node:assert/strict";
import { Cloud12306SessionTransport } from "../runner/12306-session-persistence.ts";

test("cloud auth transport aborts a stalled 12306 request instead of hanging", async () => {
  let sawSignal = false;
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      sawSignal = !!signal;
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  const transport = new Cloud12306SessionTransport({ fetchImpl, requestTimeoutMs: 100 });
  const startedAt = Date.now();
  await assert.rejects(
    () => transport.request("POST", "/passport/web/create-qr64", { appid: "otn" }),
    /RAIL12306_CLOUD_AUTH_NETWORK_ERROR:TIMEOUT/,
  );
  assert.equal(sawSignal, true);
  assert.ok(Date.now() - startedAt < 1_000, "stalled auth request must fail within a bounded interval");
});

test("cloud auth transport rejects unsafe timeout configuration", () => {
  assert.throws(
    () => new Cloud12306SessionTransport({ requestTimeoutMs: 0 }),
    /RAIL12306_CLOUD_AUTH_TIMEOUT_INVALID/,
  );
  assert.throws(
    () => new Cloud12306SessionTransport({ requestTimeoutMs: 60_000 }),
    /RAIL12306_CLOUD_AUTH_TIMEOUT_INVALID/,
  );
});


test("cloud auth transport honors a shorter per-request timeout override", async () => {
  const fetchImpl = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;

  const transport = new Cloud12306SessionTransport({ fetchImpl, requestTimeoutMs: 1_000 });
  const startedAt = Date.now();
  await assert.rejects(
    () => transport.request("GET", "/otn/login/conf", {}, { timeoutMs: 100 }),
    /RAIL12306_CLOUD_AUTH_NETWORK_ERROR:TIMEOUT/,
  );
  assert.ok(Date.now() - startedAt < 700, "per-request override must shorten the bound");
});
