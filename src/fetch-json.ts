import { ProviderFailure, ProviderUnreachableError } from "./provider.ts";
import { redactSecrets } from "./secrets.ts";
import { isUnreachable } from "./transport.ts";

export interface FetchJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Names the API in error messages, for example "the Slack API". */
  api?: string;
  /** Values that must never appear in error messages, such as the materialized credential. */
  redact?: string[];
  /**
   * Error statuses the caller interprets itself: they are returned like a success, with
   * the parsed body, instead of being classified.
   */
  accept?: number[];
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

const MAX_DETAIL = 200;

/** A short, human-readable reason from a JSON error body, when the API gives one. */
function detailOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record["error"];
  const nested =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)["message"]
      : error;
  const candidate = record["message"] ?? nested ?? record["error_description"];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim().slice(0, MAX_DETAIL)
    : undefined;
}

/**
 * Calls a JSON HTTP API from a provider handler and classifies failures by what they
 * prove about effects (spec/0.1/providers.md §5, spec/0.1/execution.md §4):
 *
 * - never sent (refused connection, unknown host, blocked port): `ProviderUnreachableError`,
 *   and the execution fails with `provider_unavailable`;
 * - refused with a 4xx status: `ProviderFailure` — 401 is `credential_unavailable`, 408 and
 *   429 are retryable `provider_unavailable`, anything else is `execution_failed`;
 * - a 5xx status, an unreadable body, or an interruption after sending: a plain `Error`,
 *   which `defineProvider` reports as `unknown`.
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<JsonResponse<T>> {
  const api = options.api ?? "the API";
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined) target.searchParams.set(key, String(value));
  const hasBody = options.body !== undefined;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(target, {
      method: options.method ?? (hasBody ? "POST" : "GET"),
      headers: {
        accept: "application/json",
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (isUnreachable(error)) throw new ProviderUnreachableError(`${api} could not be reached`);
    throw new Error(`the call to ${api} was interrupted after it was sent`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`the response of ${api} could not be read`);
  }
  let body: unknown = null;
  let parsed = true;
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      parsed = false;
    }
  }
  const status = response.status;
  if ((status >= 200 && status < 300) || options.accept?.includes(status)) {
    if (!parsed) throw new Error(`${api} answered HTTP ${status} with a body that is not JSON`);
    return { status, headers: response.headers, body: body as T };
  }
  const detail = parsed ? detailOf(body) : undefined;
  const message = redactSecrets(
    `${api} answered HTTP ${status}${detail ? `: ${detail}` : ""}`,
    options.redact ?? [],
  );
  if (status >= 400 && status < 500) {
    if (status === 401) throw new ProviderFailure(message, { code: "credential_unavailable" });
    if (status === 408 || status === 429)
      throw new ProviderFailure(message, { code: "provider_unavailable", retryable: true });
    throw new ProviderFailure(message);
  }
  // 5xx and anything unexpected: the operation may or may not have happened.
  throw new Error(message);
}
