import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProtocolError,
  runRecipe,
  validateRecipe,
  type PolicySet,
  type Recipe,
} from "../src/index.ts";
import { setup, smokeRequest, SUPPORT_AGENT } from "./helpers.ts";

const approveHighRisk: PolicySet = {
  protocol: "runtime/0.1",
  id: "policy://test/approvals",
  version: 1,
  default: "allow",
  rules: [
    {
      id: "approve-mutations",
      match: { mutating: true },
      effect: "require_approval",
      obligations: { approvers: ["identity://user/founder"] },
    },
  ],
};

test("authority is deny-by-default and happens before any provider call", async () => {
  const { runtime, reference } = setup();
  const outcome = await runtime.execute({
    ...smokeRequest,
    actor: { ref: "identity://agent/stranger" },
    authority: undefined as never,
  });
  assert.equal(outcome.execution.state, "rejected");
  assert.equal(outcome.error?.code, "authority_denied");
  assert.equal(reference.calls["communication.send"], undefined);
  assert.equal(outcome.receipt?.receipt.provider, undefined);
});

test("approval: the execution waits, an approver approves, the provider is invoked once", async () => {
  const { runtime, reference } = setup({ policySet: approveHighRisk });
  const pending = await runtime.execute(smokeRequest);
  assert.equal(pending.execution.state, "awaiting_approval");
  assert.equal(pending.receipt, undefined);
  await assert.rejects(
    runtime.decide(pending.execution.execution_id, {
      decided_by: SUPPORT_AGENT,
      decision: "approved",
    }),
    ProtocolError,
  );
  await assert.rejects(
    runtime.decide(pending.execution.execution_id, {
      decided_by: "identity://user/intern",
      decision: "approved",
    }),
    ProtocolError,
  );
  const done = await runtime.decide(pending.execution.execution_id, {
    decided_by: "identity://user/founder",
    decision: "approved",
    rationale: "ok",
  });
  assert.equal(done.execution.state, "completed");
  assert.equal(done.receipt?.receipt.approval?.decided_by, "identity://user/founder");
  assert.equal(reference.outbox.length, 1);
  const claims = (await runtime.listEvidence(done.execution.execution_id))
    .flatMap((e) => e.claims)
    .sort();
  assert.deepEqual(claims, ["approval", "delivery", "execution"]);
});

test("a lost response after the effect is unknown, never retried, and reconciled with evidence", async () => {
  const { runtime, reference } = setup({
    reference: { faults: { "communication.send": "lost_response" } },
  });
  const first = await runtime.execute(smokeRequest);
  assert.equal(first.execution.state, "unknown");
  assert.equal(first.receipt?.receipt.status, "unknown");
  assert.equal(reference.outbox.length, 1, "the effect happened");
  // Resubmission returns the same execution; nothing is re-sent.
  const again = await runtime.execute(smokeRequest);
  assert.equal(again.execution.execution_id, first.execution.execution_id);
  assert.equal(reference.calls["communication.send"], 1);
  // A different request with the same idempotency key is refused while the outcome is unknown.
  const conflict = await runtime.execute({
    ...smokeRequest,
    request_id: "req_other",
    idempotency_key: first.execution.idempotency_key!,
  });
  assert.equal(conflict.error?.detail, "idempotency_conflict");
  const reconciled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(reconciled.execution.state, "completed");
  assert.deepEqual(
    reconciled.execution.history.map((h) => h.state),
    ["pending", "authorized", "running", "unknown", "completed"],
  );
  assert.equal(reference.outbox.length, 1, "reconciliation never repeats the effect");
  assert.deepEqual(
    reconciled.events.map((e) => e.type),
    ["communication.sent"],
  );
});

test("a timeout of a mutating call is unknown; of a read it is failed", async () => {
  const { runtime } = setup({
    reference: { faults: { "communication.send": "timeout", "knowledge.search": "timeout" } },
  });
  const send = await runtime.execute({ ...smokeRequest, constraints: { timeout_ms: 20 } });
  assert.equal(send.execution.state, "unknown");
  assert.equal(send.error?.code, "timeout");
  const read = await runtime.execute({
    capability: "knowledge.search",
    input: { query: "refund" },
    actor: SUPPORT_AGENT,
    constraints: { timeout_ms: 20 },
  });
  assert.equal(read.execution.state, "failed");
  assert.equal(read.error?.code, "timeout");
});

test("reconciliation proving no effect fails the execution", async () => {
  const { runtime } = setup({ reference: { faults: { "communication.send": "unknown" } } });
  const first = await runtime.execute(smokeRequest);
  assert.equal(first.execution.state, "unknown");
  const reconciled = await runtime.reconcile(first.execution.execution_id);
  assert.equal(reconciled.execution.state, "failed");
  assert.equal(reconciled.error?.detail, "reconciled_not_applied");
});

test("request identity: same request returns the execution, a different body conflicts", async () => {
  const { runtime } = setup();
  const a = await runtime.execute(smokeRequest);
  const b = await runtime.execute(smokeRequest);
  assert.equal(a.execution.execution_id, b.execution.execution_id);
  await assert.rejects(
    runtime.execute({ ...smokeRequest, input: { ...smokeRequest.input, subject: "Other" } }),
    /request_id/,
  );
});

test("cancellation before dispatch, and terminal states never change", async () => {
  const { runtime } = setup({ policySet: approveHighRisk });
  const pending = await runtime.execute(smokeRequest);
  const cancelled = await runtime.cancel(pending.execution.execution_id);
  assert.equal(cancelled.execution.state, "cancelled");
  assert.equal(cancelled.receipt?.receipt.status, "cancelled");
  const again = await runtime.cancel(pending.execution.execution_id);
  assert.equal(again.execution.history.length, cancelled.execution.history.length);
  await assert.rejects(
    runtime.decide(pending.execution.execution_id, {
      decided_by: "identity://user/founder",
      decision: "approved",
    }),
  );
});

test("policy evidence obligations become required claims and traits", async () => {
  const { runtime } = setup({
    policySet: {
      protocol: "runtime/0.1",
      id: "policy://test/delivery",
      version: 1,
      default: "allow",
      rules: [
        {
          id: "prove-delivery",
          match: { capabilities: ["communication.*"] },
          effect: "allow",
          obligations: { evidence: { require: ["delivery"] } },
        },
      ],
    },
  });
  const outcome = await runtime.execute({
    ...smokeRequest,
    request_id: "req_obl",
    traits: undefined as never,
    evidence: undefined as never,
  });
  assert.equal(outcome.execution.state, "completed");
  assert.deepEqual(outcome.execution.traits, ["delivery_receipt"]);
});

test("recipes run step by step, each with its own authority, receipt and evidence", async () => {
  const { runtime } = setup();
  const recipe: Recipe = {
    id: "support.reply",
    version: "0.1.0",
    status: "experimental",
    level: "L2",
    description: "Find an article and email it to the customer.",
    inputs: {
      type: "object",
      properties: { question: { type: "string" }, customer: { type: "string" } },
    },
    steps: [
      {
        id: "find",
        capability: "knowledge.search",
        input: { query: { $from: "inputs.question" }, limit: 1 },
      },
      {
        id: "reply",
        capability: "communication.send",
        profile: "email",
        input: {
          recipients: [{ $from: "inputs.customer" }],
          subject: "Your question",
          content: "See the article we found for you.",
        },
      },
    ],
  };
  assert.deepEqual(validateRecipe(recipe), []);
  const run = await runRecipe(
    recipe,
    { question: "reset my password", customer: "identity://customer/981" },
    runtime,
    {
      actor: SUPPORT_AGENT,
      credential: "organization",
      request_id: "req_recipe",
    },
  );
  assert.equal(run.completed, true);
  assert.deepEqual(
    run.steps.map((s) => [s.id, s.outcome.execution.state, Boolean(s.outcome.receipt)]),
    [
      ["find", "completed", true],
      ["reply", "completed", true],
    ],
  );
});

test("discovery advertises resolvable capabilities without secrets or grants", () => {
  const { runtime } = setup();
  const discovery = runtime.discovery();
  assert.deepEqual(
    discovery.capabilities.map((c) => c.id),
    ["communication.send", "knowledge.search", "reasoning.classify"],
  );
  assert.deepEqual(runtime.registry.schemas.validate("discovery", discovery), []);
  const text = JSON.stringify(discovery);
  assert.ok(!text.includes("secret://") && !text.includes("grant"));
});
