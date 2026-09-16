import type { PassengerAlias, ReadOnlySessionState } from "./real12306-readonly.ts";
import type { PendingOrder } from "../src/ticket/contracts.ts";
import {
  Rail12306LocalAuthenticatedProvider,
  type LocalSessionHttpResponse,
  type LocalSessionHttpTransport,
} from "./12306-local-auth-readonly.ts";

const KYFW_ORIGIN = "https://kyfw.12306.cn";
const REFERER = `${KYFW_ORIGIN}/otn/leftTicket/init?linktypeid=dc`;

const MOBILE_AUTH_GET_PATHS = new Set([
  "/otn/login/conf",
  "/otn/index12306/getLoginBanner",
  "/passport/web/auth/uamtk-static",
]);

const MOBILE_AUTH_POST_PATHS = new Set([
  "/passport/web/login",
  "/passport/web/auth/uamtk",
  "/otn/uamauthclient",
  "/otn/login/checkUser",
  "/otn/confirmPassenger/getPassengerDTOs",
  "/otn/queryOrder/queryMyOrderNoComplete",
]);

export type AccountLoginState =
  | "READY"
  | "INVALID_CREDENTIALS"
  | "SMS_REQUIRED"
  | "APP_CONFIRM_REQUIRED"
  | "SLIDER_REQUIRED"
  | "OFFLINE_IDENTITY_REQUIRED"
  | "HUMAN_ACTION_REQUIRED";

export type AccountLoginResult = {
  state: AccountLoginState;
  session_state: ReadOnlySessionState;
  retryable: boolean;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(body: string, code: string): JsonObject {
  try {
    const value = JSON.parse(body);
    if (!isObject(value)) throw new Error(code);
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    throw new Error(code);
  }
}

function responseText(payload: JsonObject): string {
  const values: string[] = [];
  for (const key of ["result_message", "message", "msg"]) {
    if (typeof payload[key] === "string") values.push(payload[key] as string);
  }
  if (Array.isArray(payload.messages)) {
    for (const value of payload.messages) if (typeof value === "string") values.push(value);
  }
  return values.join(" ");
}

export function classifyAccountLoginResponse(payload: unknown): AccountLoginState {
  if (!isObject(payload)) return "HUMAN_ACTION_REQUIRED";
  if (String(payload.result_code ?? "") === "0") return "READY";

  const text = responseText(payload);
  if (/线下窗口|身份信息有问题|线下.*核验/.test(text)) return "OFFLINE_IDENTITY_REQUIRED";
  if (/十分钟内.*12306APP|APP.*登录核验|使用12306APP.*核验/.test(text)) return "APP_CONFIRM_REQUIRED";
  if (/滑动验证|滑块|滑动.*验证码/.test(text)) return "SLIDER_REQUIRED";
  if (/手机验证|短信|动态身份验证码|发短信.*12306/.test(text)) return "SMS_REQUIRED";
  if (/用户名或密码.*错误|登录名不存在|密码输入错误|密码错误|用户名.*错误/.test(text)) return "INVALID_CREDENTIALS";
  return "HUMAN_ACTION_REQUIRED";
}

function resultFor(state: AccountLoginState): AccountLoginResult {
  return {
    state,
    session_state: state === "READY" ? "READY" : state === "INVALID_CREDENTIALS" ? "AUTH_REQUIRED" : "HUMAN_ACTION_REQUIRED",
    retryable: state === "INVALID_CREDENTIALS",
  };
}

/**
 * Session transport for an iPhone-facing account-login bridge.
 * It permits authentication and authenticated READ_ONLY endpoints only.
 * Consequential ticket/order/payment endpoints are structurally absent.
 */
export class MobileAccountSessionHttpTransport implements LocalSessionHttpTransport {
  private readonly cookies = new Map<string, string>();

  async request(method: "GET" | "POST", path: string, form: Record<string, string> = {}): Promise<LocalSessionHttpResponse> {
    const allowed = method === "GET" ? MOBILE_AUTH_GET_PATHS : MOBILE_AUTH_POST_PATHS;
    if (!allowed.has(path)) throw new Error("RAIL12306_MOBILE_AUTH_PATH_BLOCKED");

    const url = new URL(path, KYFW_ORIGIN);
    if (url.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_MOBILE_AUTH_ORIGIN_BLOCKED");
    const cookie = Array.from(this.cookies, ([name, value]) => `${name}=${value}`).join("; ");
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 PersonalMCP-MobileReadOnly/1.0",
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
      throw new Error(`RAIL12306_MOBILE_AUTH_NETWORK_ERROR${typeof code === "string" ? `:${code}` : ""}`);
    }

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
    for (const raw of setCookies) this.captureCookie(raw);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("RAIL12306_MOBILE_AUTH_REDIRECT_WITHOUT_LOCATION");
      const redirected = new URL(location, url);
      if (redirected.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_MOBILE_AUTH_CROSS_ORIGIN_REDIRECT_BLOCKED");
      if (redirected.pathname !== path) throw new Error("RAIL12306_MOBILE_AUTH_UNEXPECTED_REDIRECT_BLOCKED");
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

/**
 * Account/password login for a mobile-only user. Credentials are consumed as
 * transient method arguments and are never stored on the object. JavaScript
 * cannot guarantee deterministic zeroization of immutable strings, so the host
 * must also disable request-body logging and must never persist the form body.
 */
export class Rail12306MobileAccountAuth {
  private readonly transport: LocalSessionHttpTransport;
  private readonly readOnly: Rail12306LocalAuthenticatedProvider;

  constructor(options: { aliasKey: string; transport?: LocalSessionHttpTransport }) {
    this.transport = options.transport ?? new MobileAccountSessionHttpTransport();
    this.readOnly = new Rail12306LocalAuthenticatedProvider({ aliasKey: options.aliasKey, transport: this.transport });
  }

  async login(username: string, password: string): Promise<AccountLoginResult> {
    if (!username.trim() || !password) throw new Error("RAIL12306_CREDENTIALS_REQUIRED");

    const response = await this.transport.request("POST", "/passport/web/login", {
      username,
      password,
      appid: "otn",
      _json_att: "",
    });
    if (response.status === 401 || response.status === 403) return resultFor("INVALID_CREDENTIALS");
    if (response.status < 200 || response.status >= 300) throw new Error(`RAIL12306_ACCOUNT_LOGIN_HTTP_ERROR:${response.status}`);

    const payload = parseJson(response.body, "RAIL12306_ACCOUNT_LOGIN_SCHEMA_DRIFT");
    const state = classifyAccountLoginResponse(payload);
    if (state !== "READY") return resultFor(state);

    await this.completeLogin();
    const session = await this.readOnly.sessionState();
    return session === "READY" ? resultFor("READY") : resultFor("HUMAN_ACTION_REQUIRED");
  }

  async refreshSession(): Promise<ReadOnlySessionState> { return this.readOnly.sessionState(); }
  async readPassengers(): Promise<PassengerAlias[]> { return this.readOnly.readPassengers(); }
  async readPendingOrders(): Promise<PendingOrder[]> { return this.readOnly.readPendingOrders(); }

  private async completeLogin() {
    const tokenResponse = await this.transport.request("POST", "/passport/web/auth/uamtk", { appid: "otn" });
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) throw new Error(`RAIL12306_UAMTK_HTTP_ERROR:${tokenResponse.status}`);
    const tokenPayload = parseJson(tokenResponse.body, "RAIL12306_UAMTK_SCHEMA_DRIFT");
    if (String(tokenPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMTK_REJECTED");
    const token = typeof tokenPayload.newapptk === "string" && tokenPayload.newapptk ? tokenPayload.newapptk : undefined;
    if (!token) throw new Error("RAIL12306_UAMTK_SCHEMA_DRIFT");

    const clientResponse = await this.transport.request("POST", "/otn/uamauthclient", { tk: token });
    if (clientResponse.status < 200 || clientResponse.status >= 300) throw new Error(`RAIL12306_UAMAUTH_HTTP_ERROR:${clientResponse.status}`);
    const clientPayload = parseJson(clientResponse.body, "RAIL12306_UAMAUTH_SCHEMA_DRIFT");
    if (String(clientPayload.result_code ?? "") !== "0") throw new Error("RAIL12306_UAMAUTH_REJECTED");
  }
}

export type MobileAuthChallengeState = "PENDING" | AccountLoginState | "EXPIRED" | "LOCKED";
export type MobileAuthChallenge = {
  challenge_id: string;
  expires_at: string;
  state: MobileAuthChallengeState;
  attempts: number;
};

type ChallengeRecord = {
  challenge_id: string;
  expires_at_ms: number;
  state: MobileAuthChallengeState;
  attempts: number;
};

/**
 * Host-neutral one-time challenge state. It stores only opaque challenge
 * metadata, never username/password/ID/SMS code. An HTTP/UI layer can wrap this
 * later once a deployment target is selected.
 */
export class Mobile12306AuthChallengeStore {
  private readonly records = new Map<string, ChallengeRecord>();
  private readonly auth: Rail12306MobileAccountAuth;
  private readonly maxAttempts: number;

  constructor(auth: Rail12306MobileAccountAuth, options: { maxAttempts?: number } = {}) {
    this.auth = auth;
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? 3, 1), 5);
  }

  create(ttlMs = 5 * 60_000): MobileAuthChallenge {
    const boundedTtl = Math.min(Math.max(ttlMs, 30_000), 10 * 60_000);
    const record: ChallengeRecord = {
      challenge_id: crypto.randomUUID(),
      expires_at_ms: Date.now() + boundedTtl,
      state: "PENDING",
      attempts: 0,
    };
    this.records.set(record.challenge_id, record);
    return this.publicView(record);
  }

  status(challengeId: string): MobileAuthChallenge {
    return this.publicView(this.requireRecord(challengeId));
  }

  async submitPassword(challengeId: string, username: string, password: string): Promise<AccountLoginResult> {
    const record = this.requireRecord(challengeId);
    if (record.state === "LOCKED") throw new Error("RAIL12306_AUTH_CHALLENGE_LOCKED");
    if (record.state !== "PENDING" && record.state !== "INVALID_CREDENTIALS") throw new Error("RAIL12306_AUTH_CHALLENGE_NOT_ACCEPTING_CREDENTIALS");
    if (record.attempts >= this.maxAttempts) {
      record.state = "LOCKED";
      throw new Error("RAIL12306_AUTH_CHALLENGE_LOCKED");
    }

    record.attempts += 1;
    const result = await this.auth.login(username, password);
    record.state = result.state;
    if (result.state === "INVALID_CREDENTIALS" && record.attempts >= this.maxAttempts) record.state = "LOCKED";
    return result;
  }

  async refresh(challengeId: string): Promise<MobileAuthChallenge> {
    const record = this.requireRecord(challengeId);
    if (["APP_CONFIRM_REQUIRED", "SMS_REQUIRED", "SLIDER_REQUIRED", "HUMAN_ACTION_REQUIRED"].includes(record.state)) {
      if (await this.auth.refreshSession() === "READY") record.state = "READY";
    }
    return this.publicView(record);
  }

  private requireRecord(challengeId: string): ChallengeRecord {
    const record = this.records.get(challengeId);
    if (!record) throw new Error("RAIL12306_AUTH_CHALLENGE_NOT_FOUND");
    if (record.expires_at_ms <= Date.now() && record.state !== "READY") record.state = "EXPIRED";
    if (record.state === "EXPIRED") throw new Error("RAIL12306_AUTH_CHALLENGE_EXPIRED");
    return record;
  }

  private publicView(record: ChallengeRecord): MobileAuthChallenge {
    return {
      challenge_id: record.challenge_id,
      expires_at: new Date(record.expires_at_ms).toISOString(),
      state: record.state,
      attempts: record.attempts,
    };
  }
}
