import type {
  AuthorityDecision,
  CapabilityRequest,
  CredentialRef,
  Evidence,
  Execution,
  ExecutionReceipt,
  Invocation,
  Obligations,
  PolicyDecision,
  ProtocolEvent,
} from "./types.ts";

/** Everything a runtime keeps about one execution. Only `execution` and `receipt` are public documents. */
export interface ExecutionRecord {
  execution: Execution;
  /** `actor.ref` + request_id: the request identity (spec/0.1/requests.md §6). */
  identity: string;
  /** Digest of the canonical request, to detect conflicting resubmissions. */
  requestDigest: string;
  /** The request, kept only once it passed validation (never when it carried secrets). */
  request?: CapabilityRequest;
  mutating: boolean;
  requiredClaims: string[];
  effectiveTraits: string[];
  resource?: string;
  authority?: AuthorityDecision;
  policy?: PolicyDecision;
  obligations?: Obligations;
  providerId?: string;
  invocation?: Invocation;
  /** The credential reference used; visible to the owning organization only, never in receipts. */
  credential?: CredentialRef;
  providerInvocations: number;
  reconcileInvocations: number;
  events: string[];
  receipt?: ExecutionReceipt;
}

/** Persistence of executions, evidence, receipts and events. */
export interface ExecutionStore {
  get(executionId: string): Promise<ExecutionRecord | undefined>;
  findByIdentity(identity: string): Promise<ExecutionRecord | undefined>;
  /** Executions in `unknown` or `running` that used an idempotency key. */
  findUnsettledByIdempotencyKey(key: string): Promise<ExecutionRecord | undefined>;
  save(record: ExecutionRecord): Promise<void>;
  list(): Promise<ExecutionRecord[]>;
  putEvidence(evidence: Evidence): Promise<void>;
  getEvidence(id: string): Promise<Evidence | undefined>;
  listEvidence(executionId: string): Promise<Evidence[]>;
  putEvent(event: ProtocolEvent): Promise<void>;
  listEvents(executionId: string): Promise<ProtocolEvent[]>;
}

/** Keeps everything in memory. Records are cloned on the way in and out. */
export class InMemoryExecutionStore implements ExecutionStore {
  readonly #records = new Map<string, ExecutionRecord>();
  readonly #identities = new Map<string, string>();
  readonly #evidence = new Map<string, Evidence>();
  readonly #events: ProtocolEvent[] = [];

  async get(executionId: string) {
    const record = this.#records.get(executionId);
    return record ? structuredClone(record) : undefined;
  }

  async findByIdentity(identity: string) {
    const id = this.#identities.get(identity);
    return id ? this.get(id) : undefined;
  }

  async findUnsettledByIdempotencyKey(key: string) {
    for (const record of this.#records.values())
      if (
        record.execution.idempotency_key === key &&
        ["unknown", "running"].includes(record.execution.state)
      )
        return structuredClone(record);
    return undefined;
  }

  async save(record: ExecutionRecord) {
    this.#records.set(record.execution.execution_id, structuredClone(record));
    this.#identities.set(record.identity, record.execution.execution_id);
  }

  async list() {
    return [...this.#records.values()].map((r) => structuredClone(r));
  }

  async putEvidence(evidence: Evidence) {
    this.#evidence.set(evidence.id, structuredClone(evidence));
  }

  async getEvidence(id: string) {
    const evidence = this.#evidence.get(id);
    return evidence ? structuredClone(evidence) : undefined;
  }

  async listEvidence(executionId: string) {
    return [...this.#evidence.values()]
      .filter((e) => e.execution_id === executionId)
      .map((e) => structuredClone(e));
  }

  async putEvent(event: ProtocolEvent) {
    this.#events.push(structuredClone(event));
  }

  async listEvents(executionId: string) {
    return this.#events
      .filter((e) => e.causation?.execution_id === executionId)
      .map((e) => structuredClone(e));
  }
}
