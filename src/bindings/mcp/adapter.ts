import { PROTOCOL } from "../../constants.ts";
import { digest, isRecord } from "../../json.ts";
import { toolName } from "../../naming.ts";
import { ProviderUnreachableError, type Provider } from "../../provider.ts";
import { verifyReceipt } from "../../receipt.ts";
import type {
  CredentialOwner,
  ErrorCode,
  EvidenceItem,
  ExecutionReceipt,
  Implementation,
  Invocation,
  Json,
  ProviderManifest,
  ProviderResult,
  Reconciliation,
} from "../../types.ts";
import type { JsonRpcRequest, JsonRpcResponse } from "./server.ts";

/** Sends one JSON-RPC request to an MCP server and returns its response (any transport). */
export type McpTransport = (request: JsonRpcRequest) => Promise<JsonRpcResponse>;

/** JSON-RPC errors raised before a tool runs: parse error, invalid request, unknown method, invalid params. */
const NOT_EXECUTED = new Set([-32700, -32600, -32601, -32602]);
const PROVIDER_FAILURE_CODES = new Set<ErrorCode>([
  "execution_failed",
  "timeout",
  "credential_unavailable",
  "provider_unavailable",
]);
const PROVIDER_RECEIPT_CLAIMS = new Set(["execution", "delivery"]);
const EXTERNAL_REFERENCE_CLAIMS = new Set(["execution", "delivery", "state"]);

class McpRpcError extends Error {
  readonly code: number;

  constructor(method: string, code: number) {
    super(`MCP ${method} failed with JSON-RPC error ${code}`);
    this.name = "McpRpcError";
    this.code = code;
  }
}

/** An MCP client session over a transport: lazy `initialize`, then requests. */
function session(transport: McpTransport, clientInfo: { name: string; version: string }) {
  let nextId = 1;
  let initialized: Promise<void> | undefined;
  const send = async (method: string, params?: Json): Promise<Json> => {
    const response = await transport({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params ? { params } : {}),
    });
    if (response.error) throw new McpRpcError(method, response.error.code);
    return (isRecord(response.result) ? response.result : {}) as Json;
  };
  return {
    /** Calls a tool. Initialization failures mean the tool call was never sent. */
    async call(name: string, args: Json, meta?: Json): Promise<Json> {
      initialized ??= send("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo,
      })
        .then(() => undefined)
        .catch((error: unknown) => {
          initialized = undefined;
          throw new ProviderUnreachableError(
            error instanceof Error ? error.message : "MCP initialization failed",
          );
        });
      await initialized;
      return send("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    },
  };
}

/** Maps a failed tools/call to a provider result: provable non-execution fails, anything else is unknown. */
function callFailure(
  error: unknown,
  envelope: { protocol: typeof PROTOCOL; invocation_id: string },
): ProviderResult {
  if (error instanceof ProviderUnreachableError) throw error;
  if (error instanceof McpRpcError && NOT_EXECUTED.has(error.code))
    return {
      ...envelope,
      status: "failed",
      error: { code: "execution_failed", message: error.message },
    };
  return {
    ...envelope,
    status: "unknown",
    error: { code: "execution_failed", message: "the MCP tool call did not complete" },
  };
}

export interface McpToolMapping extends Partial<Implementation> {
  capability: string;
  /** The downstream MCP tool. Its name never becomes a capability identifier. */
  tool: string;
  toArguments?: (input: Json, invocation: Invocation) => Json;
  toOutput?: (result: { structuredContent?: Json; content?: unknown[] }) => Json;
  /** Claims a successful tool result proves; `execution` by default. */
  claims?: string[];
}

export interface McpAdapterOptions {
  id: string;
  version?: string;
  transport: McpTransport;
  capabilities: McpToolMapping[];
  credentials?: { required: boolean; accepts: CredentialOwner[] };
}

/**
 * A provider that implements capabilities by calling tools of a downstream MCP server
 * (MCP server as adapter, bindings/mcp/README.md §2). Evidence is a digest of the tool
 * result, never the mere absence of an error.
 */
export function mcpToolProvider(options: McpAdapterOptions): Provider {
  const version = options.version ?? "0.1.0";
  const mcp = session(options.transport, { name: options.id, version });
  const manifest: ProviderManifest = {
    protocol: PROTOCOL,
    provider: { id: options.id, version },
    adapter: { id: `${options.id}-mcp`, version, system: "mcp" },
    implements: options.capabilities.map(
      ({ tool: _tool, toArguments: _a, toOutput: _o, claims, ...implementation }) => ({
        ...implementation,
        versions: implementation.versions ?? ["^0.1"],
        evidence: implementation.evidence ?? { claims: claims ?? ["execution"] },
      }),
    ),
    credentials: options.credentials ?? { required: false, accepts: [] },
    bindings: [{ type: "in_process" }],
  };
  return {
    manifest,
    async execute(invocation, context): Promise<ProviderResult> {
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      const mapping = options.capabilities.find((m) => m.capability === invocation.capability.id);
      if (!mapping)
        return {
          ...envelope,
          status: "failed",
          error: { code: "execution_failed", message: "capability not mapped" },
        };
      const args = mapping.toArguments
        ? mapping.toArguments(invocation.input, invocation)
        : invocation.input;
      let result: Json;
      try {
        result = await mcp.call(mapping.tool, args);
      } catch (error) {
        return callFailure(error, envelope);
      }
      // A tool error is the tool's own report that it did not perform the operation.
      if (result["isError"] === true)
        return {
          ...envelope,
          status: "failed",
          error: { code: "execution_failed", message: "the MCP tool reported an error" },
        };
      const structured = isRecord(result["structuredContent"])
        ? (result["structuredContent"] as Json)
        : undefined;
      const content = Array.isArray(result["content"]) ? (result["content"] as unknown[]) : [];
      const output = mapping.toOutput
        ? mapping.toOutput({ ...(structured ? { structuredContent: structured } : {}), content })
        : (structured ?? {});
      return {
        ...envelope,
        status: "completed",
        output,
        evidence: [
          {
            type: "provider_receipt",
            claims: (mapping.claims ?? ["execution"]).filter((c) => PROVIDER_RECEIPT_CLAIMS.has(c)),
            observed_at: context.now().toISOString(),
            data: { tool: mapping.tool, result_digest: digest(result) },
          },
        ],
      };
    },
  };
}

export interface McpRuntimeProviderOptions {
  id: string;
  version?: string;
  /** Transport to a runtime that exposes the mcp/0.1 binding. */
  transport: McpTransport;
  /** Capabilities delegated to the downstream runtime (tool names follow mcp/0.1). */
  capabilities: Array<string | (Partial<Implementation> & { capability: string })>;
  credentials?: { required: boolean; accepts: CredentialOwner[] };
}

interface ToolResult {
  protocol?: unknown;
  execution_id?: unknown;
  status?: unknown;
  output?: unknown;
  receipt?: unknown;
  error?: { code?: unknown };
}

/**
 * A provider that delegates capabilities to another runtime through its MCP binding
 * (runtime federation). The downstream runtime proves the claims this runtime requires:
 * they are forwarded as `evidence.require`, and the downstream never completes without
 * them. The downstream request identifier is the invocation identifier, so repeating a
 * call returns the existing outcome instead of repeating the effect.
 */
export function mcpRuntimeProvider(options: McpRuntimeProviderOptions): Provider {
  const version = options.version ?? "0.1.0";
  const mcp = session(options.transport, { name: options.id, version });
  const manifest: ProviderManifest = {
    protocol: PROTOCOL,
    provider: { id: options.id, version },
    adapter: { id: `${options.id}-mcp`, version, system: "runtime-protocol" },
    implements: options.capabilities.map((entry) => {
      const spec = typeof entry === "string" ? { capability: entry } : entry;
      return {
        ...spec,
        versions: spec.versions ?? ["^0.1"],
        reconciliation: spec.reconciliation ?? "supported",
      };
    }),
    credentials: options.credentials ?? { required: false, accepts: [] },
    bindings: [{ type: "in_process" }],
  };

  const call = async (invocation: Invocation): Promise<ToolResult> => {
    const args: Json = {
      input: invocation.input,
      evidence: { require: invocation.evidence.require },
      constraints: { deadline: invocation.deadline },
      ...(invocation.profile ? { profile: invocation.profile } : {}),
      ...(invocation.traits.length > 0 ? { traits: { required: invocation.traits } } : {}),
      ...(invocation.idempotency_key ? { idempotency_key: invocation.idempotency_key } : {}),
    };
    const result = await mcp.call(toolName(invocation.capability.id), args, {
      "runtime-protocol/request_id": invocation.invocation_id,
    });
    const structured = result["structuredContent"];
    return isRecord(structured) && structured["protocol"] === PROTOCOL
      ? (structured as ToolResult)
      : {};
  };

  const evidenceFor = (
    invocation: Invocation,
    result: ToolResult,
    now: Date,
    claims: string[],
  ): EvidenceItem[] => {
    const receipt = result.receipt as ExecutionReceipt;
    return [
      {
        type: "external_reference",
        claims,
        observed_at: now.toISOString(),
        external_ref: `execution://${String(result.execution_id)}`,
        data: {
          execution_id: String(result.execution_id),
          status: String(result.status),
          receipt_digest: receipt.integrity.digest,
        },
      },
    ];
  };
  const verified = (result: ToolResult) =>
    isRecord(result.receipt) && verifyReceipt(result.receipt as unknown as ExecutionReceipt);
  const provenClaims = (invocation: Invocation) => {
    const claims = invocation.evidence.require.filter((c) => EXTERNAL_REFERENCE_CLAIMS.has(c));
    return claims.includes("execution") ? claims : ["execution", ...claims];
  };

  return {
    manifest,
    async execute(invocation, context): Promise<ProviderResult> {
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      let result: ToolResult;
      try {
        result = await call(invocation);
      } catch (error) {
        return callFailure(error, envelope);
      }
      switch (result.status) {
        case "completed":
          if (!verified(result) || !isRecord(result.output)) break;
          return {
            ...envelope,
            status: "completed",
            output: result.output as Json,
            evidence: evidenceFor(invocation, result, context.now(), provenClaims(invocation)),
            observed_at: context.now().toISOString(),
          };
        case "failed":
        case "rejected":
        case "cancelled": {
          const code = result.error?.code as ErrorCode | undefined;
          return {
            ...envelope,
            status: "failed",
            error: {
              code: code && PROVIDER_FAILURE_CODES.has(code) ? code : "execution_failed",
              message: `the downstream runtime reported ${result.status}${typeof code === "string" ? ` (${code})` : ""}`,
            },
          };
        }
      }
      // Downstream unknown, running or awaiting approval: the effect may still happen.
      return {
        ...envelope,
        status: "unknown",
        error: { code: "execution_failed", message: "the downstream outcome is not settled" },
      };
    },
    async reconcile(invocation, context): Promise<Reconciliation> {
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      let result: ToolResult;
      try {
        result = await call(invocation);
      } catch {
        return {
          ...envelope,
          status: "inconclusive",
          reason: "the downstream runtime could not be queried",
        };
      }
      if (!verified(result))
        return {
          ...envelope,
          status: "inconclusive",
          reason: `the downstream execution is ${String(result.status ?? "unreadable")}`,
        };
      if (result.status === "completed" && isRecord(result.output))
        return {
          ...envelope,
          status: "completed",
          output: result.output as Json,
          evidence: evidenceFor(invocation, result, context.now(), provenClaims(invocation)),
        };
      if (
        result.status === "failed" ||
        result.status === "rejected" ||
        result.status === "cancelled"
      )
        return {
          ...envelope,
          status: "failed",
          final: true,
          reason: `the downstream runtime settled the execution as ${result.status}`,
          evidence: evidenceFor(invocation, result, context.now(), ["state"]),
        };
      return {
        ...envelope,
        status: "inconclusive",
        reason: `the downstream execution is ${String(result.status)}`,
      };
    },
  };
}
