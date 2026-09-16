import { createHash } from "node:crypto";
import { TICKET_CAPABILITY_NOT_AVAILABLE, type PendingOrder } from "../src/ticket/contracts.ts";
import type { ReadOnly12306Adapter } from "./local-runner.ts";

const KYFW_ORIGIN = "https://kyfw.12306.cn";
const INIT_PATH = "/otn/leftTicket/init?linktypeid=dc";
const STATION_PATH = "/otn/resources/js/framework/station_name.js";
const DEFAULT_LEFT_TICKET_PATH = "/otn/leftTicket/queryG";
const REFERER = `${KYFW_ORIGIN}${INIT_PATH}`;

export type ReadOnlySessionState = "READY" | "AUTH_REQUIRED" | "HUMAN_ACTION_REQUIRED";

export type HttpReadResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

export interface ReadOnlyHttpTransport {
  get(url: string, headers?: Record<string, string>): Promise<HttpReadResponse>;
}

export class FetchReadOnlyHttpTransport implements ReadOnlyHttpTransport {
  async get(url: string, headers: Record<string, string> = {}): Promise<HttpReadResponse> {
    const response = await fetch(url, { method: "GET", headers, redirect: "manual" });
    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookie = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
    return {
      status: response.status,
      headers: {
        date: response.headers.get("date") ?? undefined,
        location: response.headers.get("location") ?? undefined,
        "content-type": response.headers.get("content-type") ?? undefined,
        "set-cookie": setCookie,
      },
      body: await response.text(),
    };
  }
}

export type StationRecord = {
  search_key: string;
  name: string;
  telecode: string;
  pinyin: string;
  pinyin_short: string;
  order_index?: string;
  city_code?: string;
  city_name?: string;
};

export type SeatAvailability = {
  business?: string;
  special?: string;
  first?: string;
  second?: string;
  advanced_soft_sleeper?: string;
  soft_sleeper?: string;
  sleeper?: string;
  hard_seat?: string;
  no_seat?: string;
};

export type TrainAvailability = {
  train_no: string;
  train_code: string;
  from_station_code: string;
  from_station_name?: string;
  to_station_code: string;
  to_station_name?: string;
  departure_time: string;
  arrival_time: string;
  duration: string;
  bookable: boolean;
  from_station_no?: string;
  to_station_no?: string;
  seat_types?: string;
  seats: SeatAvailability;
};

export type ReadOnlyObservation<T> = {
  observed_at: string;
  endpoint: string;
  http_status: number;
  server_date?: string;
  schema_fingerprint: string;
  data: T;
};

export type PassengerAlias = {
  passenger_ref: string;
  passenger_type?: string;
};

export interface AuthenticatedReadOnlyProvider {
  sessionState(): Promise<ReadOnlySessionState>;
  readPassengers(): Promise<PassengerAlias[]>;
  readPendingOrders(): Promise<PendingOrder[]>;
}

function scalarShape(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return ["array", value.length ? scalarShape(value[0]) : "empty"];
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, scalarShape((value as Record<string, unknown>)[key])]));
  }
  return typeof value;
}

export function schemaFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(scalarShape(value))).digest("hex");
}

export function parseStationNameScript(script: string): StationRecord[] {
  const stations: StationRecord[] = [];
  for (const segment of script.split("@")) {
    const fields = segment.split("|");
    if (fields.length < 5 || !fields[1] || !fields[2]) continue;
    stations.push({
      search_key: fields[0] ?? "",
      name: fields[1],
      telecode: fields[2],
      pinyin: fields[3] ?? "",
      pinyin_short: fields[4] ?? "",
      ...(fields[5] ? { order_index: fields[5] } : {}),
      ...(fields[6] ? { city_code: fields[6] } : {}),
      ...(fields[7] ? { city_name: fields[7] } : {}),
    });
  }
  if (!stations.length) throw new Error("RAIL12306_STATION_SCHEMA_DRIFT");
  return stations;
}

export function parseLeftTicketPayload(payload: unknown): TrainAvailability[] {
  if (!payload || typeof payload !== "object") throw new Error("RAIL12306_QUERY_SCHEMA_DRIFT");
  const root = payload as { status?: unknown; data?: { result?: unknown; map?: unknown } };
  if (root.status !== true || !root.data || !Array.isArray(root.data.result)) throw new Error("RAIL12306_QUERY_SCHEMA_DRIFT");
  const stationMap = root.data.map && typeof root.data.map === "object" ? root.data.map as Record<string, string> : {};
  return root.data.result.map((raw, index) => {
    if (typeof raw !== "string") throw new Error(`RAIL12306_QUERY_ROW_SCHEMA_DRIFT:${index}`);
    const row = raw.split("|");
    if (row.length < 36 || !row[2] || !row[3]) throw new Error(`RAIL12306_QUERY_ROW_SCHEMA_DRIFT:${index}`);
    return {
      train_no: row[2],
      train_code: row[3],
      from_station_code: row[6] ?? "",
      ...(stationMap[row[6] ?? ""] ? { from_station_name: stationMap[row[6] ?? ""] } : {}),
      to_station_code: row[7] ?? "",
      ...(stationMap[row[7] ?? ""] ? { to_station_name: stationMap[row[7] ?? ""] } : {}),
      departure_time: row[8] ?? "",
      arrival_time: row[9] ?? "",
      duration: row[10] ?? "",
      bookable: row[11] === "Y",
      ...(row[16] ? { from_station_no: row[16] } : {}),
      ...(row[17] ? { to_station_no: row[17] } : {}),
      ...(row[35] ? { seat_types: row[35] } : {}),
      seats: {
        ...(row[32] ? { business: row[32] } : {}),
        ...(row[25] ? { special: row[25] } : {}),
        ...(row[31] ? { first: row[31] } : {}),
        ...(row[30] ? { second: row[30] } : {}),
        ...(row[21] ? { advanced_soft_sleeper: row[21] } : {}),
        ...(row[23] ? { soft_sleeper: row[23] } : {}),
        ...(row[28] ? { sleeper: row[28] } : {}),
        ...(row[29] ? { hard_seat: row[29] } : {}),
        ...(row[26] ? { no_seat: row[26] } : {}),
      },
    };
  });
}

function normalizeLeftTicketPath(candidate: string): string {
  const trimmed = candidate.trim();
  const withoutOrigin = trimmed.startsWith(KYFW_ORIGIN) ? trimmed.slice(KYFW_ORIGIN.length) : trimmed;
  const path = withoutOrigin.startsWith("/otn/") ? withoutOrigin : `/otn/${withoutOrigin.replace(/^\/+/, "")}`;
  if (!/^\/otn\/leftTicket\/query[A-Za-z0-9_-]*$/.test(path)) throw new Error("RAIL12306_UNSAFE_QUERY_REDIRECT");
  return path;
}

function parseJson(body: string): unknown {
  try { return JSON.parse(body); }
  catch { throw new Error("RAIL12306_NON_JSON_RESPONSE"); }
}

function dateHeader(headers: HttpReadResponse["headers"]): string | undefined {
  const value = headers.date;
  return typeof value === "string" && value ? value : undefined;
}

function setCookieHeaders(headers: HttpReadResponse["headers"]): string[] {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

export class Rail12306PublicReadClient {
  private readonly transport: ReadOnlyHttpTransport;
  private readonly cookies = new Map<string, string>();
  private initialized = false;
  private leftTicketPath = DEFAULT_LEFT_TICKET_PATH;
  private stationCache?: StationRecord[];

  constructor(transport: ReadOnlyHttpTransport = new FetchReadOnlyHttpTransport()) { this.transport = transport; }

  async initialize(): Promise<ReadOnlyObservation<{ left_ticket_path: string; discovery: "PAGE" | "PINNED_REFERENCE_FALLBACK" }>> {
    const response = await this.get(INIT_PATH, false);
    this.assertOk(response, "RAIL12306_INIT_HTTP_ERROR");
    const match = response.body.match(/CLeftTicketUrl\s*=\s*['\"]([^'\"]+)['\"]/);
    const discovery = match?.[1] ? "PAGE" as const : "PINNED_REFERENCE_FALLBACK" as const;
    this.leftTicketPath = normalizeLeftTicketPath(match?.[1] ?? DEFAULT_LEFT_TICKET_PATH);
    this.initialized = true;
    const data = { left_ticket_path: this.leftTicketPath, discovery };
    return this.observation(INIT_PATH, response, data);
  }

  async listStations(): Promise<ReadOnlyObservation<StationRecord[]>> {
    await this.ensureInitialized();
    if (this.stationCache) {
      const cached = this.stationCache.map(station => ({ ...station }));
      return { observed_at: new Date().toISOString(), endpoint: STATION_PATH, http_status: 200, schema_fingerprint: schemaFingerprint(cached), data: cached };
    }
    const response = await this.get(STATION_PATH);
    this.assertOk(response, "RAIL12306_STATION_HTTP_ERROR");
    const data = parseStationNameScript(response.body);
    this.stationCache = data;
    return this.observation(STATION_PATH, response, data.map(station => ({ ...station })));
  }

  async resolveStation(query: string): Promise<StationRecord> {
    const observation = await this.listStations();
    const needle = query.trim().toLowerCase();
    const match = observation.data.find(station =>
      station.name.toLowerCase() === needle ||
      station.telecode.toLowerCase() === needle ||
      station.pinyin.toLowerCase() === needle ||
      station.pinyin_short.toLowerCase() === needle
    );
    if (!match) throw new Error("RAIL12306_STATION_NOT_FOUND");
    return { ...match };
  }

  async queryTrains(input: { date: string; from_station: string; to_station: string; purpose_codes?: string }): Promise<ReadOnlyObservation<TrainAvailability[]>> {
    await this.ensureInitialized();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("RAIL12306_INVALID_DATE");
    if (!/^[A-Z0-9]{3,6}$/.test(input.from_station) || !/^[A-Z0-9]{3,6}$/.test(input.to_station)) throw new Error("RAIL12306_INVALID_STATION_CODE");
    const params = new URLSearchParams({
      "leftTicketDTO.train_date": input.date,
      "leftTicketDTO.from_station": input.from_station,
      "leftTicketDTO.to_station": input.to_station,
      purpose_codes: input.purpose_codes ?? "ADULT",
    });
    let path = this.leftTicketPath;
    let response = await this.get(`${path}?${params.toString()}`);
    this.assertOk(response, "RAIL12306_QUERY_HTTP_ERROR");
    let payload = parseJson(response.body) as { status?: unknown; c_url?: unknown; data?: { c_url?: unknown } };
    if (payload.status === false) {
      const redirect = typeof payload.c_url === "string" ? payload.c_url : typeof payload.data?.c_url === "string" ? payload.data.c_url : undefined;
      if (!redirect) throw new Error("RAIL12306_QUERY_REJECTED");
      path = normalizeLeftTicketPath(redirect);
      response = await this.get(`${path}?${params.toString()}`);
      this.assertOk(response, "RAIL12306_QUERY_REDIRECT_HTTP_ERROR");
      payload = parseJson(response.body) as typeof payload;
    }
    const data = parseLeftTicketPayload(payload);
    this.leftTicketPath = path;
    return this.observation(path, response, data);
  }

  async observeServerClock(): Promise<ReadOnlyObservation<{ server_time: string }>> {
    const response = await this.get(INIT_PATH, false);
    this.assertOk(response, "RAIL12306_CLOCK_HTTP_ERROR");
    const header = dateHeader(response.headers);
    if (!header || Number.isNaN(Date.parse(header))) throw new Error("RAIL12306_SERVER_DATE_UNAVAILABLE");
    const data = { server_time: new Date(header).toISOString() };
    return this.observation(INIT_PATH, response, data);
  }

  private async ensureInitialized() { if (!this.initialized) await this.initialize(); }

  private async get(pathWithQuery: string, includeReferer = true): Promise<HttpReadResponse> {
    const url = new URL(pathWithQuery, KYFW_ORIGIN);
    if (url.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_READ_ONLY_ORIGIN_BLOCKED");
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 PersonalMCP-ReadOnlyProbe/1.0",
      Accept: "application/json,text/javascript,*/*;q=0.8",
      ...(includeReferer ? { Referer: REFERER, "X-Requested-With": "XMLHttpRequest" } : {}),
    };
    const cookie = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) headers.Cookie = cookie;
    const response = await this.transport.get(url.toString(), headers);
    this.captureCookies(response.headers);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (typeof location !== "string") throw new Error("RAIL12306_REDIRECT_WITHOUT_LOCATION");
      const redirected = new URL(location, url);
      if (redirected.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_CROSS_ORIGIN_REDIRECT_BLOCKED");
      const redirectedResponse = await this.transport.get(redirected.toString(), headers);
      this.captureCookies(redirectedResponse.headers);
      return redirectedResponse;
    }
    return response;
  }

  private captureCookies(headers: HttpReadResponse["headers"]) {
    for (const raw of setCookieHeaders(headers)) {
      const first = raw.split(";", 1)[0] ?? "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      const value = first.slice(separator + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  private assertOk(response: HttpReadResponse, code: string) {
    if (response.status < 200 || response.status >= 300) throw new Error(`${code}:${response.status}`);
  }

  private observation<T>(endpoint: string, response: HttpReadResponse, data: T): ReadOnlyObservation<T> {
    return {
      observed_at: new Date().toISOString(),
      endpoint,
      http_status: response.status,
      ...(dateHeader(response.headers) ? { server_date: dateHeader(response.headers) } : {}),
      schema_fingerprint: schemaFingerprint(data),
      data,
    };
  }
}

function sanitizePendingOrder(order: PendingOrder): PendingOrder {
  return {
    order_id: order.order_id,
    ...(order.task_id ? { task_id: order.task_id } : {}),
    status: order.status,
    ...(order.travel_date ? { travel_date: order.travel_date } : {}),
    ...(order.train_code ? { train_code: order.train_code } : {}),
    ...(order.origin ? { origin: order.origin } : {}),
    ...(order.destination ? { destination: order.destination } : {}),
    ...(order.passenger_refs ? { passenger_refs: [...order.passenger_refs] } : {}),
    ...(order.seat_classes ? { seat_classes: [...order.seat_classes] } : {}),
    ...(typeof order.quantity === "number" ? { quantity: order.quantity } : {}),
    ...(typeof order.amount === "number" ? { amount: order.amount } : {}),
    ...(order.payment_deadline ? { payment_deadline: order.payment_deadline } : {}),
    redacted: true,
  };
}

export class Real12306ReadOnlyAdapter implements ReadOnly12306Adapter {
  readonly publicClient: Rail12306PublicReadClient;
  private readonly authenticated?: AuthenticatedReadOnlyProvider;

  constructor(options: { transport?: ReadOnlyHttpTransport; authenticated?: AuthenticatedReadOnlyProvider } = {}) {
    this.publicClient = new Rail12306PublicReadClient(options.transport);
    this.authenticated = options.authenticated;
  }

  async sessionState(): Promise<ReadOnlySessionState> {
    return this.authenticated ? this.authenticated.sessionState() : "AUTH_REQUIRED";
  }

  async readPendingOrders(): Promise<PendingOrder[]> {
    if (!this.authenticated) throw new Error("AUTH_REQUIRED");
    const state = await this.authenticated.sessionState();
    if (state !== "READY") throw new Error(state);
    const orders = await this.authenticated.readPendingOrders();
    return orders.map(sanitizePendingOrder);
  }

  async readPassengers(): Promise<PassengerAlias[]> {
    if (!this.authenticated) throw new Error("AUTH_REQUIRED");
    const state = await this.authenticated.sessionState();
    if (state !== "READY") throw new Error(state);
    const aliases = await this.authenticated.readPassengers();
    return aliases.map(item => ({ passenger_ref: item.passenger_ref, ...(item.passenger_type ? { passenger_type: item.passenger_type } : {}) }));
  }

  initializePublic() { return this.publicClient.initialize(); }
  listStations() { return this.publicClient.listStations(); }
  resolveStation(query: string) { return this.publicClient.resolveStation(query); }
  queryTrains(input: Parameters<Rail12306PublicReadClient["queryTrains"]>[0]) { return this.publicClient.queryTrains(input); }
  readServerClock() { return this.publicClient.observeServerClock(); }

  submitOrder(): never { throw new Error(TICKET_CAPABILITY_NOT_AVAILABLE); }
  confirmSingleForQueue(): never { throw new Error(TICKET_CAPABILITY_NOT_AVAILABLE); }
  payOrder(): never { throw new Error(TICKET_CAPABILITY_NOT_AVAILABLE); }
}
