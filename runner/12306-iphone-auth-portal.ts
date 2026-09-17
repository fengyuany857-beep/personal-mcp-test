import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PendingOrder } from "../src/ticket/contracts.ts";
import type { PassengerAlias, ReadOnlySessionState } from "./real12306-readonly.ts";
import type { CloudQrLoginChallenge } from "./12306-session-persistence.ts";
import { IPHONE_AUTH_APP_JS } from "./12306-iphone-auth-app.ts";

const MAX_BODY_BYTES = 8 * 1024;

type JsonObject = Record<string, unknown>;

export type IphoneAuthPortalOptions = {
  accessCodeHash: string;
  restoreSession: () => Promise<ReadOnlySessionState>;
  beginQrLogin: (timeoutMs?: number) => Promise<CloudQrLoginChallenge>;
  waitForQrConfirmation: (
    challengeId: string,
    options?: { timeoutMs?: number; pollMs?: number },
  ) => Promise<"READY">;
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
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src data: blob:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function javascript(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    ...secureHeaders("application/javascript; charset=utf-8"),
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

async function readySummary(options: IphoneAuthPortalOptions): Promise<Record<string, unknown>> {
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
<title>12306 扫码登录</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;color-scheme:light dark}body{margin:0;background:#f5f5f7;color:#1d1d1f}.wrap{max-width:520px;margin:0 auto;padding:28px 18px 64px}.card{background:#fff;border-radius:22px;padding:22px;box-shadow:0 8px 30px #00000012}h1{font-size:25px;margin:0 0 8px}.sub{font-size:14px;color:#6e6e73;line-height:1.55;margin-bottom:18px}.steps{font-size:14px;line-height:1.65;padding:0 0 0 20px}.qrbox{text-align:center;margin:18px 0}.qrbox img{width:min(78vw,320px);height:auto;border-radius:14px;background:#fff;padding:10px;box-sizing:border-box}.hidden{display:none}label{display:block;font-size:13px;margin:12px 0 6px}input{box-sizing:border-box;width:100%;font-size:16px;padding:13px 14px;border:1px solid #d2d2d7;border-radius:12px;background:#fff;color:#111}button{width:100%;margin-top:12px;border:0;border-radius:12px;padding:13px 15px;font-size:16px;font-weight:600;background:#0071e3;color:#fff}.secondary{background:#e8e8ed;color:#1d1d1f}.status{margin-top:16px;padding:14px;border-radius:12px;background:#f5f5f7;font-size:14px;white-space:pre-wrap;line-height:1.55}.warn{color:#b54708}.ok{color:#137333}.tiny{font-size:12px;color:#86868b;line-height:1.5;margin-top:12px}@media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}.card{background:#1c1c1e}.sub,.tiny{color:#a1a1a6}input{background:#2c2c2e;color:#fff;border-color:#48484a}.secondary,.status{background:#2c2c2e;color:#fff}}
</style><script src="/auth/app.js" defer></script></head><body><div class="wrap"><div class="card"><h1>12306 扫码登录</h1><div class="sub">无需输入 12306 账号或密码。二维码来自 12306 官方登录接口；确认后只保存加密会话。下单和支付能力保持关闭。</div>
<div id="accessBox" class="hidden"><label>访问码</label><input id="access" type="password" autocomplete="off" autocapitalize="off"><button id="unlock">生成二维码</button></div>
<div id="qrArea" class="hidden"><div class="qrbox"><img id="qr" alt="12306 登录二维码"></div><ol class="steps"><li>长按二维码保存到“照片”，或点“分享/保存二维码”。</li><li>打开官方铁路12306 App 的扫码入口。</li><li>选择“相册”，读取刚保存的二维码并确认登录。</li><li>回到 Safari。本页会自动检查，成功后显示 READY。</li></ol><button id="share">分享 / 保存二维码</button><button id="regen" class="secondary">二维码过期了，重新生成</button></div>
<div id="status" class="status">正在加载扫码登录脚本…</div><div class="tiny">页面不会要求身份证号、12306 密码或短信验证码。若页面脚本无法启动，会在此处显示明确错误，不再静默等待。</div></div></div></body></html>`;
}

export function createIphone12306AuthPortal(options: IphoneAuthPortalOptions): IphoneAuthPortal {
  if (!/^[0-9a-f]{64}$/.test(options.accessCodeHash)) throw new Error("AUTH_PORTAL_ACCESS_HASH_INVALID");
  const expectedHash = Buffer.from(options.accessCodeHash, "hex");

  return {
    async handle(req, res, path) {
      const method = req.method ?? "GET";
      if (path === "/auth") {
        if (method !== "GET") {
          json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
          return true;
        }
        html(res, 200, page());
        return true;
      }
      if (path === "/auth/app.js") {
        if (method !== "GET") {
          json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
          return true;
        }
        javascript(res, 200, IPHONE_AUTH_APP_JS);
        return true;
      }
      if (!path.startsWith("/auth/api/")) return false;
      if (method !== "POST") {
        json(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
        return true;
      }

      try {
        const body = await readJsonBody(req);
        if (!accessAuthorized(body, expectedHash)) {
          json(res, 401, { ok: false, error: "UNAUTHORIZED" });
          return true;
        }

        if (path === "/auth/api/qr/start") {
          const restored = await options.restoreSession();
          if (restored === "READY") {
            json(res, 200, { ok: true, ...(await readySummary(options)) });
            return true;
          }
          const challenge = await options.beginQrLogin(180_000);
          json(res, 201, {
            ok: true,
            state: "WAITING",
            challenge_id: challenge.challenge_id,
            qr_image_base64: challenge.qr_image_base64,
            expires_at: challenge.expires_at,
            submit_capability: false,
            payment_capability: false,
          });
          return true;
        }

        if (path === "/auth/api/qr/poll") {
          const challengeId = requiredString(body, "challenge_id", 128);
          try {
            const state = await options.waitForQrConfirmation(challengeId, { timeoutMs: 5_000, pollMs: 500 });
            if (state !== "READY") throw new Error("RAIL12306_LOGIN_NOT_READY");
            json(res, 200, { ok: true, challenge_id: challengeId, ...(await readySummary(options)) });
          } catch (error) {
            if (safeError(error) === "RAIL12306_QR_TIMEOUT") {
              json(res, 202, { ok: true, state: "WAITING", challenge_id: challengeId });
              return true;
            }
            throw error;
          }
          return true;
        }

        json(res, 404, { ok: false, error: "NOT_FOUND" });
        return true;
      } catch (error) {
        const code = safeError(error);
        const status = code === "RAIL12306_QR_EXPIRED" ? 410
          : code === "REQUEST_BODY_TOO_LARGE" || code.startsWith("INVALID_") ? 400
          : 502;
        json(res, status, { ok: false, error: code });
        return true;
      }
    },
  };
}
