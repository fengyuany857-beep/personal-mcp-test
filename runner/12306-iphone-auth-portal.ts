import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PendingOrder } from "../src/ticket/contracts.ts";
import type { PassengerAlias, ReadOnlySessionState } from "./real12306-readonly.ts";
import {
  Mobile12306AuthChallengeStore,
  Rail12306MobileAccountAuth,
  type AccountLoginResult,
  type MobileAuthChallenge,
  type SmsCodeRequestResult,
} from "./12306-mobile-auth.ts";
import type { LocalSessionHttpResponse, LocalSessionHttpTransport } from "./12306-local-auth-readonly.ts";
import type { PersistableLocalSessionTransport } from "./12306-session-persistence.ts";

const KYFW_ORIGIN = "https://kyfw.12306.cn";
const REFERER = `${KYFW_ORIGIN}/otn/leftTicket/init?linktypeid=dc`;
const MAX_BODY_BYTES = 8 * 1024;

const MOBILE_GET_PATHS = new Set([
  "/otn/login/conf",
  "/otn/index12306/getLoginBanner",
  "/passport/web/auth/uamtk-static",
]);

const MOBILE_POST_PATHS = new Set([
  "/passport/web/checkLoginVerify",
  "/passport/web/slide-passcode",
  "/passport/web/getMessageCode",
  "/passport/web/login",
  "/passport/web/auth/uamtk",
  "/otn/uamauthclient",
  "/otn/login/checkUser",
  "/otn/confirmPassenger/getPassengerDTOs",
  "/otn/queryOrder/queryMyOrderNoComplete",
]);

type JsonObject = Record<string, unknown>;

type MobileChallengeLike = {
  create(ttlMs?: number): MobileAuthChallenge;
  status(challengeId: string): MobileAuthChallenge;
  submitPassword(challengeId: string, username: string, password: string): Promise<AccountLoginResult>;
  requestSms(challengeId: string, username: string, idSuffix4: string): Promise<SmsCodeRequestResult>;
  submitSms(challengeId: string, username: string, password: string, smsCode: string): Promise<AccountLoginResult>;
  refresh(challengeId: string): Promise<MobileAuthChallenge>;
};

export type IphoneAuthPortalOptions = {
  accessCodeHash: string;
  aliasKey?: string;
  transport?: PersistableLocalSessionTransport;
  mobileChallenges?: MobileChallengeLike;
  clearSession?: () => void;
  restoreSession: () => Promise<ReadOnlySessionState>;
  persistReadySession: () => Promise<"READY">;
  readPassengers: () => Promise<PassengerAlias[]>;
  readPendingOrders: () => Promise<PendingOrder[]>;
};

export type IphoneAuthPortal = {
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean>;
};

function secureHeaders(contentType: string): Record<string, string> {
  return {
    "content-type": contentType,
    "cache-control": "no-store, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
  };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...secureHeaders("application/json; charset=utf-8"),
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...secureHeaders("text/html; charset=utf-8"),
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw new Error("INVALID_JSON_BODY");
  }
}

function requiredString(body: JsonObject, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value.trim();
}

function secretString(body: JsonObject, key: string, maxLength: number): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > maxLength) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value;
}

function accessAuthorized(body: JsonObject, expectedHash: Buffer): boolean {
  const value = typeof body.access_code === "string" ? body.access_code : "";
  const actual = createHash("sha256").update(value).digest();
  return value.length >= 20 && timingSafeEqual(actual, expectedHash);
}

function safeError(error: unknown): string {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  if (/^(?:RAIL12306_[A-Z0-9_]+|AUTH_REQUIRED|INVALID_[A-Z0-9_]+|REQUEST_BODY_TOO_LARGE)(?::[A-Z0-9_.-]+)?$/.test(code)) return code;
  return "INTERNAL_ERROR";
}

function captureCookies(headers: LocalSessionHttpResponse["headers"], target: PersistableLocalSessionTransport): void {
  const raw = headers?.["set-cookie"];
  const values = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  const next = { ...target.exportSessionCookies() };
  for (const item of values) {
    const first = item.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const name = first.slice(0, separator).trim();
    const value = first.slice(separator + 1).trim();
    if (!name) continue;
    if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(item)) delete next[name];
    else next[name] = value;
  }
  target.importSessionCookies(next);
}

/**
 * Mobile-login transport with no independent cookie jar. Every request reads
 * from and writes back to the canonical cloud transport, so the existing
 * AES-256-GCM session controller persists the exact authenticated cookie state.
 */
export class SharedCookieMobileTransport implements LocalSessionHttpTransport {
  private readonly shared: PersistableLocalSessionTransport;
  private readonly fetchImpl: typeof fetch;

  constructor(shared: PersistableLocalSessionTransport, fetchImpl: typeof fetch = fetch) {
    this.shared = shared;
    this.fetchImpl = fetchImpl;
  }

  async request(method: "GET" | "POST", path: string, form: Record<string, string> = {}): Promise<LocalSessionHttpResponse> {
    const allowed = method === "GET" ? MOBILE_GET_PATHS : MOBILE_POST_PATHS;
    if (!allowed.has(path)) throw new Error("RAIL12306_IPHONE_AUTH_PATH_BLOCKED");

    const url = new URL(path, KYFW_ORIGIN);
    if (url.origin !== KYFW_ORIGIN) throw new Error("RAIL12306_IPHONE_AUTH_ORIGIN_BLOCKED");
    const cookies = this.shared.exportSessionCookies();
    const cookie = Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; ");
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 PersonalMCP-iPhoneReadOnly/1.0",
      Accept: "application/json,text/javascript,*/*;q=0.8",
      Referer: REFERER,
      Origin: KYFW_ORIGIN,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        ...(method === "POST" ? { body: new URLSearchParams(form) } : {}),
      });
    } catch (error) {
      const code = (error as { cause?: { code?: unknown } }).cause?.code;
      throw new Error(`RAIL12306_IPHONE_AUTH_NETWORK_ERROR${typeof code === "string" ? `:${code}` : ""}`);
    }

    const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === "function" ? getSetCookie.call(response.headers) : [];
    const result: LocalSessionHttpResponse = {
      status: response.status,
      headers: { "set-cookie": setCookies, date: response.headers.get("date") ?? undefined },
      body: await response.text(),
    };
    captureCookies(result.headers, this.shared);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("RAIL12306_IPHONE_AUTH_REDIRECT_WITHOUT_LOCATION");
      const redirected = new URL(location, url);
      if (redirected.origin !== KYFW_ORIGIN || redirected.pathname !== path) {
        throw new Error("RAIL12306_IPHONE_AUTH_REDIRECT_BLOCKED");
      }
    }
    return result;
  }
}

async function readySummary(options: IphoneAuthPortalOptions): Promise<Record<string, unknown>> {
  await options.persistReadySession();
  const [passengers, orders] = await Promise.all([options.readPassengers(), options.readPendingOrders()]);
  return {
    state: "READY",
    session_persisted: true,
    passenger_count: passengers.length,
    pending_order_count: orders.length,
    submit_capability: false,
    payment_capability: false,
  };
}

function page(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>12306 安全登录</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color-scheme:light dark}body{margin:0;background:#f5f5f7;color:#1d1d1f}.wrap{max-width:520px;margin:0 auto;padding:32px 18px 64px}.card{background:#fff;border-radius:22px;padding:22px;box-shadow:0 8px 30px #00000012}h1{font-size:25px;margin:0 0 8px}.sub{font-size:14px;color:#6e6e73;line-height:1.5;margin-bottom:20px}label{display:block;font-size:13px;margin:12px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:13px 14px;border:1px solid #d2d2d7;border-radius:12px;background:#fff;color:#111}button{width:100%;margin-top:14px;border:0;border-radius:12px;padding:13px 15px;font-size:16px;font-weight:600;background:#0071e3;color:#fff}.secondary{background:#e8e8ed;color:#1d1d1f}.hidden{display:none}.status{margin-top:18px;padding:14px;border-radius:12px;background:#f5f5f7;font-size:14px;white-space:pre-wrap;line-height:1.5}.warn{color:#b54708}.ok{color:#137333}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}.card{background:#1c1c1e}.sub{color:#a1a1a6}input{background:#2c2c2e;color:#fff;border-color:#48484a}.secondary,.status{background:#2c2c2e;color:#fff}}
</style></head><body><div class="wrap"><div class="card"><h1>12306 安全登录</h1><div class="sub">凭据只提交到你自己的 Railway 服务，不发送给 ChatGPT。此页面只能建立 READ_ONLY 会话，不含下单或支付能力。</div>
<label>访问码</label><input id="access" type="password" autocomplete="off" autocapitalize="off">
<label>12306 用户名</label><input id="username" autocomplete="username" autocapitalize="off">
<label>12306 密码</label><input id="password" type="password" autocomplete="current-password">
<button id="login">开始登录</button>
<div id="sms" class="hidden"><label>身份证件后四位</label><input id="suffix" maxlength="4" autocomplete="off"><button id="sendSms" class="secondary">获取短信验证码</button><label>短信验证码</label><input id="smsCode" inputmode="numeric" autocomplete="one-time-code"><button id="submitSms">提交验证码</button></div>
<div id="app" class="hidden"><div class="status warn">12306 要求 APP 人工核验。请切换到官方铁路12306 App 完成提示的登录核验，然后回到这里点刷新。</div><button id="refresh" class="secondary">我已在 APP 完成，刷新状态</button></div>
<div id="status" class="status">尚未登录。</div></div></div><script>
let challengeId="";let rememberedUser="";let rememberedPassword="";
const q=id=>document.getElementById(id);const show=(id,on)=>q(id).classList.toggle("hidden",!on);
function stateMessage(data){const s=data.state||data.error||"UNKNOWN";if(s==="READY")return "登录成功并已加密保存会话。\n乘车人数量："+data.passenger_count+"\n待支付订单数量："+data.pending_order_count+"\n下单能力：关闭\n支付能力：关闭";if(s==="SMS_REQUIRED")return "需要短信验证。请填写证件后四位并获取验证码。";if(s==="APP_CONFIRM_REQUIRED")return "需要在官方铁路12306 App 完成人工登录核验。";if(s==="SLIDER_REQUIRED")return "12306 要求滑块验证。本页面不会自动化或绕过滑块，请停止本次登录。";if(s==="OFFLINE_IDENTITY_REQUIRED")return "12306 要求线下身份核验，本页面无法继续。";if(s==="INVALID_CREDENTIALS")return "用户名或密码错误。";return "状态："+s;}
async function post(path,payload){const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),cache:"no-store"});const d=await r.json().catch(()=>({error:"INVALID_RESPONSE"}));if(!r.ok)throw new Error(d.error||("HTTP_"+r.status));return d;}
function render(d){q("status").textContent=stateMessage(d);q("status").className="status "+(d.state==="READY"?"ok":d.state&&d.state!=="PENDING"?"warn":"");show("sms",d.state==="SMS_REQUIRED");show("app",d.state==="APP_CONFIRM_REQUIRED"||d.state==="HUMAN_ACTION_REQUIRED");if(d.challenge_id)challengeId=d.challenge_id;if(d.state==="READY"){rememberedPassword="";q("password").value="";}}
q("login").onclick=async()=>{try{rememberedUser=q("username").value;rememberedPassword=q("password").value;render(await post("/auth/api/start",{access_code:q("access").value,username:rememberedUser,password:rememberedPassword}));}catch(e){q("status").textContent="请求失败："+e.message;}};
q("sendSms").onclick=async()=>{try{render(await post("/auth/api/sms/request",{access_code:q("access").value,challenge_id:challengeId,username:rememberedUser,id_suffix4:q("suffix").value}));}catch(e){q("status").textContent="请求失败："+e.message;}};
q("submitSms").onclick=async()=>{try{render(await post("/auth/api/sms/submit",{access_code:q("access").value,challenge_id:challengeId,username:rememberedUser,password:rememberedPassword,sms_code:q("smsCode").value}));}catch(e){q("status").textContent="请求失败："+e.message;}};
q("refresh").onclick=async()=>{try{render(await post("/auth/api/refresh",{access_code:q("access").value,challenge_id:challengeId}));}catch(e){q("status").textContent="请求失败："+e.message;}};
</script></body></html>`;
}

export function createIphone12306AuthPortal(options: IphoneAuthPortalOptions): IphoneAuthPortal {
  if (!/^[0-9a-f]{64}$/.test(options.accessCodeHash)) throw new Error("AUTH_PORTAL_ACCESS_HASH_INVALID");
  const expectedHash = Buffer.from(options.accessCodeHash, "hex");
  let challenges = options.mobileChallenges;
  if (!challenges) {
    if (!options.transport || !options.aliasKey) throw new Error("AUTH_PORTAL_TRANSPORT_REQUIRED");
    const sharedTransport = new SharedCookieMobileTransport(options.transport);
    const auth = new Rail12306MobileAccountAuth({ aliasKey: options.aliasKey, transport: sharedTransport });
    challenges = new Mobile12306AuthChallengeStore(auth, { maxAttempts: 3 });
  }

  async function finish(result: AccountLoginResult, challenge: MobileAuthChallenge): Promise<Record<string, unknown>> {
    if (result.state === "READY") return { ok: true, challenge_id: challenge.challenge_id, ...(await readySummary(options)) };
    return { ok: true, challenge_id: challenge.challenge_id, expires_at: challenge.expires_at, attempts: challenge.attempts, state: result.state };
  }

  return {
    async handle(req, res, path) {
      if (path === "/auth" && (req.method ?? "GET") === "GET") {
        html(res, 200, page());
        return true;
      }
      if (!path.startsWith("/auth/api/")) return false;
      if ((req.method ?? "GET") !== "POST") {
        json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
        return true;
      }

      try {
        const body = await readJsonBody(req);
        if (!accessAuthorized(body, expectedHash)) {
          json(res, 401, { ok: false, error: "UNAUTHORIZED" });
          return true;
        }

        if (path === "/auth/api/start") {
          const restored = await options.restoreSession();
          if (restored === "READY") {
            json(res, 200, { ok: true, ...(await readySummary(options)) });
            return true;
          }
          const username = requiredString(body, "username", 128);
          const password = secretString(body, "password", 256);
          options.clearSession?.();
          const challenge = challenges!.create(5 * 60_000);
          const result = await challenges!.submitPassword(challenge.challenge_id, username, password);
          json(res, 200, await finish(result, challenges!.status(challenge.challenge_id)));
          return true;
        }

        const challengeId = requiredString(body, "challenge_id", 128);
        if (path === "/auth/api/sms/request") {
          const username = requiredString(body, "username", 128);
          const suffix = requiredString(body, "id_suffix4", 4);
          const result = await challenges!.requestSms(challengeId, username, suffix);
          json(res, 200, { ok: true, challenge_id: challengeId, state: result.state === "SMS_CODE_SENT" ? "SMS_REQUIRED" : result.state, sms_sent: result.state === "SMS_CODE_SENT" });
          return true;
        }
        if (path === "/auth/api/sms/submit") {
          const username = requiredString(body, "username", 128);
          const password = secretString(body, "password", 256);
          const smsCode = requiredString(body, "sms_code", 16);
          const result = await challenges!.submitSms(challengeId, username, password, smsCode);
          json(res, 200, await finish(result, challenges!.status(challengeId)));
          return true;
        }
        if (path === "/auth/api/refresh") {
          const challenge = await challenges!.refresh(challengeId);
          if (challenge.state === "READY") {
            json(res, 200, { ok: true, challenge_id: challengeId, ...(await readySummary(options)) });
          } else {
            json(res, 200, { ok: true, ...challenge });
          }
          return true;
        }

        json(res, 404, { ok: false, error: "NOT_FOUND" });
        return true;
      } catch (error) {
        const code = safeError(error);
        json(res, code === "REQUEST_BODY_TOO_LARGE" || code.startsWith("INVALID_") ? 400 : 502, { ok: false, error: code });
        return true;
      }
    },
  };
}
