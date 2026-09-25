import { PROTOCOL } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { UlidGenerator, type IdGenerator } from "./ids.ts";
import { isRecord } from "./json.ts";
import { Registry } from "./registry.ts";
import type {
  Actor,
  CapabilityRequest,
  Constraints,
  CredentialOwner,
  CredentialSelector,
  Json,
  ResourceRef,
} from "./types.ts";

/**
 * The compact form callers write: `{ capability: "communication.send", input: {…} }`.
 * The runtime fills the protocol, identifiers, version range and session defaults.
 */
export interface RequestShorthand {
  capability: string | { id: string; version?: string };
  input: Json;
  request_id?: string;
  profile?: string;
  traits?: string[] | { required?: string[]; preferred?: string[] };
  actor?: Actor | string;
  authority?: string | { ref: string };
  resource?: string | ResourceRef;
  constraints?: Constraints;
  evidence?: string[] | { require?: string[] };
  idempotency_key?: string;
  credential?: CredentialSelector | CredentialOwner;
  context?: CapabilityRequest["context"];
  extensions?: CapabilityRequest["extensions"];
}

export interface RequestDefaults {
  actor?: Actor;
  authority?: { ref: string };
  credential?: CredentialSelector;
}

export function isFullRequest(input: unknown): input is CapabilityRequest {
  return isRecord(input) && "protocol" in input;
}

/** The default version range for a capability: a caret range on the registry version. */
export function defaultRange(capabilityId: string, registry: Registry = Registry.core()): string {
  const definition = registry.capability(registry.normalize(capabilityId).id);
  if (!definition) return "*";
  const [major, minor] = definition.version.split(".");
  return `^${major}.${minor}`;
}

/** Expands a shorthand into a canonical CapabilityRequest. */
export function buildRequest(
  shorthand: RequestShorthand,
  options: { defaults?: RequestDefaults; registry?: Registry; ids?: IdGenerator } = {},
): CapabilityRequest {
  const capability =
    typeof shorthand.capability === "string" ? { id: shorthand.capability } : shorthand.capability;
  const actorInput = shorthand.actor ?? options.defaults?.actor;
  if (!actorInput)
    throw new ProtocolError("invalid_request", "An actor is required.", {
      detail: "missing_actor",
    });
  const actor: Actor = typeof actorInput === "string" ? { ref: actorInput } : actorInput;
  const authority = shorthand.authority ?? options.defaults?.authority;
  const credential = shorthand.credential ?? options.defaults?.credential;
  const traits = Array.isArray(shorthand.traits)
    ? { required: shorthand.traits }
    : shorthand.traits;
  const evidence = Array.isArray(shorthand.evidence)
    ? { require: shorthand.evidence }
    : shorthand.evidence;
  const request: CapabilityRequest = {
    protocol: PROTOCOL,
    request_id: shorthand.request_id ?? (options.ids ?? new UlidGenerator()).next("req"),
    capability: {
      id: capability.id,
      version: capability.version ?? defaultRange(capability.id, options.registry),
    },
    actor,
    input: shorthand.input,
  };
  if (shorthand.profile) request.profile = shorthand.profile;
  if (traits && (traits.required?.length || traits.preferred?.length)) request.traits = traits;
  if (authority) request.authority = typeof authority === "string" ? { ref: authority } : authority;
  if (shorthand.resource)
    request.resource =
      typeof shorthand.resource === "string" ? { ref: shorthand.resource } : shorthand.resource;
  if (shorthand.constraints) request.constraints = shorthand.constraints;
  if (evidence?.require?.length) request.evidence = evidence;
  if (shorthand.idempotency_key) request.idempotency_key = shorthand.idempotency_key;
  if (credential)
    request.credential = typeof credential === "string" ? { owner: credential } : credential;
  if (shorthand.context) request.context = shorthand.context;
  if (shorthand.extensions) request.extensions = shorthand.extensions;
  return request;
}

/** Fluent builder for capability requests. */
export class CapabilityRequestBuilder {
  readonly #shorthand: RequestShorthand;

  constructor(capability: string, version?: string) {
    this.#shorthand = { capability: version ? { id: capability, version } : capability, input: {} };
  }

  input(input: Json): this {
    this.#shorthand.input = input;
    return this;
  }
  profile(profile: string): this {
    this.#shorthand.profile = profile;
    return this;
  }
  requireTraits(...traits: string[]): this {
    const current = Array.isArray(this.#shorthand.traits)
      ? { required: this.#shorthand.traits }
      : (this.#shorthand.traits ?? {});
    this.#shorthand.traits = { ...current, required: [...(current.required ?? []), ...traits] };
    return this;
  }
  preferTraits(...traits: string[]): this {
    const current = Array.isArray(this.#shorthand.traits)
      ? { required: this.#shorthand.traits }
      : (this.#shorthand.traits ?? {});
    this.#shorthand.traits = { ...current, preferred: [...(current.preferred ?? []), ...traits] };
    return this;
  }
  actor(actor: Actor | string): this {
    this.#shorthand.actor = actor;
    return this;
  }
  authority(ref: string): this {
    this.#shorthand.authority = ref;
    return this;
  }
  resource(ref: string | ResourceRef): this {
    this.#shorthand.resource = ref;
    return this;
  }
  constraints(constraints: Constraints): this {
    this.#shorthand.constraints = { ...this.#shorthand.constraints, ...constraints };
    return this;
  }
  requireEvidence(...claims: string[]): this {
    this.#shorthand.evidence = {
      require: [
        ...((this.#shorthand.evidence as { require?: string[] } | undefined)?.require ?? []),
        ...claims,
      ],
    };
    return this;
  }
  credential(selector: CredentialSelector | CredentialOwner): this {
    this.#shorthand.credential = selector;
    return this;
  }
  idempotencyKey(key: string): this {
    this.#shorthand.idempotency_key = key;
    return this;
  }
  requestId(id: string): this {
    this.#shorthand.request_id = id;
    return this;
  }
  shorthand(): RequestShorthand {
    return structuredClone(this.#shorthand);
  }
  build(options?: Parameters<typeof buildRequest>[1]): CapabilityRequest {
    return buildRequest(this.shorthand(), options);
  }
}

export function request(capability: string, version?: string): CapabilityRequestBuilder {
  return new CapabilityRequestBuilder(capability, version);
}
