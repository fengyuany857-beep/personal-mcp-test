import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { toSafeUpstreamFailure, withUpstreamClient } from "./upstream";

const SERVER_NAME = "personal-mcp-test" as const;
const SERVER_VERSION = "1.1.0" as const;
const EXA_TOOL = "web_search_exa" as const;
const EXA_ENDPOINT = `https://mcp.exa.ai/mcp?tools=${EXA_TOOL}`;
const MAX_PROXY_TEXT_CHARS = 32_000;

type Env = {
  EXA_API_KEY?: string;
};

function capText(text: string): string {
  if (text.length <= MAX_PROXY_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_PROXY_TEXT_CHARS)}\n\n[Hub truncated upstream text at ${MAX_PROXY_TEXT_CHARS} characters.]`;
}

function createExaUpstream(env: Env) {
  return {
    id: "exa",
    url: EXA_ENDPOINT,
    timeoutMs: 15_000,
    headers: {
      "User-Agent": "Personal-MCP-Hub/1.0",
      "x-exa-source": "personal-mcp-hub",
      ...(env.EXA_API_KEY ? { "x-api-key": env.EXA_API_KEY } : {}),
    },
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
      inputSchema: z.object({ service: z.enum(["exa"]) }),
      outputSchema: z.object({
        ok: z.boolean(),
        service: z.string(),
        expectedTool: z.string(),
        toolFound: z.boolean(),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ service }) => {
      try {
        return await withUpstreamClient(createExaUpstream(env), async (client) => {
          const { tools } = await client.listTools();
          const toolFound = tools.some((tool) => tool.name === EXA_TOOL);
          const result = {
            ok: toolFound,
            service,
            expectedTool: EXA_TOOL,
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
            expectedTool: EXA_TOOL,
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

  return server;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
};
