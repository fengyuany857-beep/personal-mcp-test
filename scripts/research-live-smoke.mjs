import assert from "node:assert/strict";
import { searchPapers } from "../src/research/providers.ts";
import { ResearchRuntime } from "../src/research/runtime.ts";

const query = "music auditory imagery training";
const providers = ["semantic_scholar", "openalex", "crossref"];
const results = {};

for (const provider of providers) {
  const runtime = new ResearchRuntime({
    SEMANTIC_SCHOLAR_API_KEY: process.env.SEMANTIC_SCHOLAR_API_KEY,
    OPENALEX_API_KEY: process.env.OPENALEX_API_KEY,
    CONTACT_EMAIL: process.env.CONTACT_EMAIL,
  });

  const result = await searchPapers(runtime, {
    queries: [query],
    maxResults: 5,
    perProvider: 5,
    sources: [provider],
  });

  results[provider] = {
    status: result.status,
    papers: result.papers.length,
    coverage: result.coverage,
    failures: result.providersFailed,
    warnings: result.warnings,
    firstPaper: result.papers[0]
      ? {
          title: result.papers[0].title,
          doi: result.papers[0].doi,
          sources: result.papers[0].sources,
        }
      : null,
  };

  console.log(
    `LIVE_PROVIDER provider=${provider} status=${result.status} papers=${result.papers.length} failures=${JSON.stringify(result.providersFailed)}`,
  );
}

assert.notEqual(
  results.openalex.status,
  "blocked",
  `OpenAlex live integration blocked: ${JSON.stringify(results.openalex)}`,
);
assert.ok(results.openalex.papers > 0, "OpenAlex live search returned no papers");

assert.notEqual(
  results.crossref.status,
  "blocked",
  `Crossref live integration blocked: ${JSON.stringify(results.crossref)}`,
);
assert.ok(results.crossref.papers > 0, "Crossref live search returned no papers");

if (results.semantic_scholar.status === "blocked") {
  console.log(
    `SEMANTIC_SCHOLAR_LIVE=DEGRADED ${JSON.stringify(results.semantic_scholar.failures)}`,
  );
} else {
  assert.ok(results.semantic_scholar.papers > 0, "Semantic Scholar live search returned no papers");
  console.log("SEMANTIC_SCHOLAR_LIVE=PASS");
}

console.log("DIRECT_PROVIDER_LIVE=PASS");
