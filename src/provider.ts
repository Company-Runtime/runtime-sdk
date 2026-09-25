import { PROTOCOL } from "./constants.ts";
import { Registry } from "./registry.ts";
import type {
  Actor,
  CredentialOwner,
  EvidenceItem,
  Health,
  Implementation,
  Invocation,
  Json,
  Money,
  ProviderManifest,
  ProviderResult,
  Reconciliation,
  ResourceRef,
  ErrorCode,
} from "./types.ts";

/** What the runtime gives a provider for one invocation. */
export interface ProviderContext {
  /** Aborted when the deadline elapses or the execution is cancelled. */
  readonly signal: AbortSignal;
  now(): Date;
  /**
   * Materializes the invocation's CredentialRef inside the adapter boundary, at dispatch
   * time. Returns undefined when no credential was bound. Never log or return the value.
   */
  credential(): Promise<string | undefined>;
}

/** A provider: a manifest plus the operations of spec/0.1/providers.md §4. */
export interface Provider {
  readonly manifest: ProviderManifest;
  execute(invocation: Invocation, context: ProviderContext): Promise<ProviderResult>;
  reconcile?(invocation: Invocation, context: ProviderContext): Promise<Reconciliation>;
  health?(): Promise<Health>;
}

/** Thrown by a binding when the provider provably never received the invocation. */
export class ProviderUnreachableError extends Error {
  constructor(message = "the provider could not be reached") {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

/** Thrown by a handler when it knows no effect occurred or will occur. */
export class ProviderFailure extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: ErrorCode; retryable?: boolean } = {}) {
    super(message);
    this.name = "ProviderFailure";
    this.code = options.code ?? "execution_failed";
    this.retryable = options.retryable ?? false;
  }
}

export interface EvidenceHelpers {
  providerReceipt(claims: string[], data: Json, extra?: Partial<EvidenceItem>): EvidenceItem;
  stateObservation(claims: string[], subject: ResourceRef, data: Json): EvidenceItem;
  externalReference(claims: string[], externalRef: string, data?: Json): EvidenceItem;
  artifact(content: NonNullable<EvidenceItem["content"]>, subject?: ResourceRef): EvidenceItem;
}

export interface HandlerContext extends ProviderContext {
  invocation: Invocation;
  profile?: string;
  traits: string[];
  idempotencyKey?: string;
  actor: Actor;
  evidence: EvidenceHelpers;
}

export type HandlerResult =
  { output: Json; evidence?: EvidenceItem[]; cost?: Money } | { running: true };

export type Handler = (
  input: Json,
  context: HandlerContext,
) => Promise<HandlerResult> | HandlerResult;
export type ReconcileHandler = (
  input: Json,
  context: HandlerContext,
) =>
  | Promise<Omit<Reconciliation, "protocol" | "invocation_id">>
  | Omit<Reconciliation, "protocol" | "invocation_id">;

export interface ProviderDefinition {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  adapter?: ProviderManifest["adapter"];
  /** Capability identifiers, or implementation entries with profiles, traits, costs and regions. */
  capabilities: Array<string | (Partial<Implementation> & { capability: string })>;
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  handlers: Record<string, Handler>;
  reconcile?: Record<string, ReconcileHandler>;
  health?: () => Promise<Health["status"]> | Health["status"];
  bindings?: ProviderManifest["bindings"];
  extensions?: ProviderManifest["extensions"];
  /**
   * Registry used to validate invocation input (adapter rule: invalid input fails without
   * effects). Defaults to the core registry; pass one with overlays for extension capabilities.
   */
  registry?: Registry;
}

export function evidenceHelpers(now: () => Date): EvidenceHelpers {
  const at = () => now().toISOString();
  return {
    providerReceipt: (claims, data, extra = {}) => ({
      type: "provider_receipt",
      claims,
      observed_at: at(),
      data,
      ...extra,
    }),
    stateObservation: (claims, subject, data) => ({
      type: "state_observation",
      claims,
      observed_at: at(),
      subject,
      data,
    }),
    externalReference: (claims, externalRef, data) => ({
      type: "external_reference",
      claims,
      observed_at: at(),
      external_ref: externalRef,
      ...(data ? { data } : {}),
    }),
    artifact: (content, subject) => ({
      type: "artifact",
      claims: ["state"],
      observed_at: at(),
      content,
      ...(subject ? { subject } : {}),
    }),
  };
}

function implementationFor(
  entry: ProviderDefinition["capabilities"][number],
  hasReconcile: boolean,
  registry: Registry,
): Implementation {
  const spec = typeof entry === "string" ? { capability: entry } : entry;
  const known = registry.capability(spec.capability);
  const [major, minor] = (known?.version ?? "0.1.0").split(".");
  const implementation: Implementation = {
    ...spec,
    capability: spec.capability,
    versions: spec.versions ?? [`^${major}.${minor}`],
  };
  if (implementation.reconciliation === undefined && hasReconcile)
    implementation.reconciliation = "supported";
  if (implementation.evidence === undefined && known)
    implementation.evidence = { claims: known.evidence.claims.filter((c) => c === "execution") };
  return implementation;
}

/** Defines an in-process provider from handlers (the provider SDK). */
export function defineProvider(definition: ProviderDefinition): Provider {
  const registry = definition.registry ?? Registry.core();
  const manifest: ProviderManifest = {
    protocol: PROTOCOL,
    provider: {
      id: definition.id,
      version: definition.version ?? "0.1.0",
      ...(definition.name ? { name: definition.name } : {}),
      ...(definition.description ? { description: definition.description } : {}),
    },
    ...(definition.adapter ? { adapter: definition.adapter } : {}),
    implements: definition.capabilities.map((entry) => {
      const id = typeof entry === "string" ? entry : entry.capability;
      return implementationFor(entry, Boolean(definition.reconcile?.[id]), registry);
    }),
    credentials: definition.credentials ?? { required: false, accepts: [] },
    bindings: definition.bindings ?? [{ type: "in_process" }],
    ...(definition.extensions ? { extensions: definition.extensions } : {}),
  };
  const context = (invocation: Invocation, base: ProviderContext): HandlerContext => ({
    ...base,
    signal: base.signal,
    now: base.now,
    credential: base.credential,
    invocation,
    ...(invocation.profile ? { profile: invocation.profile } : {}),
    traits: invocation.traits,
    ...(invocation.idempotency_key ? { idempotencyKey: invocation.idempotency_key } : {}),
    actor: invocation.actor,
    evidence: evidenceHelpers(base.now),
  });
  const provider: Provider = {
    manifest,
    async execute(invocation, base) {
      const handler = definition.handlers[invocation.capability.id];
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      if (!handler)
        return {
          ...envelope,
          status: "failed",
          error: { code: "execution_failed", message: "capability not implemented" },
        };
      // Input that violates the capability input schema fails before any effect (PC-009).
      const known = registry.capability(invocation.capability.id);
      if (known) {
        const problems = registry.schemas.validate(
          registry.inputSchemaId(known, invocation.profile),
          invocation.input,
        );
        if (problems.length > 0)
          return {
            ...envelope,
            status: "failed",
            error: {
              code: "execution_failed",
              message: `The input does not match the ${known.id} input schema.`,
            },
          };
      }
      try {
        const result = await handler(invocation.input, context(invocation, base));
        if ("running" in result) return { ...envelope, status: "running" };
        return {
          ...envelope,
          status: "completed",
          output: result.output,
          evidence: result.evidence ?? [],
          ...(result.cost ? { cost: result.cost } : {}),
          observed_at: base.now().toISOString(),
        };
      } catch (error) {
        if (error instanceof ProviderFailure)
          return {
            ...envelope,
            status: "failed",
            error: { code: error.code, message: error.message, retryable: error.retryable },
          };
        // The system behind the provider never received the request: nothing happened.
        if (error instanceof ProviderUnreachableError)
          return {
            ...envelope,
            status: "failed",
            error: { code: "provider_unavailable", message: error.message, retryable: true },
          };
        const aborted = base.signal.aborted;
        return {
          ...envelope,
          status: "unknown",
          error: {
            code: aborted ? "timeout" : "execution_failed",
            message: error instanceof Error ? error.message : "provider error",
          },
        };
      }
    },
  };
  if (definition.reconcile) {
    provider.reconcile = async (invocation, base) => {
      const handler = definition.reconcile![invocation.capability.id];
      if (!handler)
        return {
          protocol: PROTOCOL,
          invocation_id: invocation.invocation_id,
          status: "inconclusive",
          reason: "reconciliation not supported",
        };
      return {
        protocol: PROTOCOL,
        invocation_id: invocation.invocation_id,
        ...(await handler(invocation.input, context(invocation, base))),
      };
    };
  }
  if (definition.health) {
    const check = definition.health;
    provider.health = async () => ({
      protocol: PROTOCOL,
      status: await check(),
      checked_at: new Date().toISOString(),
    });
  }
  return provider;
}
