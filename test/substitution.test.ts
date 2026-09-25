import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRuntime,
  GrantAuthority,
  InMemoryCredentialBroker,
  InMemoryEventLog,
  SequentialIds,
  verifyReceipt,
  type CapabilityRequest,
  type CredentialBinding,
  type ExecutionOutcome,
  type Provider,
  type Runtime,
} from "../src/index.ts";
import {
  connectRemoteProvider,
  createProviderHttpHandler,
  serve,
} from "../src/bindings/http/index.ts";
import { createMcpServer, mcpRuntimeProvider } from "../src/bindings/mcp/index.ts";
import { createReferenceProvider, type ReferenceProvider } from "../src/reference/index.ts";
import { fixedClock, grants, SUPPORT_AGENT } from "./helpers.ts";

/**
 * The caller's intent. It names no provider, transport, account or key; every
 * scenario below runs this exact document.
 */
const intent: CapabilityRequest = {
  protocol: "runtime/0.1",
  request_id: "req_substitution",
  capability: { id: "communication.send", version: "^0.1" },
  profile: "email",
  traits: { required: ["delivery_receipt"] },
  actor: { ref: SUPPORT_AGENT, type: "agent" },
  authority: { ref: "authority://company/support-manager" },
  input: {
    recipients: ["identity://customer/981"],
    subject: "Account update",
    content: "Your account has been updated.",
  },
  evidence: { require: ["execution", "delivery"] },
};

const KEYS = {
  "secret://runtime/providers/reference": "canary-managed-key-11aa",
  "secret://organization/providers/reference": "canary-byok-key-22bb",
};

function runtimeWith(
  providers: Provider[],
  bindings: CredentialBinding[] = [],
  clock: () => Date = fixedClock(),
): { runtime: Runtime; events: InMemoryEventLog } {
  const events = new InMemoryEventLog();
  const runtime = createRuntime({
    id: "support-runtime",
    providers,
    authority: grants,
    credentials: { bindings, broker: new InMemoryCredentialBroker(KEYS) },
    events,
    ids: new SequentialIds(),
    clock,
  });
  return { runtime, events };
}

/** What must hold whichever provider, transport or account served the intent. */
async function assertSameIntentServed(
  runtime: Runtime,
  events: InMemoryEventLog,
  outcome: ExecutionOutcome,
  delivered: ReferenceProvider,
) {
  assert.equal(outcome.execution.state, "completed", JSON.stringify(outcome.error));
  assert.ok(outcome.receipt && verifyReceipt(outcome.receipt));
  assert.equal(outcome.receipt.receipt.capability.id, "communication.send");
  assert.equal(outcome.receipt.receipt.request_id, intent.request_id);
  const capability = runtime.registry.capability("communication.send")!;
  assert.deepEqual(
    runtime.registry.schemas.validate(
      runtime.registry.outputSchemaId(capability),
      outcome.execution.output,
    ),
    [],
  );
  const claims = new Set(
    (await runtime.listEvidence(outcome.execution.execution_id)).flatMap((e) => e.claims),
  );
  assert.ok(claims.has("execution") && claims.has("delivery"));
  assert.equal(events.ofType("communication.sent").length, 1);
  assert.equal(delivered.outbox.length, 1, "exactly one effect");
  const visible = JSON.stringify([
    outcome,
    events.events,
    await runtime.listEvidence(outcome.execution.execution_id),
  ]);
  for (const key of Object.values(KEYS))
    assert.ok(!visible.includes(key), "key material never leaves the adapter boundary");
}

test("managed ↔ BYOK: the operator's binding decides the account, not the caller", async () => {
  const managed = createReferenceProvider();
  const m = runtimeWith(
    [managed],
    [{ provider: "reference", ref: "secret://runtime/providers/reference" }],
  );
  const managedOutcome = await m.runtime.execute(intent);
  await assertSameIntentServed(m.runtime, m.events, managedOutcome, managed);
  assert.equal(managedOutcome.receipt?.receipt.credential_owner, "runtime");

  const byok = createReferenceProvider();
  const b = runtimeWith(
    [byok],
    [{ provider: "reference", ref: "secret://organization/providers/reference" }],
  );
  const byokOutcome = await b.runtime.execute(intent);
  await assertSameIntentServed(b.runtime, b.events, byokOutcome, byok);
  assert.equal(byokOutcome.receipt?.receipt.credential_owner, "organization");

  // Both bindings present: the organization's own key wins (spec/0.1/providers.md §3.2).
  const both = createReferenceProvider();
  const o = runtimeWith(
    [both],
    [
      { provider: "reference", ref: "secret://runtime/providers/reference" },
      { provider: "reference", ref: "secret://organization/providers/reference" },
    ],
  );
  assert.equal((await o.runtime.execute(intent)).receipt?.receipt.credential_owner, "organization");
});

test("in-process ↔ REST ↔ MCP: the transport changes, the intent and its proof do not", async () => {
  // REST: the provider runs behind the http/0.1 provider API and holds its own key.
  const restReference = createReferenceProvider({ id: "rest-reference" });
  const providerServer = await serve(
    createProviderHttpHandler(restReference, { credentials: new InMemoryCredentialBroker(KEYS) }),
  );
  try {
    const rest = runtimeWith(
      [await connectRemoteProvider({ url: providerServer.url })],
      [{ provider: "rest-reference", ref: "secret://organization/providers/reference" }],
    );
    const restOutcome = await rest.runtime.execute(intent);
    await assertSameIntentServed(rest.runtime, rest.events, restOutcome, restReference);
    assert.equal(restOutcome.execution.provider?.id, "rest-reference");
  } finally {
    await providerServer.close();
  }

  // MCP: another runtime exposes the capability over mcp/0.1 and proves the claims.
  const downstreamReference = createReferenceProvider();
  const service = { ref: "identity://service/support-runtime", type: "service" as const };
  const downstream = createRuntime({
    id: "delivery-runtime",
    providers: [downstreamReference],
    authority: new GrantAuthority([
      {
        id: "federation",
        authority: "authority://delivery/federation",
        subjects: [service.ref],
        capabilities: ["communication.send"],
      },
    ]),
    credentials: {
      bindings: [{ provider: "reference", ref: "secret://organization/providers/reference" }],
      broker: new InMemoryCredentialBroker(KEYS),
    },
  });
  const mcpServer = createMcpServer(downstream, { actor: service });
  const federated = mcpRuntimeProvider({
    id: "delivery-runtime",
    transport: async (request) => (await mcpServer.handle(request))!,
    capabilities: [
      {
        capability: "communication.send",
        profiles: ["email"],
        traits: ["delivery_receipt", "idempotency"],
        evidence: { claims: ["execution", "delivery"] },
      },
    ],
  });
  // Deadlines are absolute: both runtimes share the wall clock.
  const mcp = runtimeWith([federated], [], () => new Date());
  const mcpOutcome = await mcp.runtime.execute(intent);
  await assertSameIntentServed(mcp.runtime, mcp.events, mcpOutcome, downstreamReference);
  assert.equal(mcpOutcome.execution.provider?.id, "delivery-runtime");
  assert.equal(
    mcpOutcome.receipt?.receipt.credential_owner,
    undefined,
    "the downstream runtime holds its own account",
  );
  const [evidence] = await mcp.runtime.listEvidence(mcpOutcome.execution.execution_id);
  assert.match(String(evidence?.external_ref), /^execution:\/\//);
});

test("provider swap: an unavailable provider is replaced without touching the intent", async () => {
  const alpha = createReferenceProvider({ id: "alpha" });
  const beta = createReferenceProvider({ id: "beta" });
  const { runtime } = runtimeWith(
    [alpha, beta],
    [
      { provider: "alpha", ref: "secret://organization/providers/reference" },
      { provider: "beta", ref: "secret://organization/providers/reference" },
    ],
  );
  const first = await runtime.execute(intent);
  assert.equal(first.execution.provider?.id, "alpha");
  runtime.setProviderAvailability("alpha", false);
  const second = await runtime.execute({ ...intent, request_id: "req_substitution_2" });
  assert.equal(second.execution.state, "completed");
  assert.equal(second.execution.provider?.id, "beta");
  assert.deepEqual(
    second.execution.output && Object.keys(second.execution.output).sort(),
    Object.keys(first.execution.output!).sort(),
  );
  assert.equal(alpha.outbox.length + beta.outbox.length, 2);
});
