export {
  PROTOCOL,
  SDK_VERSION,
  DEFAULT_LIMITS,
  RISK_ORDER,
  CORE_CLAIMS,
  OWNER_ORDER,
} from "./constants.ts";
export type * from "./types.ts";
export { bundle as protocolBundle } from "./protocol/bundle.generated.ts";
export { canonicalize, digest, mergePatch, jsonEqual, isRecord } from "./json.ts";
export { ERROR_CODES, ProtocolError, errorBody, sanitizeMessage } from "./errors.ts";
export {
  findSecrets,
  redactSecrets,
  SECRET_PATTERNS,
  SENSITIVE_KEYS,
  type SecretFinding,
} from "./secrets.ts";
export { parseVersion, compareVersions, satisfies, isValidRange } from "./semver.ts";
export {
  parseCapabilityId,
  isCoreId,
  shadowsCore,
  toolName,
  capabilityFromToolName,
} from "./naming.ts";
export { SchemaSet, formatErrors } from "./schema.ts";
export { Registry } from "./registry.ts";
export { validateRequest, type RequestValidation } from "./validation.ts";
export { validateManifest, assertValidManifest, type ManifestFinding } from "./manifest.ts";
export {
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from "./state.ts";
export {
  GrantAuthority,
  denyAll,
  matchPattern,
  type AuthorityEvaluator,
  type AuthorityQuestion,
} from "./authority.ts";
export {
  PolicySetEvaluator,
  allowAll,
  mergeObligations,
  strongerEffect,
  type PolicyEvaluator,
  type PolicyQuestion,
  type ProviderPolicyQuestion,
} from "./policy.ts";
export {
  InMemoryCredentialBroker,
  EnvCredentialBroker,
  ownerOf,
  selectCredential,
  type CredentialBroker,
  type CredentialSelection,
} from "./credentials.ts";
export {
  resolveProviders,
  STAGE_CODES,
  type Candidate,
  type ResolutionContext,
  type ResolutionOutcome,
} from "./resolver.ts";
export {
  CLAIM_SUPPORT,
  supports,
  recordEvidence,
  coveredClaims,
  missingClaims,
  verifyEvidence,
  evidenceRef,
} from "./evidence.ts";
export { buildReceipt, verifyReceipt } from "./receipt.ts";
export { InMemoryEventLog, type EventSink } from "./events.ts";
export { InMemoryExecutionStore, type ExecutionRecord, type ExecutionStore } from "./store.ts";
export { UlidGenerator, SequentialIds, type IdGenerator, type IdPrefix } from "./ids.ts";
export {
  defineProvider,
  evidenceHelpers,
  ProviderFailure,
  ProviderUnreachableError,
  type Provider,
  type ProviderContext,
  type ProviderDefinition,
  type Handler,
  type HandlerContext,
  type HandlerResult,
  type ReconcileHandler,
  type EvidenceHelpers,
} from "./provider.ts";
export {
  buildRequest,
  request,
  defaultRange,
  CapabilityRequestBuilder,
  type RequestShorthand,
  type RequestDefaults,
} from "./client.ts";
export {
  Runtime,
  type RuntimeOptions,
  type ExecutionOutcome,
  type ApprovalInput,
} from "./runtime.ts";
export { validateRecipe, runRecipe, type RecipeRun } from "./recipe.ts";

import { Runtime, type RuntimeOptions } from "./runtime.ts";

/** Creates a runtime (see `Runtime`). */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new Runtime(options);
}
