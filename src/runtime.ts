import { denyAll, questionFor, type AuthorityEvaluator } from "./authority.ts";
import {
  buildRequest,
  isFullRequest,
  type RequestDefaults,
  type RequestShorthand,
} from "./client.ts";
import { DEFAULT_LIMITS, PROTOCOL, SDK_VERSION } from "./constants.ts";
import type { CredentialBroker } from "./credentials.ts";
import { ProtocolError, errorBody, sanitizeMessage } from "./errors.ts";
import { coveredClaims, evidenceRef, recordEvidence } from "./evidence.ts";
import type { EventSink } from "./events.ts";
import { UlidGenerator, type IdGenerator } from "./ids.ts";
import { digest, isRecord } from "./json.ts";
import { assertValidManifest, type ManifestFinding } from "./manifest.ts";
import { allowAll, type PolicyEvaluator, type PolicyQuestion } from "./policy.ts";
import { ProviderUnreachableError, type Provider, type ProviderContext } from "./provider.ts";
import { buildReceipt } from "./receipt.ts";
import { Registry } from "./registry.ts";
import { resolveProviders, type Candidate } from "./resolver.ts";
import { findSecrets } from "./secrets.ts";
import { satisfies } from "./semver.ts";
import { InvalidTransitionError, canTransition, isTerminal } from "./state.ts";
import { InMemoryExecutionStore, type ExecutionRecord, type ExecutionStore } from "./store.ts";
import { validateRequest } from "./validation.ts";
import type {
  Actor,
  AuthorityDecision,
  CapabilityDefinition,
  CapabilityRequest,
  CredentialBinding,
  Discovery,
  ErrorBody,
  ErrorCode,
  Evidence,
  EvidenceItem,
  Execution,
  ExecutionReceipt,
  ExecutionState,
  IdentityRef,
  Invocation,
  Json,
  PolicyDecision,
  ProtocolEvent,
  ProviderResult,
  Reconciliation,
  RegistryOverlay,
  Resolution,
} from "./types.ts";

export interface RuntimeOptions {
  id?: string;
  version?: string;
  name?: string;
  /** Registry overlays: namespaced definitions and deprecated aliases. */
  overlays?: RegistryOverlay[];
  providers?: Provider[];
  /** Deny-by-default when absent. */
  authority?: AuthorityEvaluator;
  /** Allow when absent; authority still applies. */
  policy?: PolicyEvaluator;
  credentials?: { bindings?: CredentialBinding[]; broker?: CredentialBroker };
  store?: ExecutionStore;
  events?: EventSink | EventSink[];
  clock?: () => Date;
  ids?: IdGenerator;
  limits?: { maxRequestBytes?: number; defaultTimeoutMs?: number; maxTimeoutMs?: number };
  /** Session defaults applied to shorthand requests. */
  defaults?: RequestDefaults;
  /** Bindings advertised in the discovery document. */
  bindings?: Discovery["bindings"];
  /** Event source URI; defaults to runtime://<id>. */
  source?: string;
}

export interface ExecutionOutcome {
  execution: Execution;
  /** Present once the execution is terminal or unknown. */
  receipt?: ExecutionReceipt;
  events: ProtocolEvent[];
  error?: ErrorBody;
}

export interface ApprovalInput {
  decided_by: Actor | IdentityRef;
  decision: "approved" | "rejected";
  rationale?: string;
  decided_at?: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTITY = /^identity:\/\/[a-z0-9][a-z0-9._-]*\/\S+$/;
const RECEIPT_STATES: ReadonlySet<ExecutionState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "rejected",
  "unknown",
]);
const PROVIDER_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set([
  "execution_failed",
  "timeout",
  "credential_unavailable",
  "provider_unavailable",
]);

class DeadlineError extends Error {
  constructor() {
    super("The provider did not answer before the deadline.");
    this.name = "DeadlineError";
  }
}

/**
 * The reference runtime: the complete runtime/0.1 pipeline, from capability request to
 * evidence, receipt and events (spec/0.1/execution.md §2).
 */
export class Runtime {
  readonly registry: Registry;
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly #providers = new Map<string, Provider>();
  readonly #authority: AuthorityEvaluator;
  readonly #policy: PolicyEvaluator;
  readonly #bindings: CredentialBinding[];
  readonly #broker?: CredentialBroker;
  readonly #store: ExecutionStore;
  readonly #sinks: EventSink[];
  readonly #clock: () => Date;
  readonly #ids: IdGenerator;
  readonly #limits: { maxRequestBytes: number; defaultTimeoutMs: number; maxTimeoutMs: number };
  readonly #defaults: RequestDefaults;
  readonly #unavailable = new Set<string>();
  readonly #inflight = new Map<string, AbortController>();
  readonly #source: string;
  readonly #discoveryBindings: Discovery["bindings"];

  constructor(options: RuntimeOptions = {}) {
    this.registry = Registry.create(options.overlays ?? []);
    this.id = options.id ?? "runtime";
    this.version = options.version ?? SDK_VERSION;
    if (options.name) this.name = options.name;
    this.#authority = options.authority ?? denyAll;
    this.#policy = options.policy ?? allowAll;
    this.#bindings = [...(options.credentials?.bindings ?? [])];
    if (options.credentials?.broker) this.#broker = options.credentials.broker;
    this.#store = options.store ?? new InMemoryExecutionStore();
    this.#sinks =
      options.events === undefined
        ? []
        : Array.isArray(options.events)
          ? options.events
          : [options.events];
    this.#clock = options.clock ?? (() => new Date());
    this.#ids = options.ids ?? new UlidGenerator(this.#clock);
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#defaults = options.defaults ?? {};
    this.#source = options.source ?? `runtime://${this.id}`;
    this.#discoveryBindings = options.bindings ?? [{ type: "http", version: "0.1" }];
    for (const provider of options.providers ?? []) this.registerProvider(provider);
  }

  /** Validates and registers a provider; returns manifest warnings. */
  registerProvider(provider: Provider): ManifestFinding[] {
    const findings = assertValidManifest(provider.manifest, this.registry);
    const id = provider.manifest.provider.id;
    if (this.#providers.has(id))
      throw new ProtocolError("invalid_request", `Provider ${id} is already registered.`, {
        detail: "duplicate_provider",
      });
    this.#providers.set(id, provider);
    return findings;
  }

  providers(): Provider[] {
    return [...this.#providers.values()];
  }

  /** Marks a provider unavailable (resolution stage 9) or available again. */
  setProviderAvailability(id: string, available: boolean): void {
    if (available) this.#unavailable.delete(id);
    else this.#unavailable.add(id);
  }

  /** Refreshes availability from the providers' health operations. */
  async checkHealth(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [id, provider] of this.#providers) {
      if (!provider.health) continue;
      try {
        const health = await provider.health();
        out[id] = health.status;
        this.setProviderAvailability(id, health.status !== "unavailable");
      } catch {
        out[id] = "unavailable";
        this.setProviderAvailability(id, false);
      }
    }
    return out;
  }

  /** Submits a capability request, in full or shorthand form, and processes it. */
  async execute(input: CapabilityRequest | RequestShorthand): Promise<ExecutionOutcome> {
    const request = this.#normalize(input);
    const identity = identityOf(request);
    const requestDigest = digest(request);
    const existing = await this.#store.findByIdentity(identity);
    if (existing) {
      if (existing.requestDigest !== requestDigest)
        throw new ProtocolError(
          "invalid_request",
          "A different request with the same request_id exists.",
          { detail: "request_id_conflict" },
        );
      return this.#outcome(existing);
    }
    const record = this.#newRecord(
      request as unknown as CapabilityRequest,
      identity,
      requestDigest,
    );

    const validation = validateRequest(request, this.registry, {
      maxRequestBytes: this.#limits.maxRequestBytes,
    });
    if (validation.capability) record.execution.capability = validation.capability;
    if (validation.profile) record.execution.profile = validation.profile;
    if (validation.warnings.length > 0) record.execution.warnings = validation.warnings;
    if (!validation.ok) {
      const e = validation.error!;
      return this.#finish(
        record,
        "rejected",
        errorBody(e.code, e.message, { detail: e.detail, stage: "validation" }),
        "validation failed",
      );
    }
    const valid = request as unknown as CapabilityRequest;
    const capability = validation.definition!;
    record.request = valid;
    record.mutating = capability.effects.mutating;
    record.requiredClaims = validation.requiredClaims;
    record.effectiveTraits = validation.effectiveTraits;
    if (validation.resource) record.resource = validation.resource;
    if (record.effectiveTraits.length > 0) record.execution.traits = record.effectiveTraits;
    if (capability.effects.mutating) {
      const key = valid.idempotency_key ?? `${valid.actor.ref}/${valid.request_id}`;
      record.execution.idempotency_key = key;
      if (await this.#store.findUnsettledByIdempotencyKey(key))
        return this.#finish(
          record,
          "rejected",
          errorBody(
            "invalid_request",
            "Another execution with this idempotency key has an unsettled outcome; reconcile it first.",
            {
              detail: "idempotency_conflict",
            },
          ),
          "idempotency conflict",
        );
    }

    // Authority: deny-by-default, before anything else happens.
    const now = this.#clock();
    const authority = await this.#evaluateAuthority(
      questionFor(valid, capability.id, record.resource, now),
    );
    record.authority = authority;
    record.execution.authority = authoritySummary(authority);
    if (authority.decision !== "allow")
      return this.#finish(
        record,
        "rejected",
        errorBody("authority_denied", undefined, {
          detail: authority.detail ?? "no_matching_grant",
        }),
        authority.reason,
      );

    // Policy: allow, deny or require approval, with obligations.
    const policy = await this.#evaluatePolicy(this.#policyQuestion(capability, valid, now));
    record.policy = policy;
    if (policy.obligations) record.obligations = policy.obligations;
    record.execution.policy = {
      decision: policy.decision,
      refs: policy.policy_refs,
      matched_rules: policy.matched_rules,
    };
    if (policy.decision === "deny")
      return this.#finish(
        record,
        "rejected",
        errorBody("policy_denied", policy.reason, { detail: "policy_rule" }),
        policy.reason,
      );
    const obligationProblem = this.#applyObligations(record, capability);
    if (obligationProblem)
      return this.#finish(
        record,
        "rejected",
        errorBody("policy_denied", obligationProblem, { detail: "unsatisfiable_obligation" }),
        obligationProblem,
      );
    if (policy.decision === "require_approval") {
      this.#transition(record, "awaiting_approval", policy.reason);
      await this.#store.save(record);
      return this.#outcome(record);
    }
    this.#transition(record, "authorized", "authority and policy allow");
    return this.#dispatch(record, capability);
  }

  /** Dry-run resolution: validation, authority, policy and provider resolution; nothing executes. */
  async resolve(input: CapabilityRequest | RequestShorthand): Promise<Resolution> {
    const request = this.#normalize(input);
    const validation = validateRequest(request, this.registry, {
      maxRequestBytes: this.#limits.maxRequestBytes,
    });
    const capabilityRef = validation.capability ?? {
      id: String((request as { capability?: { id?: unknown } }).capability?.id ?? ""),
    };
    const failure = (error: ErrorBody): Resolution => ({
      protocol: PROTOCOL,
      capability: capabilityRef,
      eligible: [],
      rejected: [],
      error,
    });
    if (!validation.ok) {
      const e = validation.error!;
      return failure(errorBody(e.code, e.message, { detail: e.detail, stage: "validation" }));
    }
    const valid = request as unknown as CapabilityRequest;
    const capability = validation.definition!;
    const now = this.#clock();
    const authority = await this.#evaluateAuthority(
      questionFor(valid, capability.id, validation.resource, now),
    );
    if (authority.decision !== "allow")
      return failure(
        errorBody("authority_denied", undefined, {
          detail: authority.detail ?? "no_matching_grant",
        }),
      );
    const question = this.#policyQuestion(capability, valid, now);
    const policy = await this.#evaluatePolicy(question);
    if (policy.decision === "deny")
      return failure(errorBody("policy_denied", policy.reason, { detail: "policy_rule" }));
    const outcome = await resolveProviders({
      capability,
      request: valid,
      effectiveTraits: this.#effectiveTraits(validation.effectiveTraits, policy, capability),
      authority,
      policy: { evaluator: this.#policy, decision: policy, question },
      bindings: this.#bindings,
      ...(this.#broker ? { broker: this.#broker } : {}),
      providers: this.providers(),
      unavailable: this.#unavailable,
      now,
    });
    return {
      protocol: PROTOCOL,
      capability: capabilityRef,
      eligible: outcome.eligible.map((c) => ({
        provider: {
          id: c.provider.manifest.provider.id,
          version: c.provider.manifest.provider.version,
        },
        ...(c.credential ? { credential_owner: c.credential.owner } : {}),
      })),
      rejected: outcome.rejected,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /** Records an approval decision for an execution awaiting approval (spec/0.1/policy.md §5). */
  async decide(executionId: string, input: ApprovalInput): Promise<ExecutionOutcome> {
    const record = await this.#load(executionId);
    if (record.execution.state !== "awaiting_approval")
      throw new ProtocolError("invalid_request", "The execution is not awaiting approval.", {
        detail: "not_awaiting_approval",
      });
    const approver =
      typeof input.decided_by === "string" ? { ref: input.decided_by } : input.decided_by;
    const now = this.#clock();
    if (approver.ref === record.execution.actor.ref)
      throw new ProtocolError("authority_denied", "An actor cannot approve its own request.", {
        detail: "self_approval",
      });
    const approvers = record.obligations?.approvers;
    if (approvers && approvers.length > 0) {
      if (!approvers.includes(approver.ref))
        throw new ProtocolError(
          "authority_denied",
          "The actor is not an approver of this execution.",
          { detail: "not_an_approver" },
        );
    } else {
      const decision = await this.#evaluateAuthority({
        actor: approver.ref,
        capability: "approval.decide",
        at: now,
      });
      if (decision.decision !== "allow")
        throw new ProtocolError("authority_denied", "The actor may not decide approvals.", {
          detail: "not_an_approver",
        });
    }
    const decidedAt = input.decided_at ?? now.toISOString();
    const [attestation] = recordEvidence(
      [
        {
          type: "human_attestation",
          claims: ["approval"],
          observed_at: decidedAt,
          data: {
            statement: `${input.decision} ${record.execution.capability.id} for ${record.execution.execution_id}`,
            decision: input.decision,
            ...(input.rationale ? { rationale: input.rationale } : {}),
          },
        },
      ],
      { executionId, producedBy: { actor: approver.ref }, ids: this.#ids },
    );
    await this.#store.putEvidence(attestation!);
    record.execution.evidence.push(evidenceRef(attestation!.id));
    record.execution.approval = {
      decision: input.decision,
      decided_by: approver.ref,
      decided_at: decidedAt,
    };
    if (input.decision === "rejected")
      return this.#finish(
        record,
        "rejected",
        errorBody("policy_denied", "The approval was rejected.", { detail: "approval_rejected" }),
        "approval rejected",
      );
    this.#transition(record, "authorized", `approved by ${approver.ref}`);
    const capability = this.registry.capability(record.execution.capability.id)!;
    return this.#dispatch(record, capability);
  }

  /** Cancels an execution that has not been dispatched; signals a running one. */
  async cancel(executionId: string, reason = "cancelled by request"): Promise<ExecutionOutcome> {
    const record = await this.#load(executionId);
    const state = record.execution.state;
    if (state === "pending" || state === "awaiting_approval" || state === "authorized")
      return this.#finish(
        record,
        "cancelled",
        errorBody("cancelled", reason, { detail: "cancelled_before_dispatch" }),
        reason,
      );
    if (state === "running") this.#inflight.get(executionId)?.abort(new Error(reason));
    return this.#outcome(record);
  }

  /** Establishes the outcome of an unknown or running execution without re-sending it. */
  async reconcile(executionId: string): Promise<ExecutionOutcome> {
    const record = await this.#load(executionId);
    if (record.execution.state !== "unknown" && record.execution.state !== "running")
      return this.#outcome(record);
    const provider = record.providerId ? this.#providers.get(record.providerId) : undefined;
    if (!provider?.reconcile || !record.invocation) return this.#outcome(record);
    const capability = this.registry.capability(record.execution.capability.id)!;
    record.reconcileInvocations += 1;
    await this.#store.save(record);
    const materialized: string[] = [];
    let reconciliation: Reconciliation;
    try {
      reconciliation = await provider.reconcile(
        record.invocation,
        this.#context(record, new AbortController(), materialized),
      );
    } catch {
      return this.#outcome(record);
    }
    if (
      this.registry.schemas.validate("reconciliation", reconciliation).length > 0 ||
      findSecrets(reconciliation, materialized).length > 0 ||
      reconciliation.invocation_id !== record.invocation.invocation_id
    )
      return this.#outcome(record);
    if (reconciliation.status === "inconclusive") return this.#outcome(record);
    await this.#storeEvidence(record, reconciliation.evidence ?? []);
    if (reconciliation.status === "failed")
      return this.#finish(
        record,
        "failed",
        errorBody("execution_failed", reconciliation.reason ?? "Reconciliation proved no effect.", {
          detail: "reconciled_not_applied",
        }),
        "reconciled: not applied",
      );
    if (
      this.registry.schemas.validate(
        this.registry.outputSchemaId(capability),
        reconciliation.output,
      ).length > 0
    ) {
      await this.#store.save(record);
      return this.#outcome(record);
    }
    if ((await this.#missingClaims(record)).length > 0) {
      await this.#store.save(record);
      return this.#outcome(record);
    }
    return this.#complete(
      record,
      capability,
      reconciliation.output!,
      reconciliation.cost,
      "reconciled: applied",
    );
  }

  async getExecution(executionId: string): Promise<Execution | undefined> {
    return (await this.#store.get(executionId))?.execution;
  }

  async getOutcome(executionId: string): Promise<ExecutionOutcome> {
    return this.#outcome(await this.#load(executionId));
  }

  async getReceipt(executionId: string): Promise<ExecutionReceipt | undefined> {
    return (await this.#store.get(executionId))?.receipt;
  }

  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    return this.#store.getEvidence(evidenceId.replace(/^evidence:\/\//, ""));
  }

  async listEvidence(executionId: string): Promise<Evidence[]> {
    return this.#store.listEvidence(executionId);
  }

  async listEvents(executionId: string): Promise<ProtocolEvent[]> {
    return this.#store.listEvents(executionId);
  }

  /** Invocation counters, for audits and conformance. */
  async counters(executionId: string): Promise<{ provider: number; reconcile: number }> {
    const record = await this.#load(executionId);
    return { provider: record.providerInvocations, reconcile: record.reconcileInvocations };
  }

  /** The discovery document (spec/0.1/discovery.md). Reveals no secrets, grants or policies. */
  discovery(): Discovery {
    const capabilities: Discovery["capabilities"] = [];
    for (const [id, capability] of [...this.registry.capabilities].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const implementations = this.providers()
        .filter((p) => !this.#unavailable.has(p.manifest.provider.id))
        .flatMap((p) => p.manifest.implements)
        .filter(
          (i) => i.capability === id && i.versions.some((r) => satisfies(capability.version, r)),
        );
      if (implementations.length === 0) continue;
      const declared = new Set([
        ...(capability.traits.required ?? []),
        ...(capability.traits.optional ?? []),
      ]);
      capabilities.push({
        id,
        version: capability.version,
        profiles: [...new Set(implementations.flatMap((i) => i.profiles ?? []))]
          .filter((p) => capability.profiles.includes(p))
          .sort(),
        traits: [...new Set(implementations.flatMap((i) => i.traits ?? []))]
          .filter((t) => declared.has(t))
          .sort(),
      });
    }
    const namespaces = [
      ...new Set(
        [...this.registry.capabilities.keys()]
          .map((id) => id.split("."))
          .filter((parts) => ["experimental", "community", "vendor", "org"].includes(parts[0]!))
          .map((parts) =>
            parts[0] === "experimental" ? "experimental" : `${parts[0]}.${parts[1]}`,
          ),
      ),
    ].sort();
    return {
      protocol: PROTOCOL,
      runtime: { id: this.id, version: this.version, ...(this.name ? { name: this.name } : {}) },
      protocols: [PROTOCOL],
      registry: { version: this.registry.version, digest: this.registry.digest },
      capabilities,
      bindings: this.#discoveryBindings,
      limits: {
        max_request_bytes: this.#limits.maxRequestBytes,
        max_timeout_ms: this.#limits.maxTimeoutMs,
      },
      ...(namespaces.length > 0 ? { extensions: { namespaces } } : {}),
    };
  }

  // — pipeline internals —

  #normalize(input: CapabilityRequest | RequestShorthand): CapabilityRequest {
    if (isFullRequest(input)) return input;
    return buildRequest(input as RequestShorthand, {
      defaults: this.#defaults,
      registry: this.registry,
      ids: this.#ids,
    });
  }

  #newRecord(request: CapabilityRequest, identity: string, requestDigest: string): ExecutionRecord {
    const at = this.#clock().toISOString();
    const actor: Actor = { ref: request.actor.ref };
    if (typeof request.actor.type === "string") actor.type = request.actor.type;
    if (typeof request.actor.on_behalf_of === "string" && IDENTITY.test(request.actor.on_behalf_of))
      actor.on_behalf_of = request.actor.on_behalf_of;
    return {
      identity,
      requestDigest,
      mutating: false,
      requiredClaims: [],
      effectiveTraits: [],
      providerInvocations: 0,
      reconcileInvocations: 0,
      events: [],
      execution: {
        protocol: PROTOCOL,
        execution_id: this.#ids.next("exec"),
        request_id: request.request_id,
        state: "pending",
        capability: { id: request.capability.id },
        actor,
        history: [{ state: "pending", at }],
        evidence: [],
        created_at: at,
        updated_at: at,
      },
    };
  }

  async #evaluateAuthority(
    question: Parameters<AuthorityEvaluator["evaluate"]>[0],
  ): Promise<AuthorityDecision> {
    try {
      return await this.#authority.evaluate(question);
    } catch {
      return {
        protocol: PROTOCOL,
        decision: "deny",
        reason: "the authority evaluator failed",
        detail: "evaluator_unavailable",
        evaluated_at: question.at.toISOString(),
      };
    }
  }

  async #evaluatePolicy(question: PolicyQuestion): Promise<PolicyDecision> {
    try {
      const decision = await this.#policy.evaluate(question);
      const known = new Set(["providers", "regions", "evidence", "approvers"]);
      if (Object.keys(decision.obligations ?? {}).some((k) => !known.has(k)))
        return { ...decision, decision: "deny", reason: "an obligation is not understood" };
      return decision;
    } catch {
      return {
        protocol: PROTOCOL,
        decision: "deny",
        policy_refs: [],
        matched_rules: [],
        reason: "the policy evaluator failed",
        evaluated_at: question.at.toISOString(),
      };
    }
  }

  #policyQuestion(
    capability: CapabilityDefinition,
    request: CapabilityRequest,
    at: Date,
  ): PolicyQuestion {
    return {
      capability: capability.id,
      actor: request.actor.ref,
      ...(request.profile ? { profile: request.profile } : {}),
      mutating: capability.effects.mutating,
      risk: capability.risk.default,
      at,
    };
  }

  #effectiveTraits(
    traits: string[],
    policy: PolicyDecision,
    capability: CapabilityDefinition,
  ): string[] {
    const declared = new Set([
      ...(capability.traits.required ?? []),
      ...(capability.traits.optional ?? []),
    ]);
    const out = new Set(traits);
    for (const claim of policy.obligations?.evidence?.require ?? [])
      for (const trait of this.registry.traitsEnabling(claim))
        if (declared.has(trait)) out.add(trait);
    return [...out].sort();
  }

  /** Applies evidence obligations; returns a problem when the capability cannot satisfy them. */
  #applyObligations(record: ExecutionRecord, capability: CapabilityDefinition): string | undefined {
    const claims = record.policy?.obligations?.evidence?.require ?? [];
    for (const claim of claims)
      if (!capability.evidence.claims.includes(claim))
        return `Policy requires evidence '${claim}', which ${capability.id} cannot provide.`;
    record.requiredClaims = [...new Set([...record.requiredClaims, ...claims])].sort();
    record.effectiveTraits = this.#effectiveTraits(
      record.effectiveTraits,
      record.policy!,
      capability,
    );
    if (record.effectiveTraits.length > 0) record.execution.traits = record.effectiveTraits;
    return undefined;
  }

  async #dispatch(
    record: ExecutionRecord,
    capability: CapabilityDefinition,
  ): Promise<ExecutionOutcome> {
    const request = record.request!;
    const now = this.#clock();
    const question = this.#policyQuestion(capability, request, now);
    const resolution = await resolveProviders({
      capability,
      request,
      effectiveTraits: record.effectiveTraits,
      authority: record.authority!,
      policy: { evaluator: this.#policy, decision: record.policy!, question },
      bindings: this.#bindings,
      ...(this.#broker ? { broker: this.#broker } : {}),
      providers: this.providers(),
      unavailable: this.#unavailable,
      now,
    });
    const candidate: Candidate | undefined = resolution.eligible[0];
    if (!candidate)
      return this.#finish(record, "rejected", resolution.error!, "no eligible provider");
    const manifest = candidate.provider.manifest;
    record.providerId = manifest.provider.id;
    record.execution.provider = { id: manifest.provider.id, version: manifest.provider.version };
    if (candidate.credential) {
      record.credential = candidate.credential;
      record.execution.credential_owner = candidate.credential.owner;
    }
    const timeout = Math.min(
      request.constraints?.timeout_ms ?? this.#limits.defaultTimeoutMs,
      this.#limits.maxTimeoutMs,
    );
    let deadline = now.getTime() + timeout;
    if (request.constraints?.deadline)
      deadline = Math.min(deadline, Date.parse(request.constraints.deadline));
    const invocation: Invocation = {
      protocol: PROTOCOL,
      invocation_id: this.#ids.next("inv"),
      execution_id: record.execution.execution_id,
      request_id: request.request_id,
      capability: { id: capability.id, version: capability.version },
      traits: record.effectiveTraits,
      input: request.input,
      deadline: new Date(deadline).toISOString(),
      actor: request.actor,
      evidence: { require: record.requiredClaims },
      attempt: 1,
    };
    if (request.profile) invocation.profile = request.profile;
    if (record.execution.idempotency_key)
      invocation.idempotency_key = record.execution.idempotency_key;
    if (request.resource) invocation.resource = request.resource;
    if (candidate.credential)
      invocation.credential = { ref: candidate.credential.ref, owner: candidate.credential.owner };
    const context =
      request.context?.correlation_id || request.context?.trace_id
        ? { ...request.context }
        : undefined;
    if (context)
      invocation.context = {
        ...(context.correlation_id ? { correlation_id: context.correlation_id } : {}),
        ...(context.trace_id ? { trace_id: context.trace_id } : {}),
      };
    record.invocation = invocation;
    this.#transition(record, "running", `dispatched to ${manifest.provider.id}`);
    record.execution.started_at = this.#clock().toISOString();
    record.providerInvocations += 1;
    // The intent is persisted before dispatch, so a crash leaves a running execution to reconcile.
    await this.#store.save(record);

    const controller = new AbortController();
    this.#inflight.set(record.execution.execution_id, controller);
    const materialized: string[] = [];
    let result: ProviderResult | undefined;
    let thrown: unknown;
    try {
      result = await withDeadline(
        candidate.provider.execute(invocation, this.#context(record, controller, materialized)),
        Math.max(0, deadline - this.#clock().getTime()),
        controller,
      );
    } catch (error) {
      thrown = error;
    } finally {
      this.#inflight.delete(record.execution.execution_id);
    }
    return this.#settle(record, capability, candidate, result, thrown, materialized);
  }

  #context(
    record: ExecutionRecord,
    controller: AbortController,
    materialized: string[],
  ): ProviderContext {
    const credential = record.credential;
    const broker = this.#broker;
    return {
      signal: controller.signal,
      now: this.#clock,
      credential: async () => {
        if (!credential || !broker) return undefined;
        const value = await broker.materialize(credential.ref);
        materialized.push(value);
        return value;
      },
    };
  }

  async #settle(
    record: ExecutionRecord,
    capability: CapabilityDefinition,
    candidate: Candidate,
    result: ProviderResult | undefined,
    thrown: unknown,
    materialized: string[],
  ): Promise<ExecutionOutcome> {
    const uncertain = (code: ErrorCode, detail: string, message: string) =>
      record.mutating
        ? this.#finish(
            record,
            "unknown",
            errorBody(code, message, { detail, secrets: materialized }),
            "outcome unknown",
          )
        : this.#finish(
            record,
            "failed",
            errorBody(code, message, { detail, secrets: materialized }),
            "failed",
          );
    if (thrown !== undefined || result === undefined) {
      if (thrown instanceof DeadlineError)
        return uncertain("timeout", "deadline_elapsed", thrown.message);
      if (thrown instanceof ProviderUnreachableError)
        return this.#finish(
          record,
          "failed",
          errorBody("provider_unavailable", thrown.message, {
            detail: "not_received",
            secrets: materialized,
          }),
          "provider unreachable",
        );
      const message = thrown instanceof Error ? thrown.message : "The provider failed.";
      return uncertain("execution_failed", "provider_error", message);
    }
    const problems = this.registry.schemas.validate("provider-result", result);
    // Error messages are redacted, not rejected (spec/0.1/security.md §3); anything else carrying
    // secret material invalidates the result.
    const secrets = findSecrets({ ...result, error: undefined }, materialized);
    if (
      problems.length > 0 ||
      secrets.length > 0 ||
      result.invocation_id !== record.invocation!.invocation_id
    )
      return uncertain(
        "execution_failed",
        secrets.length > 0 ? "raw_secret" : "invalid_result",
        secrets.length > 0
          ? "The provider result contained secret material and was discarded."
          : "The provider result is invalid.",
      );
    if (result.cost) record.execution.cost = result.cost;
    switch (result.status) {
      case "completed": {
        if (
          this.registry.schemas.validate(this.registry.outputSchemaId(capability), result.output)
            .length > 0
        )
          return uncertain(
            "execution_failed",
            "output_invalid",
            "The provider output does not match the capability output schema.",
          );
        await this.#storeEvidence(record, result.evidence ?? []);
        const missing = await this.#missingClaims(record);
        if (missing.length > 0)
          return uncertain(
            "evidence_missing",
            "claims_not_proven",
            `Required evidence is missing: ${missing.join(", ")}.`,
          );
        return this.#complete(
          record,
          capability,
          result.output!,
          result.cost,
          "required evidence present",
        );
      }
      case "failed": {
        const code =
          result.error?.code && PROVIDER_FAILURE_CODES.has(result.error.code)
            ? result.error.code
            : "execution_failed";
        await this.#storeEvidence(record, result.evidence ?? []);
        return this.#finish(
          record,
          "failed",
          errorBody(code, result.error?.message, {
            detail: "provider_failed",
            retryable: result.error?.retryable,
            secrets: materialized,
          }),
          "provider reported failure",
        );
      }
      case "unknown":
        return uncertain(
          result.error?.code === "timeout" ? "timeout" : "execution_failed",
          "provider_uncertain",
          result.error?.message ?? "The provider cannot establish the outcome.",
        );
      case "running": {
        if (!(candidate.implementation.traits ?? []).includes("async"))
          return uncertain(
            "execution_failed",
            "unexpected_running",
            "The provider answered running without the async trait.",
          );
        await this.#store.save(record);
        return this.#outcome(record);
      }
    }
  }

  async #storeEvidence(record: ExecutionRecord, items: EvidenceItem[]): Promise<Evidence[]> {
    const evidence = recordEvidence(items, {
      executionId: record.execution.execution_id,
      producedBy: { provider: record.providerId! },
      ids: this.#ids,
    });
    for (const e of evidence) {
      await this.#store.putEvidence(e);
      record.execution.evidence.push(evidenceRef(e.id));
    }
    return evidence;
  }

  /** Required claims not yet supported by any stored evidence of the execution. */
  async #missingClaims(record: ExecutionRecord): Promise<string[]> {
    const covered = coveredClaims(await this.#store.listEvidence(record.execution.execution_id));
    return record.requiredClaims.filter((claim) => !covered.has(claim));
  }

  async #complete(
    record: ExecutionRecord,
    capability: CapabilityDefinition,
    output: Json,
    cost: ExecutionRecord["execution"]["cost"],
    reason: string,
  ): Promise<ExecutionOutcome> {
    record.execution.output = output;
    if (cost) record.execution.cost = cost;
    const time = this.#clock().toISOString();
    for (const type of capability.emits) {
      const event: ProtocolEvent = {
        protocol: PROTOCOL,
        id: this.#ids.next("evt"),
        type,
        source: this.#source,
        time,
        data: {
          capability: { id: capability.id, version: capability.version },
          ...(record.execution.profile ? { profile: record.execution.profile } : {}),
          output,
        },
        causation: {
          execution_id: record.execution.execution_id,
          request_id: record.execution.request_id,
        },
      };
      const subject = subjectOf(record, output);
      if (subject) event.subject = { ref: subject };
      if (record.request?.context?.correlation_id)
        event.correlation_id = record.request.context.correlation_id;
      await this.#store.putEvent(event);
      for (const sink of this.#sinks) await sink.publish(event);
      record.events.push(event.id);
    }
    return this.#finish(record, "completed", undefined, reason);
  }

  #transition(
    record: ExecutionRecord,
    to: ExecutionState,
    reason?: string,
    errorCode?: ErrorCode,
  ): void {
    const from = record.execution.state;
    if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
    const at = this.#clock().toISOString();
    record.execution.state = to;
    record.execution.updated_at = at;
    record.execution.history.push({
      state: to,
      at,
      ...(reason ? { reason } : {}),
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  }

  async #finish(
    record: ExecutionRecord,
    state: ExecutionState,
    error: ErrorBody | undefined,
    reason?: string,
  ): Promise<ExecutionOutcome> {
    this.#transition(record, state, reason, error?.code);
    if (error)
      record.execution.error = {
        ...error,
        execution_id: record.execution.execution_id,
        request_id: record.execution.request_id,
      };
    else delete record.execution.error;
    if (isTerminal(state) || state === "unknown")
      record.execution.completed_at = record.execution.updated_at;
    if (state === "completed") delete record.execution.error;
    if (RECEIPT_STATES.has(state)) {
      record.receipt = buildReceipt(record.execution, {
        receiptId: this.#ids.next("rcpt"),
        issuedAt: this.#clock(),
        events: record.events,
        authority: authoritySummary(record.authority),
      });
    }
    await this.#store.save(record);
    return this.#outcome(record);
  }

  async #outcome(record: ExecutionRecord): Promise<ExecutionOutcome> {
    return {
      execution: structuredClone(record.execution),
      ...(record.receipt ? { receipt: structuredClone(record.receipt) } : {}),
      events: await this.#store.listEvents(record.execution.execution_id),
      ...(record.execution.error ? { error: structuredClone(record.execution.error) } : {}),
    };
  }

  async #load(executionId: string): Promise<ExecutionRecord> {
    const record = await this.#store.get(executionId);
    if (!record)
      throw new ProtocolError("invalid_request", "Unknown execution.", {
        detail: "unknown_execution",
      });
    return record;
  }
}

function authoritySummary(
  decision: AuthorityDecision | undefined,
): Execution["authority"] & object {
  if (!decision) return { decision: "deny" };
  return {
    decision: decision.decision,
    ...(decision.decision === "allow" && decision.authority ? { ref: decision.authority } : {}),
    ...(decision.grant_id ? { grant_id: decision.grant_id } : {}),
  };
}

/** The event subject: the request resource, else the first output member holding a `ref`. */
function subjectOf(record: ExecutionRecord, output: Json): string | undefined {
  if (record.resource) return record.resource;
  for (const key of Object.keys(output).sort()) {
    const value = output[key];
    if (isRecord(value) && typeof value["ref"] === "string") return value["ref"];
  }
  return undefined;
}

function identityOf(request: unknown): string {
  const r = request as {
    request_id?: unknown;
    actor?: { ref?: unknown };
    capability?: { id?: unknown };
  };
  if (
    !isRecord(request) ||
    typeof r.request_id !== "string" ||
    !IDENTIFIER.test(r.request_id) ||
    typeof r.actor?.ref !== "string" ||
    !IDENTITY.test(r.actor.ref) ||
    typeof r.capability?.id !== "string"
  )
    throw new ProtocolError(
      "invalid_request",
      "The request must name a request_id, an actor and a capability.",
      { detail: "unidentifiable_request" },
    );
  return `${r.actor.ref}\u0000${r.request_id}`;
}

async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DeadlineError();
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export { sanitizeMessage };
