import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  FetchLocalSessionHttpTransport,
  Rail12306LocalAuthenticatedProvider,
  extractNoCompleteOrderList,
  redactNoCompleteOrders,
  type LocalSessionHttpResponse,
  type LocalSessionHttpTransport,
} from "../runner/12306-local-auth-readonly.ts";

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

const passengerPayload = {
  status: true,
  data: {
    normal_passengers: [{
      passenger_name: "测试乘客",
      passenger_id_no: "SECRET-ID-NOT-ALLOWED-OUT",
      passenger_id_type_code: "1",
      passenger_type: "1",
      mobile_no: "SECRET-PHONE-NOT-ALLOWED-OUT",
    }],
  },
};

function pendingPayload(statusName = "待支付") {
  return {
    status: true,
    data: {
      orderDBList: [{
        sequence_no: "ORDER-OPAQUE-1",
        start_train_date_page: "2026-10-01 08:00",
        train_code_page: "G100",
        from_station_name_page: "广州南",
        to_station_name_page: "长沙南",
        ticket_status_name: statusName,
        ticket_total_price_page: "¥314.00",
        tickets: [{ passenger_name: "测试乘客", seat_type_name: "二等座", ticket_status_name: statusName }],
      }],
    },
  };
}

test("authenticated provider creates stable opaque passenger refs and never emits raw PII", async () => {
  const transport = new ScriptedTransport([
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
    { method: "POST", path: "/otn/confirmPassenger/getPassengerDTOs", response: json(passengerPayload) },
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
    { method: "POST", path: "/otn/queryOrder/queryMyOrderNoComplete", response: json(pendingPayload()) },
  ]);
  const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "local-only-alias-key-123456", transport });
  const passengers = await provider.readPassengers();
  const orders = await provider.readPendingOrders();

  assert.equal(passengers.length, 1);
  assert.match(passengers[0].passenger_ref, /^psg_[0-9a-f]{24}$/);
  assert.equal(orders[0].status, "WAITING_FOR_PAYMENT");
  assert.deepEqual(orders[0].passenger_refs, [passengers[0].passenger_ref]);
  assert.deepEqual(orders[0].seat_classes, ["二等座"]);
  assert.equal(orders[0].quantity, 1);
  assert.equal(orders[0].amount, 314);
  const emitted = JSON.stringify({ passengers, orders });
  assert.equal(emitted.includes("测试乘客"), false);
  assert.equal(emitted.includes("SECRET-ID"), false);
  assert.equal(emitted.includes("SECRET-PHONE"), false);
});

test("no-complete orders are not promoted to pending payment without explicit payment status", () => {
  const aliases = new Map([["测试乘客", "psg_opaque"]]);
  const orders = redactNoCompleteOrders(pendingPayload("已支付"), aliases);
  assert.equal(orders[0].status, "UNKNOWN");
});

test("pending order payload supports current observed list variants but rejects missing arrays", () => {
  assert.equal(extractNoCompleteOrderList({ status: true, data: { orderDTODataList: [{ sequence_no: "1" }] } }).length, 1);
  assert.equal(extractNoCompleteOrderList({ status: true, data: { orders: [{ sequence_no: "2" }] } }).length, 1);
  assert.equal(extractNoCompleteOrderList({ status: true, data: [{ sequence_no: "3" }] }).length, 1);
  assert.throws(() => extractNoCompleteOrderList({ status: true, data: {} }), /RAIL12306_PENDING_SCHEMA_DRIFT/);
});

test("unmapped passenger identity stays omitted instead of leaking a name or inventing identity", () => {
  const orders = redactNoCompleteOrders(pendingPayload(), new Map());
  assert.equal(orders[0].passenger_refs, undefined);
  assert.equal(JSON.stringify(orders).includes("测试乘客"), false);
});

test("QR login flow is bounded to authentication endpoints and stores QR only at caller path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-qr-test-"));
  const qrPath = join(directory, "login.png");
  try {
    const transport = new ScriptedTransport([
      { method: "GET", path: "/otn/login/conf", response: json({ ok: true }) },
      { method: "GET", path: "/otn/index12306/getLoginBanner", response: json({ ok: true }) },
      { method: "GET", path: "/passport/web/auth/uamtk-static", response: json({ ok: true }) },
      { method: "POST", path: "/passport/web/create-qr64", response: json({ result_code: "0", image: Buffer.from("fake-png").toString("base64"), uuid: "qr-uuid" }) },
      { method: "POST", path: "/passport/web/checkqr", response: json({ result_code: "2" }) },
      { method: "POST", path: "/passport/web/auth/uamtk", response: json({ result_code: "0", newapptk: "LOCAL-TOKEN" }) },
      { method: "POST", path: "/otn/uamauthclient", response: json({ result_code: "0" }) },
      { method: "POST", path: "/otn/login/checkUser", response: ready() },
    ]);
    const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "local-only-alias-key-123456", transport });
    const challenge = await provider.beginQrLogin(qrPath, 30_000);
    assert.equal(challenge.qr_file, qrPath);
    assert.equal(challenge.uuid, "qr-uuid");
    assert.equal(existsSync(qrPath), true);
    assert.equal(await provider.waitForQrConfirmation(challenge.uuid, { timeoutMs: 5_000, pollMs: 500 }), "READY");
    assert.equal(transport.calls.some(call => call.path.includes("submitOrderRequest")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("alias key is mandatory and raw-order endpoints outside read-only allowlist are structurally blocked", async () => {
  assert.throws(() => new Rail12306LocalAuthenticatedProvider({ aliasKey: "short" }), /RAIL12306_ALIAS_KEY_REQUIRED/);
  const transport = new FetchLocalSessionHttpTransport();
  await assert.rejects(() => transport.request("POST", "/otn/leftTicket/submitOrderRequest", {}), /RAIL12306_AUTH_READ_ONLY_PATH_BLOCKED/);
  await assert.rejects(() => transport.request("POST", "/otn/confirmPassenger/confirmSingleForQueue", {}), /RAIL12306_AUTH_READ_ONLY_PATH_BLOCKED/);
});
