import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Registry,
  canTransition,
  findSecrets,
  parseCapabilityId,
  redactSecrets,
  satisfies,
  validateManifest,
  validateRequest,
  sanitizeMessage,
  capabilityFromToolName,
  toolName,
  protocolBundle,
  type ProviderManifest,
} from "../src/index.ts";

// The protocol's own fixtures: the end-to-end smoke request and an email provider.
const smokeRequest = protocolBundle.conformance.documents["fixtures/requests/send-email.yaml"];
const emailManifest = (
  protocolBundle.conformance.documents["fixtures/providers/example-email.yaml"] as {
    manifest: ProviderManifest;
  }
).manifest;

const code = (request: unknown, registry = Registry.core()) => {
  const r = validateRequest(request, registry);
  return r.ok ? "ok" : `${r.error!.code}/${r.error!.detail}`;
};
const clone = () => structuredClone(smokeRequest) as Record<string, any>;

test("request validation follows the eleven steps", () => {
  assert.equal(code(smokeRequest), "ok");
  assert.equal(
    code({ ...clone(), protocol: "runtime/0.2" }),
    "unsupported_version/unsupported_protocol",
  );
  const noActor = clone();
  delete noActor.actor;
  assert.equal(code(noActor), "invalid_request/schema_invalid");
  const secret = clone();
  secret.input.content = "xoxb-123456789012-abc";
  assert.equal(code(secret), "invalid_request/raw_secret");
  assert.equal(
    code({ ...clone(), capability: { id: "core.communication.send", version: "^0.1" } }),
    "invalid_request/invalid_capability_id",
  );
  assert.equal(
    code({ ...clone(), capability: { id: "vendor.x.communication.send", version: "^0.1" } }),
    "invalid_request/namespace_violation",
  );
  assert.equal(
    code({ ...clone(), capability: { id: "execution.run", version: "^0.1" } }),
    "unknown_capability/not_registered",
  );
  assert.equal(
    code({ ...clone(), capability: { id: "communication.send", version: "^2.0.0" } }),
    "unsupported_version/no_matching_version",
  );
  assert.equal(code({ ...clone(), profile: "pigeon" }), "unsupported_profile/unknown_profile");
  assert.equal(
    code({ ...clone(), traits: { required: ["streaming"] } }),
    "missing_trait/trait_not_declared",
  );
  const sms = clone();
  sms.profile = "sms";
  assert.equal(code(sms), "invalid_request/input_invalid");
});

test("gated input fields make traits required", () => {
  const r = clone();
  r.input.attachments = [
    { name: "a.pdf", media_type: "application/pdf", uri: "https://files.example.com/a.pdf" },
  ];
  const result = validateRequest(r, Registry.core());
  assert.equal(result.ok, true);
  assert.deepEqual(result.effectiveTraits, ["attachments", "delivery_receipt"]);
  assert.deepEqual(result.requiredClaims, ["delivery", "execution"]);
});

test("overlays add aliases and namespaced capabilities, never shadow core", () => {
  const registry = Registry.create([
    {
      protocol: "runtime/0.1",
      id: "acme",
      aliases: [
        { alias: "org.acme.message.dispatch", canonical: "communication.send", since: "0.1.0" },
      ],
    },
  ]);
  const result = validateRequest(
    { ...clone(), capability: { id: "org.acme.message.dispatch", version: "^0.1" } },
    registry,
  );
  assert.equal(result.ok, true);
  assert.equal(result.capability?.requested_as, "org.acme.message.dispatch");
  assert.throws(() =>
    Registry.create([
      {
        protocol: "runtime/0.1",
        id: "bad",
        aliases: [
          { alias: "communication.shout", canonical: "communication.send", since: "0.1.0" },
        ],
      },
    ]),
  );
});

test("manifests are validated against the registry", () => {
  assert.deepEqual(
    validateManifest(emailManifest).filter((f) => f.severity === "error"),
    [],
  );
  const manifest = structuredClone(emailManifest);
  manifest.implements[0]!.traits = ["attachments"];
  manifest.implements[0]!.reconciliation = "unsupported";
  assert.ok(validateManifest(manifest).some((f) => f.message.includes("idempotency")));
});

test("secrets are detected and redacted without echoing them", () => {
  assert.deepEqual(findSecrets({ a: { password: "hunter2hunter2" } }), [
    { path: "/a/password", kind: "sensitive_key" },
  ]);
  assert.deepEqual(findSecrets({ note: "x canary-value y" }, ["canary-value"]), [
    { path: "/note", kind: "materialized_credential" },
  ]);
  const text = redactSecrets(
    "key sk-abcdefghijklmnopqrstuv and canary-value at https://u:p@host/",
    ["canary-value"],
  );
  assert.ok(
    !text.includes("sk-abcdefghijklmnop") &&
      !text.includes("canary-value") &&
      !text.includes("u:p@"),
  );
  assert.ok(sanitizeMessage(`boom\n    at secret (file.js:1:1)`).startsWith("boom"));
  assert.ok(sanitizeMessage("x".repeat(2000)).length <= 512);
});

test("versions, identifiers and transitions", () => {
  assert.ok(satisfies("0.1.0", "^0.1") && !satisfies("0.2.0", "^0.1"));
  assert.deepEqual(parseCapabilityId("community.jane.work.create"), {
    namespace: "community",
    owner: "jane",
    local: ["work", "create"],
  });
  assert.equal(
    capabilityFromToolName(toolName("reasoning.structured_thing.generate")),
    "reasoning.structured_thing.generate",
  );
  assert.ok(
    canTransition("unknown", "completed") &&
      !canTransition("completed", "running") &&
      !canTransition("unknown", "cancelled"),
  );
});
