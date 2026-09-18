import assert from "node:assert/strict";
import test from "node:test";
import {
  citationGraph,
  findSimilar,
  reciprocalRankFuse,
  searchPapers,
} from "../src/research/providers.ts";
import { ResearchRuntime } from "../src/research/runtime.ts";
import { registerResearchTools } from "../src/research/tools.ts";
import type { Paper } from "../src/research/types.ts";

function responseJson(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function paper(overrides: Partial<Paper>): Paper {
  return {
    canonicalId: overrides.canonicalId ?? "title:test:2026",
    title: overrides.title ?? "Test",
    authors: overrides.authors ?? [],
    sources: overrides.sources ?? ["semantic_scholar"],
    sourceCount: overrides.sourceCount ?? 1,
    externalIds: overrides.externalIds ?? {},
    ...overrides,
  };
}

test("RRF fusion prefers repeated cross-provider discovery, not raw citation count", () => {
  const highCitations = paper({
    canonicalId: "doi:10.1/high",
    doi: "10.1/high",
    title: "High citations only once",
    citationCount: 100000,
  });
  const repeatedA = paper({
    canonicalId: "doi:10.1/repeated",
    doi: "10.1/repeated",
    title: "Repeated paper",
    citationCount: 1,
    sources: ["semantic_scholar"],
  });
  const repeatedB = paper({
    canonicalId: "doi:10.1/repeated",
    doi: "10.1/repeated",
    title: "Repeated paper",
    citationCount: 1,
    sources: ["openalex"],
  });

  const fused = reciprocalRankFuse([[highCitations, repeatedA], [repeatedB]]);
  assert.equal(fused[0].doi, "10.1/repeated");
  assert.equal(fused[0].sourceCount, 2);
});

test("search returns PARTIAL when one provider fails and preserves successful evidence", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("semanticscholar.org")) {
      return responseJson({
        data: [
          {
            paperId: "s2-1",
            title: "Auditory imagery training",
            year: 2024,
            authors: [{ name: "A" }],
            externalIds: { DOI: "10.1000/example" },
          },
        ],
      });
    }
    if (url.includes("openalex.org")) {
      return responseJson({
        results: [
          {
            id: "https://openalex.org/W1",
            doi: "https://doi.org/10.1000/example",
            title: "Auditory imagery training",
            publication_year: 2024,
            authorships: [],
          },
        ],
      });
    }
    return new Response("temporary", { status: 503 });
  };

  const result = await searchPapers(new ResearchRuntime({}, fakeFetch), {
    queries: ["auditory imagery"],
    maxResults: 10,
    perProvider: 5,
  });

  assert.equal(result.status, "partial");
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].sourceCount, 2);
  assert.equal(result.coverage.providerQueryAttempts, 3);
  assert.equal(result.coverage.providerQuerySuccesses, 2);
  assert.deepEqual(result.coverage.failedProviders, ["crossref"]);
  assert.ok(result.providersFailed.some((failure) => failure.provider === "crossref"));
});

test("search returns BLOCKED instead of proving absence when all providers fail", async () => {
  const fakeFetch: typeof fetch = async () => new Response("down", { status: 503 });
  const result = await searchPapers(new ResearchRuntime({}, fakeFetch), {
    queries: ["anything"],
    maxResults: 10,
    perProvider: 5,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.papers.length, 0);
  assert.equal(result.providersUsed.length, 0);
});

test("findSimilar uses Semantic Scholar Recommendations endpoint", async () => {
  let seenUrl = "";
  const fakeFetch: typeof fetch = async (input) => {
    seenUrl = String(input);
    return responseJson({
      recommendedPapers: [
        {
          paperId: "s2-rec",
          title: "Related Work",
          year: 2025,
          authors: [],
          externalIds: {},
        },
      ],
    });
  };

  const result = await findSimilar(
    new ResearchRuntime({}, fakeFetch),
    "10.1000/example",
    5,
    "recent",
  );

  assert.equal(result.status, "complete");
  assert.equal(result.papers[0].semanticScholarId, "s2-rec");
  assert.match(seenUrl, /recommendations\/v1\/papers\/forpaper\/DOI%3A10\.1000%2Fexample/);
});

test("citation graph emits correctly directed cites edges", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input);

    if (/\/paper\/root\?/.test(url)) {
      return responseJson({
        paperId: "root",
        title: "Root",
        authors: [],
        externalIds: {},
      });
    }
    if (/\/paper\/root\/references\?/.test(url)) {
      return responseJson({
        data: [
          {
            citedPaper: {
              paperId: "ref-1",
              title: "Reference",
              authors: [],
              externalIds: {},
            },
          },
        ],
      });
    }
    if (/\/paper\/root\/citations\?/.test(url)) {
      return responseJson({
        data: [
          {
            citingPaper: {
              paperId: "cite-1",
              title: "Citation",
              authors: [],
              externalIds: {},
            },
          },
        ],
      });
    }

    return new Response("not found", { status: 404 });
  };

  const result = await citationGraph(
    new ResearchRuntime({}, fakeFetch),
    "root",
    "both",
    1,
    10,
    20,
  );

  assert.equal(result.status, "complete");
  assert.ok(result.edges.some((edge) => edge.from === "root" && edge.to === "ref-1"));
  assert.ok(result.edges.some((edge) => edge.from === "cite-1" && edge.to === "root"));
});


test("public research surface registers exactly the five stable tools", () => {
  const names: string[] = [];
  const fakeServer = {
    registerTool(name: string) {
      names.push(name);
    },
  };

  registerResearchTools(fakeServer as never, {});
  assert.deepEqual(names.sort(), [
    "research.citation_graph",
    "research.find_similar",
    "research.get_paper",
    "research.search_papers",
    "research.source_status",
  ]);
});
