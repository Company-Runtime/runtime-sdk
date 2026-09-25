import { CORE_CLAIMS } from "./constants.ts";
import { ProtocolError } from "./errors.ts";
import { digest } from "./json.ts";
import { isCoreId, parseCapabilityId, shadowsCore } from "./naming.ts";
import { bundle } from "./protocol/bundle.generated.ts";
import { SchemaSet } from "./schema.ts";
import type {
  Alias,
  CapabilityDefinition,
  DomainDefinition,
  ProfileDefinition,
  RegistryOverlay,
  SchemaSource,
  TraitDefinition,
  VerbDefinition,
} from "./types.ts";

const NAMESPACED_VOCABULARY =
  /^(?:experimental\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*|(?:community|vendor|org)\.[a-z0-9][a-z0-9-]*\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)$/;

let coreRegistry: Registry | undefined;

/**
 * The semantic registry: the bundled core vocabulary plus optional overlays of
 * namespaced definitions and deprecated aliases (spec/0.1/extensions.md).
 */
export class Registry {
  readonly schemas = new SchemaSet();
  readonly domains = new Map<string, DomainDefinition>();
  readonly verbs = new Map<string, VerbDefinition>();
  readonly traits = new Map<string, TraitDefinition>();
  readonly profiles = new Map<string, ProfileDefinition>();
  readonly capabilities = new Map<string, CapabilityDefinition>();
  readonly aliases = new Map<string, Alias>();
  readonly overlays: string[] = [];
  readonly version: string;
  #digest: string;
  readonly #inputIds = new Map<string, string>();
  readonly #outputIds = new Map<string, string>();

  private constructor() {
    const r = bundle.registry;
    this.version = String(r.manifest["version"]);
    for (const d of r.domains as unknown as DomainDefinition[]) this.domains.set(d.id, d);
    for (const v of r.verbs as unknown as VerbDefinition[]) this.verbs.set(v.id, v);
    for (const t of r.traits as unknown as TraitDefinition[]) this.traits.set(t.id, t);
    for (const p of r.profiles as unknown as ProfileDefinition[]) this.profiles.set(p.id, p);
    for (const c of r.capabilities as unknown as CapabilityDefinition[])
      this.#addCapability(c, "core");
    for (const a of (r.manifest["aliases"] as Alias[] | undefined) ?? [])
      this.aliases.set(a.alias, a);
    this.#digest = digest(r);
  }

  /** The core registry of the bundled protocol (shared, never mutated). */
  static core(): Registry {
    coreRegistry ??= new Registry();
    return coreRegistry;
  }

  /** A registry with overlays applied; throws on any namespace isolation violation. */
  static create(overlays: RegistryOverlay[] = []): Registry {
    if (overlays.length === 0) return Registry.core();
    const registry = new Registry();
    for (const overlay of overlays) {
      const problems = registry.checkOverlay(overlay);
      if (problems.length > 0)
        throw new ProtocolError(
          "invalid_request",
          `Overlay ${overlay.id} is invalid: ${problems[0]}`,
          {
            detail: "namespace_violation",
          },
        );
      registry.#apply(overlay);
    }
    return registry;
  }

  /** Registry digest over the core bundle and applied overlays. */
  get digest(): string {
    return this.#digest;
  }

  coreCapabilityIds(): Set<string> {
    return new Set([...this.capabilities.keys()].filter(isCoreId));
  }

  /** Isolation violations of an overlay (spec/0.1/extensions.md §3); empty when valid. */
  checkOverlay(overlay: RegistryOverlay): string[] {
    const errors: string[] = [];
    const coreIds = this.coreCapabilityIds();
    const overlayDomains = new Set((overlay.domains ?? []).map((d) => d.id));
    for (const domain of overlay.domains ?? [])
      if (this.domains.has(domain.id)) errors.push(`domain '${domain.id}' redefines a core domain`);
    for (const capability of overlay.capabilities ?? []) {
      const parsed = parseCapabilityId(capability.id);
      if ("error" in parsed) {
        errors.push(`capability '${capability.id}': ${parsed.error}`);
        continue;
      }
      if (parsed.namespace === "core") {
        errors.push(
          `capability '${capability.id}' is a core identifier; overlays add namespaced definitions only`,
        );
        continue;
      }
      if (shadowsCore(parsed, coreIds))
        errors.push(
          `capability '${capability.id}' shadows core capability '${parsed.local.join(".")}'`,
        );
      const domain = parsed.local[0];
      const verb = parsed.local[parsed.local.length - 1];
      if (capability.domain !== domain || capability.verb !== verb)
        errors.push(`capability '${capability.id}': domain and verb must match its local part`);
      if (!this.domains.has(capability.domain) && !overlayDomains.has(capability.domain))
        errors.push(`capability '${capability.id}': unknown domain '${capability.domain}'`);
      if (!this.verbs.has(capability.verb))
        errors.push(`capability '${capability.id}': '${capability.verb}' is not a canonical verb`);
    }
    for (const definition of [...(overlay.profiles ?? []), ...(overlay.traits ?? [])])
      if (!NAMESPACED_VOCABULARY.test(definition.id))
        errors.push(`'${definition.id}' must be namespaced in an overlay`);
    for (const alias of overlay.aliases ?? []) {
      const parsed = parseCapabilityId(alias.alias);
      if ("error" in parsed || parsed.namespace === "core")
        errors.push(`alias '${alias.alias}' must be namespaced`);
      if (this.capabilities.has(alias.alias))
        errors.push(`alias '${alias.alias}' shadows a capability`);
      if (
        !this.capabilities.has(alias.canonical) &&
        !(overlay.capabilities ?? []).some((c) => c.id === alias.canonical)
      )
        errors.push(`alias '${alias.alias}' targets unknown '${alias.canonical}'`);
    }
    return errors;
  }

  #apply(overlay: RegistryOverlay): void {
    for (const d of overlay.domains ?? []) this.domains.set(d.id, d);
    for (const p of overlay.profiles ?? []) this.profiles.set(p.id, p);
    for (const t of overlay.traits ?? []) this.traits.set(t.id, t);
    for (const c of overlay.capabilities ?? []) this.#addCapability(c, overlay.id);
    for (const a of overlay.aliases ?? []) this.aliases.set(a.alias, a);
    this.overlays.push(overlay.id);
    this.#digest = digest({ base: this.#digest, overlay });
  }

  #register(source: SchemaSource, syntheticId: string): string {
    if ("schema" in source) {
      const schema = source.schema as Record<string, unknown>;
      return this.schemas.add(
        typeof schema["$id"] === "string" ? schema : { ...schema, $id: syntheticId },
      );
    }
    throw new Error(`schema_ref ${source.schema_ref} must be inlined before registration`);
  }

  #addCapability(capability: CapabilityDefinition, origin: string): void {
    this.capabilities.set(capability.id, capability);
    const base = `urn:runtime-protocol:overlay:${origin}:capability:${capability.id}:${capability.version}`;
    this.#inputIds.set(capability.id, this.#register(capability.input, `${base}:input`));
    this.#outputIds.set(capability.id, this.#register(capability.output, `${base}:output`));
  }

  /** Resolves deprecated aliases. Aliases never chain. */
  normalize(id: string): { id: string; alias?: Alias } {
    const alias = this.aliases.get(id);
    return alias ? { id: alias.canonical, alias } : { id };
  }

  capability(id: string): CapabilityDefinition | undefined {
    return this.capabilities.get(id);
  }

  /** Traits whose definition enables `claim`. */
  traitsEnabling(claim: string): string[] {
    return [...this.traits.values()]
      .filter((t) => (t.enables_claims ?? []).includes(claim))
      .map((t) => t.id);
  }

  /** Schema id of the effective input schema: capability ∧ profile (spec/0.1/capabilities.md §4). */
  inputSchemaId(capability: CapabilityDefinition, profile?: string): string {
    const capabilityId = this.#inputIds.get(capability.id)!;
    const target = profile
      ? this.profiles.get(profile)?.applies_to.find((a) => a.capability === capability.id)
      : undefined;
    if (!target?.input) return capabilityId;
    const profileId = this.#register(
      target.input,
      `urn:runtime-protocol:overlay:profile:${profile}:${capability.id}:input`,
    );
    const effective = `urn:runtime-protocol:effective:${capability.id}:${capability.version}:${profile}:input`;
    if (!this.schemas.has(effective))
      this.schemas.add({ $id: effective, allOf: [{ $ref: capabilityId }, { $ref: profileId }] });
    return effective;
  }

  outputSchemaId(capability: CapabilityDefinition): string {
    return this.#outputIds.get(capability.id)!;
  }

  isKnownClaim(claim: string): boolean {
    return (CORE_CLAIMS as readonly string[]).includes(claim) || NAMESPACED_VOCABULARY.test(claim);
  }
}
