import { createHash, timingSafeEqual } from "node:crypto";

const EXA_ENDPOINT = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_METHODS = new Set(["POST", "GET", "DELETE"]);
const REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
];
const RESPONSE_HEADERS = [
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
];

function sameSecret(actual, expected) {
  if (!actual || !expected) return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function json(status, body) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function buildUpstreamHeaders(request) {
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("user-agent", "Personal-MCP-Hub-Relay/1.0");
  headers.set("x-exa-source", "personal-mcp-hub-relay");

  if (process.env.EXA_API_KEY) {
    headers.set("x-api-key", process.env.EXA_API_KEY);
  }

  return headers;
}

async function boundedBody(request) {
  if (request.method === "GET" || request.method === "DELETE") return undefined;

  const advertised = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(advertised) && advertised > MAX_REQUEST_BYTES) {
    throw new RangeError("request body too large");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new RangeError("request body too large");
  }
  return bytes;
}

export default {
  async fetch(request) {
    const relaySecret = process.env.HUB_RELAY_TOKEN;
    if (!relaySecret) {
      return json(503, { ok: false, code: "RELAY_NOT_CONFIGURED" });
    }

    if (!sameSecret(request.headers.get("x-hub-relay-token"), relaySecret)) {
      return json(401, { ok: false, code: "RELAY_UNAUTHORIZED" });
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return new Response(null, {
        status: 405,
        headers: {
          allow: [...ALLOWED_METHODS].join(", "),
          "cache-control": "no-store",
        },
      });
    }

    let body;
    try {
      body = await boundedBody(request);
    } catch (error) {
      if (error instanceof RangeError) {
        return json(413, { ok: false, code: "REQUEST_TOO_LARGE" });
      }
      return json(400, { ok: false, code: "INVALID_REQUEST_BODY" });
    }

    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(request.signal.reason), {
      once: true,
    });

    let upstream;
    try {
      upstream = await fetch(EXA_ENDPOINT, {
        method: request.method,
        headers: buildUpstreamHeaders(request),
        body,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      return json(aborted ? 499 : 502, {
        ok: false,
        code: aborted ? "CLIENT_CANCELLED" : "UPSTREAM_FETCH_FAILED",
      });
    }

    const headers = new Headers({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
