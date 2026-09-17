import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRail12306CloudSessionRuntime } from "../runner/12306-cloud-session-runtime.ts";
import type { LocalSessionHttpResponse } from "../runner/12306-local-auth-readonly.ts";
import type { PersistableLocalSessionTransport, SessionCookieJar } from "../runner/12306-session-persistence.ts";

class ReadyTransport implements PersistableLocalSessionTransport {
  private jar: SessionCookieJar = {};
  readonly calls: string[] = [];
  exportSessionCookies() { return { ...this.jar }; }
  importSessionCookies(cookies: SessionCookieJar) { this.jar = { ...cookies }; }
  clearSessionCookies() { this.jar = {}; }
  async request(method: "GET" | "POST", path: string): Promise<LocalSessionHttpResponse> {
    this.calls.push(`${method}:${path}`);
    if (method === "POST" && path === "/otn/login/checkUser") {
      return { status: 200, body: JSON.stringify({ status: true, data: { flag: true } }) };
    }
    throw new Error(`UNEXPECTED_HTTP_CALL:${method}:${path}`);
  }
}

test("canonical cloud session factory binds provider and controller to one cookie jar", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rail12306-runtime-factory-"));
  const path = join(directory, "session.sqlite");
  const transport = new ReadyTransport();
  try {
    const runtime = createRail12306CloudSessionRuntime({
      accountRef: "acct_factory",
      aliasKey: "factory-alias-key-123456789",
      databasePath: path,
      encryptionKey: Buffer.alloc(32, 17),
      transport,
    });
    runtime.store.save("acct_factory", { RAIL_SESSION: "persisted-factory-session" });

    assert.equal(await runtime.controller.restore(), "READY");
    assert.equal(runtime.transport.exportSessionCookies().RAIL_SESSION, "persisted-factory-session");
    assert.deepEqual(transport.calls, ["POST:/otn/login/checkUser"]);
    runtime.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
