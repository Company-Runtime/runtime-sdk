import {
  createRuntime,
  GrantAuthority,
  InMemoryCredentialBroker,
  InMemoryEventLog,
  PolicySetEvaluator,
  SequentialIds,
  type PolicySet,
  type RuntimeOptions,
} from "../src/index.ts";
import { createReferenceProvider, type ReferenceProviderOptions } from "../src/reference/index.ts";

export const SUPPORT_AGENT = "identity://agent/support-agent";
export const ORG_KEY_REF = "secret://organization/providers/reference";
export const ORG_KEY = "canary-organization-key-7c1d";

export const grants = new GrantAuthority([
  {
    id: "support",
    authority: "authority://company/support-manager",
    subjects: [SUPPORT_AGENT],
    capabilities: [
      "communication.send",
      "knowledge.search",
      "reasoning.classify",
      "resource.delete",
    ],
  },
  {
    id: "founder",
    authority: "authority://company/founder",
    subjects: ["identity://user/founder"],
    capabilities: ["approval.decide"],
  },
]);

export function fixedClock(start = "2026-01-01T00:00:00.000Z") {
  let t = Date.parse(start);
  return () => new Date((t += 1));
}

export function setup(
  options: Partial<RuntimeOptions> & {
    reference?: ReferenceProviderOptions;
    policySet?: PolicySet;
  } = {},
) {
  const reference = createReferenceProvider(options.reference);
  const events = new InMemoryEventLog();
  const runtime = createRuntime({
    id: "test-runtime",
    providers: [reference],
    authority: grants,
    credentials: {
      bindings: [{ provider: "reference", ref: ORG_KEY_REF }],
      broker: new InMemoryCredentialBroker({ [ORG_KEY_REF]: ORG_KEY }),
    },
    events,
    ids: new SequentialIds(),
    clock: fixedClock(),
    ...(options.policySet ? { policy: new PolicySetEvaluator(options.policySet) } : {}),
    ...options,
  });
  return { runtime, reference, events };
}

export const smokeRequest = {
  protocol: "runtime/0.1" as const,
  request_id: "req_smoke",
  capability: { id: "communication.send", version: "^0.1" },
  profile: "email",
  traits: { required: ["delivery_receipt"] },
  actor: { ref: SUPPORT_AGENT, type: "agent" as const },
  authority: { ref: "authority://company/support-manager" },
  input: {
    recipients: ["identity://customer/981"],
    subject: "Account update",
    content: "Your account has been updated.",
  },
  evidence: { require: ["execution", "delivery"] },
  credential: { owner: "organization" as const },
};
