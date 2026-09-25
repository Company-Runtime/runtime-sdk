import { ProtocolError } from "./errors.ts";
import { isCoreId, parseCapabilityId, shadowsCore } from "./naming.ts";
import { Registry } from "./registry.ts";
import { findSecrets } from "./secrets.ts";
import { satisfies } from "./semver.ts";
import type { ErrorCode, ProviderManifest } from "./types.ts";

export interface ManifestFinding {
  code: ErrorCode;
  message: string;
  /** Warnings do not invalidate a manifest (for example a range the registry cannot satisfy yet). */
  severity: "error" | "warning";
}

/** Validates a provider manifest against its schema and the registry (spec/0.1/providers.md §2). */
export function validateManifest(
  manifest: unknown,
  registry: Registry = Registry.core(),
): ManifestFinding[] {
  const findings: ManifestFinding[] = [];
  const error = (code: ErrorCode, message: string) =>
    findings.push({ code, message, severity: "error" });
  for (const message of registry.schemas.validate("provider-manifest", manifest))
    error("invalid_request", `schema: ${message}`);
  if (findings.length > 0) return findings;
  for (const secret of findSecrets(manifest))
    error("invalid_request", `raw secret (${secret.kind}) at ${secret.path}`);
  const doc = manifest as ProviderManifest;
  const coreIds = new Set([...registry.capabilities.keys()].filter(isCoreId));
  const seen = new Set<string>();
  for (const implementation of doc.implements) {
    const id = implementation.capability;
    if (seen.has(id)) error("invalid_request", `${id} is implemented twice`);
    seen.add(id);
    const parsed = parseCapabilityId(id);
    if ("error" in parsed) {
      error("invalid_request", `${id}: ${parsed.error}`);
      continue;
    }
    if (shadowsCore(parsed, coreIds)) error("invalid_request", `${id} shadows a core capability`);
    const capability = registry.capability(id);
    if (!capability) {
      error("unknown_capability", `${id} is not registered`);
      continue;
    }
    if (!implementation.versions.some((range) => satisfies(capability.version, range)))
      findings.push({
        code: "unsupported_version",
        message: `${id}: no declared range contains ${capability.version}`,
        severity: "warning",
      });
    for (const profile of implementation.profiles ?? [])
      if (!capability.profiles.includes(profile))
        error("unsupported_profile", `${id} does not accept profile ${profile}`);
    const declared = new Set([
      ...(capability.traits.required ?? []),
      ...(capability.traits.optional ?? []),
    ]);
    for (const trait of implementation.traits ?? [])
      if (!declared.has(trait)) error("missing_trait", `${id} does not declare trait ${trait}`);
    for (const trait of capability.traits.required ?? [])
      if (!(implementation.traits ?? []).includes(trait))
        error("missing_trait", `${id} requires trait ${trait}`);
    for (const claim of implementation.evidence?.claims ?? [])
      if (!capability.evidence.claims.includes(claim))
        error("invalid_request", `${id} cannot prove claim ${claim}`);
    if (
      capability.effects.mutating &&
      !(implementation.traits ?? []).includes("idempotency") &&
      implementation.reconciliation !== "supported"
    )
      error(
        "invalid_request",
        `${id} is mutating: declare the idempotency trait or reconciliation: supported`,
      );
  }
  return findings;
}

/** Throws when a manifest has errors; returns warnings otherwise. */
export function assertValidManifest(
  manifest: unknown,
  registry: Registry = Registry.core(),
): ManifestFinding[] {
  const findings = validateManifest(manifest, registry);
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length > 0)
    throw new ProtocolError("invalid_request", `Invalid provider manifest: ${errors[0]!.message}`, {
      detail: "invalid_manifest",
    });
  return findings;
}
