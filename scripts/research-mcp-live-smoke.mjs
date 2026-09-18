import assert from "node:assert/strict";

const endpoint = process.env.MCP_ENDPOINT ?? "http://127.0.0.1:8788/mcp";
let nextId = 0;
let sessionId = null;

function parseResponseBody(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const lines = text.split(/\r?\n/).filter((line) => line.startsWith("data:"));
    if (!lines.length) throw new Error(`No SSE data frame: ${text.slice(0, 500)}`);
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

  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
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
    } catch (error) {
      lastError = error;
      if (attempt === 19) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

function getStructured(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find((entry) => entry?.type === "text")?.text;
  if (!text) throw new Error(`No structured/tool JSON: ${JSON.stringify(result)}`);
  return JSON.parse(text);
}

const init = await mcpFetch("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "research-live-smoke", version: "1.0.0" },
});
assert.equal(init?.serverInfo?.name, "personal-mcp-test");
console.log(`MCP_INITIALIZE=PASS version=${init?.serverInfo?.version}`);

await mcpFetch("notifications/initialized", {}, true);

const list = await mcpFetch("tools/list", {});
const names = (list?.tools ?? []).map((tool) => tool.name);
const researchNames = names.filter((name) => name.startsWith("research.")).sort();
assert.deepEqual(researchNames, [
  "research.citation_graph",
  "research.find_similar",
  "research.get_paper",
  "research.search_papers",
  "research.source_status",
]);
console.log(`MCP_RESEARCH_TOOLS=PASS ${JSON.stringify(researchNames)}`);

const searchCall = await mcpFetch("tools/call", {
  name: "research.search_papers",
  arguments: {
    query: ["music auditory imagery training", "audiation music education"],
    maxResults: 10,
    perProvider: 5,
    sources: ["openalex", "crossref"],
  },
});
if (searchCall?.isError) {
  throw new Error(`research.search_papers isError: ${JSON.stringify(searchCall)}`);
}
const search = getStructured(searchCall);
assert.equal(search.status, "complete");
assert.ok(Array.isArray(search.papers) && search.papers.length > 0);
assert.equal(search.coverage.requestedProviders.length, 2);
assert.equal(search.coverage.providerQueryAttempts, 4);
console.log(
  `MCP_SEARCH=PASS papers=${search.papers.length} attempts=${search.coverage.providerQueryAttempts}`,
);

const firstDoi = search.papers.find((paper) => paper.doi)?.doi;
if (firstDoi) {
  const getCall = await mcpFetch("tools/call", {
    name: "research.get_paper",
    arguments: { identifier: firstDoi },
  });
  const got = getStructured(getCall);
  assert.ok(got.paper, `get_paper failed for DOI ${firstDoi}: ${JSON.stringify(got)}`);
  console.log(`MCP_GET_PAPER=PASS doi=${firstDoi} sources=${JSON.stringify(got.paper.sources)}`);
} else {
  console.log("MCP_GET_PAPER=SKIP no DOI in bounded live search");
}

const statusCall = await mcpFetch("tools/call", {
  name: "research.source_status",
  arguments: { sources: ["semantic_scholar", "openalex", "crossref"] },
});
const status = getStructured(statusCall);
assert.ok(["complete", "partial", "blocked"].includes(status.status));
console.log(
  `MCP_SOURCE_STATUS=${String(status.status).toUpperCase()} observations=${JSON.stringify(status.observations)} failures=${JSON.stringify(status.failures)}`,
);

const s2Seed = firstDoi ?? "10.1016/s0028-3932(00)00079-8";

const similarCall = await mcpFetch("tools/call", {
  name: "research.find_similar",
  arguments: { identifier: s2Seed, maxResults: 5, pool: "recent" },
});
const similar = getStructured(similarCall);
assert.ok(["complete", "blocked"].includes(similar.status));
if (similar.status === "complete") {
  assert.ok(Array.isArray(similar.papers));
  console.log(`MCP_FIND_SIMILAR=PASS seed=${s2Seed} papers=${similar.papers.length}`);
} else {
  assert.equal(similarCall?.isError, true);
  assert.ok(Array.isArray(similar.warnings) && similar.warnings.length > 0);
  console.log(`MCP_FIND_SIMILAR=DEGRADED seed=${s2Seed} warnings=${JSON.stringify(similar.warnings)}`);
}

const graphCall = await mcpFetch("tools/call", {
  name: "research.citation_graph",
  arguments: {
    identifier: s2Seed,
    direction: "references",
    depth: 1,
    perPaperLimit: 3,
    maxNodes: 10,
  },
});
const graph = getStructured(graphCall);
assert.ok(["complete", "partial", "blocked"].includes(graph.status));
if (graph.status === "blocked") {
  assert.equal(graphCall?.isError, true);
  assert.ok(Array.isArray(graph.warnings) && graph.warnings.length > 0);
  console.log(`MCP_CITATION_GRAPH=DEGRADED seed=${s2Seed} warnings=${JSON.stringify(graph.warnings)}`);
} else {
  assert.ok(Array.isArray(graph.edges));
  console.log(`MCP_CITATION_GRAPH=PASS seed=${s2Seed} nodes=${graph.papers.length} edges=${graph.edges.length}`);
}

console.log("LOCAL_MCP_LIVE=PASS");
