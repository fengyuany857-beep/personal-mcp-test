import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  citationGraph,
  findSimilar,
  getPaper,
  probeProvider,
  searchPapers,
} from "./providers.ts";
import { ResearchRuntime, toProviderFailure } from "./runtime.ts";
import type { ProviderName, ResearchEnv } from "./types.ts";

const PROVIDERS = ["semantic_scholar", "openalex", "crossref"] as const;

export function registerResearchTools(server: McpServer, env: ResearchEnv): void {
  server.registerTool(
    "research.search_papers",
    {
      description:
        "Read-only federated academic search across Semantic Scholar, OpenAlex, and Crossref. Returns explicit partial/blocked states instead of treating provider failures or empty results as proof of absence.",
      inputSchema: z.object({
        query: z.union([
          z.string().min(1).max(500),
          z.array(z.string().min(1).max(500)).min(1).max(5),
        ]),
        maxResults: z.number().int().min(1).max(50).default(20),
        perProvider: z.number().int().min(1).max(25).default(10),
        sources: z.array(z.enum(PROVIDERS)).min(1).max(3).optional(),
        yearFrom: z.number().int().min(1600).max(2100).optional(),
        yearTo: z.number().int().min(1600).max(2100).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ query, maxResults, perProvider, sources, yearFrom, yearTo }) => {
      if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) {
        return jsonResult(
          {
            status: "blocked",
            code: "INVALID_DATE_RANGE",
            message: "yearFrom must be less than or equal to yearTo.",
          },
          true,
        );
      }

      const queries = (Array.isArray(query) ? query : [query])
        .map((item) => item.trim())
        .filter(Boolean);
      const runtime = new ResearchRuntime(env);
      const result = await searchPapers(runtime, {
        queries,
        maxResults,
        perProvider,
        sources,
        yearFrom,
        yearTo,
      });
      return jsonResult(result, result.status === "blocked");
    },
  );

  server.registerTool(
    "research.get_paper",
    {
      description:
        "Read-only paper metadata lookup by DOI, Semantic Scholar identifier, OpenAlex W-id, PMID/ARXIV-style Semantic Scholar identifier, with cross-provider merge where applicable.",
      inputSchema: z.object({
        identifier: z.string().min(1).max(500),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier }) => {
      const runtime = new ResearchRuntime(env);
      const result = await getPaper(runtime, identifier.trim());
      return jsonResult(result, result.status === "blocked");
    },
  );

  server.registerTool(
    "research.find_similar",
    {
      description:
        "Read-only related-paper discovery using the official Semantic Scholar Recommendations API. Recommendation relevance is not treated as evidence quality.",
      inputSchema: z.object({
        identifier: z.string().min(1).max(500),
        maxResults: z.number().int().min(1).max(50).default(20),
        pool: z.enum(["recent", "all-cs"]).default("recent"),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier, maxResults, pool }) => {
      const runtime = new ResearchRuntime(env);
      const result = await findSimilar(runtime, identifier.trim(), maxResults, pool);
      return jsonResult(result, result.status === "blocked");
    },
  );

  server.registerTool(
    "research.citation_graph",
    {
      description:
        "Read-only bounded citation/reference traversal through Semantic Scholar. Depth is capped at 2 and total nodes are capped to prevent runaway graph expansion.",
      inputSchema: z.object({
        identifier: z.string().min(1).max(500),
        direction: z.enum(["citations", "references", "both"]).default("both"),
        depth: z.number().int().min(1).max(2).default(1),
        perPaperLimit: z.number().int().min(1).max(25).default(10),
        maxNodes: z.number().int().min(5).max(75).default(40),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ identifier, direction, depth, perPaperLimit, maxNodes }) => {
      const runtime = new ResearchRuntime(env);
      const result = await citationGraph(
        runtime,
        identifier.trim(),
        direction,
        depth,
        perPaperLimit,
        maxNodes,
      );
      return jsonResult(result, result.status === "blocked");
    },
  );

  server.registerTool(
    "research.source_status",
    {
      description:
        "Read-only bounded health probe for academic providers. Reports live observed state and rate-limit headers when available; it never reports AVAILABLE without an observed successful request in this call.",
      inputSchema: z.object({
        sources: z.array(z.enum(PROVIDERS)).min(1).max(3).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: false,
      },
    },
    async ({ sources }) => {
      const selected = (sources?.length ? sources : [...PROVIDERS]) as ProviderName[];
      const runtime = new ResearchRuntime(env);
      const failures = [];

      await Promise.all(
        selected.map(async (provider) => {
          try {
            await probeProvider(runtime, provider);
          } catch (error) {
            failures.push(toProviderFailure(provider, error));
          }
        }),
      );

      const observations = runtime.snapshots(selected);
      const available = observations.filter((item) => item.state === "AVAILABLE").length;
      const status = available === 0 ? "blocked" : failures.length > 0 ? "partial" : "complete";

      return jsonResult(
        {
          status,
          observations,
          failures,
          configured: {
            semanticScholarApiKey: Boolean(env.SEMANTIC_SCHOLAR_API_KEY),
            openAlexApiKey: Boolean(env.OPENALEX_API_KEY),
            contactEmail: Boolean(env.CONTACT_EMAIL),
          },
        },
        status === "blocked",
      );
    },
  );
}

function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}
