const endpoint = "https://mcp.firecrawl.dev/v2/mcp";
let sessionId = null;
let nextId = 0;

function parse(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const data = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!data) throw new Error(`No SSE data frame: ${text.slice(0, 500)}`);
    return JSON.parse(data.slice(5).trim());
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
  console.log(`FIRECRAWL_HTTP method=${method} status=${response.status} contentType=${JSON.stringify(response.headers.get("content-type"))} auth=${JSON.stringify(response.headers.get("www-authenticate"))}`);
  if (!response.ok) {
    console.log(`FIRECRAWL_BODY ${text.slice(0, 1000)}`);
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
    clientInfo: { name: "personal-mcp-firecrawl-probe", version: "1.0.0" },
  });
  console.log(`FIRECRAWL_INITIALIZE=PASS ${JSON.stringify(init?.serverInfo ?? null)}`);
  await call("notifications/initialized", {}, true);
  const list = await call("tools/list", {});
  const tools = list?.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  console.log(`FIRECRAWL_TOOLS_LIST=PASS ${JSON.stringify(names)}`);
  const scrape = tools.find((tool) => tool.name === "firecrawl_scrape");
  if (!scrape) throw new Error("firecrawl_scrape missing");
  console.log(`FIRECRAWL_SCRAPE_SCHEMA=${JSON.stringify({ inputSchema: scrape.inputSchema, outputSchema: scrape.outputSchema ?? null, annotations: scrape.annotations ?? null })}`);
  console.log("FIRECRAWL_BARE_ENDPOINT_PASS");
} catch (error) {
  console.log(`FIRECRAWL_BARE_ENDPOINT_FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
