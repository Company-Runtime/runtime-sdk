import { PROTOCOL } from "../constants.ts";
import { ProviderUnreachableError, type Provider } from "../provider.ts";
import type {
  EvidenceItem,
  Json,
  Money,
  ProviderManifest,
  ProviderResult,
  Reconciliation,
} from "../types.ts";

/** A scripted provider fixture (conformance/schemas/provider-fixture.schema.json). */
export interface ProviderFixture {
  manifest: ProviderManifest;
  behavior: Record<
    string,
    {
      result: "completed" | "failed" | "unknown" | "running" | "timeout" | "unreachable";
      output?: Json;
      evidence?: EvidenceItem[];
      cost?: Money;
      error?: { message: string; retryable?: boolean };
    }
  >;
  reconcile?: Record<
    string,
    {
      status: "completed" | "failed" | "inconclusive";
      output?: Json;
      evidence?: EvidenceItem[];
      reason?: string;
    }
  >;
}

export interface ScriptedProvider extends Provider {
  readonly executions: number;
  readonly reconciliations: number;
}

/** Builds a provider that behaves exactly as its fixture scripts. */
export function scriptedProvider(fixture: ProviderFixture): ScriptedProvider {
  let executions = 0;
  let reconciliations = 0;
  const provider: ScriptedProvider = {
    manifest: fixture.manifest,
    get executions() {
      return executions;
    },
    get reconciliations() {
      return reconciliations;
    },
    async execute(invocation, context): Promise<ProviderResult> {
      executions++;
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      const behavior = fixture.behavior[invocation.capability.id];
      if (!behavior)
        return {
          ...envelope,
          status: "failed",
          error: { code: "execution_failed", message: "not scripted" },
        };
      switch (behavior.result) {
        case "timeout":
          return new Promise((_, reject) =>
            context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            }),
          );
        case "unreachable":
          throw new ProviderUnreachableError();
        case "completed":
          return {
            ...envelope,
            status: "completed",
            output: structuredClone(behavior.output ?? {}),
            evidence: structuredClone(behavior.evidence ?? []),
            ...(behavior.cost ? { cost: behavior.cost } : {}),
          };
        case "running":
          return { ...envelope, status: "running" };
        case "failed":
        case "unknown": {
          const secret = (await context.credential()) ?? "";
          const message = (behavior.error?.message ?? "scripted").replaceAll("{{secret}}", secret);
          return {
            ...envelope,
            status: behavior.result,
            error: {
              code: "execution_failed",
              message,
              ...(behavior.error?.retryable !== undefined
                ? { retryable: behavior.error.retryable }
                : {}),
            },
            ...(behavior.evidence ? { evidence: structuredClone(behavior.evidence) } : {}),
          };
        }
      }
    },
  };
  if (fixture.reconcile) {
    provider.reconcile = async (invocation): Promise<Reconciliation> => {
      reconciliations++;
      const script = fixture.reconcile?.[invocation.capability.id];
      const envelope = { protocol: PROTOCOL, invocation_id: invocation.invocation_id } as const;
      if (!script) return { ...envelope, status: "inconclusive", reason: "not scripted" };
      return {
        ...envelope,
        status: script.status,
        ...(script.output ? { output: structuredClone(script.output) } : {}),
        ...(script.evidence ? { evidence: structuredClone(script.evidence) } : {}),
        ...(script.status === "failed" ? { final: true as const } : {}),
        ...(script.reason ? { reason: script.reason } : {}),
      };
    };
  }
  return provider;
}
