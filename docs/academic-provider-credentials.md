# Academic Provider Credentials

This file documents the credential contract for the isolated Academic Evidence test Worker.

No API keys or email addresses belong in source control.

## GitHub repository secrets

Create these repository secrets when available:

- `OPENALEX_API_KEY`
- `SEMANTIC_SCHOLAR_API_KEY`
- `RESEARCH_CONTACT_EMAIL`

The deployment workflow:

`.github/workflows/deploy-academic-test.yml`

will:

1. deploy the isolated `lattice-mcp-academic-test` Worker,
2. report only whether each credential is configured,
3. conditionally sync configured values to Cloudflare Worker secrets,
4. never print credential values,
5. run the remote MCP smoke test after synchronization.

Cloudflare Worker secret names:

- `OPENALEX_API_KEY`
- `SEMANTIC_SCHOLAR_API_KEY`
- `CONTACT_EMAIL`

## OpenAlex

Official API settings:

https://openalex.org/settings/api

Official authentication documentation:

https://help.openalex.org/api/authentication/

As of 2026-09-18, OpenAlex documents:

- keyless API use is allowed for casual use,
- a free account API key raises the daily free budget from $0.10/day to $1/day,
- the free account does not require a payment method,
- the key can be sent as `?api_key=...` or as a Bearer token,
- budget exhaustion returns HTTP 429.

This project uses the `api_key` query parameter.

## Semantic Scholar

Official API overview and API-key request:

https://www.semanticscholar.org/product/api

Official tutorial:

https://www.semanticscholar.org/product/api/tutorial

As of 2026-09-18, Semantic Scholar documents:

- most public endpoints can be called without a key,
- unauthenticated callers share a public rate-limit pool and may be additionally throttled,
- API-key users receive an introductory 1 request/second rate limit,
- the private key is delivered by email,
- the key should not be shared.

This project sends the key as the `x-api-key` request header.

## Contact email

`RESEARCH_CONTACT_EMAIL` is optional.

When configured, the Worker exposes it to provider adapters as `CONTACT_EMAIL`.
It is used for polite/contact identification where supported, including Crossref/OpenAlex request metadata.

Do not use a private email unless the user explicitly wants that address sent to external academic providers.

## Current degraded behavior without keys

The system is intentionally usable without credentials.

Expected anonymous behavior:

- Crossref normally remains available.
- OpenAlex may return HTTP 429 when the anonymous daily budget is exhausted.
- Semantic Scholar may return HTTP 429 when the shared unauthenticated pool is throttled.
- `research.search_papers` returns `partial` when at least one requested provider succeeds.
- `research.source_status` exposes the observed provider state.
- An empty/failed provider is never translated into "no research exists."

## Verification after adding secrets

After repository secrets are added, rerun:

`Deploy Academic Test Worker`

Expected verification target:

- `OPENALEX_API_KEY_CONFIGURED=true`
- `SEMANTIC_SCHOLAR_API_KEY_CONFIGURED=true`
- optional `RESEARCH_CONTACT_EMAIL_CONFIGURED=true`
- remote MCP initialize PASS
- five `research.*` tools listed
- OpenAlex source state AVAILABLE
- Semantic Scholar source state AVAILABLE, subject to upstream service health
- Crossref source state AVAILABLE
- bounded search returns papers
- similar/citation calls do not fail from missing credentials

The test Worker endpoint remains:

https://lattice-mcp-academic-test.3254849126a.workers.dev/mcp
