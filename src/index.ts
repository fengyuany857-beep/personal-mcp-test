import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toSafeUpstreamFailure, withUpstreamClient } from "./upstream";
import { registerResearchTools } from "./research/tools.ts";
import type { ResearchEnv } from "./research/types.ts";

const SERVER_NAME = "lattice-mcp" as const;
const SERVER_VERSION = "1.4.0" as const;
const EXA_TOOL = "web_search_exa" as const;
const EXA_ENDPOINT = `https://mcp.exa.ai/mcp?tools=${EXA_TOOL}`;
const FIRECRAWL_TOOL = "firecrawl_scrape" as const;
const FIRECRAWL_ENDPOINT = "https://mcp.firecrawl.dev/v2/mcp";
const APIFY_SEARCH_TOOL = "search-actors" as const;
const APIFY_DETAILS_TOOL = "fetch-actor-details" as const;
const APIFY_ENDPOINT = `https://mcp.apify.com?tools=${APIFY_SEARCH_TOOL},${APIFY_DETAILS_TOOL}`;
const MAX_PROXY_TEXT_CHARS = 32_000;

type Env = ResearchEnv & {
  EXA_API_KEY?: string;
  EXA_RELAY_URL?: string;
  HUB_RELAY_TOKEN?: string;
};

function capText(text: string): string {
  if (text.length <= MAX_PROXY_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_PROXY_TEXT_CHARS)}\n\n[Hub truncated upstream text at ${MAX_PROXY_TEXT_CHARS} characters.]`;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text as string)
    .join("\n");
}

function findMarkdown(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value == null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.markdown === "string") return record.markdown;
  for (const child of Object.values(record)) {
    const found = findMarkdown(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function configuredRelayUrl(env: Env): string | undefined {
  const raw = env.EXA_RELAY_URL?.trim();
  if (!raw) return undefined;

  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("MCP relay configuration error: EXA_RELAY_URL must use HTTPS");
  }
  return url.toString();
}

function createExaUpstream(env: Env) {
  const relayUrl = configuredRelayUrl(env);
  if (relayUrl) {
    if (!env.HUB_RELAY_TOKEN) {
      throw new Error("MCP relay configuration error: HUB_RELAY_TOKEN is required when EXA_RELAY_URL is set");
    }

    return {
      id: "exa",
      url: relayUrl,
      timeoutMs: 15_000,
      headers: {
        "x-hub-relay-token": env.HUB_RELAY_TOKEN,
      },
    };
  }

  return {
    id: "exa",
    url: EXA_ENDPOINT,
    timeoutMs: 15_000,
    headers: {
      "User-Agent": "Lattice-MCP/1.0",
      "x-exa-source": "lattice-mcp",
      ...(env.EXA_API_KEY ? { "x-api-key": env.EXA_API_KEY } : {}),
    },
  };
}

function createFirecrawlUpstream() {
  return {
    id: "firecrawl",
    url: FIRECRAWL_ENDPOINT,
    timeoutMs: 30_000,
  };
}

function createApifyUpstream() {
  return {
    id: "apify",
    url: APIFY_ENDPOINT,
    timeoutMs: 20_000,
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "ping",
    {
      description: "Stateless connectivity test. Returns the supplied message unchanged, or pong when omitted.",
      inputSchema: z.object({ message: z.string().optional() }),
      outputSchema: z.object({
        ok: z.literal(true),
        message: z.string(),
        server: z.literal(SERVER_NAME),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ message }) => {
      const result = { ok: true as const, message: message ?? "pong", server: SERVER_NAME };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "echo",
    {
      description: "Returns the supplied text unchanged.",
      inputSchema: z.object({ text: z.string() }),
      outputSchema: z.object({ ok: z.literal(true), echo: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ text }) => {
      const result = { ok: true as const, echo: text };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "system.upstream_status",
    {
      description: "Checks whether an allowlisted upstream MCP is reachable and exposes the expected curated tool.",
      inputSchema: z.object({ service: z.enum(["exa", "firecrawl", "apify"]) }),
      outputSchema: z.object({
        ok: z.boolean(),
        service: z.string(),
        expectedTool: z.string(),
        toolFound: z.boolean(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ service }) => {
      const expectedTool =
        service === "exa" ? EXA_TOOL : service === "firecrawl" ? FIRECRAWL_TOOL : APIFY_SEARCH_TOOL;
      const upstream =
        service === "exa" ? createExaUpstream(env) : service === "firecrawl" ? createFirecrawlUpstream() : createApifyUpstream();
      try {
        return await withUpstreamClient(upstream, async (client) => {
          const { tools } = await client.listTools();
          const toolFound = tools.some((tool) => tool.name === expectedTool);
          const result = {
            ok: toolFound,
            service,
            expectedTool,
            toolFound,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result,
          };
        });
      } catch (error) {
        const failure = toSafeUpstreamFailure(service, error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: {
            ok: false,
            service,
            expectedTool,
            toolFound: false,
          },
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "search.exa_search",
    {
      description: "L0/L1 read-only web discovery through the allowlisted Exa MCP web_search_exa tool.",
      inputSchema: z.object({
        query: z.string().min(1).max(4_000),
        numResults: z.number().int().min(1).max(25).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, numResults }) => {
      try {
        return await withUpstreamClient(createExaUpstream(env), async (client) => {
          const { tools } = await client.listTools();
          const tool = tools.find((candidate) => candidate.name === EXA_TOOL);
          if (!tool) throw new Error(`MCP protocol drift: missing ${EXA_TOOL}`);

          const result = await client.callTool(
            {
              name: EXA_TOOL,
              arguments: {
                query,
                ...(numResults !== undefined ? { numResults } : {}),
              },
            },
            undefined,
            { toolDefinition: tool },
          );

          return {
            ...result,
            content: result.content.map((entry) =>
              entry.type === "text" ? { ...entry, text: capText(entry.text) } : entry,
            ),
          };
        });
      } catch (error) {
        const failure = toSafeUpstreamFailure("exa", error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "crawl.firecrawl_scrape",
    {
      description: "L0/L1 read-only page extraction through the allowlisted Firecrawl MCP firecrawl_scrape tool. Returns clean main-content Markdown.",
      inputSchema: z.object({
        url: z.string().url(),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        url: z.string(),
        markdown: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ url }) => {
      try {
        return await withUpstreamClient(createFirecrawlUpstream(), async (client) => {
          const { tools } = await client.listTools();
          const tool = tools.find((candidate) => candidate.name === FIRECRAWL_TOOL);
          if (!tool) throw new Error(`MCP protocol drift: missing ${FIRECRAWL_TOOL}`);

          const upstreamResult = await client.callTool(
            {
              name: FIRECRAWL_TOOL,
              arguments: {
                url,
                formats: ["markdown"],
                onlyMainContent: true,
              },
            },
            undefined,
            { toolDefinition: tool },
          );
          if (upstreamResult.isError) throw new Error("MCP protocol error: firecrawl_scrape returned isError");

          let markdown = findMarkdown(upstreamResult.structuredContent);
          if (!markdown) {
            for (const entry of upstreamResult.content) {
              if (entry.type !== "text") continue;
              try {
                markdown = findMarkdown(JSON.parse(entry.text));
              } catch {
                if (entry.text.trim()) markdown = entry.text;
              }
              if (markdown) break;
            }
          }
          if (!markdown) throw new Error("MCP protocol drift: firecrawl_scrape returned no Markdown");

          const result = { ok: true as const, url, markdown: capText(markdown) };
          return {
            content: [{ type: "text" as const, text: result.markdown }],
            structuredContent: result,
          };
        });
      } catch (error) {
        const failure = toSafeUpstreamFailure("firecrawl", error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "actor.search",
    {
      description: "Read-only discovery of existing Actors in Apify Store. This tool never runs an Actor.",
      inputSchema: z.object({
        keywords: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(10).optional(),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        keywords: z.string(),
        results: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ keywords, limit }) => {
      try {
        return await withUpstreamClient(createApifyUpstream(), async (client) => {
          const { tools } = await client.listTools();
          const tool = tools.find((candidate) => candidate.name === APIFY_SEARCH_TOOL);
          if (!tool) throw new Error(`MCP protocol drift: missing ${APIFY_SEARCH_TOOL}`);

          const upstreamResult = await client.callTool(
            {
              name: APIFY_SEARCH_TOOL,
              arguments: {
                keywords: keywords ?? "",
                limit: limit ?? 5,
                offset: 0,
              },
            },
            undefined,
            { toolDefinition: tool },
          );
          if (upstreamResult.isError) throw new Error("MCP protocol error: search-actors returned isError");
          const results = capText(textContent(upstreamResult));
          if (!results) throw new Error("MCP protocol drift: search-actors returned no text");

          const result = { ok: true as const, keywords: keywords ?? "", results };
          return {
            content: [{ type: "text" as const, text: results }],
            structuredContent: result,
          };
        });
      } catch (error) {
        const failure = toSafeUpstreamFailure("apify", error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "actor.fetch_details",
    {
      description: "Read-only metadata lookup for one existing Apify Actor. Returns description, usage stats, pricing, rating, metadata, and input schema. This tool never runs an Actor.",
      inputSchema: z.object({
        actor: z.string().min(3).max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        actor: z.string(),
        details: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      },
    },
    async ({ actor }) => {
      try {
        return await withUpstreamClient(createApifyUpstream(), async (client) => {
          const { tools } = await client.listTools();
          const tool = tools.find((candidate) => candidate.name === APIFY_DETAILS_TOOL);
          if (!tool) throw new Error(`MCP protocol drift: missing ${APIFY_DETAILS_TOOL}`);

          const upstreamResult = await client.callTool(
            {
              name: APIFY_DETAILS_TOOL,
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
            },
            undefined,
            { toolDefinition: tool },
          );
          if (upstreamResult.isError) throw new Error("MCP protocol error: fetch-actor-details returned isError");
          const details = capText(textContent(upstreamResult));
          if (!details) throw new Error("MCP protocol drift: fetch-actor-details returned no text");

          const result = { ok: true as const, actor, details };
          return {
            content: [{ type: "text" as const, text: details }],
            structuredContent: result,
          };
        });
      } catch (error) {
        const failure = toSafeUpstreamFailure("apify", error);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(failure) }],
          structuredContent: failure,
          isError: true,
        };
      }
    },
  );

  registerResearchTools(server, env);

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
