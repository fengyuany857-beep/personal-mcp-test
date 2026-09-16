import { Real12306ReadOnlyAdapter } from "../runner/real12306-readonly.ts";

function nextShanghaiDate(): string {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(tomorrow);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

const date = process.env.RAIL12306_PROBE_DATE?.trim() || nextShanghaiDate();
const fromQuery = process.env.RAIL12306_PROBE_FROM?.trim() || "北京南";
const toQuery = process.env.RAIL12306_PROBE_TO?.trim() || "上海虹桥";

try {
  const adapter = new Real12306ReadOnlyAdapter();
  const initialized = await adapter.initializePublic();
  const stations = await adapter.listStations();
  const from = stations.data.find(item => [item.name, item.telecode, item.pinyin, item.pinyin_short].some(value => value.toLowerCase() === fromQuery.toLowerCase()));
  const to = stations.data.find(item => [item.name, item.telecode, item.pinyin, item.pinyin_short].some(value => value.toLowerCase() === toQuery.toLowerCase()));
  if (!from || !to) throw new Error("RAIL12306_STATION_NOT_FOUND");
  const query = await adapter.queryTrains({ date, from_station: from.telecode, to_station: to.telecode });

  console.log(JSON.stringify({
    ok: true,
    mode: "READ_ONLY",
    observed_at: query.observed_at,
    date,
    from: { name: from.name, telecode: from.telecode },
    to: { name: to.name, telecode: to.telecode },
    station_count: stations.data.length,
    station_schema_fingerprint: stations.schema_fingerprint,
    query_endpoint: query.endpoint,
    query_route_discovery: initialized.data.discovery,
    train_count: query.data.length,
    sample_train_codes: query.data.slice(0, 5).map(item => item.train_code),
    query_schema_fingerprint: query.schema_fingerprint,
    server_date: query.server_date ?? initialized.server_date ?? null,
    authenticated_reads: "NOT_ATTEMPTED",
    raw_cookie_logged: false,
    order_effect: "NONE",
    submit_capability: "NOT_AVAILABLE",
    payment_capability: "NOT_AVAILABLE",
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    mode: "READ_ONLY",
    error_code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
    raw_response_logged: false,
    raw_cookie_logged: false,
    order_effect: "NONE",
    submit_capability: "NOT_AVAILABLE",
    payment_capability: "NOT_AVAILABLE",
  }));
  process.exitCode = 1;
}
