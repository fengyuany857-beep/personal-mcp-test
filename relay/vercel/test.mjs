import assert from "node:assert/strict";
import relay from "./api/exa-mcp.mjs";

async function bodyJson(response) {
  return JSON.parse(await response.text());
}

delete process.env.HUB_RELAY_TOKEN;
let response = await relay.fetch(
  new Request("https://relay.example/api/exa-mcp", { method: "POST", body: "{}" }),
);
assert.equal(response.status, 503);
assert.equal((await bodyJson(response)).code, "RELAY_NOT_CONFIGURED");

process.env.HUB_RELAY_TOKEN = "unit-test-secret";
response = await relay.fetch(
  new Request("https://relay.example/api/exa-mcp", {
    method: "POST",
    headers: { "x-hub-relay-token": "wrong" },
    body: "{}",
  }),
);
assert.equal(response.status, 401);
assert.equal((await bodyJson(response)).code, "RELAY_UNAUTHORIZED");

response = await relay.fetch(
  new Request("https://relay.example/api/exa-mcp", {
    method: "PUT",
    headers: { "x-hub-relay-token": "unit-test-secret" },
    body: "{}",
  }),
);
assert.equal(response.status, 405);

let observed;
globalThis.fetch = async (url, init) => {
  observed = { url, init };
  return new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', {
    status: 200,
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "unit-session",
      "x-not-allowlisted": "must-not-pass",
    },
  });
};

response = await relay.fetch(
  new Request("https://relay.example/api/exa-mcp", {
    method: "POST",
    headers: {
      "x-hub-relay-token": "unit-test-secret",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-not-allowlisted": "must-not-pass",
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  }),
);
assert.equal(response.status, 200);
assert.equal(observed.url, "https://mcp.exa.ai/mcp?tools=web_search_exa");
assert.equal(observed.init.headers.get("x-hub-relay-token"), null);
assert.equal(observed.init.headers.get("x-not-allowlisted"), null);
assert.equal(observed.init.headers.get("user-agent"), "Personal-MCP-Hub-Relay/1.0");
assert.equal(response.headers.get("mcp-session-id"), "unit-session");
assert.equal(response.headers.get("x-not-allowlisted"), null);

const oversized = "x".repeat(1024 * 1024 + 1);
response = await relay.fetch(
  new Request("https://relay.example/api/exa-mcp", {
    method: "POST",
    headers: {
      "x-hub-relay-token": "unit-test-secret",
      "content-type": "text/plain",
    },
    body: oversized,
  }),
);
assert.equal(response.status, 413);
assert.equal((await bodyJson(response)).code, "REQUEST_TOO_LARGE");

console.log("RELAY_UNIT=PASS");
