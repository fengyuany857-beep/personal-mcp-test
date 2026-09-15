const endpoint = "https://mcp.apify.com?tools=search-actors,fetch-actor-details";
let sessionId = null;
let nextId = 0;

function parse(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const frame = text.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!frame) throw new Error(`No SSE frame: ${text.slice(0, 500)}`);
    return JSON.parse(frame.slice(5).trim());
  }
  return JSON.parse(text);
}

async function call(method, params = {}, notification = false) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = ++nextId;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 800)}`);
  if (notification || response.status === 202) return null;
  const payload = parse(response.headers.get("content-type") ?? "", text);
  if (payload.error) throw new Error(`${method} MCP error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function textContent(result) {
  return (result?.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function findActorName(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    const m = value.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/);
    return m?.[1] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findActorName(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value;
    for (const key of ["fullName", "actorFullName", "name", "id"]) {
      if (typeof record[key] === "string" && record[key].includes("/")) return record[key];
    }
    for (const child of Object.values(record)) {
      const found = findActorName(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

await call("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "personal-mcp-apify-readonly-chain", version: "1.0.0" },
});
await call("notifications/initialized", {}, true);
const list = await call("tools/list", {});
const names = (list?.tools ?? []).map((tool) => tool.name).sort();
if (JSON.stringify(names) !== JSON.stringify(["fetch-actor-details", "search-actors"])) {
  throw new Error(`Unexpected tool surface: ${JSON.stringify(names)}`);
}
console.log(`APIFY_READONLY_TOOLS=PASS ${JSON.stringify(names)}`);

const search = await call("tools/call", {
  name: "search-actors",
  arguments: { keywords: "Google Maps", limit: 3, offset: 0 },
});
if (search?.isError) throw new Error(`search-actors returned isError: ${JSON.stringify(search).slice(0, 1200)}`);
const searchText = textContent(search);
console.log(`APIFY_SEARCH_ACTORS=PASS chars=${searchText.length}`);
console.log(`APIFY_SEARCH_SAMPLE=${JSON.stringify(searchText.slice(0, 1800))}`);

let actor = findActorName(search?.structuredContent) ?? findActorName(searchText);
if (!actor) throw new Error("Could not resolve actor full name from search-actors response");
console.log(`APIFY_ACTOR_SELECTED=${actor}`);

const details = await call("tools/call", {
  name: "fetch-actor-details",
  arguments: {
    actor,
    output: {
      description: true,
      stats: true,
      pricing: true,
      rating: true,
      metadata: true,
      inputSchema: true,
      readme: false,
      outputSchema: false,
      mcpTools: false,
    },
  },
});
if (details?.isError) throw new Error(`fetch-actor-details returned isError: ${JSON.stringify(details).slice(0, 1200)}`);
const detailsText = textContent(details);
if (detailsText.length < 100) throw new Error(`Actor details too short: ${detailsText}`);
console.log(`APIFY_FETCH_DETAILS=PASS chars=${detailsText.length}`);
console.log(`APIFY_DETAILS_SAMPLE=${JSON.stringify(detailsText.slice(0, 1800))}`);
console.log("APIFY_READONLY_CHAIN_PASS");
