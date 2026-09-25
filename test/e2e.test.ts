import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, verifyReceipt, verifyEvidence } from "../src/index.ts";
import { ORG_KEY, setup, smokeRequest } from "./helpers.ts";

test("smoke: support agent → communication.send/email with delivery evidence via BYOK → receipt → event", async () => {
  const { runtime, reference, events } = setup();
  const outcome = await runtime.execute(smokeRequest);
  const { execution, receipt } = outcome;

  // intent, authority, policy, resolution, BYOK, reference adapter, completion
  assert.equal(execution.state, "completed", JSON.stringify(outcome.error));
  assert.deepEqual(
    execution.history.map((h) => h.state),
    ["pending", "authorized", "running", "completed"],
  );
  assert.deepEqual(execution.authority, {
    decision: "allow",
    ref: "authority://company/support-manager",
    grant_id: "support",
  });
  assert.equal(execution.policy?.decision, "allow");
  assert.deepEqual(execution.provider, { id: "reference", version: "0.1.0" });
  assert.equal(execution.credential_owner, "organization");
  assert.equal(reference.outbox.length, 1);
  assert.equal(reference.outbox[0]!.profile, "email");

  // provider evidence
  const evidence = await runtime.listEvidence(execution.execution_id);
  assert.deepEqual(evidence.flatMap((e) => e.claims).sort(), ["delivery", "execution"]);
  for (const e of evidence) {
    assert.ok(verifyEvidence(e));
    assert.deepEqual(Registry.core().schemas.validate("evidence", e), []);
  }

  // canonical receipt
  assert.ok(receipt);
  assert.equal(receipt.receipt.status, "completed");
  assert.ok(verifyReceipt(receipt));
  assert.deepEqual(Registry.core().schemas.validate("execution-receipt", receipt), []);
  assert.deepEqual(Registry.core().schemas.validate("execution", execution), []);
  assert.equal(receipt.receipt.credential_owner, "organization");
  assert.ok(
    !JSON.stringify(receipt).includes("secret://"),
    "receipts never carry credential references",
  );

  // communication.sent event
  assert.deepEqual(
    events.events.map((e) => e.type),
    ["communication.sent"],
  );
  assert.equal(events.events[0]!.causation?.execution_id, execution.execution_id);
  assert.deepEqual(receipt.receipt.events, [events.events[0]!.id]);
  assert.deepEqual(Registry.core().schemas.validate("event", events.events[0]), []);

  // the materialized key never leaves the adapter boundary
  const everything = JSON.stringify([outcome, evidence, events.events]);
  assert.ok(!everything.includes(ORG_KEY));
});

test("the shorthand form of the guideline works with session defaults", async () => {
  const { runtime } = setup({
    defaults: {
      actor: { ref: "identity://agent/support-agent" },
      credential: { owner: "organization" },
    },
  });
  const outcome = await runtime.execute({
    capability: "knowledge.search",
    input: { query: "reset password" },
  });
  assert.equal(outcome.execution.state, "completed");
  assert.equal((outcome.execution.output as { results: unknown[] }).results.length > 0, true);
});
