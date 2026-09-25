import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRuntime,
  defineProvider,
  GrantAuthority,
  InMemoryCredentialBroker,
  PolicySetEvaluator,
} from "../src/index.ts";

const grants = new GrantAuthority([
  {
    id: "all",
    authority: "authority://t/all",
    subjects: ["identity://agent/a"],
    capabilities: ["*"],
  },
]);
const search = (id: string, extra: Record<string, unknown> = {}) =>
  defineProvider({
    id,
    capabilities: [
      {
        capability: "knowledge.search",
        cost: { estimate: { amount: 0.01, currency: "USD" } },
        regions: ["eu"],
        ...extra,
      },
    ],
    handlers: {
      "knowledge.search": (_input, ctx) => ({
        output: { results: [] },
        evidence: [ctx.evidence.providerReceipt(["execution"], { id })],
      }),
    },
  });
const request = {
  capability: "knowledge.search",
  input: { query: "hello" },
  actor: "identity://agent/a",
};

test("eligible providers are ordered by preference, preferred traits, identifier and version", async () => {
  const runtime = createRuntime({
    authority: grants,
    providers: [search("zeta"), search("alpha"), search("beta", { traits: [] }), search("mid", {})],
  });
  let r = await runtime.resolve(request);
  assert.deepEqual(
    r.eligible.map((e) => e.provider.id),
    ["alpha", "beta", "mid", "zeta"],
  );
  r = await runtime.resolve({
    ...request,
    constraints: { providers: { prefer: ["zeta", "mid"] } },
  });
  assert.deepEqual(
    r.eligible.map((e) => e.provider.id),
    ["zeta", "mid", "alpha", "beta"],
  );
});

test("resolution is deterministic regardless of registration order", async () => {
  const a = createRuntime({
    authority: grants,
    providers: [search("p1"), search("p2"), search("p3")],
  });
  const b = createRuntime({
    authority: grants,
    providers: [search("p3"), search("p1"), search("p2")],
  });
  assert.deepEqual(await a.resolve(request), await b.resolve(request));
});

test("rejections carry the stage and the overall code is the latest stage", async () => {
  const runtime = createRuntime({
    authority: grants,
    providers: [
      search("costly", { cost: { estimate: { amount: 5, currency: "USD" } } }),
      search("foreign", { regions: ["us"] }),
    ],
  });
  const r = await runtime.resolve({
    ...request,
    constraints: { max_cost: { amount: 1, currency: "USD" }, regions: { allow: ["eu"] } },
  });
  assert.deepEqual(r.eligible, []);
  assert.deepEqual(
    r.rejected.map((x) => [x.provider.id, x.stage, x.code, x.detail]),
    [
      ["costly", 7, "constraint_unsatisfied", "cost_exceeds_limit"],
      ["foreign", 7, "constraint_unsatisfied", "region_not_allowed"],
    ],
  );
  assert.equal(r.error?.code, "constraint_unsatisfied");
});

test("a credential selector requires a matching credential; without one, providers that need none are eligible", async () => {
  const byok = defineProvider({
    id: "byok",
    capabilities: ["knowledge.search"],
    credentials: { required: true, accepts: ["organization"] },
    handlers: { "knowledge.search": () => ({ output: { results: [] } }) },
  });
  const open = search("open");
  const runtime = createRuntime({
    authority: grants,
    providers: [byok, open],
    credentials: {
      bindings: [{ provider: "byok", ref: "secret://organization/kb" }],
      broker: new InMemoryCredentialBroker({ "secret://organization/kb": "canary-kb-0001" }),
    },
  });
  assert.deepEqual(
    (await runtime.resolve(request)).eligible.map((e) => [
      e.provider.id,
      e.credential_owner ?? null,
    ]),
    [
      ["byok", "organization"],
      ["open", null],
    ],
  );
  const selected = await runtime.resolve({ ...request, credential: "organization" });
  assert.deepEqual(
    selected.eligible.map((e) => e.provider.id),
    ["byok"],
  );
  assert.deepEqual(
    selected.rejected.map((x) => [x.provider.id, x.stage]),
    [["open", 8]],
  );
});

test("provider-scoped policy and provider risk make providers ineligible", async () => {
  const risky = search("risky", { risk: "high" });
  const safe = search("safe");
  const runtime = createRuntime({
    authority: grants,
    providers: [risky, safe, search("banned")],
    policy: new PolicySetEvaluator({
      protocol: "runtime/0.1",
      id: "policy://t/p",
      version: 1,
      default: "allow",
      rules: [
        { id: "approve-high", match: { risk: { at_least: "high" } }, effect: "require_approval" },
        { id: "ban", match: { providers: ["banned"] }, effect: "deny" },
      ],
    }),
  });
  const r = await runtime.resolve(request);
  assert.deepEqual(
    r.eligible.map((e) => e.provider.id),
    ["safe"],
  );
  assert.deepEqual(
    r.rejected.map((x) => [x.provider.id, x.stage, x.detail]),
    [
      ["banned", 6, "rule_ban"],
      ["risky", 6, "provider_risk_not_allowed"],
    ],
  );
});
