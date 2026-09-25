import { PROTOCOL, RISK_ORDER } from "./constants.ts";
import { matchPattern } from "./authority.ts";
import type {
  Obligations,
  PolicyDecision,
  PolicyEffect,
  PolicyRule,
  PolicySet,
  Risk,
} from "./types.ts";

/** What policy is asked at request level (spec/0.1/policy.md §3.1). */
export interface PolicyQuestion {
  capability: string;
  actor: string;
  profile?: string;
  mutating: boolean;
  risk: Risk;
  at: Date;
}

export interface ProviderPolicyQuestion extends PolicyQuestion {
  provider: string;
}

export interface PolicyEvaluator {
  evaluate(question: PolicyQuestion): PolicyDecision | Promise<PolicyDecision>;
  /** Provider-scoped rules; returns the rule that makes the provider ineligible, if any. */
  denyProvider?(question: ProviderPolicyQuestion): string | undefined | Promise<string | undefined>;
}

const STRENGTH: Record<PolicyEffect, number> = { allow: 0, require_approval: 1, deny: 2 };
const rank = (risk: Risk) => RISK_ORDER.indexOf(risk);

export function strongerEffect(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
  return STRENGTH[a] >= STRENGTH[b] ? a : b;
}

function matches(rule: PolicyRule, q: PolicyQuestion): boolean {
  const m = rule.match ?? {};
  if (m.capabilities && !m.capabilities.some((p) => matchPattern(p, q.capability))) return false;
  if (m.actors && !m.actors.some((p) => matchPattern(p, q.actor))) return false;
  if (m.profiles && (q.profile === undefined || !m.profiles.includes(q.profile))) return false;
  if (m.mutating !== undefined && m.mutating !== q.mutating) return false;
  if (m.risk?.at_least && rank(q.risk) < rank(m.risk.at_least)) return false;
  if (m.risk?.at_most && rank(q.risk) > rank(m.risk.at_most)) return false;
  return true;
}

const intersect = (a: string[] | undefined, b: string[] | undefined) =>
  a === undefined ? b : b === undefined ? a : a.filter((x) => b.includes(x));
const union = (a: string[] | undefined, b: string[] | undefined) =>
  a === undefined && b === undefined ? undefined : [...new Set([...(a ?? []), ...(b ?? [])])];

/** Merges obligations: allow-lists by intersection, deny-lists, evidence and approvers by union. */
export function mergeObligations(list: Obligations[]): Obligations | undefined {
  if (list.length === 0) return undefined;
  const out: Obligations = {};
  for (const o of list) {
    const allow = intersect(out.providers?.allow, o.providers?.allow);
    const denyList = union(out.providers?.deny, o.providers?.deny);
    if (allow || denyList)
      out.providers = { ...(allow ? { allow } : {}), ...(denyList ? { deny: denyList } : {}) };
    const regions = intersect(out.regions?.allow, o.regions?.allow);
    if (regions) out.regions = { allow: regions };
    const evidence = union(out.evidence?.require, o.evidence?.require);
    if (evidence) out.evidence = { require: evidence };
    const approvers = union(out.approvers, o.approvers);
    if (approvers) out.approvers = approvers;
  }
  return out;
}

/** The minimal portable policy set (spec/0.1/policy.md §3). */
export class PolicySetEvaluator implements PolicyEvaluator {
  readonly policy: PolicySet;

  constructor(policy: PolicySet) {
    this.policy = policy;
  }

  evaluate(q: PolicyQuestion): PolicyDecision {
    const requestRules = this.policy.rules.filter(
      (r) => r.match?.providers === undefined && matches(r, q),
    );
    if (requestRules.length === 0)
      return {
        protocol: PROTOCOL,
        decision: this.policy.default,
        policy_refs: [this.policy.id],
        matched_rules: [],
        reason: `default ${this.policy.default}`,
        evaluated_at: q.at.toISOString(),
      };
    const decision = requestRules.map((r) => r.effect).reduce(strongerEffect);
    const decisive = requestRules.filter((r) => r.effect === decision);
    const obligations = mergeObligations(
      decisive.flatMap((r) => (r.obligations ? [r.obligations] : [])),
    );
    return {
      protocol: PROTOCOL,
      decision,
      policy_refs: [this.policy.id],
      matched_rules: requestRules.map((r) => r.id),
      reason: decisive.find((r) => r.reason)?.reason ?? `rule ${decisive[0]!.id}`,
      ...(obligations ? { obligations } : {}),
      evaluated_at: q.at.toISOString(),
    };
  }

  denyProvider(q: ProviderPolicyQuestion): string | undefined {
    return this.policy.rules.find(
      (r) => r.match?.providers?.includes(q.provider) && r.effect === "deny" && matches(r, q),
    )?.id;
  }
}

/** The evaluator used when none is configured: policy allows; authority still applies. */
export const allowAll: PolicyEvaluator = {
  evaluate: (q) => ({
    protocol: PROTOCOL,
    decision: "allow",
    policy_refs: ["policy://runtime/allow-all"],
    matched_rules: [],
    reason: "no policy is configured",
    evaluated_at: q.at.toISOString(),
  }),
};

export function maxRisk(a: Risk, b: Risk | undefined): Risk {
  return b !== undefined && rank(b) > rank(a) ? b : a;
}
