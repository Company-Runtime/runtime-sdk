const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/**
 * True when a fetch failure provably happened before the request reached the other side:
 * connection refused, unresolvable host, unreachable network, or a port the Fetch
 * standard blocks. Walks the cause chain, including aggregated connection attempts.
 */
export function isUnreachable(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;
  const { code, message, cause, errors } = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    errors?: unknown;
  };
  if (typeof code === "string" && UNREACHABLE.has(code)) return true;
  if (message === "bad port") return true;
  if (
    Array.isArray(errors) &&
    errors.length > 0 &&
    errors.every((e) => isUnreachable(e, depth + 1))
  )
    return true;
  return isUnreachable(cause, depth + 1);
}
