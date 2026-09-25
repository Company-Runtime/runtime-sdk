export const PROTOCOL = "runtime/0.1" as const;
export const SCHEMA_PREFIX = "urn:runtime-protocol:schemas:0.1:";
export const SDK_VERSION = "0.1.0";

/** Defaults of spec/0.1/security.md. */
export const DEFAULT_LIMITS = {
  maxRequestBytes: 1024 * 1024,
  maxDepth: 32,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 3_600_000,
} as const;

export const NAMESPACES = ["core", "experimental", "community", "vendor", "org"] as const;
export const CREDENTIAL_OWNERS = [
  "organization",
  "runtime",
  "provider",
  "workload",
  "user",
] as const;
/** Credential selection order when the request names no owner (spec/0.1/providers.md §3.2). */
export const OWNER_ORDER = ["organization", "workload", "user", "runtime", "provider"] as const;
export const RISK_ORDER = ["none", "low", "medium", "high", "critical"] as const;
export const CORE_CLAIMS = ["execution", "delivery", "state", "approval"] as const;
