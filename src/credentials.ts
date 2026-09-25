import { OWNER_ORDER } from "./constants.ts";
import type {
  CredentialBinding,
  CredentialOwner,
  CredentialRef,
  CredentialSelector,
  ProviderManifest,
} from "./types.ts";

/**
 * Materializes CredentialRefs inside the adapter boundary at dispatch time
 * (spec/0.1/providers.md §3.3). Vaults, KMS and OAuth stores implement this.
 */
export interface CredentialBroker {
  has(ref: string): boolean | Promise<boolean>;
  materialize(ref: string): string | Promise<string>;
}

export function ownerOf(ref: string): CredentialOwner {
  return ref.slice("secret://".length).split("/")[0] as CredentialOwner;
}

/** Broker over an in-memory map — for tests, examples and conformance. */
export class InMemoryCredentialBroker implements CredentialBroker {
  readonly #secrets: Map<string, string>;

  constructor(secrets: Record<string, string> = {}) {
    this.#secrets = new Map(Object.entries(secrets));
  }

  has(ref: string): boolean {
    return this.#secrets.has(ref);
  }

  materialize(ref: string): string {
    const value = this.#secrets.get(ref);
    if (value === undefined) throw new Error("credential is not available");
    return value;
  }
}

/**
 * Broker over environment variables for local development:
 * `secret://organization/providers/example` → `RUNTIME_SECRET_ORGANIZATION_PROVIDERS_EXAMPLE`.
 */
export class EnvCredentialBroker implements CredentialBroker {
  readonly #env: Record<string, string | undefined>;
  readonly #prefix: string;

  constructor(env: Record<string, string | undefined> = process.env, prefix = "RUNTIME_SECRET_") {
    this.#env = env;
    this.#prefix = prefix;
  }

  variable(ref: string): string {
    return (
      this.#prefix +
      ref
        .slice("secret://".length)
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
    );
  }

  has(ref: string): boolean {
    return Boolean(this.#env[this.variable(ref)]);
  }

  materialize(ref: string): string {
    const value = this.#env[this.variable(ref)];
    if (!value) throw new Error("credential is not available");
    return value;
  }
}

export type CredentialSelection =
  | { kind: "selected"; credential: CredentialRef & { owner: CredentialOwner } }
  | { kind: "not_required" }
  | { kind: "unavailable"; detail: string };

/** Deterministic credential selection for one provider (spec/0.1/providers.md §3.2). */
export async function selectCredential(
  manifest: ProviderManifest,
  bindings: readonly CredentialBinding[],
  selector: CredentialSelector | undefined,
  broker: CredentialBroker | undefined,
): Promise<CredentialSelection> {
  const accepts = manifest.credentials?.accepts ?? [];
  const required = manifest.credentials?.required ?? false;
  const own = bindings.filter((b) => b.provider === manifest.provider.id);
  let candidates = own;
  if (selector?.ref) candidates = own.filter((b) => b.ref === selector.ref);
  else if (selector?.owner) candidates = own.filter((b) => ownerOf(b.ref) === selector.owner);
  else
    candidates = [...own].sort(
      (a, b) =>
        OWNER_ORDER.indexOf(ownerOf(a.ref)) - OWNER_ORDER.indexOf(ownerOf(b.ref)) ||
        (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    );
  for (const binding of candidates) {
    const owner = ownerOf(binding.ref);
    if (!accepts.includes(owner)) continue;
    if (broker && (await broker.has(binding.ref)))
      return { kind: "selected", credential: { ref: binding.ref, owner } };
  }
  // Without a selector, a provider that needs no credential is eligible without one. A selector
  // is the caller asking for a specific account (for example BYOK), which such a provider cannot honor.
  if (!required && !selector?.ref && !selector?.owner) return { kind: "not_required" };
  return {
    kind: "unavailable",
    detail: selector?.ref
      ? "credential_not_bound"
      : selector?.owner
        ? `no_${selector.owner}_credential`
        : "no_credential",
  };
}
