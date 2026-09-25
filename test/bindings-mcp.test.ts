import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createRuntime,
  GrantAuthority,
  InMemoryCredentialBroker,
  SequentialIds,
  verifyReceipt,
  type Json,
} from "../src/index.ts";
import {
  createMcpServer,
  mcpRuntimeProvider,
  mcpToolProvider,
  serveStdio,
  toolsFor,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
} from "../src/bindings/mcp/index.ts";
import { createReferenceProvider } from "../src/reference/index.ts";
import { grants, ORG_KEY, ORG_KEY_REF, setup, smokeRequest, SUPPORT_AGENT } from "./helpers.ts";

const session = {
  actor: { ref: SUPPORT_AGENT, type: "agent" as const },
  credential: { owner: "organization" as const },
};
const rpc = (id: number, method: string, params?: Json): JsonRpcRequest => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params ? { params } : {}),
});
// Tool results are loosely typed JSON; tests read them through this view.
const view = (response: JsonRpcResponse | undefined) => response?.result as Record<string, any>;

test("mcp/0.1 lifecycle: initialize negotiates, ping answers, notifications are silent", async () => {
  const { runtime } = setup();
  const server = createMcpServer(runtime, session);
  const init = view(
    await server.handle(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {} })),
  );
  assert.equal(init["protocolVersion"], "2025-03-26");
  assert.deepEqual(init["capabilities"], { tools: { listChanged: false } });
  const fallback = view(
    await server.handle(rpc(2, "initialize", { protocolVersion: "1999-01-01" })),
  );
  assert.equal(fallback["protocolVersion"], "2025-06-18");
  assert.deepEqual(view(await server.handle(rpc(3, "ping"))), {});
  assert.equal(
    await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }),
    undefined,
  );
  assert.equal((await server.handle(rpc(4, "resources/list")))?.error?.code, -32601);
});

test("tools/list exposes one self-contained tool per resolvable capability", async () => {
  const { runtime } = setup();
  const tools = toolsFor(runtime);
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "communication__send",
    "knowledge__search",
    "reasoning__classify",
  ]);
  const send = tools.find((t) => t.name === "communication__send")!;
  assert.equal(send.title, "communication.send");
  assert.equal(send.annotations.readOnlyHint, false);
  assert.equal(send.annotations.idempotentHint, true);
  assert.equal(tools.find((t) => t.name === "knowledge__search")!.annotations.readOnlyHint, true);
  assert.deepEqual(send._meta, {
    "runtime-protocol/capability": "communication.send",
    "runtime-protocol/version": "0.1.0",
  });
  // MCP hosts cannot resolve registry URNs: every schema is inlined.
  assert.doesNotMatch(JSON.stringify(tools), /"\$ref":"urn:/);
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(send.inputSchema as object);
  assert.ok(
    validate({
      input: smokeRequest.input,
      profile: "email",
      traits: { required: ["delivery_receipt"] },
    }),
  );
  assert.ok(!validate({ input: { recipients: [] }, profile: "fax" }));
});

test("tools/call runs as the session actor and returns a verifiable receipt", async () => {
  const { runtime, reference } = setup();
  const server = createMcpServer(runtime, session);
  const call = rpc(1, "tools/call", {
    name: "communication__send",
    // The actor comes from the session; a tool argument cannot choose it.
    arguments: {
      input: smokeRequest.input,
      profile: "email",
      traits: smokeRequest.traits,
      evidence: smokeRequest.evidence,
      actor: { ref: "identity://user/founder" },
    },
    _meta: { "runtime-protocol/request_id": "req_mcp_1" },
  });
  const result = view(await server.handle(call));
  assert.equal(result["isError"], false);
  const structured = result["structuredContent"];
  assert.equal(structured.status, "completed");
  assert.ok(verifyReceipt(structured.receipt));
  assert.equal(structured.receipt.receipt.actor.ref, SUPPORT_AGENT);
  assert.equal(structured.receipt.receipt.request_id, "req_mcp_1");
  assert.equal(structured.receipt.receipt.credential_owner, "organization");
  assert.match(result["content"][0].text, /communication\.send completed/);
  // The same request identifier returns the existing outcome, never a second effect.
  const again = view(await server.handle({ ...call, id: 2 }));
  assert.equal(again["structuredContent"].execution_id, structured.execution_id);
  assert.equal(reference.outbox.length, 1);
});

test("denials are tool errors; unknown tools are JSON-RPC errors", async () => {
  const { runtime } = setup();
  const stranger = createMcpServer(runtime, {
    actor: { ref: "identity://agent/stranger", type: "agent" },
  });
  const denied = view(
    await stranger.handle(
      rpc(1, "tools/call", {
        name: "knowledge__search",
        arguments: { input: { query: "password" } },
      }),
    ),
  );
  assert.equal(denied["isError"], true);
  assert.equal(denied["structuredContent"].status, "rejected");
  assert.equal(denied["structuredContent"].error.code, "authority_denied");
  const unknown = await stranger.handle(
    rpc(2, "tools/call", { name: "vendor__acme__send", arguments: { input: {} } }),
  );
  assert.equal(unknown?.error?.code, -32602);
});

test("stdio transport: newline-delimited JSON-RPC in, responses out", async () => {
  const { runtime } = setup();
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => (written += chunk.toString("utf8")));
  const done = serveStdio(createMcpServer(runtime, session), { input, output });
  input.write(`${JSON.stringify(rpc(1, "initialize", { protocolVersion: "2025-06-18" }))}\n`);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  input.write("not json\n\n");
  input.write(`${JSON.stringify(rpc(2, "tools/list"))}\n`);
  input.end();
  await done;
  const responses = written
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRpcResponse);
  assert.equal(responses.length, 3);
  const byId = new Map(responses.map((r) => [r.id, r]));
  assert.equal(byId.get(null)?.error?.code, -32700);
  assert.equal((byId.get(1)?.result as Json)["protocolVersion"], "2025-06-18");
  assert.equal(((byId.get(2)?.result as Json)["tools"] as unknown[]).length, 3);
});

/** A downstream MCP server with one vendor-shaped tool, as an adapter finds it. */
function docsServer(options: { failInitialize?: boolean } = {}) {
  const calls: Json[] = [];
  const transport: McpTransport = async (request) => {
    const id = request.id ?? null;
    if (request.method === "initialize")
      return options.failInitialize
        ? { jsonrpc: "2.0", id, error: { code: -32603, message: "starting" } }
        : {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "docs", version: "1" },
            },
          };
    if (request.method !== "tools/call")
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    const params = request.params as Record<string, any>;
    calls.push(params);
    if (params["name"] !== "search_docs")
      return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
    if (params["arguments"].q === "offline")
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "index offline" }], isError: true },
      };
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: "1 hit" }],
        structuredContent: {
          hits: [
            {
              id: "reset-password",
              title: "Reset your password",
              text: "Open Settings, then Security.",
            },
          ],
        },
      },
    };
  };
  return { transport, calls };
}

function docsProvider(transport: McpTransport, tool = "search_docs") {
  return mcpToolProvider({
    id: "docs",
    transport,
    capabilities: [
      {
        capability: "knowledge.search",
        tool,
        toArguments: (input) => ({ q: input["query"] as string }),
        toOutput: ({ structuredContent }) => ({
          results: ((structuredContent?.["hits"] ?? []) as Array<Record<string, string>>).map(
            (hit) => ({
              source: `resource://docs/${hit["id"]}`,
              title: hit["title"]!,
              excerpt: hit["text"]!,
            }),
          ),
        }),
      },
    ],
  });
}

test("MCP server as adapter: a downstream tool implements a core capability with evidence", async () => {
  const docs = docsServer();
  const runtime = createRuntime({ providers: [docsProvider(docs.transport)], authority: grants });
  const outcome = await runtime.execute({
    capability: "knowledge.search",
    input: { query: "reset password" },
    actor: SUPPORT_AGENT,
  });
  assert.equal(outcome.execution.state, "completed");
  assert.equal(outcome.execution.provider?.id, "docs");
  assert.deepEqual(
    (outcome.execution.output as Record<string, any>)["results"][0].source,
    "resource://docs/reset-password",
  );
  assert.deepEqual(docs.calls[0], { name: "search_docs", arguments: { q: "reset password" } });
  const [evidence] = await runtime.listEvidence(outcome.execution.execution_id);
  assert.equal(evidence?.type, "provider_receipt");
  assert.match(String((evidence?.data as Json)["result_digest"]), /^sha256:[0-9a-f]{64}$/);
  // The downstream tool name never becomes vocabulary.
  assert.equal(runtime.registry.capability("search_docs"), undefined);
});

test("MCP server as adapter: tool errors fail, protocol errors fail, a dead server is unavailable", async () => {
  const docs = docsServer();
  const runtime = createRuntime({ providers: [docsProvider(docs.transport)], authority: grants });
  const offline = await runtime.execute({
    capability: "knowledge.search",
    input: { query: "offline" },
    actor: SUPPORT_AGENT,
  });
  assert.equal(offline.execution.state, "failed");
  assert.equal(offline.error?.code, "execution_failed");

  const renamed = createRuntime({
    providers: [docsProvider(docs.transport, "search_v2")],
    authority: grants,
  });
  const unknownTool = await renamed.execute({
    capability: "knowledge.search",
    input: { query: "x" },
    actor: SUPPORT_AGENT,
  });
  assert.equal(unknownTool.execution.state, "failed");

  const dead = createRuntime({
    providers: [docsProvider(docsServer({ failInitialize: true }).transport)],
    authority: grants,
  });
  const unavailable = await dead.execute({
    capability: "knowledge.search",
    input: { query: "x" },
    actor: SUPPORT_AGENT,
  });
  assert.equal(unavailable.execution.state, "failed");
  assert.equal(unavailable.error?.code, "provider_unavailable");
});

test("runtime federation over MCP: an uncertain downstream outcome reconciles without a second effect", async () => {
  const delivered = createReferenceProvider({ faults: { "communication.send": "lost_response" } });
  const service = { ref: "identity://service/support-runtime", type: "service" as const };
  const downstream = createRuntime({
    id: "delivery-runtime",
    providers: [delivered],
    authority: new GrantAuthority([
      {
        id: "federation",
        authority: "authority://delivery/federation",
        subjects: [service.ref],
        capabilities: ["communication.send"],
      },
    ]),
    credentials: {
      bindings: [{ provider: "reference", ref: ORG_KEY_REF }],
      broker: new InMemoryCredentialBroker({ [ORG_KEY_REF]: ORG_KEY }),
    },
    ids: new SequentialIds(),
  });
  const server = createMcpServer(downstream, { actor: service });
  const upstream = createRuntime({
    providers: [
      mcpRuntimeProvider({
        id: "delivery-runtime",
        transport: async (request) => (await server.handle(request))!,
        capabilities: [
          {
            capability: "communication.send",
            profiles: ["email"],
            traits: ["delivery_receipt", "idempotency"],
            evidence: { claims: ["execution", "delivery"] },
          },
        ],
      }),
    ],
    authority: grants,
  });
  const { credential: _credential, ...request } = smokeRequest;
  const first = await upstream.execute(request);
  assert.equal(first.execution.state, "unknown");
  assert.equal(delivered.outbox.length, 1, "the effect happened; only the answer was lost");

  // The downstream outcome is still unknown: reconciliation is inconclusive and sends nothing.
  assert.equal((await upstream.reconcile(first.execution.execution_id)).execution.state, "unknown");

  // Once the downstream runtime reconciles its own execution, the upstream one settles.
  assert.equal((await downstream.reconcile("exec_0001")).execution.state, "completed");
  const settled = await upstream.reconcile(first.execution.execution_id);
  assert.equal(settled.execution.state, "completed");
  assert.ok(settled.receipt && verifyReceipt(settled.receipt));
  assert.equal(delivered.outbox.length, 1);
  assert.equal(delivered.calls["communication.send"], 1);
});
