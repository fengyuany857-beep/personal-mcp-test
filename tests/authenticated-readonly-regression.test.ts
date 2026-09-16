import test from "node:test";
import assert from "node:assert/strict";
import {
  Rail12306LocalAuthenticatedProvider,
  redactNoCompleteOrders,
  type LocalSessionHttpResponse,
  type LocalSessionHttpTransport,
} from "../runner/12306-local-auth-readonly.ts";

class QueueTransport implements LocalSessionHttpTransport {
  private readonly queue: Array<{ method: "GET" | "POST"; path: string; response: LocalSessionHttpResponse }>;
  constructor(queue: Array<{ method: "GET" | "POST"; path: string; response: LocalSessionHttpResponse }>) { this.queue = [...queue]; }
  async request(method: "GET" | "POST", path: string) {
    const next = this.queue.shift();
    if (!next) throw new Error(`UNEXPECTED_HTTP_CALL:${method}:${path}`);
    assert.equal(method, next.method);
    assert.equal(path, next.path);
    return next.response;
  }
}

function json(body: unknown): LocalSessionHttpResponse { return { status: 200, body: JSON.stringify(body) }; }
const ready = () => json({ status: true, data: { flag: true } });

test("nested passengerDTO and stationTrainDTO are normalized without leaking nested PII", () => {
  const orders = redactNoCompleteOrders({
    status: true,
    data: {
      orderDBList: [{
        sequence_no: "ORDER-NESTED-1",
        tickets: [{
          ticket_status_name: "待支付",
          seat_name: "二等座",
          passengerDTO: { passenger_name: "测试乘客", passenger_id_no: "SECRET-NESTED-ID" },
          stationTrainDTO: {
            station_train_code: "G101",
            from_station_name: "广州南",
            to_station_name: "长沙南",
            train_date: "2026-10-01",
          },
        }],
      }],
    },
  }, new Map([["测试乘客", "psg_nested"]]));

  assert.equal(orders[0].order_id, "ORDER-NESTED-1");
  assert.equal(orders[0].status, "WAITING_FOR_PAYMENT");
  assert.equal(orders[0].train_code, "G101");
  assert.equal(orders[0].origin, "广州南");
  assert.equal(orders[0].destination, "长沙南");
  assert.equal(orders[0].travel_date, "2026-10-01");
  assert.deepEqual(orders[0].passenger_refs, ["psg_nested"]);
  assert.deepEqual(orders[0].seat_classes, ["二等座"]);
  assert.equal(JSON.stringify(orders).includes("测试乘客"), false);
  assert.equal(JSON.stringify(orders).includes("SECRET-NESTED-ID"), false);
});

test("pending order without an authoritative order identity fails closed", () => {
  assert.throws(() => redactNoCompleteOrders({
    status: true,
    data: { orderDBList: [{ tickets: [] }] },
  }, new Map()), /RAIL12306_PENDING_ORDER_ID_MISSING/);
});

test("duplicate passenger names never collapse two identities into one pending-order passenger_ref", async () => {
  const transport = new QueueTransport([
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
    { method: "POST", path: "/otn/confirmPassenger/getPassengerDTOs", response: json({
      status: true,
      data: {
        normal_passengers: [
          { passenger_name: "同名乘客", passenger_id_no: "ID-A", passenger_id_type_code: "1", passenger_type: "1" },
          { passenger_name: "同名乘客", passenger_id_no: "ID-B", passenger_id_type_code: "1", passenger_type: "1" },
        ],
      },
    }) },
    { method: "POST", path: "/otn/login/checkUser", response: ready() },
    { method: "POST", path: "/otn/queryOrder/queryMyOrderNoComplete", response: json({
      status: true,
      data: {
        orderDBList: [{
          sequence_no: "ORDER-DUPLICATE-NAME",
          ticket_status_name: "待支付",
          tickets: [{ passenger_name: "同名乘客", seat_type_name: "二等座", ticket_status_name: "待支付" }],
        }],
      },
    }) },
  ]);

  const provider = new Rail12306LocalAuthenticatedProvider({ aliasKey: "local-only-alias-key-123456", transport });
  const passengers = await provider.readPassengers();
  assert.equal(passengers.length, 2);
  assert.notEqual(passengers[0].passenger_ref, passengers[1].passenger_ref);
  const orders = await provider.readPendingOrders();
  assert.equal(orders[0].passenger_refs, undefined);
});
