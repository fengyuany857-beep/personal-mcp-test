const endpoint = "https://mcp.apify.com?tools=search-actors,fetch-actor-details";
let sessionId = null;
let nextId = 0;

function parse(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const frame = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!frame) throw new Error(`No SSE data frame: ${text.slice(0, 500)}`);
    return JSON.parse(frame.slice(5).trim());
  }
  return JSON.parse(text);
}

async function call(method, params = {}, notification = false) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
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
  console.log(`APIFY_HTTP method=${method} status=${response.status} auth=${JSON.stringify(response.headers.get("www-authenticate"))}`);
  if (!response.ok) {
    console.log(`APIFY_BODY ${text.slice(0, 1000)}`);
    throw new Error(`${method} HTTP ${response.status}`);
  }
  if (notification || response.status === 202) return null;
  const payload = parse(response.headers.get("content-type") ?? "", text);
  if (payload.error) throw new Error(`${method} MCP error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

try {
  const init = await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "personal-mcp-apify-probe", version: "1.0.0" },
  });
  console.log(`APIFY_INITIALIZE=PASS ${JSON.stringify(init?.serverInfo ?? null)}`);
  await call("notifications/initialized", {}, true);
  const list = await call("tools/list", {});
  const tools = list?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  console.log(`APIFY_TOOLS_LIST=PASS ${JSON.stringify(names)}`);
  if (JSON.stringify(names) !== JSON.stringify(["fetch-actor-details", "search-actors"])) {
    throw new Error(`Unexpected Apify tool surface: ${JSON.stringify(names)}`);
  }
  for (const name of names) {
    const tool = tools.find((candidate) => candidate.name === name);
    console.log(`APIFY_TOOL_SCHEMA name=${name} schema=${JSON.stringify(tool?.inputSchema ?? null)} annotations=${JSON.stringify(tool?.annotations ?? null)}`);
  }
  console.log("APIFY_READONLY_SURFACE_PASS");
} catch (error) {
  console.log(`APIFY_READONLY_SURFACE_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
