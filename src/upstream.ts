import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const DEFAULT_TIMEOUT_MS = 12_000;

export type UpstreamDefinition = {
  id: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

export type UpstreamFailure = {
  ok: false;
  service: string;
  code: "UPSTREAM_TIMEOUT" | "UPSTREAM_UNAVAILABLE" | "UPSTREAM_PROTOCOL_ERROR";
  message: string;
  diagnostic?: string;
};

function createTimeoutFetch(timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("upstream timeout"), timeoutMs);
    const parentSignal = init?.signal;

    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
    } else {
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    }

    try {
      const workerInput = input instanceof URL ? input.toString() : input;
      return await fetch(workerInput, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
}

export async function withUpstreamClient<T>(
  upstream: UpstreamDefinition,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client(
    { name: `personal-mcp-hub/${upstream.id}`, version: "1.0.0" },
    {
      // Hosted upstreams in the current build are 2025-era Streamable HTTP servers.
      // Use the legacy initialize handshake directly. Auto mode first sends the
      // 2026 server/discover probe, and Exa currently rejects that probe with 403.
      versionNegotiation: { mode: "legacy" },
      listMaxPages: 8,
    },
  );

  const transport = new StreamableHTTPClientTransport(new URL(upstream.url), {
    fetch: createTimeoutFetch(upstream.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ...(upstream.headers && Object.keys(upstream.headers).length > 0
      ? { requestInit: { headers: upstream.headers } }
      : {}),
  });

  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    try {
      await client.close();
    } catch {
      // Closing an upstream must never turn a successful proxy call into a Hub failure.
    }
  }
}

function safeDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return `non-error:${typeof error}`;
  const maybe = error as Error & { code?: unknown; status?: unknown };
  const code = typeof maybe.code === "string" || typeof maybe.code === "number" ? String(maybe.code) : "none";
  const status = typeof maybe.status === "number" ? String(maybe.status) : "none";
  const message = error.message
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:exaApiKey|api[_-]?key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 240);
  return `${error.name}|code=${code}|status=${status}|${message}`;
}

export function toSafeUpstreamFailure(service: string, error: unknown): UpstreamFailure {
  const diagnostic = safeDiagnostic(error);
  const isTimeout =
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`));

  if (isTimeout) {
    return {
      ok: false,
      service,
      code: "UPSTREAM_TIMEOUT",
      message: `${service} did not respond before the Hub timeout.`,
      diagnostic,
    };
  }

  const isProtocolError =
    error instanceof Error && /protocol|json-rpc|initialize|discover|mcp/i.test(error.message);

  return {
    ok: false,
    service,
    code: isProtocolError ? "UPSTREAM_PROTOCOL_ERROR" : "UPSTREAM_UNAVAILABLE",
    message: `${service} is currently unavailable through the Hub.`,
    diagnostic,
  };
}
