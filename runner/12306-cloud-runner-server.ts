import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PendingOrder } from "../src/ticket/contracts.ts";
import type { PassengerAlias, ReadOnlySessionState } from "./real12306-readonly.ts";
import { createRail12306CloudSessionRuntime } from "./12306-cloud-session-runtime.ts";
import type { CloudQrLoginChallenge } from "./12306-session-persistence.ts";
import { ensurePersistenceMarker } from "./persistence-marker.ts";

const SERVICE_NAME = "rail12306-cloud-readonly";
const MAX_JSON_BODY_BYTES = 8 * 1024;
const DEFAULT_PORT = 3000;

type JsonObject = Record<string, unknown>;

export interface CloudRunnerRuntimeLike {
  controller: {
    restore(): Promise<ReadOnlySessionState>;
    beginQrLogin(timeoutMs?: number): Promise<CloudQrLoginChallenge>;
    waitForQrConfirmation(challengeId: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<"READY">;
  };
  provider: {
    sessionState(): Promise<ReadOnlySessionState>;
    readPassengers(): Promise<PassengerAlias[]>;
    readPendingOrders(): Promise<PendingOrder[]>;
  };
  close(): void;
}

export type CloudRunnerServerOptions = {
  adminToken: string;
  runtime: CloudRunnerRuntimeLike;
  persistenceMarkerHash?: string;
};

export type CloudRunnerEnvConfig = {
  adminToken: string;
  accountRef: string;
  aliasKey: string;
  sessionKey: Buffer;
  stateDir: string;
  databasePath: string;
  port: number;
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function requestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://runner.invalid").pathname;
}

function bearerAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(providedHash, expectedHash) && provided.length > 0;
}

async function readJsonBody(req: IncomingMessage): Promise<JsonObject> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_JSON_BODY_BYTES) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new Error("INVALID_JSON_BODY");
  }
}

function integerField(body: JsonObject, key: string, fallback: number, min: number, max: number): number {
  const value = body[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) throw new Error(`INVALID_${key.toUpperCase()}`);
  return Math.min(Math.max(value as number, min), max);
}

function stringField(body: JsonObject, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_${key.toUpperCase()}`);
  return value.trim();
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "INTERNAL_ERROR";
  return /^[A-Z][A-Z0-9_]*(?::[A-Z0-9_.-]+)?$/.test(message) ? message : "INTERNAL_ERROR";
}

function errorStatus(code: string): number {
  if (code === "RAIL12306_QR_EXPIRED") return 410;
  if (code === "AUTH_REQUIRED" || code === "RAIL12306_LOGIN_NOT_READY") return 409;
  if (code.startsWith("INVALID_") || code === "REQUEST_BODY_TOO_LARGE") return 400;
  if (code.includes("NETWORK_ERROR") || code.includes("HTTP_ERROR") || code.includes("SCHEMA_DRIFT") || code.includes("QUERY_REJECTED")) return 502;
  return 500;
}

export function createCloudRunnerHttpServer(options: CloudRunnerServerOptions): Server {
  if (!options.adminToken || options.adminToken.length < 32) throw new Error("RUNNER_ADMIN_TOKEN_TOO_SHORT");

  return createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = requestPath(req);

    if (method === "GET" && path === "/health") {
      json(res, 200, {
        ok: true,
        service: SERVICE_NAME,
        mode: "READ_ONLY",
        submit_capability: false,
        payment_capability: false,
        ...(options.persistenceMarkerHash ? { persistence_marker_hash: options.persistenceMarkerHash } : {}),
      });
      return;
    }

    if (!bearerAuthorized(req, options.adminToken)) {
      json(res, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }

    try {
      if (method === "GET" && path === "/v1/session/status") {
        const state = await options.runtime.provider.sessionState();
        json(res, 200, { ok: true, state });
        return;
      }

      if (method === "POST" && path === "/v1/session/restore") {
        const state = await options.runtime.controller.restore();
        json(res, 200, { ok: true, state });
        return;
      }

      if (method === "POST" && path === "/v1/session/qr") {
        const body = await readJsonBody(req);
        const timeoutMs = integerField(body, "timeout_ms", 120_000, 5_000, 180_000);
        const challenge = await options.runtime.controller.beginQrLogin(timeoutMs);
        json(res, 201, {
          ok: true,
          challenge_id: challenge.challenge_id,
          qr_image_base64: challenge.qr_image_base64,
          expires_at: challenge.expires_at,
        });
        return;
      }

      if (method === "POST" && path === "/v1/session/qr/poll") {
        const body = await readJsonBody(req);
        const challengeId = stringField(body, "challenge_id");
        const timeoutMs = integerField(body, "timeout_ms", 5_000, 5_000, 5_000);
        try {
          const state = await options.runtime.controller.waitForQrConfirmation(challengeId, { timeoutMs, pollMs: 500 });
          json(res, 200, { ok: true, state });
        } catch (error) {
          const code = safeErrorCode(error);
          if (code === "RAIL12306_QR_TIMEOUT") {
            json(res, 202, { ok: true, state: "WAITING" });
            return;
          }
          throw error;
        }
        return;
      }

      if (method === "GET" && path === "/v1/passengers") {
        const passengers = await options.runtime.provider.readPassengers();
        json(res, 200, { ok: true, passengers });
        return;
      }

      if (method === "GET" && path === "/v1/pending-orders") {
        const orders = await options.runtime.provider.readPendingOrders();
        json(res, 200, { ok: true, orders });
        return;
      }

      json(res, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      const code = safeErrorCode(error);
      json(res, errorStatus(code), { ok: false, error: code });
    }
  });
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string, minLength = 1): string {
  const value = env[name]?.trim();
  if (!value || value.length < minLength) throw new Error(`${name}_REQUIRED`);
  return value;
}

export function loadCloudRunnerEnv(env: NodeJS.ProcessEnv = process.env): CloudRunnerEnvConfig {
  const adminToken = requiredEnv(env, "RUNNER_ADMIN_TOKEN", 32);
  const accountRef = requiredEnv(env, "RAIL12306_ACCOUNT_REF");
  const aliasKey = requiredEnv(env, "RAIL12306_ALIAS_KEY", 16);
  const encodedKey = requiredEnv(env, "RAIL12306_SESSION_KEY_B64");
  const sessionKey = Buffer.from(encodedKey, "base64");
  if (sessionKey.length !== 32) throw new Error("RAIL12306_SESSION_KEY_B64_INVALID");

  const stateDir = env.RAIL12306_STATE_DIR?.trim() || env.RAILWAY_VOLUME_MOUNT_PATH?.trim() || "/data";
  const portText = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT_INVALID");

  return {
    adminToken,
    accountRef,
    aliasKey,
    sessionKey,
    stateDir,
    databasePath: join(stateDir, "12306-session.sqlite"),
    port,
  };
}

export function createCloudRunnerRuntimeFromEnv(config: CloudRunnerEnvConfig): CloudRunnerRuntimeLike {
  return createRail12306CloudSessionRuntime({
    accountRef: config.accountRef,
    aliasKey: config.aliasKey,
    databasePath: config.databasePath,
    encryptionKey: config.sessionKey,
  });
}

export function startCloudRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): { server: Server; runtime: CloudRunnerRuntimeLike } {
  const config = loadCloudRunnerEnv(env);
  const persistenceMarkerHash = ensurePersistenceMarker(config.stateDir);
  const runtime = createCloudRunnerRuntimeFromEnv(config);
  const server = createCloudRunnerHttpServer({
    adminToken: config.adminToken,
    runtime,
    persistenceMarkerHash,
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: SERVICE_NAME, event: "listening", port: config.port, mode: "READ_ONLY" }));
  });

  const shutdown = () => {
    server.close(() => runtime.close());
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, runtime };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) startCloudRunnerFromEnv();
