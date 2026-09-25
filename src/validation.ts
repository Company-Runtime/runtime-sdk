import { DEFAULT_LIMITS, PROTOCOL } from "./constants.ts";
import { isRecord } from "./json.ts";
import { isCoreId, parseCapabilityId, shadowsCore } from "./naming.ts";
import { Registry } from "./registry.ts";
import { findSecrets } from "./secrets.ts";
import { satisfies } from "./semver.ts";
import type { CapabilityDefinition, CapabilityRequest, ErrorCode, Warning } from "./types.ts";

export interface RequestValidation {
  ok: boolean;
  error?: { code: ErrorCode; detail: string; message: string };
  warnings: Warning[];
  /** The normalized capability, once known. */
  capability?: { id: string; version: string; requested_as?: string };
  definition?: CapabilityDefinition;
  profile?: string;
  effectiveTraits: string[];
  requiredClaims: string[];
  /** The request resource used for authority (spec/0.1/requests.md §3). */
  resource?: string;
}

function depth(value: unknown): number {
  if (Array.isArray(value)) return 1 + Math.max(0, ...value.map(depth));
  if (isRecord(value)) return 1 + Math.max(0, ...Object.values(value).map(depth));
  return 0;
}

/**
 * Deterministic request validation: steps 1–11 of spec/0.1/requests.md §5.
 * The first failing step determines the error.
 */
export function validateRequest(
  request: unknown,
  registry: Registry = Registry.core(),
  limits: { maxRequestBytes?: number } = {},
): RequestValidation {
  const result: RequestValidation = {
    ok: false,
    warnings: [],
    effectiveTraits: [],
    requiredClaims: [],
  };
  const fail = (code: ErrorCode, detail: string, message: string): RequestValidation => ({
    ...result,
    ok: false,
    error: { code, detail, message },
  });

  // 1. size and depth
  const size = Buffer.byteLength(JSON.stringify(request ?? null), "utf8");
  if (size > (limits.maxRequestBytes ?? DEFAULT_LIMITS.maxRequestBytes))
    return fail("invalid_request", "payload_too_large", "The request exceeds the size limit.");
  if (depth(request) > DEFAULT_LIMITS.maxDepth)
    return fail("invalid_request", "payload_too_deep", "The request is nested too deeply.");
  // 2. protocol
  if (!isRecord(request))
    return fail("invalid_request", "not_an_object", "The request must be an object.");
  if (request["protocol"] !== PROTOCOL)
    return fail(
      "unsupported_version",
      "unsupported_protocol",
      "The protocol version is not supported.",
    );
  // 3. schema
  const schemaErrors = registry.schemas.validate("capability-request", request);
  if (schemaErrors.length > 0)
    return fail("invalid_request", "schema_invalid", `The request is invalid: ${schemaErrors[0]}`);
  // 4. raw secrets and credential consistency
  if (findSecrets(request).length > 0)
    return fail("invalid_request", "raw_secret", "The request contains secret material.");
  const typed = request as unknown as CapabilityRequest;
  const credential = typed.credential;
  if (credential?.ref && credential.owner && credential.ref.split("/")[2] !== credential.owner)
    return fail(
      "invalid_request",
      "credential_owner_mismatch",
      "The credential owner does not match its reference.",
    );
  // 5. identifier and namespace isolation
  const requested = typed.capability;
  const parsed = parseCapabilityId(requested.id);
  if ("error" in parsed) return fail("invalid_request", "invalid_capability_id", parsed.error);
  if (shadowsCore(parsed, new Set([...registry.capabilities.keys()].filter(isCoreId))))
    return fail(
      "invalid_request",
      "namespace_violation",
      "The identifier shadows a core capability.",
    );
  // 6. existence after alias normalization
  const { id, alias } = registry.normalize(requested.id);
  if (alias)
    result.warnings.push({
      code: "deprecated_alias",
      message: `${requested.id} is a deprecated alias of ${id}`,
    });
  const capability = registry.capability(id);
  if (!capability)
    return fail(
      "unknown_capability",
      "not_registered",
      `Capability ${requested.id} does not exist.`,
    );
  if (capability.status === "deprecated")
    result.warnings.push({ code: "deprecated_capability", message: `${id} is deprecated` });
  // 7. version
  if (!satisfies(capability.version, requested.version))
    return fail(
      "unsupported_version",
      "no_matching_version",
      `No version of ${id} satisfies ${requested.version}.`,
    );
  result.capability = alias
    ? { id, version: capability.version, requested_as: requested.id }
    : { id, version: capability.version };
  result.definition = capability;
  // 8. profile
  if (typed.profile !== undefined) {
    if (!registry.profiles.has(typed.profile))
      return fail(
        "unsupported_profile",
        "unknown_profile",
        `Profile ${typed.profile} does not exist.`,
      );
    if (!capability.profiles.includes(typed.profile))
      return fail(
        "unsupported_profile",
        "profile_not_accepted",
        `${id} does not accept profile ${typed.profile}.`,
      );
    result.profile = typed.profile;
  }
  // 9. traits: explicit, enabled by claims, gated by input fields, required by the capability
  const input = typed.input;
  const claims = [...(typed.evidence?.require ?? [])];
  const declared = new Set([
    ...(capability.traits.required ?? []),
    ...(capability.traits.optional ?? []),
  ]);
  const effective = new Set<string>([
    ...(typed.traits?.required ?? []),
    ...(capability.traits.required ?? []),
  ]);
  for (const claim of claims)
    for (const trait of registry.traitsEnabling(claim))
      if (declared.has(trait)) effective.add(trait);
  for (const [trait, fields] of Object.entries(capability.traits.input_gates ?? {}))
    if (fields.some((field) => field in input)) effective.add(trait);
  for (const trait of [...(typed.traits?.required ?? []), ...(typed.traits?.preferred ?? [])])
    if (!registry.traits.has(trait))
      return fail("missing_trait", "unknown_trait", `Trait ${trait} does not exist.`);
  for (const trait of effective)
    if (!declared.has(trait))
      return fail("missing_trait", "trait_not_declared", `${id} does not declare trait ${trait}.`);
  result.effectiveTraits = [...effective].sort();
  // 10. evidence claims
  for (const claim of claims)
    if (!capability.evidence.claims.includes(claim))
      return fail("invalid_request", "unsupported_claim", `${id} cannot prove claim ${claim}.`);
  const required = new Set(claims);
  if (capability.effects.mutating) required.add("execution");
  result.requiredClaims = [...required].sort();
  // 11. input against the effective schema, and resource consistency
  const inputErrors = registry.schemas.validate(
    registry.inputSchemaId(capability, typed.profile),
    input,
  );
  if (inputErrors.length > 0)
    return fail("invalid_request", "input_invalid", `The input is invalid: ${inputErrors[0]}`);
  const inputResource = typeof input["resource"] === "string" ? input["resource"] : undefined;
  if (typed.resource && inputResource && typed.resource.ref !== inputResource)
    return fail(
      "invalid_request",
      "resource_mismatch",
      "The request resource differs from the input resource.",
    );
  result.resource = typed.resource?.ref ?? inputResource;
  return { ...result, ok: true };
}
