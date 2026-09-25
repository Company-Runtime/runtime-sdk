import { PROTOCOL } from "./constants.ts";
import type {
  AuthorityDecision,
  AuthorityGrant,
  AuthorityGrants,
  CapabilityRequest,
} from "./types.ts";

/** What authority is asked (spec/0.1/authority.md §1). */
export interface AuthorityQuestion {
  actor: string;
  /** Normalized capability identifier. */
  capability: string;
  profile?: string;
  resource?: string;
  /** The authority the request names, if any. */
  authority?: string;
  at: Date;
}

export interface AuthorityEvaluator {
  evaluate(question: AuthorityQuestion): AuthorityDecision | Promise<AuthorityDecision>;
}

/** Exact match, or a trailing `*` matching any suffix. */
export function matchPattern(pattern: string, value: string): boolean {
  return pattern.endsWith("*") ? value.startsWith(pattern.slice(0, -1)) : pattern === value;
}

const deny = (
  reason: string,
  detail: AuthorityDecision["detail"],
  at: Date,
  authority?: string,
): AuthorityDecision => ({
  protocol: PROTOCOL,
  decision: "deny",
  ...(authority ? { authority } : {}),
  reason,
  detail,
  evaluated_at: at.toISOString(),
});

/** Deny-by-default evaluator over the portable grant format (spec/0.1/authority.md §3–4). */
export class GrantAuthority implements AuthorityEvaluator {
  readonly grants: readonly AuthorityGrant[];

  constructor(grants: AuthorityGrants | readonly AuthorityGrant[]) {
    this.grants = Array.isArray(grants) ? grants : (grants as AuthorityGrants).grants;
  }

  evaluate(q: AuthorityQuestion): AuthorityDecision {
    let candidates = this.grants;
    if (q.authority) {
      candidates = this.grants.filter((g) => g.authority === q.authority);
      if (!candidates.some((g) => g.subjects.some((s) => matchPattern(s, q.actor))))
        return deny(
          "the actor does not hold the named authority",
          "authority_not_held",
          q.at,
          q.authority,
        );
    }
    const time = q.at.getTime();
    const grant = candidates.find(
      (g) =>
        g.subjects.some((s) => matchPattern(s, q.actor)) &&
        g.capabilities.some((c) => matchPattern(c, q.capability)) &&
        (g.profiles === undefined || (q.profile !== undefined && g.profiles.includes(q.profile))) &&
        (g.resources === undefined ||
          (q.resource !== undefined && g.resources.some((r) => matchPattern(r, q.resource!)))) &&
        (g.valid_from === undefined || Date.parse(g.valid_from) <= time) &&
        (g.valid_until === undefined || time < Date.parse(g.valid_until)),
    );
    if (!grant) return deny("no grant allows this request", "no_matching_grant", q.at, q.authority);
    return {
      protocol: PROTOCOL,
      decision: "allow",
      authority: grant.authority,
      grant_id: grant.id,
      reason: `grant ${grant.id} matched`,
      detail: "grant_matched",
      ...(grant.providers ? { providers: [...grant.providers] } : {}),
      evaluated_at: q.at.toISOString(),
    };
  }
}

/** The evaluator used when none is configured: everything is denied. */
export const denyAll: AuthorityEvaluator = {
  evaluate: (q) => deny("no authority is configured", "evaluator_unavailable", q.at),
};

export function questionFor(
  request: CapabilityRequest,
  capability: string,
  resource: string | undefined,
  at: Date,
): AuthorityQuestion {
  return {
    actor: request.actor.ref,
    capability,
    ...(request.profile ? { profile: request.profile } : {}),
    ...(resource ? { resource } : {}),
    ...(request.authority ? { authority: request.authority.ref } : {}),
    at,
  };
}
