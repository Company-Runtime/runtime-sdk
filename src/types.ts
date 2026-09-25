/**
 * TypeScript shapes of the runtime/0.1 documents. The JSON Schemas of the
 * protocol (bundled from runtime-protocol) are normative; these types follow them.
 */
import type { CREDENTIAL_OWNERS, RISK_ORDER } from "./constants.ts";

export type Protocol = "runtime/0.1";
export type IdentityRef = string;
export type AuthorityRef = string;
export type SecretRef = string;
export type EvidenceRef = string;
export type PolicyRef = string;
export type CapabilityId = string;
export type CredentialOwner = (typeof CREDENTIAL_OWNERS)[number];
export type Risk = (typeof RISK_ORDER)[number];
export type Json = Record<string, unknown>;

export interface Money {
  amount: number;
  currency: string;
}

export interface Actor {
  ref: IdentityRef;
  type?: "human" | "agent" | "service" | "system";
  on_behalf_of?: IdentityRef;
  display_name?: string;
}

export interface ResourceRef {
  ref: string;
  type?: string;
  version?: string;
}

export interface Constraints {
  timeout_ms?: number;
  deadline?: string;
  max_cost?: Money;
  providers?: { allow?: string[]; deny?: string[]; prefer?: string[] };
  regions?: { allow: string[] };
}

export interface CredentialSelector {
  ref?: SecretRef;
  owner?: CredentialOwner;
}

export interface CredentialRef {
  ref: SecretRef;
  owner?: CredentialOwner;
}

export interface CredentialBinding {
  provider: string;
  ref: SecretRef;
}

export interface CapabilityRequest {
  protocol: Protocol;
  request_id: string;
  capability: { id: CapabilityId; version: string };
  profile?: string;
  traits?: { required?: string[]; preferred?: string[] };
  actor: Actor;
  authority?: { ref: AuthorityRef };
  resource?: ResourceRef;
  input: Json;
  constraints?: Constraints;
  evidence?: { require?: string[] };
  idempotency_key?: string;
  credential?: CredentialSelector;
  context?: {
    correlation_id?: string;
    causation_id?: string;
    trace_id?: string;
    labels?: Record<string, string>;
  };
  extensions?: Record<string, Json>;
}

export type SchemaSource = { schema_ref: string } | { schema: Json };

export interface CapabilityDefinition {
  id: CapabilityId;
  version: string;
  status: "experimental" | "candidate" | "stable" | "deprecated";
  domain: string;
  verb: string;
  description: string;
  object_justification?: string;
  input: SchemaSource;
  output: SchemaSource;
  profiles: string[];
  traits: { required?: string[]; optional?: string[]; input_gates?: Record<string, string[]> };
  authority: { required: true };
  evidence: { supported: boolean; claims: string[] };
  risk: { default: Risk };
  effects: { mutating: boolean };
  emits: string[];
  relations?: { requires?: string[]; related?: string[] };
  deprecation?: { replaced_by: CapabilityId; since: string; remove_after?: string };
  proposal_ref?: string;
  rfc?: string;
}

export interface ProfileDefinition {
  id: string;
  version: string;
  status: string;
  definition: string;
  applies_to: Array<{ capability: CapabilityId; input?: SchemaSource }>;
  excludes?: string[];
}

export interface TraitDefinition {
  id: string;
  version: string;
  status: string;
  definition: string;
  enables_claims?: string[];
}

export interface DomainDefinition {
  id: string;
  version: string;
  status: string;
  definition: string;
  excludes: string[];
}

export interface VerbDefinition {
  id: string;
  version: string;
  status: string;
  definition: string;
  past_tense: string;
  mutating: boolean | "varies";
  rejected_synonyms: string[];
}

export interface Alias {
  alias: CapabilityId;
  canonical: CapabilityId;
  since: string;
  remove_after?: string;
}

export interface RegistryOverlay {
  protocol: Protocol;
  id: string;
  description?: string;
  domains?: DomainDefinition[];
  capabilities?: CapabilityDefinition[];
  profiles?: ProfileDefinition[];
  traits?: TraitDefinition[];
  aliases?: Alias[];
}

export interface Recipe {
  id: string;
  version: string;
  status: string;
  level: "L2";
  description: string;
  inputs?: Json;
  steps: Array<{
    id: string;
    capability: CapabilityId;
    version?: string;
    profile?: string;
    traits?: { required?: string[] };
    input: Json;
    description?: string;
  }>;
  outputs?: Json;
}

export interface Implementation {
  capability: CapabilityId;
  versions: string[];
  profiles?: string[];
  traits?: string[];
  evidence?: { claims?: string[]; types?: string[] };
  risk?: Risk;
  cost?: { estimate: Money };
  regions?: string[];
  reconciliation?: "supported" | "unsupported";
  extensions?: Record<string, Json>;
}

export type BindingDescriptor =
  | { type: "in_process"; module?: string }
  | { type: "http"; version?: "0.1"; url?: string; ref?: string }
  | {
      type: "mcp";
      version?: "0.1";
      transport: "stdio" | "streamable_http";
      command?: string;
      args?: string[];
      url?: string;
      ref?: string;
    }
  | { type: "events"; version?: "0.1"; format: "cloudevents/1.0"; endpoint?: string };

export interface ProviderManifest {
  protocol: Protocol;
  provider: {
    id: string;
    version: string;
    name?: string;
    description?: string;
    publisher?: { name: string; url?: string };
  };
  adapter?: { id: string; version: string; system?: string };
  implements: Implementation[];
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  bindings?: BindingDescriptor[];
  extensions?: Record<string, Json>;
}

export interface EvidenceItem {
  type: string;
  claims: string[];
  observed_at: string;
  subject?: ResourceRef;
  data?: Json;
  external_ref?: string;
  content?: { media_type: string; digest: string; size?: number; uri?: string };
  signature?: { format: "jws" | "cose" | "openpgp" | "x509-cms"; value?: string; key_ref?: string };
  extensions?: Record<string, Json>;
}

export interface Evidence extends EvidenceItem {
  protocol: Protocol;
  id: string;
  execution_id: string;
  produced_by: { provider: string } | { actor: IdentityRef };
  digest: string;
}

export interface Invocation {
  protocol: Protocol;
  invocation_id: string;
  execution_id: string;
  request_id: string;
  capability: { id: CapabilityId; version: string };
  profile?: string;
  traits: string[];
  input: Json;
  idempotency_key?: string;
  deadline: string;
  actor: Actor;
  resource?: ResourceRef;
  evidence: { require: string[] };
  credential?: CredentialRef;
  attempt?: number;
  context?: { correlation_id?: string; trace_id?: string };
  extensions?: Record<string, Json>;
}

export interface ProviderError {
  code?: ErrorCode;
  message: string;
  retryable?: boolean;
}

export interface ProviderResult {
  protocol: Protocol;
  invocation_id: string;
  status: "completed" | "failed" | "unknown" | "running";
  output?: Json;
  evidence?: EvidenceItem[];
  cost?: Money;
  error?: ProviderError;
  observed_at?: string;
  extensions?: Record<string, Json>;
}

export interface Reconciliation {
  protocol: Protocol;
  invocation_id: string;
  status: "completed" | "failed" | "inconclusive";
  output?: Json;
  evidence?: EvidenceItem[];
  final?: true;
  reason?: string;
  cost?: Money;
  extensions?: Record<string, Json>;
}

export interface Health {
  protocol: Protocol;
  status: "ok" | "degraded" | "unavailable";
  checked_at: string;
  detail?: string;
}

export type ErrorCode =
  | "invalid_request"
  | "unknown_capability"
  | "unsupported_version"
  | "unsupported_profile"
  | "missing_trait"
  | "authority_denied"
  | "policy_denied"
  | "constraint_unsatisfied"
  | "credential_unavailable"
  | "provider_unavailable"
  | "execution_failed"
  | "evidence_missing"
  | "timeout"
  | "cancelled";

export type ErrorStage =
  "validation" | "authority" | "policy" | "resolution" | "binding" | "execution" | "evidence";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  stage?: ErrorStage;
  detail?: string;
  execution_id?: string;
  request_id?: string;
}

export interface Warning {
  code: "deprecated_alias" | "deprecated_capability";
  message: string;
}

export interface AuthorityGrant {
  id: string;
  description?: string;
  authority: AuthorityRef;
  subjects: string[];
  capabilities: string[];
  profiles?: string[];
  resources?: string[];
  providers?: string[];
  valid_from?: string;
  valid_until?: string;
}

export interface AuthorityGrants {
  protocol: Protocol;
  grants: AuthorityGrant[];
}

export interface AuthorityDecision {
  protocol: Protocol;
  decision: "allow" | "deny";
  authority?: AuthorityRef;
  grant_id?: string;
  reason: string;
  detail?: "grant_matched" | "no_matching_grant" | "authority_not_held" | "evaluator_unavailable";
  providers?: string[];
  evaluated_at: string;
}

export type PolicyEffect = "allow" | "deny" | "require_approval";

export interface Obligations {
  providers?: { allow?: string[]; deny?: string[] };
  regions?: { allow: string[] };
  evidence?: { require: string[] };
  approvers?: IdentityRef[];
}

export interface PolicyRule {
  id: string;
  description?: string;
  match?: {
    capabilities?: string[];
    actors?: string[];
    profiles?: string[];
    mutating?: boolean;
    risk?: { at_least?: Risk; at_most?: Risk };
    providers?: string[];
  };
  effect: PolicyEffect;
  obligations?: Obligations;
  reason?: string;
}

export interface PolicySet {
  protocol: Protocol;
  id: PolicyRef;
  version: number;
  description?: string;
  default: PolicyEffect;
  rules: PolicyRule[];
}

export interface PolicyDecision {
  protocol: Protocol;
  decision: PolicyEffect;
  policy_refs: PolicyRef[];
  matched_rules: string[];
  reason: string;
  obligations?: Obligations;
  evaluated_at: string;
}

export interface ApprovalDecision {
  protocol: Protocol;
  execution_id: string;
  decision: "approved" | "rejected";
  decided_by: Actor;
  decided_at: string;
  rationale?: string;
}

export type ExecutionState =
  | "pending"
  | "awaiting_approval"
  | "authorized"
  | "running"
  | "unknown"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

export interface HistoryEntry {
  state: ExecutionState;
  at: string;
  reason?: string;
  error_code?: ErrorCode;
}

export interface Execution {
  protocol: Protocol;
  execution_id: string;
  request_id: string;
  state: ExecutionState;
  capability: { id: CapabilityId; version?: string; requested_as?: CapabilityId };
  profile?: string;
  traits?: string[];
  actor: Actor;
  authority?: { decision: "allow" | "deny"; ref?: AuthorityRef; grant_id?: string };
  policy?: { decision: PolicyEffect; refs: PolicyRef[]; matched_rules?: string[] };
  approval?: { decision: "approved" | "rejected"; decided_by: IdentityRef; decided_at: string };
  provider?: { id: string; version?: string };
  credential_owner?: CredentialOwner;
  idempotency_key?: string;
  history: HistoryEntry[];
  output?: Json;
  error?: ErrorBody;
  warnings?: Warning[];
  evidence: EvidenceRef[];
  cost?: Money;
  created_at: string;
  updated_at: string;
  started_at?: string;
  completed_at?: string;
  extensions?: Record<string, Json>;
}

export interface ReceiptBody {
  receipt_id: string;
  request_id: string;
  execution_id: string;
  capability: { id: CapabilityId; version?: string; requested_as?: CapabilityId };
  profile?: string;
  traits?: string[];
  provider?: { id: string; version?: string };
  actor: Actor;
  authority: { decision: "allow" | "deny"; ref?: AuthorityRef; grant_id?: string };
  policy?: { decision: PolicyEffect; refs: PolicyRef[]; matched_rules?: string[] };
  approval?: { decision: "approved" | "rejected"; decided_by: IdentityRef; decided_at: string };
  credential_owner?: CredentialOwner;
  status: "completed" | "failed" | "cancelled" | "rejected" | "unknown";
  error?: ErrorBody;
  warnings?: Warning[];
  idempotency_key?: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  cost?: Money;
  evidence: EvidenceRef[];
  events?: string[];
  issued_at: string;
  extensions?: Record<string, Json>;
}

export interface ExecutionReceipt {
  protocol: Protocol;
  receipt: ReceiptBody;
  integrity: { canonicalization: "RFC8785"; digest: string };
}

export interface ProtocolEvent {
  protocol: Protocol;
  id: string;
  type: string;
  source: string;
  time: string;
  subject?: ResourceRef;
  data: Json;
  causation?: {
    execution_id?: string;
    request_id?: string;
    observation_id?: string;
    event_id?: string;
  };
  correlation_id?: string;
  extensions?: Record<string, Json>;
}

export interface Observation {
  protocol: Protocol;
  id: string;
  subject: ResourceRef;
  property: string;
  value: unknown;
  unit?: string;
  observed_at: string;
  observer: { ref: IdentityRef } | { provider: string };
  evidence?: EvidenceRef;
  extensions?: Record<string, Json>;
}

export interface RejectedProvider {
  provider: { id: string; version?: string };
  stage: number;
  code: ErrorCode;
  detail?: string;
}

export interface Resolution {
  protocol: Protocol;
  capability: { id: CapabilityId; version?: string; requested_as?: CapabilityId };
  eligible: Array<{
    provider: { id: string; version?: string };
    credential_owner?: CredentialOwner;
  }>;
  rejected: RejectedProvider[];
  error?: ErrorBody;
}

export interface Discovery {
  protocol: Protocol;
  runtime: { id: string; version: string; name?: string };
  protocols: string[];
  registry?: { version: string; digest?: string; source?: string };
  capabilities: Array<{ id: CapabilityId; version: string; profiles: string[]; traits: string[] }>;
  bindings: Array<{
    type: "http" | "mcp" | "events";
    version: "0.1";
    endpoint?: string;
    transport?: "stdio" | "streamable_http";
    format?: "cloudevents/1.0";
  }>;
  limits?: { max_request_bytes?: number; max_timeout_ms?: number };
  extensions?: { namespaces?: string[] };
}
