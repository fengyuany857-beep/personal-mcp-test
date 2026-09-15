import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const SERVER_NAME = "personal-mcp-test" as const;
const SERVER_VERSION = "1.0.0" as const;

function createServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "ping",
    {
      description: "Stateless connectivity test. Returns the supplied message unchanged, or pong when omitted.",
      inputSchema: z.object({
        message: z.string().optional(),
      }),
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
      const result = {
        ok: true as const,
        message: message ?? "pong",
        server: SERVER_NAME,
      };

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
      inputSchema: z.object({
        text: z.string(),
      }),
      outputSchema: z.object({
        ok: z.literal(true),
        echo: z.string(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text }) => {
      const result = {
        ok: true as const,
        echo: text,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(createServer);

export default {
  fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname !== "/mcp") {
      return new Response("Not Found", { status: 404 });
    }

    return mcpHandler(request, env, ctx);
  },
};
