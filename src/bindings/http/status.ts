import { ERROR_CODES } from "../../errors.ts";
import type { ExecutionOutcome } from "../../runtime.ts";

/** HTTP status of an execution envelope (bindings/http/README.md §2.2). */
export function statusFor(outcome: ExecutionOutcome): number {
  const state = outcome.execution.state;
  if (state === "completed") return 200;
  if (
    state === "pending" ||
    state === "awaiting_approval" ||
    state === "authorized" ||
    state === "running" ||
    state === "unknown"
  )
    return 202;
  const code = outcome.error?.code ?? outcome.execution.error?.code;
  return code ? ERROR_CODES[code].http : 500;
}

export const PROTOCOL_HEADER = "Runtime-Protocol";
