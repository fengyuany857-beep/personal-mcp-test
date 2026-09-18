/*
 * Portions of the provider-normalization approach in this file are adapted from
 * Devil-Galois/paper-search-mcp, commit
 * 48220407b540bc027848e45fb5a7a8a37d37d190, src/providers.js.
 * Upstream license: MIT. See THIRD_PARTY_NOTICES.md.
 */

import { ResearchRuntime, toProviderFailure } from "./runtime.ts";
import type {
  CitationEdge,
  CitationGraphResult,
  GetPaperResult,
  Paper,
  ProviderFailure,
  ProviderName,
  SearchResult,
  SimilarResult,
} from "./types.ts";

const CORE_PROVIDERS: ProviderName[] = ["semantic_scholar", "openalex", "crossref"];

const S2_FIELDS = [
  "paperId",
  "title",
  "abstract",
  "year",
  "publicationDate",
  "venue",
  "authors",
  "citationCount",
  "referenceCount",
  "externalIds",
  "url",
  "openAccessPdf",
].join(",");

export type SearchInput = {
  queries: string[];
  maxResults: number;
  perProvider: number;
  sources?: ProviderName[];
  yearFrom?: number;
  yearTo?: number;
};

export async function searchPapers(
  runtime: ResearchRuntime,
  input: SearchInput,
): Promise<SearchResult> {
  const providers = uniqueProviders(input.sources?.length ? input.sources : CORE_PROVIDERS);
  const lists: Paper[][] = [];
  const failures: ProviderFailure[] = [];
  const provenance: SearchResult["provenance"] = [];
  const providersUsed = new Set<ProviderName>();

  await Promise.all(
    input.queries.flatMap((query) =>
      providers.map(async (provider) => {
        try {
          const papers = await searchProvider(runtime, provider, {
            query,
            maxResults: input.perProvider,
            yearFrom: input.yearFrom,
            yearTo: input.yearTo,
          });
          lists.push(papers);
          providersUsed.add(provider);
          provenance.push({ provider, query });
        } catch (error) {
          failures.push(toProviderFailure(provider, error));
        }
      }),
    ),
  );

  const papers = reciprocalRankFuse(lists).slice(0, input.maxResults);
  const used = [...providersUsed];
  const status = used.length === 0 ? "blocked" : failures.length > 0 ? "partial" : "complete";
  const warnings = failures.map(
    (failure) => `${failure.provider}: ${failure.code} - ${failure.message}`,
  );

  if (papers.length === 0 && used.length > 0) {
    warnings.push("EMPTY_SEARCH_RESULT: no papers matched this bounded search. This does not prove absence.");
  }

  return {
    status,
    queries: input.queries,
    papers,
    coverage: {
      requestedProviders: providers,
      successfulProviders: used,
      failedProviders: [...new Set(failures.map((failure) => failure.provider))],
      queryCount: input.queries.length,
      providerQueryAttempts: input.queries.length * providers.length,
      providerQuerySuccesses: provenance.length,
      returnedPapers: papers.length,
    },
    providersUsed: used,
    providersFailed: dedupeFailures(failures),
    warnings,
    provenance,
  };
}

export async function getPaper(
  runtime: ResearchRuntime,
  identifier: string,
): Promise<GetPaperResult> {
  const providers = providersForIdentifier(identifier);
  const failures: ProviderFailure[] = [];
  const providersUsed = new Set<ProviderName>();
  const papers: Paper[] = [];

  await Promise.all(
    providers.map(async (provider) => {
      try {
        const paper = await getPaperFromProvider(runtime, provider, identifier);
        if (paper) {
          papers.push(paper);
          providersUsed.add(provider);
        }
      } catch (error) {
        failures.push(toProviderFailure(provider, error));
      }
    }),
  );

  const merged = mergeMany(papers);
  const used = [...providersUsed];
  const status =
    used.length === 0 && failures.length > 0
      ? "blocked"
      : failures.length > 0
        ? "partial"
        : "complete";
  const warnings = failures.map(
    (failure) => `${failure.provider}: ${failure.code} - ${failure.message}`,
  );

  if (!merged && used.length === 0 && failures.length === 0) {
    warnings.push("NOT_FOUND: the identifier was not resolved by the bounded provider set.");
  }

  return {
    status,
    identifier,
    paper: merged,
    providersUsed: used,
    providersFailed: dedupeFailures(failures),
    warnings,
  };
}

export async function findSimilar(
  runtime: ResearchRuntime,
  identifier: string,
  maxResults: number,
  pool: "recent" | "all-cs",
): Promise<SimilarResult> {
  const paperId = normalizeS2Identifier(identifier);
  const params = new URLSearchParams({
    fields: S2_FIELDS,
    limit: String(Math.min(maxResults, 100)),
    from: pool,
  });

  try {
    const data = await runtime.getJson<{ recommendedPapers?: unknown[] }>(
      "semantic_scholar",
      `https://api.semanticscholar.org/recommendations/v1/papers/forpaper/${encodeURIComponent(
        paperId,
      )}?${params}`,
      { headers: semanticScholarHeaders(runtime) },
    );

    const papers = (data.recommendedPapers ?? [])
      .map((paper) => normalizeSemanticScholarPaper(paper))
      .filter((paper): paper is Paper => paper !== null)
      .slice(0, maxResults);

    return {
      status: "complete",
      seed: identifier,
      papers,
      provider: "semantic_scholar",
      warnings: [],
    };
  } catch (error) {
    const failure = toProviderFailure("semantic_scholar", error);
    return {
      status: "blocked",
      seed: identifier,
      papers: [],
      provider: "semantic_scholar",
      warnings: [`${failure.code}: ${failure.message}`],
    };
  }
}

export async function citationGraph(
  runtime: ResearchRuntime,
  identifier: string,
  direction: "citations" | "references" | "both",
  depth: number,
  perPaperLimit: number,
  maxNodes: number,
): Promise<CitationGraphResult> {
  const rootId = normalizeS2Identifier(identifier);
  const papersByKey = new Map<string, Paper>();
  const edges: CitationEdge[] = [];
  const failures: ProviderFailure[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  const visited = new Set<string>();
  let providerWorked = false;

  while (queue.length > 0 && papersByKey.size < maxNodes) {
    const current = queue.shift()!;
    const currentKey = current.id.toLowerCase();
    if (visited.has(currentKey)) continue;
    visited.add(currentKey);

    const currentResult = await getPaper(runtime, current.id);
    if (currentResult.paper) {
      providerWorked = providerWorked || currentResult.providersUsed.includes("semantic_scholar");
      papersByKey.set(paperKey(currentResult.paper), currentResult.paper);
    }
    failures.push(...currentResult.providersFailed.filter((f) => f.provider === "semantic_scholar"));

    if (current.depth >= depth) continue;

    const directions =
      direction === "both" ? (["citations", "references"] as const) : ([direction] as const);

    for (const relation of directions) {
      try {
        const neighbors = await fetchS2GraphNeighbors(
          runtime,
          current.id,
          relation,
          perPaperLimit,
        );
        providerWorked = true;

        for (const neighbor of neighbors) {
          if (papersByKey.size >= maxNodes) break;
          const key = paperKey(neighbor);
          const neighborId = neighbor.semanticScholarId ?? neighbor.canonicalId;
          papersByKey.set(key, mergePaper(papersByKey.get(key), neighbor));

          if (relation === "references") {
            edges.push({ from: current.id, to: neighborId, relation: "cites" });
          } else {
            edges.push({ from: neighborId, to: current.id, relation: "cites" });
          }

          if (current.depth + 1 < depth) {
            queue.push({ id: neighborId, depth: current.depth + 1 });
          }
        }
      } catch (error) {
        failures.push(toProviderFailure("semantic_scholar", error));
      }
    }
  }

  const uniqueFailures = dedupeFailures(failures);
  const status = providerWorked ? (uniqueFailures.length > 0 ? "partial" : "complete") : "blocked";
  return {
    status,
    root: identifier,
    direction,
    depth,
    papers: [...papersByKey.values()],
    edges: dedupeEdges(edges),
    providersUsed: providerWorked ? ["semantic_scholar"] : [],
    providersFailed: uniqueFailures,
    warnings: uniqueFailures.map(
      (failure) => `${failure.provider}: ${failure.code} - ${failure.message}`,
    ),
  };
}

export async function probeProvider(
  runtime: ResearchRuntime,
  provider: ProviderName,
): Promise<void> {
  await searchProvider(runtime, provider, { query: "research", maxResults: 1 });
}

async function searchProvider(
  runtime: ResearchRuntime,
  provider: ProviderName,
  input: {
    query: string;
    maxResults: number;
    yearFrom?: number;
    yearTo?: number;
  },
): Promise<Paper[]> {
  if (provider === "semantic_scholar") return searchSemanticScholar(runtime, input);
  if (provider === "openalex") return searchOpenAlex(runtime, input);
  return searchCrossref(runtime, input);
}

async function searchSemanticScholar(
  runtime: ResearchRuntime,
  input: { query: string; maxResults: number; yearFrom?: number; yearTo?: number },
): Promise<Paper[]> {
  const params = new URLSearchParams({
    query: sanitizeS2Query(input.query),
    limit: String(Math.min(input.maxResults, 100)),
    fields: S2_FIELDS,
  });
  if (input.yearFrom || input.yearTo) {
    params.set("year", `${input.yearFrom ?? ""}-${input.yearTo ?? ""}`);
  }

  const data = await runtime.getJson<{ data?: unknown[] }>(
    "semantic_scholar",
    `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
    { headers: semanticScholarHeaders(runtime) },
  );

  return (data.data ?? [])
    .map((paper) => normalizeSemanticScholarPaper(paper))
    .filter((paper): paper is Paper => paper !== null);
}

async function searchOpenAlex(
  runtime: ResearchRuntime,
  input: { query: string; maxResults: number; yearFrom?: number; yearTo?: number },
): Promise<Paper[]> {
  const params = new URLSearchParams({
    search: input.query,
    per_page: String(Math.min(input.maxResults, 100)),
  });
  const filters: string[] = [];
  if (input.yearFrom) filters.push(`from_publication_date:${input.yearFrom}-01-01`);
  if (input.yearTo) filters.push(`to_publication_date:${input.yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));
  applyOpenAlexAuth(runtime, params);

  const data = await runtime.getJson<{ results?: unknown[] }>(
    "openalex",
    `https://api.openalex.org/works?${params}`,
  );

  return (data.results ?? [])
    .map((paper) => normalizeOpenAlexPaper(paper))
    .filter((paper): paper is Paper => paper !== null);
}

async function searchCrossref(
  runtime: ResearchRuntime,
  input: { query: string; maxResults: number; yearFrom?: number; yearTo?: number },
): Promise<Paper[]> {
  const params = new URLSearchParams({
    query: input.query,
    rows: String(Math.min(input.maxResults, 100)),
  });
  const filters: string[] = [];
  if (input.yearFrom) filters.push(`from-pub-date:${input.yearFrom}-01-01`);
  if (input.yearTo) filters.push(`until-pub-date:${input.yearTo}-12-31`);
  if (filters.length > 0) params.set("filter", filters.join(","));
  if (runtime.env.CONTACT_EMAIL) params.set("mailto", runtime.env.CONTACT_EMAIL);

  const data = await runtime.getJson<{ message?: { items?: unknown[] } }>(
    "crossref",
    `https://api.crossref.org/works?${params}`,
    { headers: { "User-Agent": crossrefUserAgent(runtime) } },
  );

  return (data.message?.items ?? [])
    .map((paper) => normalizeCrossrefPaper(paper))
    .filter((paper): paper is Paper => paper !== null);
}

async function getPaperFromProvider(
  runtime: ResearchRuntime,
  provider: ProviderName,
  identifier: string,
): Promise<Paper | null> {
  if (provider === "semantic_scholar") {
    const data = await runtime.getJson<unknown>(
      "semantic_scholar",
      `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
        normalizeS2Identifier(identifier),
      )}?fields=${encodeURIComponent(S2_FIELDS)}`,
      { headers: semanticScholarHeaders(runtime) },
    );
    return normalizeSemanticScholarPaper(data);
  }

  if (provider === "openalex") {
    const openAlexId = normalizeOpenAlexIdentifier(identifier);
    if (!openAlexId) return null;
    const params = new URLSearchParams();
    applyOpenAlexAuth(runtime, params);
    const data = await runtime.getJson<unknown>(
      "openalex",
      `https://api.openalex.org/works/${encodeURIComponent(openAlexId)}${params.size ? `?${params}` : ""}`,
    );
    return normalizeOpenAlexPaper(data);
  }

  if (!looksLikeDoi(identifier)) return null;
  const params = new URLSearchParams();
  if (runtime.env.CONTACT_EMAIL) params.set("mailto", runtime.env.CONTACT_EMAIL);
  const data = await runtime.getJson<{ message?: unknown }>(
    "crossref",
    `https://api.crossref.org/works/${encodeURIComponent(stripDoiPrefix(identifier))}${params.size ? `?${params}` : ""}`,
    { headers: { "User-Agent": crossrefUserAgent(runtime) } },
  );
  return data.message ? normalizeCrossrefPaper(data.message) : null;
}

async function fetchS2GraphNeighbors(
  runtime: ResearchRuntime,
  identifier: string,
  direction: "citations" | "references",
  limit: number,
): Promise<Paper[]> {
  const fields = [
    "title",
    "abstract",
    "year",
    "publicationDate",
    "venue",
    "authors",
    "citationCount",
    "referenceCount",
    "externalIds",
    "url",
    "openAccessPdf",
  ].join(",");
  const params = new URLSearchParams({
    limit: String(Math.min(limit, 1000)),
    fields,
  });

  const data = await runtime.getJson<{ data?: unknown[] }>(
    "semantic_scholar",
    `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(
      normalizeS2Identifier(identifier),
    )}/${direction}?${params}`,
    { headers: semanticScholarHeaders(runtime) },
  );

  const childField = direction === "citations" ? "citingPaper" : "citedPaper";
  return (data.data ?? [])
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      return normalizeSemanticScholarPaper((entry as Record<string, unknown>)[childField]);
    })
    .filter((paper): paper is Paper => paper !== null);
}

export function reciprocalRankFuse(lists: Paper[][]): Paper[] {
  const byKey = new Map<string, { paper: Paper; score: number; firstSeen: number }>();
  let firstSeen = 0;

  for (const list of lists) {
    list.forEach((paper, index) => {
      const key = paperKey(paper);
      const existing = byKey.get(key);
      const score = 1 / (60 + index + 1);
      if (!existing) {
        byKey.set(key, { paper, score, firstSeen: firstSeen++ });
      } else {
        existing.paper = mergePaper(existing.paper, paper);
        existing.score += score;
      }
    });
  }

  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map(({ paper }) => paper);
}

export function normalizeSemanticScholarPaper(value: unknown): Paper | null {
  if (!value || typeof value !== "object") return null;
  const paper = value as Record<string, unknown>;
  const title = asString(paper.title);
  if (!title) return null;

  const external = asRecord(paper.externalIds);
  const doi = normalizeDoi(asString(external?.DOI));
  const semanticScholarId = asString(paper.paperId);
  const arxivId = asString(external?.ArXiv);
  const pmid = asString(external?.PubMed);

  return finalizePaper({
    canonicalId: doi
      ? `doi:${doi}`
      : semanticScholarId
        ? `s2:${semanticScholarId}`
        : `title:${fingerprintTitle(title)}:${asNumber(paper.year) ?? "unknown"}`,
    title,
    authors: asArray(paper.authors)
      .map((author) => asString(asRecord(author)?.name))
      .filter((author): author is string => Boolean(author)),
    year: asNumber(paper.year),
    publishedDate: asString(paper.publicationDate),
    venue: asString(paper.venue),
    abstract: asString(paper.abstract),
    doi,
    semanticScholarId,
    arxivId,
    pmid,
    url: asString(paper.url),
    pdfUrl: asString(asRecord(paper.openAccessPdf)?.url),
    citationCount: asNumber(paper.citationCount),
    referenceCount: asNumber(paper.referenceCount),
    sources: ["semantic_scholar"],
    sourceCount: 1,
    externalIds: compactStrings({
      DOI: doi,
      SemanticScholar: semanticScholarId,
      ArXiv: arxivId,
      PMID: pmid,
    }),
  });
}

export function normalizeOpenAlexPaper(value: unknown): Paper | null {
  if (!value || typeof value !== "object") return null;
  const work = value as Record<string, unknown>;
  const title = asString(work.title);
  if (!title) return null;

  const doi = normalizeDoi(asString(work.doi));
  const openAlexId = stripOpenAlexUrl(asString(work.id));
  const authors = asArray(work.authorships)
    .map((item) => asString(asRecord(asRecord(item)?.author)?.display_name))
    .filter((author): author is string => Boolean(author));
  const primaryLocation = asRecord(work.primary_location);
  const source = asRecord(primaryLocation?.source);
  const openAccess = asRecord(work.open_access);
  const ids = asRecord(work.ids);

  return finalizePaper({
    canonicalId: doi
      ? `doi:${doi}`
      : openAlexId
        ? `openalex:${openAlexId}`
        : `title:${fingerprintTitle(title)}:${asNumber(work.publication_year) ?? "unknown"}`,
    title,
    authors,
    year: asNumber(work.publication_year),
    publishedDate: asString(work.publication_date),
    venue: asString(source?.display_name),
    abstract: invertOpenAlexAbstract(asRecord(work.abstract_inverted_index)),
    doi,
    openAlexId,
    url: asString(primaryLocation?.landing_page_url) ?? asString(work.id),
    pdfUrl: asString(primaryLocation?.pdf_url) ?? asString(openAccess?.oa_url),
    citationCount: asNumber(work.cited_by_count),
    referenceCount: asNumber(work.referenced_works_count),
    sources: ["openalex"],
    sourceCount: 1,
    externalIds: compactStrings({
      DOI: doi,
      OpenAlex: openAlexId,
      PMID: stripPrefix(asString(ids?.pmid), "https://pubmed.ncbi.nlm.nih.gov/"),
    }),
  });
}

export function normalizeCrossrefPaper(value: unknown): Paper | null {
  if (!value || typeof value !== "object") return null;
  const work = value as Record<string, unknown>;
  const title = firstString(work.title);
  if (!title) return null;

  const doi = normalizeDoi(asString(work.DOI));
  const year = extractCrossrefYear(work);
  const authors = asArray(work.author)
    .map((author) => {
      const record = asRecord(author);
      return [asString(record?.given), asString(record?.family)].filter(Boolean).join(" ");
    })
    .filter(Boolean);

  return finalizePaper({
    canonicalId: doi ? `doi:${doi}` : `title:${fingerprintTitle(title)}:${year ?? "unknown"}`,
    title,
    authors,
    year,
    venue: firstString(work["container-title"]),
    abstract: stripTags(asString(work.abstract)),
    doi,
    url: asString(work.URL),
    citationCount: asNumber(work["is-referenced-by-count"]),
    referenceCount: asArray(work.reference).length || undefined,
    sources: ["crossref"],
    sourceCount: 1,
    externalIds: compactStrings({ DOI: doi }),
  });
}

export function mergePaper(left: Paper | undefined, right: Paper): Paper {
  if (!left) return right;
  const sources = [...new Set([...left.sources, ...right.sources])];

  return finalizePaper({
    canonicalId: chooseCanonicalId(left, right),
    title: richerString(left.title, right.title) ?? left.title,
    authors: left.authors.length >= right.authors.length ? left.authors : right.authors,
    year: left.year ?? right.year,
    publishedDate: left.publishedDate ?? right.publishedDate,
    venue: richerString(left.venue, right.venue),
    abstract: richerString(left.abstract, right.abstract),
    doi: left.doi ?? right.doi,
    semanticScholarId: left.semanticScholarId ?? right.semanticScholarId,
    openAlexId: left.openAlexId ?? right.openAlexId,
    arxivId: left.arxivId ?? right.arxivId,
    pmid: left.pmid ?? right.pmid,
    url: left.url ?? right.url,
    pdfUrl: left.pdfUrl ?? right.pdfUrl,
    citationCount: maxDefined(left.citationCount, right.citationCount),
    referenceCount: maxDefined(left.referenceCount, right.referenceCount),
    sources,
    sourceCount: sources.length,
    externalIds: { ...right.externalIds, ...left.externalIds },
  });
}

function mergeMany(papers: Paper[]): Paper | null {
  if (papers.length === 0) return null;
  return papers.slice(1).reduce((acc, paper) => mergePaper(acc, paper), papers[0]);
}

function paperKey(paper: Paper): string {
  return paper.doi
    ? `doi:${paper.doi.toLowerCase()}`
    : paper.semanticScholarId
      ? `s2:${paper.semanticScholarId}`
      : paper.openAlexId
        ? `openalex:${paper.openAlexId}`
        : `title:${fingerprintTitle(paper.title)}:${paper.year ?? "unknown"}`;
}

function providersForIdentifier(identifier: string): ProviderName[] {
  if (looksLikeDoi(identifier)) return CORE_PROVIDERS;
  if (/^(?:https:\/\/openalex\.org\/)?W\d+$/i.test(identifier)) {
    return ["openalex", "semantic_scholar"];
  }
  return ["semantic_scholar"];
}

function normalizeS2Identifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (looksLikeDoi(trimmed)) return `DOI:${stripDoiPrefix(trimmed)}`;
  return trimmed;
}

function normalizeOpenAlexIdentifier(identifier: string): string | null {
  const trimmed = identifier.trim();
  if (looksLikeDoi(trimmed)) return `https://doi.org/${stripDoiPrefix(trimmed)}`;
  const id = stripOpenAlexUrl(trimmed);
  return id && /^W\d+$/i.test(id) ? id : null;
}

function semanticScholarHeaders(runtime: ResearchRuntime): Record<string, string> {
  return runtime.env.SEMANTIC_SCHOLAR_API_KEY
    ? { "x-api-key": runtime.env.SEMANTIC_SCHOLAR_API_KEY }
    : {};
}

function applyOpenAlexAuth(runtime: ResearchRuntime, params: URLSearchParams): void {
  if (runtime.env.OPENALEX_API_KEY) params.set("api_key", runtime.env.OPENALEX_API_KEY);
  if (runtime.env.CONTACT_EMAIL) params.set("mailto", runtime.env.CONTACT_EMAIL);
}

function crossrefUserAgent(runtime: ResearchRuntime): string {
  return runtime.env.CONTACT_EMAIL
    ? `Personal-MCP-Hub/1.0 (mailto:${runtime.env.CONTACT_EMAIL})`
    : "Personal-MCP-Hub/1.0";
}

function sanitizeS2Query(query: string): string {
  return query.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function finalizePaper(paper: Paper): Paper {
  return {
    ...paper,
    authors: [...new Set(paper.authors.filter(Boolean))],
    sources: [...new Set(paper.sources)],
    sourceCount: new Set(paper.sources).size,
    externalIds: compactStrings(paper.externalIds),
  };
}

function chooseCanonicalId(a: Paper, b: Paper): string {
  if (a.doi || b.doi) return `doi:${(a.doi ?? b.doi)!.toLowerCase()}`;
  if (a.semanticScholarId || b.semanticScholarId) {
    return `s2:${a.semanticScholarId ?? b.semanticScholarId}`;
  }
  if (a.openAlexId || b.openAlexId) return `openalex:${a.openAlexId ?? b.openAlexId}`;
  return a.canonicalId;
}

function dedupeFailures(failures: ProviderFailure[]): ProviderFailure[] {
  const map = new Map<string, ProviderFailure>();
  for (const failure of failures) {
    map.set(`${failure.provider}:${failure.code}:${failure.httpStatus ?? ""}`, failure);
  }
  return [...map.values()];
}

function dedupeEdges(edges: CitationEdge[]): CitationEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}->${edge.to}:${edge.relation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueProviders(providers: ProviderName[]): ProviderName[] {
  return [...new Set(providers)];
}

function compactStrings(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstString(value: unknown): string | undefined {
  return asArray(value).map(asString).find(Boolean) ?? asString(value);
}

function richerString(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.length >= b.length ? a : b;
}

function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function normalizeDoi(value?: string): string | undefined {
  if (!value) return undefined;
  return (
    value
      .replace(/^https?:\/\/doi\.org\//i, "")
      .replace(/^doi:/i, "")
      .trim()
      .toLowerCase() || undefined
  );
}

function stripDoiPrefix(value: string): string {
  return value
    .replace(/^https?:\/\/doi\.org\//i, "")
    .replace(/^doi:/i, "")
    .trim();
}

function looksLikeDoi(value: string): boolean {
  return /^((?:https?:\/\/doi\.org\/)|(?:doi:))?10\.\d{4,9}\//i.test(value.trim());
}

function stripOpenAlexUrl(value?: string): string | undefined {
  return value?.replace(/^https?:\/\/openalex\.org\//i, "").trim() || undefined;
}

function stripPrefix(value: string | undefined, prefix: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith(prefix) ? value.slice(prefix.length).replace(/\/$/, "") : value;
}

function fingerprintTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9\u00C0-\uFFFF]+/g, " ").trim();
}

function stripTags(value?: string): string | undefined {
  return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function extractCrossrefYear(work: Record<string, unknown>): number | undefined {
  const candidates = [
    work["published-print"],
    work["published-online"],
    work.published,
    work.issued,
  ];
  for (const candidate of candidates) {
    const dateParts = asArray(asRecord(candidate)?.["date-parts"]);
    const first = asArray(dateParts[0]);
    const year = asNumber(first[0]);
    if (year) return year;
  }
  return undefined;
}

function invertOpenAlexAbstract(index: Record<string, unknown> | undefined): string | undefined {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positionsValue] of Object.entries(index)) {
    for (const position of asArray(positionsValue)) {
      const indexValue = asNumber(position);
      if (indexValue !== undefined) words[indexValue] = word;
    }
  }
  return words.filter(Boolean).join(" ") || undefined;
}
