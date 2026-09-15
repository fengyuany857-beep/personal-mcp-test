import assert from "node:assert/strict";

const endpoint = process.env.RELAY_URL;
const token = process.env.HUB_RELAY_TOKEN;
if (!endpoint) throw new Error("RELAY_URL is required");
if (!token) throw new Error("HUB_RELAY_TOKEN is required");

function parseResponseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!lines.length) throw new Error(`No SSE data frame in response: ${text.slice(0, 500)}`);
    return JSON.parse(lines[0].slice(5).trim());
  }
  return JSON.parse(text);
}

async function rawPost(relayToken, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (relayToken !== undefined) headers["x-hub-relay-token"] = relayToken;
  if (sessionId) headers["mcp-session-id"] = sessionId;
  return fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "manual",
  });
}

const initializeBody = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "personal-mcp-vercel-relay-e2e", version: "1.0.0" },
  },
};

let response = await rawPost(undefined, initializeBody);
assert.equal(response.status, 401, `missing token expected 401, got ${response.status}: ${await response.text()}`);
console.log("RELAY_AUTH_MISSING=PASS");

response = await rawPost(`wrong-${crypto.randomUUID()}`, initializeBody);
assert.equal(response.status, 401, `wrong token expected 401, got ${response.status}: ${await response.text()}`);
console.log("RELAY_AUTH_WRONG=PASS");

let sessionId = null;
let nextId = 1;
async function mcpCall(method, params = {}, notification = false) {
  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = ++nextId;
  const res = await rawPost(token, body, sessionId);
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} HTTP ${res.status}: ${text.slice(0, 1000)}`);
  if (notification || res.status === 202) return null;
  const payload = parseResponseBody(res.headers.get("content-type") ?? "", text);
  if (payload.error) throw new Error(`${method} MCP error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

const init = await mcpCall("initialize", initializeBody.params);
if (init?.serverInfo?.name !== "exa-search-server") {
  throw new Error(`Unexpected Exa serverInfo: ${JSON.stringify(init?.serverInfo ?? null)}`);
}
console.log(`RELAY_INITIALIZE=PASS server=${JSON.stringify(init.serverInfo)}`);

await mcpCall("notifications/initialized", {}, true);

const listed = await mcpCall("tools/list", {});
const names = (listed?.tools ?? []).map((tool) => tool.name).sort();
assert.deepEqual(names, ["web_search_exa"]);
console.log(`RELAY_TOOLS_LIST=PASS tools=${JSON.stringify(names)}`);

const search = await mcpCall("tools/call", {
  name: "web_search_exa",
  arguments: {
    query: "official Model Context Protocol specification documentation",
    numResults: 3,
  },
});
if (search?.isError) throw new Error(`web_search_exa returned isError: ${JSON.stringify(search)}`);
const text = search?.content?.find((entry) => entry?.type === "text")?.text ?? "";
if (text.length < 40 || !/https?:\/\//i.test(text)) {
  throw new Error(`Unexpected web_search_exa result: ${text.slice(0, 1000)}`);
}
console.log(`RELAY_EXA_SEARCH=PASS chars=${text.length}`);
console.log("VERCEL_EXA_RELAY_PASS");
