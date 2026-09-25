import { PROTOCOL } from "../../constants.ts";
import type { CredentialBroker } from "../../credentials.ts";
import { errorBody, sanitizeMessage } from "../../errors.ts";
import type { Provider, ProviderContext } from "../../provider.ts";
import { Registry } from "../../registry.ts";
import type { Invocation } from "../../types.ts";
import { PROTOCOL_HEADER } from "./status.ts";

export interface ProviderHttpOptions {
  /** The provider side's own broker: it materializes the invocation's CredentialRef locally. */
  credentials?: CredentialBroker;
  /** Authenticates the calling runtime (transport credentials); reject unknown callers. */
  authenticate?: (request: Request) => Promise<boolean> | boolean;
  registry?: Registry;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", [PROTOCOL_HEADER]: PROTOCOL },
  });

/**
 * Exposes a provider through the provider API of the http/0.1 binding: a sidecar,
 * container or standalone service reached by runtimes over HTTP.
 */
export function createProviderHttpHandler(provider: Provider, options: ProviderHttpOptions = {}) {
  const registry = options.registry ?? Registry.core();
  const context = (invocation: Invocation, controller: AbortController): ProviderContext => ({
    signal: controller.signal,
    now: () => new Date(),
    credential: async () => {
      const ref = invocation.credential?.ref;
      if (!ref || !options.credentials) return undefined;
      return options.credentials.materialize(ref);
    },
  });
  const invocationOf = async (request: Request): Promise<Invocation | Response> => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        protocol: PROTOCOL,
        error: errorBody("invalid_request", "The body is not valid JSON.", {
          detail: "invalid_json",
        }),
      });
    }
    const problems = registry.schemas.validate("invocation", body);
    if (problems.length > 0)
      return json(400, {
        protocol: PROTOCOL,
        error: errorBody("invalid_request", `Invalid invocation: ${problems[0]}`, {
          detail: "schema_invalid",
        }),
      });
    return body as Invocation;
  };
  const withDeadline = (invocation: Invocation) => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("deadline")),
      Math.max(0, Date.parse(invocation.deadline) - Date.now()),
    );
    return { controller, done: () => clearTimeout(timer) };
  };

  return async (request: Request): Promise<Response> => {
    if (options.authenticate && !(await options.authenticate(request)))
      return json(401, {
        protocol: PROTOCOL,
        error: errorBody("authority_denied", "The caller is not authenticated.", {
          detail: "unauthenticated",
        }),
      });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    if (method === "GET" && path === "/.well-known/runtime-provider")
      return json(200, provider.manifest);
    if (method === "GET" && path === "/health")
      return json(
        200,
        provider.health
          ? await provider.health()
          : { protocol: PROTOCOL, status: "ok", checked_at: new Date().toISOString() },
      );
    if (method === "POST" && path === "/invocations") {
      const invocation = await invocationOf(request);
      if (invocation instanceof Response) return invocation;
      const { controller, done } = withDeadline(invocation);
      try {
        return json(200, await provider.execute(invocation, context(invocation, controller)));
      } catch (error) {
        return json(200, {
          protocol: PROTOCOL,
          invocation_id: invocation.invocation_id,
          status: "unknown",
          error: {
            code: "execution_failed",
            message: sanitizeMessage(error instanceof Error ? error.message : "provider error"),
          },
        });
      } finally {
        done();
      }
    }
    const reconcile = /^\/invocations\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\/reconcile$/.exec(path);
    if (method === "POST" && reconcile) {
      const invocation = await invocationOf(request);
      if (invocation instanceof Response) return invocation;
      if (invocation.invocation_id !== reconcile[1])
        return json(400, {
          protocol: PROTOCOL,
          error: errorBody("invalid_request", "The invocation id differs from the path.", {
            detail: "invocation_mismatch",
          }),
        });
      if (!provider.reconcile)
        return json(200, {
          protocol: PROTOCOL,
          invocation_id: invocation.invocation_id,
          status: "inconclusive",
          reason: "reconciliation is not supported",
        });
      const { controller, done } = withDeadline({
        ...invocation,
        deadline: new Date(Date.now() + 30_000).toISOString(),
      });
      try {
        return json(200, await provider.reconcile(invocation, context(invocation, controller)));
      } finally {
        done();
      }
    }
    return json(404, {
      protocol: PROTOCOL,
      error: errorBody("invalid_request", "Not found.", { detail: "not_found" }),
    });
  };
}
