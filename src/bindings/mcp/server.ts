import { PROTOCOL } from "../../constants.ts";
import { ProtocolError } from "../../errors.ts";
import { capabilityFromToolName, toolName } from "../../naming.ts";
import type { ExecutionOutcome, Runtime } from "../../runtime.ts";
import type { RequestShorthand } from "../../client.ts";
import type { Actor, CredentialSelector, Json } from "../../types.ts";
import { inlineSchema } from "./schema.ts";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerOptions {
  /** The session actor. Tool calls can never choose or change it. */
  actor: Actor;
  authority?: string;
  credential?: CredentialSelector;
  serverInfo?: { name: string; version: string };
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Json;
  outputSchema: Json;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
  };
  _meta: Record<string, string>;
}

const OUTPUT_SCHEMA: Json = {
  type: "object",
  required: ["protocol", "execution_id", "status"],
  properties: {
    protocol: { const: PROTOCOL },
    execution_id: { type: "string" },
    status: { type: "string" },
    output: { type: "object" },
    receipt: { type: "object" },
    error: { type: "object" },
  },
};

/** Tools of the mcp/0.1 binding for the capabilities a runtime can resolve (bindings/mcp/README.md §1.3). */
export function toolsFor(runtime: Runtime): McpTool[] {
  return runtime.discovery().capabilities.map((entry) => {
    const capability = runtime.registry.capability(entry.id)!;
    const inputId = runtime.registry.inputSchemaId(capability);
    const input = inlineSchema(
      runtime.registry.schemas.ajv.getSchema(inputId)?.schema,
      runtime.registry,
    ) as Json;
    const properties: Json = {
      input,
      constraints: inlineSchema(
        { $ref: "urn:runtime-protocol:schemas:0.1:constraints" },
        runtime.registry,
      ) as Json,
      evidence: {
        type: "object",
        properties: { require: { type: "array", items: { enum: capability.evidence.claims } } },
      },
      idempotency_key: { type: "string", minLength: 1, maxLength: 255 },
    };
    if (entry.profiles.length > 0) properties["profile"] = { enum: entry.profiles };
    if (entry.traits.length > 0)
      properties["traits"] = {
        type: "object",
        properties: { required: { type: "array", items: { enum: entry.traits } } },
      };
    const extras = [
      entry.profiles.length > 0 ? `Profiles: ${entry.profiles.join(", ")}.` : "",
      entry.traits.length > 0 ? `Traits: ${entry.traits.join(", ")}.` : "",
    ].filter(Boolean);
    return {
      name: toolName(entry.id),
      title: entry.id,
      description: [capability.description, ...extras].join(" "),
      inputSchema: { type: "object", properties, required: ["input"] },
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: !capability.effects.mutating,
        destructiveHint:
          capability.verb === "delete" || ["high", "critical"].includes(capability.risk.default),
        idempotentHint: entry.traits.includes("idempotency"),
        openWorldHint: true,
      },
      _meta: { "runtime-protocol/capability": entry.id, "runtime-protocol/version": entry.version },
    };
  });
}

function summary(outcome: ExecutionOutcome): string {
  const e = outcome.execution;
  const head = `${e.capability.id} ${e.state} (execution ${e.execution_id})`;
  return outcome.error ? `${head}: ${outcome.error.code} — ${outcome.error.message}` : head;
}

/**
 * A runtime exposed as an MCP server (runtime as MCP server, mcp/0.1). Handle one
 * JSON-RPC message at a time; notifications return undefined.
 */
export function createMcpServer(runtime: Runtime, options: McpServerOptions) {
  const serverInfo = options.serverInfo ?? {
    name: runtime.name ?? runtime.id,
    version: runtime.version,
  };
  const ok = (id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  });
  const fail = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });

  async function call(params: Json | undefined): Promise<unknown> {
    const name = typeof params?.["name"] === "string" ? params["name"] : "";
    const args = (params?.["arguments"] ?? {}) as Json;
    const meta = (params?.["_meta"] ?? {}) as Json;
    const capability = capabilityFromToolName(name);
    if (!toolsFor(runtime).some((t) => t.name === name))
      throw new ProtocolError("unknown_capability", `Unknown tool ${name}.`);
    const shorthand: RequestShorthand = {
      capability,
      input: (args["input"] ?? {}) as Json,
      actor: options.actor,
      ...(options.authority ? { authority: options.authority } : {}),
      ...(options.credential ? { credential: options.credential } : {}),
      ...(typeof args["profile"] === "string" ? { profile: args["profile"] } : {}),
      ...(args["traits"] ? { traits: args["traits"] as RequestShorthand["traits"] } : {}),
      ...(args["constraints"]
        ? { constraints: args["constraints"] as RequestShorthand["constraints"] }
        : {}),
      ...(args["evidence"] ? { evidence: args["evidence"] as RequestShorthand["evidence"] } : {}),
      ...(typeof args["idempotency_key"] === "string"
        ? { idempotency_key: args["idempotency_key"] }
        : {}),
      ...(typeof meta["runtime-protocol/request_id"] === "string"
        ? { request_id: meta["runtime-protocol/request_id"] }
        : {}),
    };
    const outcome = await runtime.execute(shorthand);
    const state = outcome.execution.state;
    return {
      content: [{ type: "text", text: summary(outcome) }],
      structuredContent: {
        protocol: PROTOCOL,
        execution_id: outcome.execution.execution_id,
        status: state,
        ...(outcome.execution.output ? { output: outcome.execution.output } : {}),
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      },
      isError:
        state === "rejected" || state === "failed" || state === "cancelled" || state === "unknown",
    };
  }

  return {
    async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
      if (message.id === undefined) return undefined; // notification (for example notifications/initialized)
      try {
        switch (message.method) {
          case "initialize": {
            const requested = message.params?.["protocolVersion"];
            const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
              ? requested
              : MCP_PROTOCOL_VERSIONS[0];
            return ok(message.id, {
              protocolVersion: version,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
            });
          }
          case "ping":
            return ok(message.id, {});
          case "tools/list":
            return ok(message.id, { tools: toolsFor(runtime) });
          case "tools/call":
            return ok(message.id, await call(message.params));
          default:
            return fail(message.id, -32601, `Method not found: ${message.method}`);
        }
      } catch (error) {
        if (error instanceof ProtocolError) return fail(message.id, -32602, error.message);
        return fail(message.id, -32603, "Internal error");
      }
    },
  };
}

export type McpServer = ReturnType<typeof createMcpServer>;
