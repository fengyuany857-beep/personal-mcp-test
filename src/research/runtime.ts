import type {
  ProviderFailure,
  ProviderName,
  ProviderObservation,
  ProviderState,
  ResearchEnv,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RETRIES = 1;
const MAX_BACKOFF_MS = 2_000;

type FetchLike = typeof fetch;

export class ResearchProviderError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderFailure["code"];
  readonly httpStatus?: number;

  constructor(
    provider: ProviderName,
    code: ProviderFailure["code"],
    message: string,
    httpStatus?: number,
  ) {
    super(message);
    this.name = "ResearchProviderError";
    this.provider = provider;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function toProviderFailure(provider: ProviderName, error: unknown): ProviderFailure {
  if (error instanceof ResearchProviderError) {
    return {
      provider,
      code: error.code,
      message: error.message,
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    provider,
    code: /abort|timeout/i.test(message) ? "TIMEOUT" : "NETWORK_ERROR",
    message: safeMessage(message),
  };
}

export class ResearchRuntime {
  readonly env: ResearchEnv;
  private readonly fetchImpl: FetchLike;
  private readonly observations = new Map<ProviderName, ProviderObservation>();
  private readonly providerChains = new Map<ProviderName, Promise<void>>();
  private readonly providerLastStart = new Map<ProviderName, number>();

  constructor(env: ResearchEnv, fetchImpl: FetchLike = fetch) {
    this.env = env;
    // Cloudflare's global fetch must not be invoked with ResearchRuntime as its
    // `this` receiver. Wrap the injected function so the captured callable is
    // always invoked as a plain function, while keeping test injection intact.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  async getJson<T>(
    provider: ProviderName,
    url: URL | string,
    init: RequestInit = {},
  ): Promise<T> {
    return this.schedule(provider, async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          const response = await this.fetchWithTimeout(url, init);
          this.observeResponse(provider, response);

          if (response.ok) {
            try {
              return (await response.json()) as T;
            } catch {
              throw new ResearchProviderError(
                provider,
                "INVALID_RESPONSE",
                `${provider} returned invalid JSON.`,
                response.status,
              );
            }
          }

          const retryable = response.status === 429 || response.status >= 500;
          const code: ProviderFailure["code"] =
            response.status === 429 ? "RATE_LIMIT" : "HTTP_ERROR";
          const body = safeMessage(await response.text().catch(() => ""));
          lastError = new ResearchProviderError(
            provider,
            code,
            `${provider} HTTP ${response.status}${body ? `: ${body}` : ""}`,
            response.status,
          );

          if (!retryable || attempt >= MAX_RETRIES) throw lastError;

          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
          await sleep(Math.min(retryAfterMs ?? 400 * 2 ** attempt, MAX_BACKOFF_MS));
        } catch (error) {
          if (error instanceof ResearchProviderError) {
            if (attempt >= MAX_RETRIES || error.code === "HTTP_ERROR") throw error;
            lastError = error;
          } else {
            const timeout =
              (error instanceof DOMException && error.name === "AbortError") ||
              (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`));
            lastError = new ResearchProviderError(
              provider,
              timeout ? "TIMEOUT" : "NETWORK_ERROR",
              timeout
                ? `${provider} request timed out.`
                : `${provider} network request failed: ${safeMessage(
                    error instanceof Error ? error.message : String(error),
                  )}`,
            );
          }

          if (attempt >= MAX_RETRIES) throw lastError;
          await sleep(Math.min(400 * 2 ** attempt, MAX_BACKOFF_MS));
        }
      }

      throw lastError;
    });
  }

  snapshot(provider: ProviderName): ProviderObservation {
    return (
      this.observations.get(provider) ?? {
        provider,
        state: "UNKNOWN",
        observedAt: new Date().toISOString(),
        message: "No live request has been observed in this tool call.",
      }
    );
  }

  snapshots(providers: ProviderName[]): ProviderObservation[] {
    return providers.map((provider) => this.snapshot(provider));
  }

  private async schedule<T>(provider: ProviderName, task: () => Promise<T>): Promise<T> {
    const previous = this.providerChains.get(provider) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.providerChains.set(
      provider,
      previous
        .catch(() => undefined)
        .then(() => current),
    );

    await previous.catch(() => undefined);

    try {
      const minSpacingMs = this.minSpacingMs(provider);
      const lastStart = this.providerLastStart.get(provider) ?? 0;
      const waitMs = Math.max(0, minSpacingMs - (Date.now() - lastStart));
      if (waitMs > 0) await sleep(waitMs);
      this.providerLastStart.set(provider, Date.now());
      return await task();
    } finally {
      release();
    }
  }

  private minSpacingMs(provider: ProviderName): number {
    if (provider === "semantic_scholar") {
      return this.env.SEMANTIC_SCHOLAR_API_KEY ? 1_050 : 1_250;
    }
    return 0;
  }

  private async fetchWithTimeout(
    input: URL | string,
    init: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("research provider timeout"), DEFAULT_TIMEOUT_MS);
    const parentSignal = init.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);

    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }

  private observeResponse(provider: ProviderName, response: Response): void {
    let state: ProviderState = "AVAILABLE";
    if (response.status === 429) state = "RATE_LIMITED";
    else if (response.status >= 500) state = "DEGRADED";
    else if (!response.ok) state = "UNAVAILABLE";

    this.observations.set(provider, {
      provider,
      state,
      observedAt: new Date().toISOString(),
      httpStatus: response.status,
      ...(response.headers.get("retry-after")
        ? { retryAfterSeconds: Number(response.headers.get("retry-after")) || undefined }
        : {}),
      ...(response.headers.get("x-ratelimit-limit")
        ? { rateLimitLimit: response.headers.get("x-ratelimit-limit") ?? undefined }
        : {}),
      ...(response.headers.get("x-ratelimit-remaining")
        ? { rateLimitRemaining: response.headers.get("x-ratelimit-remaining") ?? undefined }
        : {}),
      ...(response.headers.get("x-ratelimit-reset")
        ? { rateLimitReset: response.headers.get("x-ratelimit-reset") ?? undefined }
        : {}),
    });
  }
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, when - Date.now());
}

function safeMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
