import { PROTOCOL } from "../../constants.ts";
import { ERROR_CODES, ProtocolError, errorBody } from "../../errors.ts";
import { isRecord } from "../../json.ts";
import type { ExecutionOutcome, Runtime } from "../../runtime.ts";
import type { Actor, ErrorBody } from "../../types.ts";
import { PROTOCOL_HEADER, statusFor } from "./status.ts";

export interface HttpHandlerOptions {
  /**
   * Authenticates the caller (OAuth bearer tokens, mutual TLS, …) and returns the
   * principal, or undefined when unauthenticated. The principal may only act as itself.
   */
  authenticate?: (request: Request) => Promise<Actor | undefined> | Actor | undefined;
  /** Explicit opt-in for local development: trust `actor.ref` without authentication. */
  trustActors?: boolean;
  maxBodyBytes?: number;
}

type Handler = (request: Request) => Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [PROTOCOL_HEADER]: PROTOCOL,
      ...headers,
    },
  });

const errorResponse = (status: number, error: ErrorBody): Response =>
  json(status, { protocol: PROTOCOL, error });

const envelope = (outcome: ExecutionOutcome): Response =>
  json(
    statusFor(outcome),
    {
      protocol: PROTOCOL,
      execution: outcome.execution,
      ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    { location: `/executions/${outcome.execution.execution_id}` },
  );

/**
 * The runtime API of the http/0.1 binding as a fetch-style handler
 * (`Request → Response`), usable with any server that speaks the Fetch API.
 */
export function createHttpHandler(runtime: Runtime, options: HttpHandlerOptions = {}): Handler {
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;

  const principalOf = async (request: Request): Promise<Actor | undefined> => {
    if (options.authenticate) return options.authenticate(request);
    return undefined;
  };
  const mayActAs = (principal: Actor | undefined, ref: string): boolean =>
    options.trustActors === true || (principal !== undefined && principal.ref === ref);

  const readJson = async (request: Request): Promise<unknown> => {
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > maxBody)
      throw new ProtocolError("invalid_request", "The request body is too large.", {
        detail: "payload_too_large",
      });
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > maxBody)
      throw new ProtocolError("invalid_request", "The request body is too large.", {
        detail: "payload_too_large",
      });
    try {
      return JSON.parse(text);
    } catch {
      throw new ProtocolError("invalid_request", "The body is not valid JSON.", {
        detail: "invalid_json",
      });
    }
  };

  const route = async (request: Request): Promise<Response> => {
    const declared = request.headers.get(PROTOCOL_HEADER);
    if (declared && declared !== PROTOCOL)
      return errorResponse(
        400,
        errorBody("unsupported_version", "The protocol version is not supported.", {
          detail: "unsupported_protocol",
        }),
      );
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const principal = await principalOf(request);

    if (method === "GET" && path === "/.well-known/runtime") {
      const discovery = runtime.discovery();
      return json(200, {
        ...discovery,
        bindings: discovery.bindings.map((b) =>
          b.type === "http" ? { ...b, endpoint: `${url.origin}/` } : b,
        ),
      });
    }
    if (method === "POST" && path === "/executions") {
      const body = await readJson(request);
      if (!isRecord(body))
        throw new ProtocolError("invalid_request", "The body must be a capability request.", {
          detail: "not_an_object",
        });
      const key = request.headers.get("idempotency-key");
      if (key !== null) {
        if (body["idempotency_key"] !== undefined && body["idempotency_key"] !== key)
          throw new ProtocolError("invalid_request", "Idempotency-Key differs from the body.", {
            detail: "idempotency_key_mismatch",
          });
        body["idempotency_key"] = key;
      }
      const actor = isRecord(body["actor"]) ? body["actor"]["ref"] : undefined;
      if (typeof actor !== "string" || !mayActAs(principal, actor))
        throw new ProtocolError("authority_denied", "The caller may not act as this actor.", {
          detail: "actor_binding",
        });
      return envelope(await runtime.execute(body as never));
    }
    if (method === "POST" && path === "/resolutions") {
      const body = await readJson(request);
      const actor = isRecord(body) && isRecord(body["actor"]) ? body["actor"]["ref"] : undefined;
      if (typeof actor !== "string" || !mayActAs(principal, actor))
        throw new ProtocolError("authority_denied", "The caller may not act as this actor.", {
          detail: "actor_binding",
        });
      return json(200, await runtime.resolve(body as never));
    }
    const execution =
      /^\/executions\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\/(approval|cancel|reconcile|receipt))?$/.exec(
        path,
      );
    if (execution) {
      const id = execution[1]!;
      const action = execution[2];
      const current = await runtime.getExecution(id);
      if (!current)
        return errorResponse(
          404,
          errorBody("invalid_request", "Unknown execution.", { detail: "unknown_execution" }),
        );
      if (method === "POST" && action === "approval") {
        const body = await readJson(request);
        const problems = runtime.registry.schemas.validate("approval-decision", body);
        if (problems.length > 0)
          throw new ProtocolError("invalid_request", `Invalid approval: ${problems[0]}`, {
            detail: "schema_invalid",
          });
        const decision = body as {
          execution_id: string;
          decision: "approved" | "rejected";
          decided_by: Actor;
          decided_at: string;
          rationale?: string;
        };
        if (decision.execution_id !== id)
          throw new ProtocolError("invalid_request", "The approval names another execution.", {
            detail: "execution_mismatch",
          });
        if (!mayActAs(principal, decision.decided_by.ref))
          throw new ProtocolError("authority_denied", "The caller may not decide as this actor.", {
            detail: "actor_binding",
          });
        return envelope(await runtime.decide(id, decision));
      }
      if (!mayActAs(principal, current.actor.ref))
        throw new ProtocolError("authority_denied", "The caller may not access this execution.", {
          detail: "actor_binding",
        });
      if (method === "GET" && action === undefined) return envelope(await runtime.getOutcome(id));
      if (method === "POST" && action === "cancel") return envelope(await runtime.cancel(id));
      if (method === "POST" && action === "reconcile") return envelope(await runtime.reconcile(id));
      if (method === "GET" && action === "receipt") {
        const receipt = await runtime.getReceipt(id);
        return receipt
          ? json(200, receipt)
          : errorResponse(
              404,
              errorBody("invalid_request", "No receipt yet.", { detail: "no_receipt" }),
            );
      }
    }
    const evidence = /^\/evidence\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path);
    if (method === "GET" && evidence) {
      const document = await runtime.getEvidence(evidence[1]!);
      const owner = document ? await runtime.getExecution(document.execution_id) : undefined;
      if (!document || !owner)
        return errorResponse(
          404,
          errorBody("invalid_request", "Unknown evidence.", { detail: "unknown_evidence" }),
        );
      if (!mayActAs(principal, owner.actor.ref))
        throw new ProtocolError("authority_denied", "The caller may not access this evidence.", {
          detail: "actor_binding",
        });
      return json(200, document);
    }
    return errorResponse(404, errorBody("invalid_request", "Not found.", { detail: "not_found" }));
  };

  return async (request) => {
    try {
      return await route(request);
    } catch (error) {
      if (error instanceof ProtocolError) {
        const status = error.detail === "payload_too_large" ? 413 : ERROR_CODES[error.code].http;
        return errorResponse(status, error.toJSON());
      }
      return errorResponse(
        500,
        errorBody("execution_failed", "Internal error.", { detail: "internal" }),
      );
    }
  };
}
