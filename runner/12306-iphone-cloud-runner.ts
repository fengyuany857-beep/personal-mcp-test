import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createCloudRunnerHttpServer, loadCloudRunnerEnv } from "./12306-cloud-runner-server.ts";
import { createRail12306CloudSessionRuntime } from "./12306-cloud-session-runtime.ts";
import { createIphone12306AuthPortal } from "./12306-iphone-auth-portal.ts";
import { ensurePersistenceMarker } from "./persistence-marker.ts";

const SERVICE_NAME = "rail12306-cloud-readonly";
const IPHONE_AUTH_ACCESS_SHA256 = "8737334cae4569a4b958f57e0279d3dee5df48effd5168cad317e63b77987315";

function requestPath(url = "/"): string {
  return new URL(url, "http://runner.invalid").pathname;
}

export function startIphoneCloudRunnerFromEnv(env: NodeJS.ProcessEnv = process.env): {
  server: Server;
  runtime: ReturnType<typeof createRail12306CloudSessionRuntime>;
} {
  const config = loadCloudRunnerEnv(env);
  const persistenceMarkerHash = ensurePersistenceMarker(config.stateDir);
  const runtime = createRail12306CloudSessionRuntime({
    accountRef: config.accountRef,
    aliasKey: config.aliasKey,
    databasePath: config.databasePath,
    encryptionKey: config.sessionKey,
  });

  const authPortal = createIphone12306AuthPortal({
    accessCodeHash: IPHONE_AUTH_ACCESS_SHA256,
    restoreSession: () => runtime.controller.restore(),
    beginQrLogin: timeoutMs => runtime.controller.beginQrLogin(timeoutMs),
    waitForQrConfirmation: (challengeId, options) => runtime.controller.waitForQrConfirmation(challengeId, options),
    readPassengers: () => runtime.provider.readPassengers(),
    readPendingOrders: () => runtime.provider.readPendingOrders(),
  });

  const legacyServer = createCloudRunnerHttpServer({
    adminToken: config.adminToken,
    runtime,
    persistenceMarkerHash,
  });

  const server = createServer(async (req, res) => {
    const path = requestPath(req.url);
    if (await authPortal.handle(req, res, path)) return;
    legacyServer.emit("request", req, res);
  });

  server.listen(config.port, "0.0.0.0", () => {
    console.log(JSON.stringify({ service: SERVICE_NAME, event: "listening", port: config.port, mode: "READ_ONLY", iphone_auth_portal: true, auth_mode: "QR_ONLY" }));
  });

  const shutdown = () => {
    server.close(() => runtime.close());
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { server, runtime };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) startIphoneCloudRunnerFromEnv();
