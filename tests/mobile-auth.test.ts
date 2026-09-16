import test from "node:test";
import assert from "node:assert/strict";
import {
  Mobile12306AuthChallengeStore,
  MobileAccountSessionHttpTransport,
  Rail12306MobileAccountAuth,
  classifyAccountLoginResponse,
} from "../runner/12306-mobile-auth.ts";
import type { LocalSessionHttpResponse, LocalSessionHttpTransport } from "../runner/12306-local-auth-readonly.ts";

class ScriptedTransport implements LocalSessionHttpTransport {
  readonly calls: Array<{ method: string; path: string; form?: Record<string, string> }> = [];
  private readonly queue: Array<{ method: "GET" | "POST"; path: string; response: LocalSessionHttpResponse }>;
  constructor(queue: Array<{ method: "GET" | "POST"; path: string; response: LocalSessionHttpResponse }>) { this.queue = [...queue]; }
  async request(method: "GET" | "POST", path: string, form?: Record<string, string>) {
    this.calls.push({ method, path, ...(form ? { form: { ...form } } : {}) });
    const next = this.queue.shift();
    if (!next) throw new Error(`UNEXPECTED_HTTP_CALL:${method}:${path}`);
    assert.equal(method, next.method);
    assert.equal(path, next.path);
    return next.response;
  }
}

function json(body: unknown, status = 200): LocalSessionHttpResponse { return { status, body: JSON.stringify(body) }; }
const ready = () => json({ status: true, data: { flag: true } });

test("mobile account login completes the existing authenticated session handshake without exposing credentials", async () => {
  const transport = new ScriptedTransport([
    { method: "POST", path: "/passport/web/login", response: json({ result_code: 0, result_message: "登录成功" }) },
    { method: "POST", path: "/passport/web/auth/uamtk", response: json({ result_code: 0, newapptk: "OPAQUE-UAMTK" }) },
    { method: "POST", path: "/otn/uamauthclient", response: json({ result_code: 0 }) },
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
  ]);
  const auth = new Rail12306MobileAccountAuth({ aliasKey: "mobile-alias-key-123456789", transport });
  const result = await auth.login("fake-user@example.invalid", "FAKE-PASSWORD-NOT-A-SECRET");

  assert.deepEqual(result, { state: "READY", session_state: "READY", retryable: false });
  assert.equal(JSON.stringify(result).includes("FAKE-PASSWORD"), false);
  assert.deepEqual(transport.calls.map(call => call.path), [
    "/passport/web/login",
    "/passport/web/auth/uamtk",
    "/otn/uamauthclient",
    "/otn/login/checkUser",
  ]);
  assert.equal(transport.calls.some(call => /submitOrderRequest|confirmSingleForQueue|pay/i.test(call.path)), false);
});

test("official human-verification messages collapse to coarse non-PII states", () => {
  assert.equal(classifyAccountLoginResponse({ result_code: 2, result_message: "为了保护您的账户安全，请在十分钟内使用12306APP进行登录核验。" }), "APP_CONFIRM_REQUIRED");
  assert.equal(classifyAccountLoginResponse({ result_code: 2, result_message: "手机验证提醒，请获取动态身份验证码" }), "SMS_REQUIRED");
  assert.equal(classifyAccountLoginResponse({ result_code: 2, result_message: "请选择滑动验证" }), "SLIDER_REQUIRED");
  assert.equal(classifyAccountLoginResponse({ result_code: 2, result_message: "身份信息有问题，需到线下窗口进行身份核验" }), "OFFLINE_IDENTITY_REQUIRED");
  assert.equal(classifyAccountLoginResponse({ result_code: 1, result_message: "用户名或密码输入错误" }), "INVALID_CREDENTIALS");
  assert.equal(classifyAccountLoginResponse({ result_code: 99, result_message: "未知的新核验流程" }), "HUMAN_ACTION_REQUIRED");
});

test("failed account login never returns raw 12306 message or masked account data", async () => {
  const transport = new ScriptedTransport([
    { method: "POST", path: "/passport/web/login", response: json({ result_code: 2, result_message: "请用尾号2753手机号发短信666到12306。" }) },
  ]);
  const auth = new Rail12306MobileAccountAuth({ aliasKey: "mobile-alias-key-123456789", transport });
  const result = await auth.login("fake-user", "fake-password");
  const emitted = JSON.stringify(result);
  assert.deepEqual(result, { state: "SMS_REQUIRED", session_state: "HUMAN_ACTION_REQUIRED", retryable: false });
  assert.equal(emitted.includes("2753"), false);
  assert.equal(emitted.includes("666"), false);
  assert.equal(emitted.includes("fake-user"), false);
  assert.equal(emitted.includes("fake-password"), false);
});

test("mobile challenge store retains only opaque metadata, bounds password retries and can observe later app confirmation", async () => {
  const transport = new ScriptedTransport([
    { method: "POST", path: "/passport/web/login", response: json({ result_code: 1, result_message: "用户名或密码输入错误" }) },
    { method: "POST", path: "/passport/web/login", response: json({ result_code: 2, result_message: "请在十分钟内使用12306APP进行登录核验" }) },
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
  ]);
  const auth = new Rail12306MobileAccountAuth({ aliasKey: "mobile-alias-key-123456789", transport });
  const store = new Mobile12306AuthChallengeStore(auth, { maxAttempts: 3 });
  const challenge = store.create(60_000);

  const first = await store.submitPassword(challenge.challenge_id, "fake-user-1", "fake-password-1");
  assert.equal(first.state, "INVALID_CREDENTIALS");
  assert.equal(store.status(challenge.challenge_id).attempts, 1);

  const second = await store.submitPassword(challenge.challenge_id, "fake-user-2", "fake-password-2");
  assert.equal(second.state, "APP_CONFIRM_REQUIRED");
  const before = JSON.stringify(store.status(challenge.challenge_id));
  assert.equal(before.includes("fake-user"), false);
  assert.equal(before.includes("fake-password"), false);

  const refreshed = await store.refresh(challenge.challenge_id);
  assert.equal(refreshed.state, "READY");
});

test("mobile transport structurally blocks order, queue-confirm and payment paths", async () => {
  const transport = new MobileAccountSessionHttpTransport();
  await assert.rejects(() => transport.request("POST", "/otn/leftTicket/submitOrderRequest", {}), /RAIL12306_MOBILE_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/confirmPassenger/confirmSingleForQueue", {}), /RAIL12306_MOBILE_AUTH_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/payOrder/init", {}), /RAIL12306_MOBILE_AUTH_PATH_BLOCKED/);
});
