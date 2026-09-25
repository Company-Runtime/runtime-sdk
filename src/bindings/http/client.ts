import {
  buildRequest,
  isFullRequest,
  type RequestDefaults,
  type RequestShorthand,
} from "../../client.ts";
import { PROTOCOL } from "../../constants.ts";
import { ProtocolError } from "../../errors.ts";
import { isRecord } from "../../json.ts";
import type { ApprovalInput, ExecutionOutcome } from "../../runtime.ts";
import type {
  CapabilityRequest,
  Discovery,
  ErrorCode,
  Evidence,
  ExecutionReceipt,
  Resolution,
} from "../../types.ts";
import { PROTOCOL_HEADER } from "./status.ts";

export interface HttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Transport authentication, for example `{ authorization: "Bearer …" }` for the runtime itself. */
  headers?: Record<string, string>;
  defaults?: RequestDefaults;
}

/** A caller of the http/0.1 runtime API with the same shape as a local Runtime. */
export class RuntimeHttpClient {
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;
  readonly #defaults: RequestDefaults;

  constructor(options: HttpClientOptions) {
    this.#base = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#headers = options.headers ?? {};
    this.#defaults = options.defaults ?? {};
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        [PROTOCOL_HEADER]: PROTOCOL,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...this.#headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  #envelope(result: { status: number; body: unknown }): ExecutionOutcome {
    const body = result.body;
    if (isRecord(body) && isRecord(body["execution"])) {
      return {
        execution: body["execution"] as unknown as ExecutionOutcome["execution"],
        ...(isRecord(body["receipt"])
          ? { receipt: body["receipt"] as unknown as ExecutionReceipt }
          : {}),
        ...(isRecord(body["error"])
          ? { error: body["error"] as unknown as ExecutionOutcome["error"] }
          : {}),
        events: [],
      };
    }
    throw this.#error(result);
  }

  #error(result: { status: number; body: unknown }): ProtocolError {
    const error =
      isRecord(result.body) && isRecord(result.body["error"]) ? result.body["error"] : undefined;
    const code = (error?.["code"] as ErrorCode | undefined) ?? "execution_failed";
    return new ProtocolError(code, String(error?.["message"] ?? `HTTP ${result.status}`), {
      ...(typeof error?.["detail"] === "string" ? { detail: error["detail"] } : {}),
    });
  }

  async execute(input: CapabilityRequest | RequestShorthand): Promise<ExecutionOutcome> {
    const request = isFullRequest(input)
      ? input
      : buildRequest(input, { defaults: this.#defaults });
    return this.#envelope(await this.#call("POST", "/executions", request));
  }

  async resolve(input: CapabilityRequest | RequestShorthand): Promise<Resolution> {
    const request = isFullRequest(input)
      ? input
      : buildRequest(input, { defaults: this.#defaults });
    const result = await this.#call("POST", "/resolutions", request);
    if (result.status !== 200) throw this.#error(result);
    return result.body as Resolution;
  }

  async getOutcome(executionId: string): Promise<ExecutionOutcome> {
    return this.#envelope(
      await this.#call("GET", `/executions/${encodeURIComponent(executionId)}`),
    );
  }

  async decide(executionId: string, input: ApprovalInput): Promise<ExecutionOutcome> {
    const decidedBy =
      typeof input.decided_by === "string" ? { ref: input.decided_by } : input.decided_by;
    return this.#envelope(
      await this.#call("POST", `/executions/${encodeURIComponent(executionId)}/approval`, {
        protocol: PROTOCOL,
        execution_id: executionId,
        decision: input.decision,
        decided_by: decidedBy,
        decided_at: input.decided_at ?? new Date().toISOString(),
        ...(input.rationale ? { rationale: input.rationale } : {}),
      }),
    );
  }

  async cancel(executionId: string): Promise<ExecutionOutcome> {
    return this.#envelope(
      await this.#call("POST", `/executions/${encodeURIComponent(executionId)}/cancel`),
    );
  }

  async reconcile(executionId: string): Promise<ExecutionOutcome> {
    return this.#envelope(
      await this.#call("POST", `/executions/${encodeURIComponent(executionId)}/reconcile`),
    );
  }

  async getReceipt(executionId: string): Promise<ExecutionReceipt | undefined> {
    const result = await this.#call(
      "GET",
      `/executions/${encodeURIComponent(executionId)}/receipt`,
    );
    return result.status === 200 ? (result.body as ExecutionReceipt) : undefined;
  }

  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    const result = await this.#call(
      "GET",
      `/evidence/${encodeURIComponent(evidenceId.replace(/^evidence:\/\//, ""))}`,
    );
    return result.status === 200 ? (result.body as Evidence) : undefined;
  }

  async discovery(): Promise<Discovery> {
    const result = await this.#call("GET", "/.well-known/runtime");
    if (result.status !== 200) throw this.#error(result);
    return result.body as Discovery;
  }
}
