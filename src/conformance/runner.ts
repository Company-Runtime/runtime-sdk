import { GrantAuthority } from "../authority.ts";
import { InMemoryCredentialBroker } from "../credentials.ts";
import { ProtocolError } from "../errors.ts";
import { SequentialIds } from "../ids.ts";
import { isRecord, mergePatch } from "../json.ts";
import { validateManifest } from "../manifest.ts";
import { PolicySetEvaluator } from "../policy.ts";
import { bundle } from "../protocol/bundle.generated.ts";
import { Registry } from "../registry.ts";
import { Runtime, type ExecutionOutcome } from "../runtime.ts";
import { canTransition } from "../state.ts";
import { InMemoryExecutionStore } from "../store.ts";
import type {
  AuthorityGrants,
  CapabilityRequest,
  CredentialBinding,
  ErrorBody,
  ExecutionState,
  PolicySet,
  RegistryOverlay,
} from "../types.ts";
import { validateRequest } from "../validation.ts";
import {
  scriptedProvider,
  type ProviderFixture,
  type ScriptedProvider,
} from "./scripted-provider.ts";

/** A conformance case (conformance/schemas/case.schema.json). */
export interface ConformanceCase {
  id: string;
  title: string;
  category: string;
  level: "document" | "runtime";
  kind: "document" | "request" | "state_machine" | "resolution" | "execution";
  given?: {
    overlays?: string[];
    providers?: string[];
    authority?: string;
    policy?: string;
    credentials?: CredentialBinding[];
    secrets?: Record<string, string>;
    unavailable_providers?: string[];
  };
  document_type?: string;
  document?: unknown;
  request?: unknown;
  transitions?: Array<{ from: ExecutionState; to: ExecutionState; valid: boolean }>;
  then?: Array<Record<string, unknown>>;
  expect_initial?: Expectation;
  expect: Expectation;
}

interface Expectation {
  valid?: boolean;
  error?: { code: string; detail?: string };
  capability?: { id?: string; requested_as?: string };
  state?: ExecutionState;
  history?: ExecutionState[];
  provider?: string | null;
  provider_invocations?: number;
  reconcile_invocations?: number;
  executions?: number;
  evidence_claims?: string[];
  events?: string[];
  warnings?: string[];
  forbidden?: string[];
  receipt?: {
    status?: string;
    provider?: string | null;
    credential_owner?: string | null;
    requested_as?: string;
    has?: string[];
    lacks?: string[];
    forbidden?: string[];
  };
  resolution?: {
    eligible: string[];
    rejected: Array<{ provider: string; stage: number; code: string }>;
  };
}

export interface CaseResult {
  id: string;
  title: string;
  category: string;
  passed: boolean;
  failures: string[];
}

export interface ConformanceReport {
  suite: string;
  protocol: string;
  protocol_commit: string;
  level: "runtime";
  passed: boolean;
  total: number;
  failed: number;
  results: CaseResult[];
}

/** Loads a case source: a path, `{ $base, $patch }` or an inline document. */
export function resolveSource(
  source: unknown,
  documents: Record<string, unknown> = bundle.conformance.documents,
): unknown {
  if (typeof source === "string") return structuredClone(fixture(source, documents));
  if (isRecord(source) && typeof source["$base"] === "string") {
    const base = fixture(source["$base"], documents);
    return source["$patch"] === undefined
      ? structuredClone(base)
      : mergePatch(base, source["$patch"]);
  }
  return structuredClone(source);
}

function fixture(path: string, documents: Record<string, unknown>): unknown {
  if (!(path in documents)) throw new Error(`fixture ${path} is not in the bundle`);
  return documents[path];
}

/** Everything a case needs to build a runtime. */
export interface Arrangement {
  runtime: Runtime;
  store: InMemoryExecutionStore;
  providers: ScriptedProvider[];
  registry: Registry;
}

/** Builds the runtime described by a case's `given` block. Implementations adapting the suite replace this. */
export function arrange(given: ConformanceCase["given"] = {}): Arrangement {
  const overlays = (given.overlays ?? []).map((p) => resolveSource(p) as RegistryOverlay);
  const providers = (given.providers ?? []).map((p) =>
    scriptedProvider(resolveSource(p) as ProviderFixture),
  );
  const store = new InMemoryExecutionStore();
  let tick = Date.parse("2026-01-01T00:00:00.000Z");
  const runtime = new Runtime({
    id: "conformance-runtime",
    overlays,
    providers,
    ...(given.authority
      ? { authority: new GrantAuthority(resolveSource(given.authority) as AuthorityGrants) }
      : {}),
    ...(given.policy
      ? { policy: new PolicySetEvaluator(resolveSource(given.policy) as PolicySet) }
      : {}),
    credentials: {
      bindings: given.credentials ?? [],
      broker: new InMemoryCredentialBroker(given.secrets ?? {}),
    },
    store,
    ids: new SequentialIds(),
    clock: () => new Date((tick += 1)),
  });
  for (const id of given.unavailable_providers ?? []) runtime.setProviderAvailability(id, false);
  return { runtime, store, providers, registry: runtime.registry };
}

function compareError(
  failures: string[],
  expected: Expectation["error"],
  actual: { code: string; detail?: string } | undefined,
) {
  if (!expected) return;
  if (!actual) failures.push(`expected error ${expected.code}, got none`);
  else if (actual.code !== expected.code || (expected.detail && actual.detail !== expected.detail))
    failures.push(
      `expected error ${expected.code}/${expected.detail ?? "*"}, got ${actual.code}/${actual.detail ?? "-"}`,
    );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
}

async function checkOutcome(
  failures: string[],
  expect: Expectation,
  outcome: ExecutionOutcome,
  arrangement: Arrangement,
): Promise<void> {
  const { runtime, store, providers } = arrangement;
  const execution = outcome.execution;
  if (expect.state && execution.state !== expect.state)
    failures.push(`expected state ${expect.state}, got ${execution.state}`);
  if (expect.history) {
    const history = execution.history.map((h) => h.state);
    if (history.join(">") !== expect.history.join(">"))
      failures.push(`expected history ${expect.history.join(" → ")}, got ${history.join(" → ")}`);
  }
  compareError(failures, expect.error, outcome.error ?? execution.error);
  if (expect.provider !== undefined && (execution.provider?.id ?? null) !== expect.provider)
    failures.push(`expected provider ${expect.provider}, got ${execution.provider?.id ?? null}`);
  const invocations = providers.reduce((n, p) => n + p.executions, 0);
  if (expect.provider_invocations !== undefined && invocations !== expect.provider_invocations)
    failures.push(
      `expected ${expect.provider_invocations} provider invocation(s), got ${invocations}`,
    );
  const reconciliations = providers.reduce((n, p) => n + p.reconciliations, 0);
  if (
    expect.reconcile_invocations !== undefined &&
    reconciliations !== expect.reconcile_invocations
  )
    failures.push(
      `expected ${expect.reconcile_invocations} reconciliation(s), got ${reconciliations}`,
    );
  if (expect.executions !== undefined) {
    const count = (await store.list()).length;
    if (count !== expect.executions)
      failures.push(`expected ${expect.executions} execution(s), got ${count}`);
  }
  const evidence = await runtime.listEvidence(execution.execution_id);
  if (expect.evidence_claims) {
    const claims = [...new Set(evidence.flatMap((e) => e.claims))];
    if (!sameSet(claims, expect.evidence_claims))
      failures.push(`expected evidence claims [${expect.evidence_claims}], got [${claims}]`);
  }
  const events = await runtime.listEvents(execution.execution_id);
  if (
    expect.events &&
    !sameSet(
      events.map((e) => e.type),
      expect.events,
    )
  )
    failures.push(`expected events [${expect.events}], got [${events.map((e) => e.type)}]`);
  if (expect.warnings) {
    const warnings: string[] = (execution.warnings ?? []).map((w) => w.code);
    for (const w of expect.warnings)
      if (!warnings.includes(w)) failures.push(`expected warning ${w}`);
  }
  if (expect.receipt) {
    const r = outcome.receipt?.receipt;
    if (!r) failures.push("expected a receipt");
    else {
      const e = expect.receipt;
      if (e.status && r.status !== e.status)
        failures.push(`expected receipt status ${e.status}, got ${r.status}`);
      if (e.provider !== undefined && (r.provider?.id ?? null) !== e.provider)
        failures.push(`expected receipt provider ${e.provider}, got ${r.provider?.id ?? null}`);
      if (e.credential_owner !== undefined && (r.credential_owner ?? null) !== e.credential_owner)
        failures.push(
          `expected receipt credential_owner ${e.credential_owner}, got ${r.credential_owner ?? null}`,
        );
      if (e.requested_as && r.capability.requested_as !== e.requested_as)
        failures.push(`expected requested_as ${e.requested_as}`);
      for (const field of e.has ?? []) if (!(field in r)) failures.push(`receipt lacks ${field}`);
      for (const field of e.lacks ?? [])
        if (field in r) failures.push(`receipt must not have ${field}`);
      const text = JSON.stringify(outcome.receipt);
      for (const s of e.forbidden ?? [])
        if (text.includes(s)) failures.push(`receipt contains forbidden text`);
      if (runtime.registry.schemas.validate("execution-receipt", outcome.receipt).length > 0)
        failures.push("receipt is schema-invalid");
    }
  }
  if (expect.forbidden) {
    const text = JSON.stringify([outcome, evidence, events, await store.list()]);
    for (const s of expect.forbidden)
      if (text.includes(s)) failures.push("a forbidden string leaked into the runtime's records");
  }
  if (runtime.registry.schemas.validate("execution", execution).length > 0)
    failures.push(
      `execution is schema-invalid: ${runtime.registry.schemas.validate("execution", execution)[0]}`,
    );
}

async function runCase(testCase: ConformanceCase): Promise<string[]> {
  const failures: string[] = [];
  const expect = testCase.expect;
  switch (testCase.kind) {
    case "state_machine":
      for (const t of testCase.transitions ?? [])
        if (canTransition(t.from, t.to) !== t.valid)
          failures.push(`${t.from} → ${t.to} should be ${t.valid ? "allowed" : "refused"}`);
      return failures;
    case "request": {
      const { registry } = arrange(testCase.given);
      const result = validateRequest(resolveSource(testCase.request), registry);
      if (expect.valid !== undefined && result.ok !== expect.valid)
        failures.push(`expected valid=${expect.valid}, got ${result.ok}`);
      compareError(failures, expect.error, result.error);
      for (const w of expect.warnings ?? [])
        if (!result.warnings.some((x) => x.code === w)) failures.push(`expected warning ${w}`);
      if (expect.capability?.id && result.capability?.id !== expect.capability.id)
        failures.push(`expected capability ${expect.capability.id}`);
      if (
        expect.capability?.requested_as &&
        result.capability?.requested_as !== expect.capability.requested_as
      )
        failures.push(`expected requested_as ${expect.capability.requested_as}`);
      return failures;
    }
    case "document": {
      const document = resolveSource(testCase.document);
      const registry = Registry.core();
      const type = testCase.document_type!;
      let problems =
        type in bundle.schemas
          ? registry.schemas.validate(type, document)
          : [`unknown type ${type}`];
      if (problems.length === 0 && type === "provider-manifest")
        problems = validateManifest(document, registry)
          .filter((f) => f.severity === "error")
          .map((f) => f.message);
      if (problems.length === 0 && type === "registry-overlay")
        problems = registry.checkOverlay(document as RegistryOverlay);
      if (problems.length === 0 && type === "capability-request") {
        const result = validateRequest(document, registry);
        if (!result.ok) problems = [result.error!.message];
      }
      if (expect.valid !== undefined && (problems.length === 0) !== expect.valid)
        failures.push(`expected valid=${expect.valid}${problems[0] ? ` (${problems[0]})` : ""}`);
      return failures;
    }
    case "resolution": {
      const { runtime } = arrange(testCase.given);
      const resolution = await runtime.resolve(
        resolveSource(testCase.request) as CapabilityRequest,
      );
      compareError(failures, expect.error, resolution.error);
      if (expect.resolution) {
        const eligible = resolution.eligible.map((e) => e.provider.id);
        if (eligible.join(",") !== expect.resolution.eligible.join(","))
          failures.push(`expected eligible [${expect.resolution.eligible}], got [${eligible}]`);
        const key = (r: { provider: string; stage: number; code: string }) =>
          `${r.provider}:${r.stage}:${r.code}`;
        const rejected = resolution.rejected.map((r) =>
          key({ provider: r.provider.id, stage: r.stage, code: r.code }),
        );
        if (!sameSet(rejected, expect.resolution.rejected.map(key)))
          failures.push(
            `expected rejected [${expect.resolution.rejected.map(key)}], got [${rejected}]`,
          );
      }
      if (runtime.registry.schemas.validate("resolution", resolution).length > 0)
        failures.push("resolution is schema-invalid");
      return failures;
    }
    case "execution": {
      const arrangement = arrange(testCase.given);
      const { runtime } = arrangement;
      const request = resolveSource(testCase.request) as CapabilityRequest;
      let outcome = await runtime.execute(request);
      if (testCase.expect_initial)
        await checkOutcome(failures, testCase.expect_initial, outcome, arrangement);
      // An action refused without an execution leaves the current execution unchanged;
      // its error is the one `expect.error` asserts (spec/0.1/conformance.md §3).
      let refusal: ErrorBody | undefined;
      for (const action of testCase.then ?? []) {
        const id = outcome.execution.execution_id;
        refusal = undefined;
        try {
          if ("approve" in action)
            outcome = await runtime.decide(
              id,
              action["approve"] as { decided_by: string; decision: "approved" | "rejected" },
            );
          else if ("reconcile" in action) outcome = await runtime.reconcile(id);
          else if ("resubmit" in action) outcome = await runtime.execute(request);
          else if ("submit" in action)
            outcome = await runtime.execute(resolveSource(action["submit"]) as CapabilityRequest);
          else if ("cancel" in action) outcome = await runtime.cancel(id);
        } catch (error) {
          if (!(error instanceof ProtocolError)) throw error;
          refusal = error.toJSON();
          outcome = await runtime.getOutcome(id);
        }
      }
      await checkOutcome(
        failures,
        expect,
        refusal ? { ...outcome, error: refusal } : outcome,
        arrangement,
      );
      return failures;
    }
  }
}

/** Runs the bundled conformance suite against this SDK's runtime. */
export async function runConformance(
  filter?: (c: ConformanceCase) => boolean,
): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  for (const cases of Object.values(bundle.conformance.cases)) {
    for (const raw of cases) {
      const testCase = raw as unknown as ConformanceCase;
      if (filter && !filter(testCase)) continue;
      let failures: string[];
      try {
        failures = await runCase(testCase);
      } catch (error) {
        failures = [`threw: ${error instanceof Error ? error.message : String(error)}`];
      }
      results.push({
        id: testCase.id,
        title: testCase.title,
        category: testCase.category,
        passed: failures.length === 0,
        failures,
      });
    }
  }
  const failed = results.filter((r) => !r.passed).length;
  return {
    suite: String(bundle.conformance.suite["version"]),
    protocol: bundle.protocol,
    protocol_commit: bundle.source.commit,
    level: "runtime",
    passed: failed === 0,
    total: results.length,
    failed,
    results,
  };
}
