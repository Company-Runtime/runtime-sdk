import { redactSecrets } from "./secrets.ts";
import type { ErrorBody, ErrorCode, ErrorStage, ExecutionState } from "./types.ts";

interface CodeInfo {
  stage: ErrorStage;
  retryable: boolean;
  /** HTTP status of the http/0.1 binding. */
  http: number;
  message: string;
}

/** The v0.1 error codes (spec/0.1/errors.md §2). */
export const ERROR_CODES: Readonly<Record<ErrorCode, CodeInfo>> = {
  invalid_request: {
    stage: "validation",
    retryable: false,
    http: 400,
    message: "The request is invalid.",
  },
  unknown_capability: {
    stage: "validation",
    retryable: false,
    http: 422,
    message: "The capability does not exist.",
  },
  unsupported_version: {
    stage: "validation",
    retryable: false,
    http: 422,
    message: "The version is not supported.",
  },
  unsupported_profile: {
    stage: "validation",
    retryable: false,
    http: 422,
    message: "The profile is not supported.",
  },
  missing_trait: {
    stage: "validation",
    retryable: false,
    http: 422,
    message: "A required trait is not supported.",
  },
  authority_denied: {
    stage: "authority",
    retryable: false,
    http: 403,
    message: "The actor is not authorized to request this capability.",
  },
  policy_denied: {
    stage: "policy",
    retryable: false,
    http: 403,
    message: "Policy does not allow this request.",
  },
  constraint_unsatisfied: {
    stage: "resolution",
    retryable: false,
    http: 422,
    message: "No provider satisfies the constraints.",
  },
  credential_unavailable: {
    stage: "binding",
    retryable: true,
    http: 503,
    message: "No usable credential is available.",
  },
  provider_unavailable: {
    stage: "resolution",
    retryable: true,
    http: 503,
    message: "No provider is available.",
  },
  execution_failed: {
    stage: "execution",
    retryable: false,
    http: 502,
    message: "The execution failed.",
  },
  evidence_missing: {
    stage: "evidence",
    retryable: false,
    http: 502,
    message: "Required evidence is missing.",
  },
  timeout: { stage: "execution", retryable: true, http: 504, message: "The execution timed out." },
  cancelled: {
    stage: "execution",
    retryable: false,
    http: 409,
    message: "The execution was cancelled.",
  },
};

export const MAX_MESSAGE_LENGTH = 512;

/** Sanitizes an error message: no secrets, no stack traces, bounded length. */
export function sanitizeMessage(message: string, secrets: readonly string[] = []): string {
  const firstLine = message.split(/\r?\n\s*at\s/)[0] ?? message;
  const clean = redactSecrets(firstLine, secrets).replace(/\s+/g, " ").trim();
  const bounded =
    clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : clean;
  return bounded || "Unspecified error.";
}

export interface ErrorOptions {
  detail?: string;
  stage?: ErrorStage;
  retryable?: boolean;
  execution_id?: string;
  request_id?: string;
  secrets?: readonly string[];
}

export function errorBody(
  code: ErrorCode,
  message?: string,
  options: ErrorOptions = {},
): ErrorBody {
  const info = ERROR_CODES[code];
  const body: ErrorBody = {
    code,
    message: sanitizeMessage(message ?? info.message, options.secrets),
    retryable: options.retryable ?? info.retryable,
    stage: options.stage ?? info.stage,
  };
  if (options.detail) body.detail = options.detail;
  if (options.execution_id) body.execution_id = options.execution_id;
  if (options.request_id) body.request_id = options.request_id;
  return body;
}

/** A protocol error raised before an execution exists, or by an invalid operation on one. */
export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly retryable: boolean;
  readonly stage: ErrorStage;

  constructor(code: ErrorCode, message?: string, options: ErrorOptions = {}) {
    const body = errorBody(code, message, options);
    super(body.message);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = body.detail;
    this.retryable = body.retryable;
    this.stage = body.stage!;
  }

  toJSON(): ErrorBody {
    return errorBody(this.code, this.message, {
      detail: this.detail,
      stage: this.stage,
      retryable: this.retryable,
    });
  }
}

/** Execution state an error code leads to when it ends an execution before dispatch. */
export function preDispatchState(code: ErrorCode): ExecutionState {
  return code === "cancelled" ? "cancelled" : "rejected";
}
