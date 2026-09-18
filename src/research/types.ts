export type ResearchEnv = {
  SEMANTIC_SCHOLAR_API_KEY?: string;
  OPENALEX_API_KEY?: string;
  CONTACT_EMAIL?: string;
};

export type ProviderName = "semantic_scholar" | "openalex" | "crossref";

export type ProviderState =
  | "AVAILABLE"
  | "DEGRADED"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "UNKNOWN";

export type ProviderObservation = {
  provider: ProviderName;
  state: ProviderState;
  observedAt: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  rateLimitLimit?: string;
  rateLimitRemaining?: string;
  rateLimitReset?: string;
  message?: string;
};

export type Paper = {
  canonicalId: string;
  title: string;
  authors: string[];
  year?: number;
  publishedDate?: string;
  venue?: string;
  abstract?: string;
  doi?: string;
  semanticScholarId?: string;
  openAlexId?: string;
  arxivId?: string;
  pmid?: string;
  url?: string;
  pdfUrl?: string;
  citationCount?: number;
  referenceCount?: number;
  sources: ProviderName[];
  sourceCount: number;
  externalIds: Record<string, string>;
};

export type ProviderFailure = {
  provider: ProviderName;
  code: "TIMEOUT" | "RATE_LIMIT" | "HTTP_ERROR" | "NETWORK_ERROR" | "INVALID_RESPONSE";
  message: string;
  httpStatus?: number;
};

export type ResearchStatus = "complete" | "partial" | "blocked";

export type SearchResult = {
  status: ResearchStatus;
  queries: string[];
  papers: Paper[];
  coverage: {
    requestedProviders: ProviderName[];
    successfulProviders: ProviderName[];
    failedProviders: ProviderName[];
    queryCount: number;
    providerQueryAttempts: number;
    providerQuerySuccesses: number;
    returnedPapers: number;
  };
  providersUsed: ProviderName[];
  providersFailed: ProviderFailure[];
  warnings: string[];
  provenance: Array<{
    provider: ProviderName;
    query: string;
  }>;
};

export type GetPaperResult = {
  status: ResearchStatus;
  identifier: string;
  paper: Paper | null;
  providersUsed: ProviderName[];
  providersFailed: ProviderFailure[];
  warnings: string[];
};

export type CitationEdge = {
  from: string;
  to: string;
  relation: "cites";
};

export type CitationGraphResult = {
  status: ResearchStatus;
  root: string;
  direction: "citations" | "references" | "both";
  depth: number;
  papers: Paper[];
  edges: CitationEdge[];
  providersUsed: ProviderName[];
  providersFailed: ProviderFailure[];
  warnings: string[];
};

export type SimilarResult = {
  status: ResearchStatus;
  seed: string;
  papers: Paper[];
  provider: "semantic_scholar";
  warnings: string[];
};
