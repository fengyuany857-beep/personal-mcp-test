const EXA_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const FIRECRAWL_ENDPOINT = "https://mcp.firecrawl.dev/v2/mcp";

function parseMcpPayload(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const frames = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!frames.length) throw new Error(`No SSE data frame: ${text.slice(0, 500)}`);
    return JSON.parse(frames[0].slice(5).trim());
  }
  return JSON.parse(text);
}

function createClient(endpoint, name) {
  let sessionId = null;
  let nextId = 0;
  return async function call(method, params = {}, notification = false) {
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
    if (!response.ok) throw new Error(`${name}:${method} HTTP ${response.status}: ${text.slice(0, 700)}`);
    if (notification || response.status === 202) return null;
    const payload = parseMcpPayload(response.headers.get("content-type") ?? "", text);
    if (payload.error) throw new Error(`${name}:${method} MCP error: ${JSON.stringify(payload.error)}`);
    return payload.result;
  };
}

function textContent(result) {
  return (result?.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
  return [...new Set(matches.map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

function findMarkdown(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "object") {
    if (typeof value.markdown === "string") return value.markdown;
    for (const child of Object.values(value)) {
      const found = findMarkdown(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const exa = createClient(EXA_ENDPOINT, "exa");
const firecrawl = createClient(FIRECRAWL_ENDPOINT, "firecrawl");

const exaInit = await exa("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "personal-mcp-firecrawl-chain-exa", version: "1.0.0" },
});
await exa("notifications/initialized", {}, true);
const exaTools = await exa("tools/list", {});
if (!(exaTools?.tools ?? []).some((tool) => tool.name === "web_search_exa")) {
  throw new Error("Exa missing web_search_exa");
}
console.log(`CHAIN_EXA_INITIALIZE=PASS server=${JSON.stringify(exaInit?.serverInfo ?? null)}`);

const search = await exa("tools/call", {
  name: "web_search_exa",
  arguments: {
    query: "official Model Context Protocol documentation modelcontextprotocol.io introduction",
    numResults: 5,
  },
});
if (search?.isError) throw new Error(`Exa search returned isError: ${JSON.stringify(search)}`);
const exaText = textContent(search);
const urls = extractUrls(exaText);
const selectedUrl = urls.find((url) => /modelcontextprotocol\.io/i.test(url)) ?? urls[0];
if (!selectedUrl) throw new Error(`Exa search returned no URL: ${exaText.slice(0, 1000)}`);
console.log(`CHAIN_EXA_URL=PASS ${selectedUrl}`);

const fcInit = await firecrawl("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "personal-mcp-firecrawl-chain", version: "1.0.0" },
});
await firecrawl("notifications/initialized", {}, true);
const fcTools = await firecrawl("tools/list", {});
const scrapeTool = (fcTools?.tools ?? []).find((tool) => tool.name === "firecrawl_scrape");
if (!scrapeTool) throw new Error("Firecrawl missing firecrawl_scrape");
const schema = scrapeTool.inputSchema ?? {};
if (!schema?.properties?.url || !(schema.required ?? []).includes("url")) {
  throw new Error(`Unexpected firecrawl_scrape schema: ${JSON.stringify(schema)}`);
}
console.log(`CHAIN_FIRECRAWL_INITIALIZE=PASS server=${JSON.stringify(fcInit?.serverInfo ?? null)}`);

const scraped = await firecrawl("tools/call", {
  name: "firecrawl_scrape",
  arguments: {
    url: selectedUrl,
    formats: ["markdown"],
    onlyMainContent: true,
  },
});
if (scraped?.isError) throw new Error(`Firecrawl scrape returned isError: ${JSON.stringify(scraped).slice(0, 1200)}`);

const rawText = textContent(scraped);
let parsedText = null;
try {
  parsedText = rawText ? JSON.parse(rawText) : null;
} catch {}
const markdown = findMarkdown(scraped) ?? findMarkdown(parsedText) ?? rawText;
if (typeof markdown !== "string" || markdown.trim().length < 200) {
  throw new Error(`Firecrawl markdown too short: ${JSON.stringify(scraped).slice(0, 1500)}`);
}
if (/<html[\s>]/i.test(markdown) || /<body[\s>]/i.test(markdown)) {
  throw new Error("Firecrawl returned raw HTML instead of clean markdown");
}
console.log(`CHAIN_FIRECRAWL_SCRAPE=PASS chars=${markdown.length}`);
console.log(`CHAIN_FIRECRAWL_SAMPLE=${JSON.stringify(markdown.slice(0, 220))}`);
console.log("EXA_TO_FIRECRAWL_CHAIN_PASS");
