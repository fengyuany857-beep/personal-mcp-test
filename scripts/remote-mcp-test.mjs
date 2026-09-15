const endpoint = process.env.MCP_ENDPOINT;
if (!endpoint) throw new Error("MCP_ENDPOINT is required");

let nextId = 0;
let sessionId = null;

function parseResponseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!lines.length) throw new Error(`No SSE data frame in response: ${text}`);
    return JSON.parse(lines[0].slice(5).trim());
  }
  return JSON.parse(text);
}

async function mcpFetch(method, params = {}, notification = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = ++nextId;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();

  if (notification || response.status === 202) {
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`);
    return null;
  }

  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text}`);
  const payload = parseResponseBody(response.headers.get("content-type") ?? "", text);
  if (payload.error) throw new Error(`${method} MCP error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function getStructured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((entry) => entry?.type === "text")?.text;
  if (!text) throw new Error(`Tool result has no structuredContent or text JSON: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label} mismatch\nexpected=${e}\nactual=${a}`);
}

const init = await mcpFetch("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "personal-mcp-independent-test", version: "1.1.0" },
});
if (init?.serverInfo?.name !== "personal-mcp-test") {
  throw new Error(`Unexpected serverInfo: ${JSON.stringify(init?.serverInfo)}`);
}
console.log(`INITIALIZE=PASS ${JSON.stringify(init)}`);

await mcpFetch("notifications/initialized", {}, true);

const tools = await mcpFetch("tools/list", {});
const toolNames = (tools?.tools ?? []).map((tool) => tool.name).sort();
assertEqual(
  toolNames,
  ["echo", "ping", "search.exa_search", "system.upstream_status"],
  "tools/list",
);
console.log(`TOOLS_LIST=PASS ${JSON.stringify(toolNames)}`);

const nonce = `independent-${Date.now()}-${crypto.randomUUID()}`;
const pingResult = getStructured(
  await mcpFetch("tools/call", { name: "ping", arguments: { message: nonce } }),
);
assertEqual(
  pingResult,
  { ok: true, message: nonce, server: "personal-mcp-test" },
  "ping result",
);
console.log(`PING=PASS ${JSON.stringify(pingResult)}`);
console.log(`NONCE_ROUND_TRIP=PASS ${nonce}`);

const echoText = `Independent MCP E2E ${nonce}`;
const echoResult = getStructured(
  await mcpFetch("tools/call", { name: "echo", arguments: { text: echoText } }),
);
assertEqual(echoResult, { ok: true, echo: echoText }, "echo result");
console.log(`ECHO=PASS ${JSON.stringify(echoResult)}`);

const exaStatusCall = await mcpFetch("tools/call", {
  name: "system.upstream_status",
  arguments: { service: "exa" },
});
if (exaStatusCall?.isError) throw new Error(`EXA_STATUS isError: ${JSON.stringify(exaStatusCall)}`);
const exaStatus = getStructured(exaStatusCall);
assertEqual(
  exaStatus,
  { ok: true, service: "exa", expectedTool: "web_search_exa", toolFound: true },
  "exa upstream status",
);
console.log(`EXA_DISCOVERY=PASS ${JSON.stringify(exaStatus)}`);

const exaSearch = await mcpFetch("tools/call", {
  name: "search.exa_search",
  arguments: {
    query: "official Model Context Protocol specification documentation",
    numResults: 3,
  },
});
if (exaSearch?.isError) throw new Error(`EXA_SEARCH isError: ${JSON.stringify(exaSearch)}`);
const exaText = exaSearch?.content?.find((entry) => entry?.type === "text")?.text ?? "";
if (exaText.length < 40 || !/https?:\/\//i.test(exaText)) {
  throw new Error(`EXA_SEARCH unexpected result: ${exaText.slice(0, 1000)}`);
}
console.log(`EXA_SEARCH=PASS chars=${exaText.length}`);

console.log("EXA_HUB_PASS");
