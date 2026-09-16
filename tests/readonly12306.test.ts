import test from "node:test";
import assert from "node:assert/strict";
import {
  Rail12306PublicReadClient,
  Real12306ReadOnlyAdapter,
  parseLeftTicketPayload,
  parseStationNameScript,
  type HttpReadResponse,
  type ReadOnlyHttpTransport,
} from "../runner/real12306-readonly.ts";

class QueueTransport implements ReadOnlyHttpTransport {
  readonly calls: Array<{ url: string; headers: Record<string, string> }> = [];
  private readonly queue: HttpReadResponse[];
  constructor(queue: HttpReadResponse[]) { this.queue = [...queue]; }
  async get(url: string, headers: Record<string, string> = {}) {
    this.calls.push({ url, headers: { ...headers } });
    const response = this.queue.shift();
    if (!response) throw new Error("UNEXPECTED_HTTP_CALL");
    return response;
  }
}

function response(body: string, options: { status?: number; date?: string; setCookie?: string[] } = {}): HttpReadResponse {
  return { status: options.status ?? 200, headers: { date: options.date ?? "Wed, 16 Sep 2026 18:00:00 GMT", "set-cookie": options.setCookie ?? [] }, body };
}

function ticketRow(trainCode = "G1") {
  const row = Array.from({ length: 40 }, () => "");
  row[2] = "24000000G10L";
  row[3] = trainCode;
  row[6] = "VNP";
  row[7] = "AOH";
  row[8] = "06:43";
  row[9] = "11:14";
  row[10] = "04:31";
  row[11] = "Y";
  row[16] = "01";
  row[17] = "07";
  row[30] = "5";
  row[31] = "有";
  row[32] = "无";
  row[35] = "9MOO";
  return row.join("|");
}

const querySuccess = () => JSON.stringify({ status: true, httpstatus: 200, data: { result: [ticketRow()], map: { VNP: "北京南", AOH: "上海虹桥" } } });

test("station dictionary parser extracts public station identity fields", () => {
  const stations = parseStationNameScript("var station_names ='@bjn|北京南|VNP|beijingnan|bjn|3|0357|北京|||@shh|上海虹桥|AOH|shanghaihongqiao|shhq|10|0321|上海|||';");
  assert.equal(stations.length, 2);
  assert.deepEqual(stations[0], { search_key: "bjn", name: "北京南", telecode: "VNP", pinyin: "beijingnan", pinyin_short: "bjn", order_index: "3", city_code: "0357", city_name: "北京" });
});

test("ticket parser extracts only bounded public query fields", () => {
  const result = parseLeftTicketPayload(JSON.parse(querySuccess()));
  assert.equal(result[0].train_code, "G1");
  assert.equal(result[0].bookable, true);
  assert.equal(result[0].seats.second, "5");
  assert.equal(result[0].from_station_name, "北京南");
  assert.equal(result[0].to_station_name, "上海虹桥");
});

test("public query initializes cookie, discovers endpoint and performs GET only", async () => {
  const transport = new QueueTransport([
    response("<script>var CLeftTicketUrl = 'leftTicket/queryG';</script>", { setCookie: ["RAIL_EXPIRATION=1; Path=/; Secure"] }),
    response(querySuccess()),
  ]);
  const client = new Rail12306PublicReadClient(transport);
  const result = await client.queryTrains({ date: "2026-09-18", from_station: "VNP", to_station: "AOH" });
  assert.equal(result.endpoint, "/otn/leftTicket/queryG");
  assert.equal(result.data.length, 1);
  assert.equal(transport.calls.length, 2);
  assert.match(transport.calls[1].url, /\/otn\/leftTicket\/queryG\?/);
  assert.match(transport.calls[1].headers.Cookie ?? "", /RAIL_EXPIRATION=1/);
});

test("c_url endpoint drift is followed once only within the leftTicket query family", async () => {
  const transport = new QueueTransport([
    response("<html>no inline route</html>"),
    response(JSON.stringify({ status: false, c_url: "leftTicket/queryH" })),
    response(querySuccess()),
  ]);
  const client = new Rail12306PublicReadClient(transport);
  const result = await client.queryTrains({ date: "2026-09-18", from_station: "VNP", to_station: "AOH" });
  assert.equal(result.endpoint, "/otn/leftTicket/queryH");
  assert.equal(transport.calls.length, 3);
  assert.match(transport.calls[2].url, /\/otn\/leftTicket\/queryH\?/);
});

test("unsafe c_url cannot escape the read-only 12306 query allowlist", async () => {
  const transport = new QueueTransport([
    response("<html>init</html>"),
    response(JSON.stringify({ status: false, c_url: "https://example.com/write" })),
  ]);
  const client = new Rail12306PublicReadClient(transport);
  await assert.rejects(() => client.queryTrains({ date: "2026-09-18", from_station: "VNP", to_station: "AOH" }), /RAIL12306_UNSAFE_QUERY_REDIRECT/);
  assert.equal(transport.calls.length, 2);
});

test("server clock uses the HTTP Date observation without inventing a provider timestamp", async () => {
  const transport = new QueueTransport([response("<html>init</html>", { date: "Wed, 16 Sep 2026 18:01:02 GMT" })]);
  const clock = await new Rail12306PublicReadClient(transport).observeServerClock();
  assert.equal(clock.data.server_time, "2026-09-16T18:01:02.000Z");
});

test("authenticated read-only boundary strips unapproved PII fields and keeps all commit methods unavailable", async () => {
  const adapter = new Real12306ReadOnlyAdapter({ authenticated: {
    sessionState: async () => "READY",
    readPassengers: async () => [{ passenger_ref: "psg_self", passenger_type: "1", id_number: "SHOULD_NOT_ESCAPE" } as never],
    readPendingOrders: async () => [{ order_id: "o1", status: "WAITING_FOR_PAYMENT", travel_date: "2026-09-18", train_code: "G1", passenger_refs: ["psg_self"], seat_classes: ["二等座"], quantity: 1, amount: 553, payment_deadline: "2026-09-17T18:15:00Z", redacted: true, passenger_name: "SHOULD_NOT_ESCAPE" } as never],
  } });
  const passengers = await adapter.readPassengers();
  const orders = await adapter.readPendingOrders();
  assert.deepEqual(passengers, [{ passenger_ref: "psg_self", passenger_type: "1" }]);
  assert.equal("id_number" in passengers[0], false);
  assert.equal("passenger_name" in orders[0], false);
  assert.equal(orders[0].redacted, true);
  assert.throws(() => adapter.submitOrder(), /CAPABILITY_NOT_AVAILABLE/);
  assert.throws(() => adapter.confirmSingleForQueue(), /CAPABILITY_NOT_AVAILABLE/);
  assert.throws(() => adapter.payOrder(), /CAPABILITY_NOT_AVAILABLE/);
});

test("real adapter without a local authenticated provider fails closed", async () => {
  const adapter = new Real12306ReadOnlyAdapter({ transport: new QueueTransport([]) });
  assert.equal(await adapter.sessionState(), "AUTH_REQUIRED");
  await assert.rejects(() => adapter.readPendingOrders(), /AUTH_REQUIRED/);
  await assert.rejects(() => adapter.readPassengers(), /AUTH_REQUIRED/);
});
