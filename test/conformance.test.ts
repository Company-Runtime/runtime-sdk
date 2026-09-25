import { test } from "node:test";
import assert from "node:assert/strict";
import { defineProvider, PROTOCOL, type Provider } from "../src/index.ts";
import {
  runConformance,
  runProviderHarness,
  PROVIDER_REQUIREMENTS,
} from "../src/conformance/index.ts";
import { createReferenceProvider } from "../src/reference/index.ts";

test("the reference runtime passes the whole runtime/0.1 conformance suite", async () => {
  const report = await runConformance();
  const failures = report.results
    .filter((r) => !r.passed)
    .map((r) => `${r.id}: ${r.failures.join("; ")}`);
  assert.deepEqual(failures, []);
  assert.equal(report.total, 58);
  const categories = new Set(report.results.map((r) => r.category));
  for (const required of [
    "schema_validation",
    "canonical_naming",
    "domain_verb_existence",
    "unknown_profiles",
    "missing_traits",
    "version_mismatch",
    "authority_denial",
    "policy_denial",
    "invalid_state_transition",
    "raw_secret_rejection",
    "provider_resolution",
    "receipt_generation",
    "evidence_requirement",
    "deprecated_alias",
    "namespace_isolation",
    "end_to_end",
  ])
    assert.ok(categories.has(required), required);
});

const samples = [
  {
    capability: "communication.send",
    profile: "email",
    traits: ["delivery_receipt"],
    input: { recipients: ["identity://customer/1"], subject: "Hi", content: "Hello" },
    credential: { ref: "secret://organization/providers/reference", value: "canary-harness-0001" },
  },
  {
    capability: "knowledge.search",
    input: { query: "refund" },
    credential: { ref: "secret://organization/providers/reference", value: "canary-harness-0001" },
  },
  {
    capability: "reasoning.classify",
    input: {
      input: "charged twice",
      labels: [{ id: "billing", description: "charges" }, { id: "access" }],
    },
    credential: { ref: "secret://organization/providers/reference", value: "canary-harness-0001" },
  },
];

test("the reference provider meets every provider requirement", async () => {
  const report = await runProviderHarness(createReferenceProvider(), samples);
  assert.deepEqual(
    report.requirements.filter((r) => !r.passed),
    [],
  );
  assert.deepEqual(
    report.requirements.map((r) => r.id),
    Object.keys(PROVIDER_REQUIREMENTS),
  );
});

test("the harness catches assertion without evidence, leaks and lax input validation", async () => {
  const { manifest } = defineProvider({
    id: "sloppy",
    capabilities: [{ capability: "communication.send", traits: ["idempotency"] }],
    credentials: { required: true, accepts: ["organization"] },
    handlers: {},
  });
  // A hand-written provider: no input validation, no evidence, echoes its credential.
  const sloppy: Provider = {
    manifest,
    execute: async (invocation, context) => ({
      protocol: PROTOCOL,
      invocation_id: invocation.invocation_id,
      status: "completed",
      output: {
        message: { ref: "resource://x/1" },
        accepted_recipients: [],
        echo: (await context.credential()) ?? null,
      },
      evidence: [],
      observed_at: context.now().toISOString(),
    }),
  };
  const report = await runProviderHarness(sloppy, [samples[0]!]);
  const failed = report.requirements.filter((r) => !r.passed).map((r) => r.id);
  assert.ok(failed.includes("PC-003"), "asserts completion without evidence");
  assert.ok(failed.includes("PC-005"), "leaks the materialized credential");
  assert.ok(failed.includes("PC-009"), "accepts invalid input");
  assert.equal(report.passed, false);
});
