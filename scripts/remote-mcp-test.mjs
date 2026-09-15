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

async function directExaProbe() {
  const exaEndpoint = "https://mcp.exa.ai/mcp?tools=web_search_exa";
  let exaSession = null;
  let exaId = 0;

  const call = async (method, params = {}, notification = false) => {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (exaSession) headers["mcp-session-id"] = exaSession;
    const body = { jsonrpc: "2.0", method, params };
    if (!notification) body.id = ++exaId;
    const response = await fetch(exaEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    exaSession = response.headers.get("mcp-session-id") ?? exaSession;
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} HTTP ${response.status}: ${text.slice(0, 500)}`);
    if (notification || response.status === 202) return null;
    const payload = parseResponseBody(response.headers.get("content-type") ?? "", text);
    if (payload.error) throw new Error(`${method} MCP error: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };

  try {
    const init = await call("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "personal-mcp-exa-direct-probe", version: "1.0.0" },
    });
    await call("notifications/initialized", {}, true);
    const list = await call("tools/list", {});
    const names = (list?.tools ?? []).map((tool) => tool.name).sort();
    console.log(`EXA_DIRECT_PROBE=PASS server=${JSON.stringify(init?.serverInfo ?? null)} tools=${JSON.stringify(names)}`);
  } catch (error) {
    console.log(`EXA_DIRECT_PROBE=FAIL ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  }
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

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

const init = await mcpFetch("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "personal-mcp-independent-test", version: "1.3.0" },
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
  [
    "actor.fetch_details",
    "actor.search",
    "crawl.firecrawl_scrape",
    "echo",
    "ping",
    "search.exa_search",
    "system.upstream_status",
  ],
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

await directExaProbe();

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
    query: "official Model Context Protocol documentation modelcontextprotocol.io introduction",
    numResults: 5,
  },
});
if (exaSearch?.isError) throw new Error(`EXA_SEARCH isError: ${JSON.stringify(exaSearch)}`);
const exaText = exaSearch?.content?.find((entry) => entry?.type === "text")?.text ?? "";
if (exaText.length < 40 || !/https?:\/\//i.test(exaText)) {
  throw new Error(`EXA_SEARCH unexpected result: ${exaText.slice(0, 1000)}`);
}
console.log(`EXA_SEARCH=PASS chars=${exaText.length}`);
console.log("EXA_HUB_PASS");

const firecrawlStatusCall = await mcpFetch("tools/call", {
  name: "system.upstream_status",
  arguments: { service: "firecrawl" },
});
if (firecrawlStatusCall?.isError) {
  throw new Error(`FIRECRAWL_STATUS isError: ${JSON.stringify(firecrawlStatusCall)}`);
}
const firecrawlStatus = getStructured(firecrawlStatusCall);
assertEqual(
  firecrawlStatus,
  { ok: true, service: "firecrawl", expectedTool: "firecrawl_scrape", toolFound: true },
  "firecrawl upstream status",
);
console.log(`FIRECRAWL_DISCOVERY=PASS ${JSON.stringify(firecrawlStatus)}`);

const urls = extractUrls(exaText);
const scrapeUrl = urls.find((url) => /modelcontextprotocol\.io/i.test(url)) ?? urls[0];
if (!scrapeUrl) throw new Error("EXA_TO_FIRECRAWL no URL found in Exa response");
console.log(`EXA_TO_FIRECRAWL_URL=PASS ${scrapeUrl}`);

const firecrawlCall = await mcpFetch("tools/call", {
  name: "crawl.firecrawl_scrape",
  arguments: { url: scrapeUrl },
});
if (firecrawlCall?.isError) {
  throw new Error(`FIRECRAWL_SCRAPE isError: ${JSON.stringify(firecrawlCall)}`);
}
const firecrawlResult = getStructured(firecrawlCall);
if (
  firecrawlResult?.ok !== true ||
  firecrawlResult?.url !== scrapeUrl ||
  typeof firecrawlResult?.markdown !== "string" ||
  firecrawlResult.markdown.length < 200
) {
  throw new Error(`FIRECRAWL_SCRAPE unexpected result: ${JSON.stringify(firecrawlResult).slice(0, 1200)}`);
}
if (/<html[\s>]/i.test(firecrawlResult.markdown) || /<body[\s>]/i.test(firecrawlResult.markdown)) {
  throw new Error("FIRECRAWL_SCRAPE returned raw HTML instead of clean Markdown");
}
console.log(`FIRECRAWL_SCRAPE=PASS chars=${firecrawlResult.markdown.length}`);
console.log("FIRECRAWL_HUB_PASS");

const apifyStatusCall = await mcpFetch("tools/call", {
  name: "system.upstream_status",
  arguments: { service: "apify" },
});
if (apifyStatusCall?.isError) throw new Error(`APIFY_STATUS isError: ${JSON.stringify(apifyStatusCall)}`);
const apifyStatus = getStructured(apifyStatusCall);
assertEqual(
  apifyStatus,
  { ok: true, service: "apify", expectedTool: "search-actors", toolFound: true },
  "apify upstream status",
);
console.log(`APIFY_DISCOVERY=PASS ${JSON.stringify(apifyStatus)}`);

const apifySearchCall = await mcpFetch("tools/call", {
  name: "actor.search",
  arguments: { keywords: "Google Maps", limit: 3 },
});
if (apifySearchCall?.isError) throw new Error(`APIFY_SEARCH isError: ${JSON.stringify(apifySearchCall)}`);
const apifySearch = getStructured(apifySearchCall);
if (apifySearch?.ok !== true || typeof apifySearch?.results !== "string" || apifySearch.results.length < 100) {
  throw new Error(`APIFY_SEARCH unexpected result: ${JSON.stringify(apifySearch).slice(0, 1200)}`);
}
const actorMatch = apifySearch.results.match(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`/);
const actor = actorMatch?.[1];
if (!actor) throw new Error(`APIFY_SEARCH did not return a parsable actor full name: ${apifySearch.results.slice(0, 1200)}`);
console.log(`APIFY_SEARCH=PASS actor=${actor} chars=${apifySearch.results.length}`);

const apifyDetailsCall = await mcpFetch("tools/call", {
  name: "actor.fetch_details",
  arguments: { actor },
});
if (apifyDetailsCall?.isError) throw new Error(`APIFY_FETCH_DETAILS isError: ${JSON.stringify(apifyDetailsCall)}`);
const apifyDetails = getStructured(apifyDetailsCall);
if (
  apifyDetails?.ok !== true ||
  apifyDetails?.actor !== actor ||
  typeof apifyDetails?.details !== "string" ||
  apifyDetails.details.length < 100 ||
  !apifyDetails.details.includes(actor)
) {
  throw new Error(`APIFY_FETCH_DETAILS unexpected result: ${JSON.stringify(apifyDetails).slice(0, 1200)}`);
}
console.log(`APIFY_FETCH_DETAILS=PASS actor=${actor} chars=${apifyDetails.details.length}`);
console.log("APIFY_DISCOVERY_HUB_PASS");
