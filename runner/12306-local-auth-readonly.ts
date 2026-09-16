import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import type { PendingOrder } from "../src/ticket/contracts.ts";
import type { AuthenticatedReadOnlyProvider, PassengerAlias, ReadOnlySessionState } from "./real12306-readonly.ts";

const KYFW_ORIGIN = "https://kyfw.12306.cn";
const REFERER = `${KYFW_ORIGIN}/otn/leftTicket/init?linktypeid=dc`;

const READ_ONLY_GET_PATHS = new Set([
  "/otn/login/conf",
  "/otn/index12306/getLoginBanner",
  "/passport/web/auth/uamtk-static",
]);

const READ_ONLY_POST_PATHS = new Set([
  "/otn/login/checkUser",
  "/passport/web/create-qr64",
  "/passport/web/checkqr",
  "/passport/web/auth/uamtk",
  "/otn/uamauthclient",
  "/otn/confirmPassenger/getPassengerDTOs",
  "/otn/queryOrder/queryMyOrderNoComplete",
]);

export type LocalSessionHttpResponse = {
  status: number;
  body: string;
  headers?: Record<string, string | string[] | undefined>;
};

export interface LocalSessionHttpTransport {
  request(method: "GET" | "POST", path: string, form?: Record<string, string>): Promise<LocalSessionHttpResponse>;
}

function setCookieHeaders(headers: LocalSessionHttpResponse["headers"]): string[] {
  const value = headers?.["set-cookie"];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

export class FetchLocalSessionHttpTransport implements LocalSessionHttpTransport {
  private readonly cookies = new Map<string, string>();

  async request(method: "GET" | "POST", path: string, form: Record<string, string> = {}): Promise<LocalSessionHttpResponse> {
    const allowed = method === "GET" ? READ_ONLY_GET_PATHS : READ_ONLY_POST_PATHS;
    if (!allowed.has(path)) throw new Error("RAIL12306_AUTH_READ_ONLY_PATH_BLOCKED");

    const url = new URL(path, KYFW_ORIGIN);
    if (url.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_AUTH_READ_ONLY_ORIGIN_BLOCKED");
    const cookie = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 PersonalMCP-LocalReadOnly/1.0",
      Accept: "application/json,text/javascript,*/*;q=0.8",
      Referer: REFERER,
      Origin: KYFW_ORIGIN,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        redirect: "manual",
        ...(method === "POST" ? { body: new URLSearchParams(form) } : {}),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      throw new Error(`RAIL12306_AUTH_NETWORK_ERROR${typeof code === "string" ? `:${code}` : ""}`);
    }

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
    for (const raw of setCookies) this.captureCookie(raw);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("RAIL12306_AUTH_REDIRECT_WITHOUT_LOCATION");
      const redirected = new URL(location, url);
      if (redirected.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_AUTH_CROSS_ORIGIN_REDIRECT_BLOCKED");
      if (redirected.pathname !== path) throw new Error("RAIL12306_AUTH_UNEXPECTED_REDIRECT_BLOCKED");
    }

    return {
      status: response.status,
      headers: { "set-cookie": setCookies, date: response.headers.get("date") ?? undefined },
      body: await response.text(),
    };
  }

  private captureCookie(raw: string) {
    const first = raw.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) return;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (name) this.cookies.set(name, value);
  }
}

export type QrLoginChallenge = {
  qr_file: string;
  uuid: string;
  expires_at: string;
};

export type QrLoginStatus = "WAITING" | "SCANNED" | "CONFIRMED" | "EXPIRED";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonObject;
}

function parseJson(body: string, code: string): JsonObject {
  try { return asObject(JSON.parse(body), code); }
  catch (error) { if (error instanceof Error && error.message === code) throw error; throw new Error(code); }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as JsonObject[] : [];
}

function firstString(object: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizedDate(value?: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/(\d{4})[-年/]?(\d{2})[-月/]?(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function explicitPaymentState(order: JsonObject, tickets: JsonObject[]): PendingOrder["status"] {
  const texts = [
    firstString(order, ["ticket_status_name", "order_status_name", "statusName", "status_name", "order_status"]),
    ...tickets.map(ticket => firstString(ticket, ["ticket_status_name", "status_name", "statusName", "ticket_status"])),
  ].filter(Boolean).join(" ");
  return /待支付|未支付|等待支付|支付未完成/.test(texts) ? "WAITING_FOR_PAYMENT" : "UNKNOWN";
}

export function extractNoCompleteOrderList(payload: unknown): JsonObject[] {
  const root = asObject(payload, "RAIL12306_PENDING_SCHEMA_DRIFT");
  if (root.status !== true) throw new Error("RAIL12306_PENDING_QUERY_REJECTED");
  const data = root.data;
  if (Array.isArray(data)) return arrayValue(data);
  const dataObject = asObject(data, "RAIL12306_PENDING_SCHEMA_DRIFT");
  for (const key of ["orderDBList", "orderDTODataList", "orders"]) {
    if (Array.isArray(dataObject[key])) return arrayValue(dataObject[key]);
  }
  throw new Error("RAIL12306_PENDING_SCHEMA_DRIFT");
}

export function redactNoCompleteOrders(payload: unknown, passengerAliases: ReadonlyMap<string, string>): PendingOrder[] {
  return extractNoCompleteOrderList(payload).map(order => {
    const tickets = arrayValue(order.tickets);
    const refs = tickets.map(ticket => firstString(ticket, ["passenger_name", "passengerName"]))
      .filter((name): name is string => !!name)
      .map(name => passengerAliases.get(name))
      .filter((ref): ref is string => !!ref);
    const allPassengerNamesMapped = tickets.length > 0 && refs.length === tickets.length;
    const seatClasses = [...new Set(tickets.map(ticket => firstString(ticket, ["seat_type_name", "seatTypeName"]))
      .filter((seat): seat is string => !!seat))];
    const paymentDeadline = firstString(order, ["payment_deadline", "pay_deadline", "lose_time"]);
    const amount = numericValue(order.ticket_total_price_page ?? order.ticket_total_price ?? order.total_price);

    return {
      order_id: firstString(order, ["sequence_no", "order_id", "sequenceNo"]) ?? "UNKNOWN_ORDER_ID",
      status: explicitPaymentState(order, tickets),
      ...(normalizedDate(firstString(order, ["start_train_date_page", "start_train_date", "train_date"])) ? { travel_date: normalizedDate(firstString(order, ["start_train_date_page", "start_train_date", "train_date"])) } : {}),
      ...(firstString(order, ["train_code_page", "station_train_code", "train_code"]) ? { train_code: firstString(order, ["train_code_page", "station_train_code", "train_code"]) } : {}),
      ...(firstString(order, ["from_station_name_page", "from_station_name"]) ? { origin: firstString(order, ["from_station_name_page", "from_station_name"]) } : {}),
      ...(firstString(order, ["to_station_name_page", "to_station_name"]) ? { destination: firstString(order, ["to_station_name_page", "to_station_name"]) } : {}),
      ...(allPassengerNamesMapped ? { passenger_refs: [...new Set(refs)] } : {}),
      ...(seatClasses.length ? { seat_classes: seatClasses } : {}),
      ...(tickets.length ? { quantity: tickets.length } : {}),
      ...(typeof amount === "number" ? { amount } : {}),
      ...(paymentDeadline && /\d{4}.*\d{2}.*\d{2}/.test(paymentDeadline) ? { payment_deadline: paymentDeadline } : {}),
      redacted: true,
    };
  });
}

export class Rail12306LocalAuthenticatedProvider implements AuthenticatedReadOnlyProvider {
  private readonly transport: LocalSessionHttpTransport;
  private readonly aliasKey: string;
  private readonly passengerAliasesByName = new Map<string, string>();

  constructor(options: { aliasKey: string; transport?: LocalSessionHttpTransport }) {
    if (!options.aliasKey || options.aliasKey.length < 16) throw new Error("RAIL12306_ALIAS_KEY_REQUIRED");
    this.aliasKey = options.aliasKey;
    this.transport = options.transport ?? new FetchLocalSessionHttpTransport();
  }

  async sessionState(): Promise<ReadOnlySessionState> {
    const response = await this.transport.request("POST", "/otn/login/checkUser", { _json_att: "" });
    if (response.status === 401 || response.status === 403) return "AUTH_REQUIRED";
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_SESSION_HTTP_ERROR:${response.status}`);
    const payload = parseJson(response.body, "RAIL12306_SESSION_SCHEMA_DRIFT");
    const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data as JsonObject : {};
    return data.flag === true ? "READY" : "AUTH_REQUIRED";
  }

  async beginQrLogin(outputPath = join(tmpdir(), "personal-mcp-12306-login-qr.png"), timeoutMs = 120_000): Promise<QrLoginChallenge> {
    for (const path of READ_ONLY_GET_PATHS) {
      try { await this.transport.request("GET", path); } catch { /* prefetch is best-effort only */ }
    }
    const response = await this.transport.request("POST", "/passport/web/create-qr64", { appid: "otn" });
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_QR_HTTP_ERROR:${response.status}`);
    const payload = parseJson(response.body, "RAIL12306_QR_SCHEMA_DRIFT");
    if (String(payload.result_code ?? "") !== "0") throw new Error("RAIL12306_QR_CREATE_REJECTED");
    const image = stringValue(payload.image);
    const uuid = stringValue(payload.uuid);
    if (!image || !uuid) throw new Error("RAIL12306_QR_SCHEMA_DRIFT");
    let bytes: Buffer;
    try { bytes = Buffer.from(image, "base64"); } catch { throw new Error("RAIL12306_QR_IMAGE_INVALID"); }
    if (!bytes.length) throw new Error("RAIL12306_QR_IMAGE_INVALID");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, bytes, { mode: 0o600 });
    return { qr_file: outputPath, uuid, expires_at: new Date(Date.now() + timeoutMs).toISOString() };
  }

  async qrStatus(uuid: string): Promise<QrLoginStatus> {
    const response = await this.transport.request("POST", "/passport/web/checkqr", { uuid, appid: "otn" });
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_QR_STATUS_HTTP_ERROR:${response.status}`);
    const payload = parseJson(response.body, "RAIL12306_QR_STATUS_SCHEMA_DRIFT");
    const code = String(payload.result_code ?? "");
    if (code === "0") return "WAITING";
    if (code === "1") return "SCANNED";
    if (code === "2") return "CONFIRMED";
    if (code === "3") return "EXPIRED";
    throw new Error("RAIL12306_QR_STATUS_UNKNOWN");
  }

  async waitForQrConfirmation(uuid: string, options: { timeoutMs?: number; pollMs?: number } = {}): Promise<"READY"> {
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 120_000, 5_000), 180_000);
    const pollMs = Math.min(Math.max(options.pollMs ?? 2_000, 500), 5_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.qrStatus(uuid);
      if (status === "EXPIRED") throw new Error("RAIL12306_QR_EXPIRED");
      if (status === "CONFIRMED") {
        await this.completeLogin();
        if (await this.sessionState() !== "READY") throw new Error("RAIL12306_LOGIN_NOT_READY");
        return "READY";
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new Error("RAIL12306_QR_TIMEOUT");
  }

  async readPassengers(): Promise<PassengerAlias[]> {
    await this.requireReady();
    const response = await this.transport.request("POST", "/otn/confirmPassenger/getPassengerDTOs", { _json_att: "" });
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_PASSENGER_HTTP_ERROR:${response.status}`);
    const payload = parseJson(response.body, "RAIL12306_PASSENGER_SCHEMA_DRIFT");
    const data = asObject(payload.data, "RAIL12306_PASSENGER_SCHEMA_DRIFT");
    if (!Array.isArray(data.normal_passengers)) throw new Error("RAIL12306_PASSENGER_SCHEMA_DRIFT");
    const aliases: PassengerAlias[] = [];
    for (const passenger of arrayValue(data.normal_passengers)) {
      const name = firstString(passenger, ["passenger_name", "passengerName"]);
      const id = firstString(passenger, ["passenger_id_no", "passengerIdNo", "id_no"]);
      const idType = firstString(passenger, ["passenger_id_type_code", "passengerIdTypeCode", "id_type_code"]) ?? "unknown";
      if (!name || !id) continue;
      const passengerRef = `psg_${createHmac("sha256", this.aliasKey).update(`${idType}:${id}`).digest("hex").slice(0, 24)}`;
      this.passengerAliasesByName.set(name, passengerRef);
      aliases.push({ passenger_ref: passengerRef, ...(firstString(passenger, ["passenger_type", "passengerType"]) ? { passenger_type: firstString(passenger, ["passenger_type", "passengerType"]) } : {}) });
    }
    return aliases;
  }

  async readPendingOrders(): Promise<PendingOrder[]> {
    await this.requireReady();
    if (this.passengerAliasesByName.size === 0) await this.readPassengers();
    const response = await this.transport.request("POST", "/otn/queryOrder/queryMyOrderNoComplete", { _json_att: "" });
    if (response.status === 401 || response.status === 403) throw new Error("AUTH_REQUIRED");
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_PENDING_HTTP_ERROR:${response.status}`);
    const payload = parseJson(response.body, "RAIL12306_PENDING_SCHEMA_DRIFT");
    return redactNoCompleteOrders(payload, this.passengerAliasesByName);
  }

  private async completeLogin() {
    const tokenResponse = await this.transport.request("POST", "/passport/web/auth/uamtk", { appid: "otn" });
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) throw new Error(`RAIL12306_UAMTK_HTTP_ERROR:${tokenResponse.status}`);
    const tokenPayload = parseJson(tokenResponse.body, "RAIL12306_UAMTK_SCHEMA_DRIFT");
    if (String(tokenPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMTK_REJECTED");
    const token = stringValue(tokenPayload.newapptk);
    if (!token) throw new Error("RAIL12306_UAMTK_SCHEMA_DRIFT");

    const clientResponse = await this.transport.request("POST", "/otn/uamauthclient", { tk: token });
    if (clientResponse.status < 200 || clientResponse.status >= 300) throw new Error(`RAIL12306_UAMAUTH_HTTP_ERROR:${clientResponse.status}`);
    const clientPayload = parseJson(clientResponse.body, "RAIL12306_UAMAUTH_SCHEMA_DRIFT");
    if (String(clientPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMAUTH_REJECTED");
  }

  private async requireReady() {
    const state = await this.sessionState();
    if (state !== "READY") throw new Error(state);
  }
}

export function defaultLocalQrPath() { return join(tmpdir(), "personal-mcp-12306-login-qr.png"); }
