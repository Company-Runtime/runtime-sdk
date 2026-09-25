import type { ExecutionState } from "./types.ts";

/** Allowed transitions of spec/0.1/execution.md §1. Every other transition is invalid. */
export const TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  pending: ["awaiting_approval", "authorized", "rejected", "cancelled"],
  awaiting_approval: ["authorized", "rejected", "cancelled"],
  authorized: ["running", "rejected", "cancelled"],
  running: ["completed", "failed", "unknown", "cancelled"],
  unknown: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  rejected: [],
};

export const TERMINAL_STATES: ReadonlySet<ExecutionState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ExecutionState): boolean {
  return TERMINAL_STATES.has(state);
}

export class InvalidTransitionError extends Error {
  readonly from: ExecutionState;
  readonly to: ExecutionState;

  constructor(from: ExecutionState, to: ExecutionState) {
    super(`invalid execution transition ${from} → ${to}`);
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
  }
}
