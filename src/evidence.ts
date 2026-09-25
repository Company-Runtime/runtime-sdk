import { PROTOCOL } from "./constants.ts";
import { digest } from "./json.ts";
import type { IdGenerator } from "./ids.ts";
import type { Evidence, EvidenceItem } from "./types.ts";

/** Evidence types that can support each core claim (spec/0.1/evidence.md §4). */
export const CLAIM_SUPPORT: Readonly<Record<string, readonly string[]>> = {
  execution: ["provider_receipt", "external_reference", "signature", "state_observation"],
  delivery: ["provider_receipt", "state_observation", "external_reference"],
  state: ["state_observation", "artifact", "external_reference"],
  approval: ["human_attestation", "signature"],
};

/** Whether an evidence type can support a claim; namespaced claims are allowed for every type. */
export function supports(type: string, claim: string): boolean {
  const types = CLAIM_SUPPORT[claim];
  return types === undefined ? claim.includes(".") : types.includes(type);
}

/** Turns provider-reported items into stored evidence: ids, producer and integrity digest. */
export function recordEvidence(
  items: readonly EvidenceItem[],
  context: { executionId: string; producedBy: Evidence["produced_by"]; ids: IdGenerator },
): Evidence[] {
  return items.map((item) => {
    const body = {
      protocol: PROTOCOL,
      id: context.ids.next("ev"),
      execution_id: context.executionId,
      ...structuredClone(item),
      produced_by: context.producedBy,
    } as Omit<Evidence, "digest">;
    return { ...body, digest: digest(body) } as Evidence;
  });
}

/** Claims supported by at least one valid evidence document. */
export function coveredClaims(evidence: readonly Evidence[]): Set<string> {
  const covered = new Set<string>();
  for (const e of evidence)
    for (const claim of e.claims) if (supports(e.type, claim)) covered.add(claim);
  return covered;
}

export function missingClaims(
  required: readonly string[],
  evidence: readonly Evidence[],
): string[] {
  const covered = coveredClaims(evidence);
  return required.filter((claim) => !covered.has(claim));
}

/** Recomputes an evidence digest (spec/0.1/evidence.md §5). */
export function verifyEvidence(evidence: Evidence): boolean {
  const { digest: recorded, ...rest } = evidence;
  return digest(rest) === recorded;
}

export const evidenceRef = (id: string) => `evidence://${id}`;
