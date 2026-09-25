import { selectCredential, type CredentialBroker } from "./credentials.ts";
import { errorBody } from "./errors.ts";
import { maxRisk, strongerEffect, type PolicyEvaluator, type PolicyQuestion } from "./policy.ts";
import type { Provider } from "./provider.ts";
import { compareVersions, parseVersion, satisfies } from "./semver.ts";
import type {
  AuthorityDecision,
  CapabilityDefinition,
  CapabilityRequest,
  CredentialBinding,
  CredentialOwner,
  CredentialRef,
  ErrorBody,
  ErrorCode,
  Implementation,
  PolicyDecision,
  RejectedProvider,
} from "./types.ts";

/** Stage codes of spec/0.1/providers.md §6.1. */
export const STAGE_CODES: Readonly<Record<number, ErrorCode>> = {
  1: "provider_unavailable",
  2: "unsupported_version",
  3: "unsupported_profile",
  4: "missing_trait",
  5: "authority_denied",
  6: "policy_denied",
  7: "constraint_unsatisfied",
  8: "credential_unavailable",
  9: "provider_unavailable",
};

export interface ResolutionContext {
  capability: CapabilityDefinition;
  request: CapabilityRequest;
  effectiveTraits: readonly string[];
  authority: AuthorityDecision;
  policy: { evaluator: PolicyEvaluator; decision: PolicyDecision; question: PolicyQuestion };
  bindings: readonly CredentialBinding[];
  broker?: CredentialBroker;
  providers: readonly Provider[];
  unavailable: ReadonlySet<string>;
  now: Date;
}

export interface Candidate {
  provider: Provider;
  implementation: Implementation;
  credential?: CredentialRef & { owner: CredentialOwner };
}

export interface ResolutionOutcome {
  eligible: Candidate[];
  rejected: RejectedProvider[];
  error?: ErrorBody;
}

type Check = { ok: true; candidate: Candidate } | { ok: false; stage: number; detail: string };

async function check(ctx: ResolutionContext, provider: Provider): Promise<Check> {
  const manifest = provider.manifest;
  const id = manifest.provider.id;
  const reject = (stage: number, detail: string): Check => ({ ok: false, stage, detail });
  // 1. implements the capability
  const implementation = manifest.implements.find((i) => i.capability === ctx.capability.id);
  if (!implementation) return reject(1, "capability_not_implemented");
  // 2. version
  if (!implementation.versions.some((range) => satisfies(ctx.capability.version, range)))
    return reject(2, "version_not_implemented");
  // 3. profile
  if (ctx.request.profile && !(implementation.profiles ?? []).includes(ctx.request.profile))
    return reject(3, "profile_not_supported");
  // 4. traits
  const traits = implementation.traits ?? [];
  const missing = ctx.effectiveTraits.find((t) => !traits.includes(t));
  if (missing) return reject(4, `trait_${missing}_not_supported`);
  // 5. authority restrictions
  if (ctx.authority.providers && !ctx.authority.providers.includes(id))
    return reject(5, "provider_not_granted");
  // 6. policy obligations and provider-scoped rules
  const obligations = ctx.policy.decision.obligations;
  if (obligations?.providers?.allow && !obligations.providers.allow.includes(id))
    return reject(6, "provider_not_allowed_by_policy");
  if (obligations?.providers?.deny?.includes(id)) return reject(6, "provider_denied_by_policy");
  if (
    obligations?.regions &&
    !(implementation.regions ?? []).some((r) => obligations.regions!.allow.includes(r))
  )
    return reject(6, "region_not_allowed_by_policy");
  const rule = await ctx.policy.evaluator.denyProvider?.({ ...ctx.policy.question, provider: id });
  if (rule) return reject(6, `rule_${rule.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`);
  const providerRisk = maxRisk(ctx.policy.question.risk, implementation.risk);
  if (providerRisk !== ctx.policy.question.risk) {
    const decision = await ctx.policy.evaluator.evaluate({
      ...ctx.policy.question,
      risk: providerRisk,
    });
    if (
      strongerEffect(decision.decision, ctx.policy.decision.decision) !==
      ctx.policy.decision.decision
    )
      return reject(6, "provider_risk_not_allowed");
  }
  // 7. constraints
  const c = ctx.request.constraints;
  if (c?.providers?.allow && !c.providers.allow.includes(id))
    return reject(7, "provider_not_allowed");
  if (c?.providers?.deny?.includes(id)) return reject(7, "provider_denied");
  if (c?.regions && !(implementation.regions ?? []).some((r) => c.regions!.allow.includes(r)))
    return reject(7, "region_not_allowed");
  if (c?.max_cost) {
    const estimate = implementation.cost?.estimate;
    if (!estimate) return reject(7, "cost_unknown");
    if (estimate.currency !== c.max_cost.currency) return reject(7, "currency_mismatch");
    if (estimate.amount > c.max_cost.amount) return reject(7, "cost_exceeds_limit");
  }
  if (c?.deadline && Date.parse(c.deadline) <= ctx.now.getTime())
    return reject(7, "deadline_passed");
  // 8. credentials
  const selection = await selectCredential(
    manifest,
    ctx.bindings,
    ctx.request.credential,
    ctx.broker,
  );
  if (selection.kind === "unavailable") return reject(8, selection.detail);
  // 9. availability
  if (ctx.unavailable.has(id)) return reject(9, "provider_unhealthy");
  return {
    ok: true,
    candidate: {
      provider,
      implementation,
      ...(selection.kind === "selected" ? { credential: selection.credential } : {}),
    },
  };
}

/**
 * Deterministic provider resolution (spec/0.1/providers.md §6): the same registry,
 * providers, bindings, obligations and request always produce the same result.
 */
export async function resolveProviders(ctx: ResolutionContext): Promise<ResolutionOutcome> {
  const eligible: Candidate[] = [];
  const rejected: RejectedProvider[] = [];
  const sorted = [...ctx.providers].sort((a, b) =>
    cmp(a.manifest.provider.id, b.manifest.provider.id),
  );
  for (const provider of sorted) {
    const result = await check(ctx, provider);
    if (result.ok) eligible.push(result.candidate);
    else
      rejected.push({
        provider: {
          id: provider.manifest.provider.id,
          version: provider.manifest.provider.version,
        },
        stage: result.stage,
        code: STAGE_CODES[result.stage]!,
        detail: result.detail,
      });
  }
  const prefer = ctx.request.constraints?.providers?.prefer ?? [];
  const preferred = ctx.request.traits?.preferred ?? [];
  const position = (id: string) => (prefer.includes(id) ? prefer.indexOf(id) : prefer.length);
  const score = (c: Candidate) =>
    preferred.filter((t) => (c.implementation.traits ?? []).includes(t)).length;
  eligible.sort((a, b) => {
    const ida = a.provider.manifest.provider.id;
    const idb = b.provider.manifest.provider.id;
    return (
      position(ida) - position(idb) ||
      score(b) - score(a) ||
      cmp(ida, idb) ||
      compareVersions(
        parseVersion(b.provider.manifest.provider.version)!,
        parseVersion(a.provider.manifest.provider.version)!,
      )
    );
  });
  rejected.sort((a, b) => cmp(a.provider.id, b.provider.id));
  if (eligible.length > 0) return { eligible, rejected };
  const latest = rejected.reduce((stage, r) => Math.max(stage, r.stage), 0);
  const code = latest === 0 ? "provider_unavailable" : STAGE_CODES[latest]!;
  return {
    eligible,
    rejected,
    error: errorBody(code, undefined, {
      stage: "resolution",
      detail: latest === 0 ? "no_providers" : "no_eligible_provider",
    }),
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
