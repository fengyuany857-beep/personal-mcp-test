import assert from "node:assert/strict";

const endpoint = process.env.MCP_ENDPOINT;
const videoUrl = process.env.VIDEO_URL ?? "https://www.youtube.com/watch?v=teKcE8YhLhA";
if (!endpoint) throw new Error("MCP_ENDPOINT is required");

let id = 0;
let sessionId = null;

function parse(contentType, text) {
  if (contentType.includes("text/event-stream")) {
    const line = text.split(/\r?\n/).find((item) => item.startsWith("data:"));
    if (!line) throw new Error("Missing SSE data");
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

async function call(method, params = {}, notification = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const body = { jsonrpc: "2.0", method, params };
  if (!notification) body.id = ++id;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  sessionId = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  if (notification || response.status === 202) {
    if (!response.ok) throw new Error(method + " HTTP " + response.status + ": " + text);
    return null;
  }
  if (!response.ok) throw new Error(method + " HTTP " + response.status + ": " + text);
  const payload = parse(response.headers.get("content-type") ?? "", text);
  if (payload.error) throw new Error(method + " MCP error: " + JSON.stringify(payload.error));
  return payload.result;
}

const init = await call("initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "video-transcript-smoke", version: "1.0.0" },
});
assert.equal(init?.serverInfo?.name, "lattice-mcp");
await call("notifications/initialized", {}, true);

const list = await call("tools/list", {});
assert.ok((list?.tools ?? []).some((tool) => tool.name === "video.youtube_transcript"));

const result = await call("tools/call", {
  name: "video.youtube_transcript",
  arguments: {
    url: videoUrl,
    includeTimestamps: false,
    maxCharacters: 20000,
  },
});

if (result?.isError) {
  throw new Error("video.youtube_transcript failed: " + JSON.stringify(result));
}
const structured = result?.structuredContent;
assert.equal(structured?.ok, true);
assert.ok(typeof structured?.text === "string" && structured.text.length > 100);
console.log(
  "VIDEO_TRANSCRIPT=PASS provider=" +
    structured.provider +
    " language=" +
    structured.language +
    " chars=" +
    structured.text.length,
);
