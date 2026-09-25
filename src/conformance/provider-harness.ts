import { PROTOCOL } from "../constants.ts";
import { MAX_MESSAGE_LENGTH } from "../errors.ts";
import { recordEvidence, coveredClaims } from "../evidence.ts";
import { SequentialIds } from "../ids.ts";
import { validateManifest } from "../manifest.ts";
import type { Provider, ProviderContext } from "../provider.ts";
import { Registry } from "../registry.ts";
import { findSecrets } from "../secrets.ts";
import type { CredentialOwner, Invocation, Json, ProviderResult } from "../types.ts";

/** A sample invocation the provider under test must complete. */
export interface ProviderSample {
  capability: string;
  input: Json;
  profile?: string;
  traits?: string[];
  /** Credential to hand the provider: a reference and the canary value the broker materializes. */
  credential?: { ref: string; value: string };
  /** Abort after this many milliseconds to check that an interrupted mutating call reports `unknown` (PC-006). */
  abortAfterMs?: number;
}

export interface RequirementResult {
  id: string;
  passed: boolean;
  details: string[];
}

export interface ProviderReport {
  provider: { id: string; version: string };
  passed: boolean;
  requirements: RequirementResult[];
}

export const PROVIDER_REQUIREMENTS: Readonly<Record<string, string>> = {
  "PC-001": "The manifest validates against its schema and the registry",
  "PC-002": "Completed outputs validate against the capability output schema",
  "PC-003": "Completed results carry evidence for every claim required of them",
  "PC-004": "Mutating capabilities are idempotent or reconcilable; repeated keys cause one effect",
  "PC-005": "No result, error or evidence contains secret material or the materialized credential",
  "PC-006": "A call interrupted after dispatch is reported as unknown, never failed",
  "PC-007": "Error messages are sanitized and at most 512 characters",
  "PC-008": "Capabilities outside the core are namespaced and never shadow core identifiers",
  "PC-009": "Input that violates the capability input schema fails without effects",
  "PC-010": "Health reports availability without side effects",
};

/**
 * Verifies a provider against the provider requirements of spec/0.1/conformance.md §4,
 * using sample invocations supplied by the provider's authors.
 */
export async function runProviderHarness(
  provider: Provider,
  samples: ProviderSample[],
  registry: Registry = Registry.core(),
): Promise<ProviderReport> {
  const results = new Map<string, string[]>(
    Object.keys(PROVIDER_REQUIREMENTS).map((id) => [id, []]),
  );
  const fail = (id: string, detail: string) => results.get(id)!.push(detail);
  const ids = new SequentialIds();
  const manifest = provider.manifest;

  for (const finding of validateManifest(manifest, registry)) {
    if (finding.severity !== "error") continue;
    fail(
      /shadows|namespace|core identifier/.test(finding.message) ? "PC-008" : "PC-001",
      finding.message,
    );
  }

  const invoke = async (
    sample: ProviderSample,
    input: Json,
    key: string,
    abortAfterMs?: number,
  ) => {
    const capability = registry.capability(sample.capability)!;
    const controller = new AbortController();
    const canaries = sample.credential ? [sample.credential.value] : [];
    const invocation: Invocation = {
      protocol: PROTOCOL,
      invocation_id: ids.next("inv"),
      execution_id: ids.next("exec"),
      request_id: ids.next("req"),
      capability: { id: capability.id, version: capability.version },
      traits: sample.traits ?? [],
      input,
      deadline: new Date(Date.now() + 30_000).toISOString(),
      actor: { ref: "identity://service/conformance-harness", type: "service" },
      evidence: { require: requiredClaims(sample) },
      ...(capability.effects.mutating ? { idempotency_key: key } : {}),
      ...(sample.profile ? { profile: sample.profile } : {}),
      ...(sample.credential
        ? {
            credential: {
              ref: sample.credential.ref,
              owner: sample.credential.ref.split("/")[2] as CredentialOwner,
            },
          }
        : {}),
    };
    const context: ProviderContext = {
      signal: controller.signal,
      now: () => new Date(),
      credential: async () => sample.credential?.value,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (abortAfterMs !== undefined)
      timer = setTimeout(() => controller.abort(new Error("aborted by harness")), abortAfterMs);
    try {
      const result = await provider.execute(invocation, context);
      return { result, canaries, invocation };
    } catch (error) {
      return { error, canaries, invocation };
    } finally {
      clearTimeout(timer);
    }
  };

  const requiredClaims = (sample: ProviderSample): string[] => {
    const capability = registry.capability(sample.capability)!;
    const claims = new Set<string>(capability.effects.mutating ? ["execution"] : []);
    for (const trait of sample.traits ?? [])
      for (const t of registry.traits.get(trait)?.enables_claims ?? []) claims.add(t);
    return [...claims];
  };

  const checkResult = (label: string, result: ProviderResult, canaries: string[]) => {
    if (registry.schemas.validate("provider-result", result).length > 0)
      fail("PC-002", `${label}: result is schema-invalid`);
    if (findSecrets(result, canaries).length > 0)
      fail("PC-005", `${label}: result contains secret material`);
    const message = result.error?.message;
    if (message !== undefined && (message.length > MAX_MESSAGE_LENGTH || /\n\s+at\s/.test(message)))
      fail("PC-007", `${label}: error message is not sanitized`);
  };

  for (const sample of samples) {
    const capability = registry.capability(sample.capability);
    const label = sample.capability;
    if (!capability) {
      fail("PC-001", `${label}: not a registered capability`);
      continue;
    }
    const implementation = manifest.implements.find((i) => i.capability === capability.id);
    if (!implementation) {
      fail("PC-001", `${label}: not declared in the manifest`);
      continue;
    }
    const inputErrors = registry.schemas.validate(
      registry.inputSchemaId(capability, sample.profile),
      sample.input,
    );
    if (inputErrors.length > 0) {
      fail("PC-002", `${label}: sample input is invalid (${inputErrors[0]})`);
      continue;
    }
    // PC-002 / PC-003 / PC-005 / PC-007
    const first = await invoke(sample, sample.input, `harness/${label}/1`);
    if (!first.result) {
      fail("PC-002", `${label}: execute threw instead of returning a result`);
      continue;
    }
    checkResult(label, first.result, first.canaries);
    if (first.result.status !== "completed") {
      fail(
        "PC-002",
        `${label}: sample did not complete (${first.result.status}: ${first.result.error?.message ?? ""})`,
      );
      continue;
    }
    if (
      registry.schemas.validate(registry.outputSchemaId(capability), first.result.output).length > 0
    )
      fail("PC-002", `${label}: output does not match ${capability.id} output schema`);
    const evidence = recordEvidence(first.result.evidence ?? [], {
      executionId: first.invocation.execution_id,
      producedBy: { provider: manifest.provider.id },
      ids,
    });
    const covered = coveredClaims(evidence);
    for (const claim of requiredClaims(sample))
      if (!covered.has(claim)) fail("PC-003", `${label}: no evidence for claim ${claim}`);

    // PC-004: idempotency or reconciliation for mutating capabilities.
    if (capability.effects.mutating) {
      const idempotent = (implementation.traits ?? []).includes("idempotency");
      if (!idempotent && implementation.reconciliation !== "supported" && !provider.reconcile)
        fail("PC-004", `${label}: mutating without idempotency or reconciliation`);
      if (idempotent) {
        const again = await invoke(sample, sample.input, `harness/${label}/1`);
        if (
          again.result?.status !== "completed" ||
          JSON.stringify(again.result.output) !== JSON.stringify(first.result.output)
        )
          fail(
            "PC-004",
            `${label}: repeating the idempotency key did not return the original result`,
          );
      }
      // PC-006: interrupted after dispatch → unknown.
      if (sample.abortAfterMs !== undefined) {
        const interrupted = await invoke(
          sample,
          sample.input,
          `harness/${label}/interrupted`,
          sample.abortAfterMs,
        );
        if (interrupted.result?.status === "failed")
          fail("PC-006", `${label}: an interrupted call was reported as failed`);
        if (interrupted.result)
          checkResult(`${label} (interrupted)`, interrupted.result, interrupted.canaries);
      }
    }

    // PC-009: invalid input fails without effects.
    const invalid = await invoke(
      sample,
      { ...sample.input, __conformance_invalid__: true },
      `harness/${label}/invalid`,
    );
    if (invalid.result?.status === "completed")
      fail("PC-009", `${label}: accepted input that violates the input schema`);
    if (invalid.result) checkResult(`${label} (invalid input)`, invalid.result, invalid.canaries);
  }

  // PC-008: namespaced capabilities.
  for (const implementation of manifest.implements) {
    const known = registry.capability(implementation.capability);
    if (!known && !/^(experimental|community|vendor|org)\./.test(implementation.capability))
      fail("PC-008", `${implementation.capability} is neither core nor namespaced`);
  }

  // PC-010: health.
  if (provider.health) {
    try {
      const health = await provider.health();
      if (registry.schemas.validate("health", health).length > 0)
        fail("PC-010", "health is schema-invalid");
    } catch {
      fail("PC-010", "health threw");
    }
  }

  const requirements = [...results].map(([id, details]) => ({
    id,
    passed: details.length === 0,
    details,
  }));
  return {
    provider: { id: manifest.provider.id, version: manifest.provider.version },
    passed: requirements.every((r) => r.passed),
    requirements,
  };
}
