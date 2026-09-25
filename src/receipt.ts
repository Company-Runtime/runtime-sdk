import { PROTOCOL } from "./constants.ts";
import { compact, digest } from "./json.ts";
import type { Execution, ExecutionReceipt, ReceiptBody } from "./types.ts";

/** Builds the canonical receipt of an execution (spec/0.1/evidence.md §6). */
export function buildReceipt(
  execution: Execution,
  context: {
    receiptId: string;
    issuedAt: Date;
    events: string[];
    authority: ReceiptBody["authority"];
  },
): ExecutionReceipt {
  if (!["completed", "failed", "cancelled", "rejected", "unknown"].includes(execution.state))
    throw new Error(`no receipt for state ${execution.state}`);
  const started = execution.started_at ? Date.parse(execution.started_at) : undefined;
  const settled = execution.completed_at ? Date.parse(execution.completed_at) : undefined;
  const body: ReceiptBody = compact({
    receipt_id: context.receiptId,
    request_id: execution.request_id,
    execution_id: execution.execution_id,
    capability: execution.capability,
    profile: execution.profile,
    traits: execution.traits && execution.traits.length > 0 ? execution.traits : undefined,
    provider: execution.provider,
    actor: execution.actor,
    authority: context.authority,
    policy: execution.policy
      ? { decision: execution.policy.decision, refs: execution.policy.refs }
      : undefined,
    approval: execution.approval,
    credential_owner: execution.credential_owner,
    status: execution.state as ReceiptBody["status"],
    error: execution.error,
    warnings: execution.warnings && execution.warnings.length > 0 ? execution.warnings : undefined,
    idempotency_key: execution.idempotency_key,
    created_at: execution.created_at,
    started_at: execution.started_at,
    completed_at: execution.completed_at,
    duration_ms:
      started !== undefined && settled !== undefined ? Math.max(0, settled - started) : undefined,
    cost: execution.cost,
    evidence: [...execution.evidence],
    events: context.events.length > 0 ? [...context.events] : undefined,
    issued_at: context.issuedAt.toISOString(),
  });
  return {
    protocol: PROTOCOL,
    receipt: body,
    integrity: { canonicalization: "RFC8785", digest: digest(body) },
  };
}

/** Recomputes the integrity digest of a receipt. */
export function verifyReceipt(receipt: ExecutionReceipt): boolean {
  return (
    receipt.integrity.canonicalization === "RFC8785" &&
    digest(receipt.receipt) === receipt.integrity.digest
  );
}
