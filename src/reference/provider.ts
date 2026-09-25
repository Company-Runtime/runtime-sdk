import {
  defineProvider,
  ProviderFailure,
  type HandlerContext,
  type Provider,
} from "../provider.ts";
import type { CredentialOwner, EvidenceItem, Json } from "../types.ts";

export interface KnowledgeDocument {
  ref: string;
  title: string;
  content: string;
}

export interface SentMessage {
  ref: string;
  recipients: string[];
  subject?: string;
  content?: string;
  profile?: string;
  idempotencyKey?: string;
  sentAt: string;
}

/** Faults a test can inject per capability. */
export type ReferenceFault =
  /** Never answers; the runtime's deadline elapses. The effect does not happen. */
  | "timeout"
  /** Performs the effect, then loses the response (the runtime sees an error). */
  | "lost_response"
  /** Answers `unknown` without performing the effect. */
  | "unknown"
  /** Fails with proof that no effect happened. */
  | "fail";

export interface ReferenceProviderOptions {
  id?: string;
  version?: string;
  profiles?: string[];
  credentials?: { required: boolean; accepts: CredentialOwner[] };
  knowledge?: KnowledgeDocument[];
  faults?: Partial<Record<string, ReferenceFault>>;
}

export interface ReferenceProvider extends Provider {
  /** Messages delivered by communication.send, in order. */
  readonly outbox: SentMessage[];
  /** Number of handler calls per capability (effects are counted in `outbox`). */
  readonly calls: Record<string, number>;
  setFault(capability: string, fault: ReferenceFault | undefined): void;
}

export const DEFAULT_KNOWLEDGE: KnowledgeDocument[] = [
  {
    ref: "resource://reference/kb/reset-password",
    title: "Reset your password",
    content:
      "Open Settings, choose Security and select Reset password. A reset link is emailed to you.",
  },
  {
    ref: "resource://reference/kb/refunds",
    title: "Refunds and double charges",
    content:
      "If you were charged twice, the duplicate charge is refunded automatically within five business days.",
  },
  {
    ref: "resource://reference/kb/close-account",
    title: "Close your account",
    content:
      "Account owners can close the account from Settings. Closing an account deletes its data after thirty days.",
  },
];

const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);

async function applyFault(
  fault: ReferenceFault | undefined,
  context: HandlerContext,
): Promise<void> {
  if (fault === "timeout")
    await new Promise((_, reject) =>
      context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  if (fault === "unknown") throw new Error("the downstream system did not confirm the operation");
  if (fault === "fail")
    throw new ProviderFailure("the downstream system rejected the request before acting");
}

/**
 * The in-memory reference provider: communication.send, knowledge.search and
 * reasoning.classify with real semantics, evidence, idempotency and reconciliation.
 */
export function createReferenceProvider(options: ReferenceProviderOptions = {}): ReferenceProvider {
  const outbox: SentMessage[] = [];
  const calls: Record<string, number> = {};
  const faults = new Map(Object.entries(options.faults ?? {}));
  const knowledge = options.knowledge ?? DEFAULT_KNOWLEDGE;
  const id = options.id ?? "reference";
  const byKey = (key: string | undefined) =>
    key ? outbox.find((m) => m.idempotencyKey === key) : undefined;
  const count = (capability: string) => (calls[capability] = (calls[capability] ?? 0) + 1);

  const sendEvidence = (message: SentMessage, context: HandlerContext): EvidenceItem[] => {
    const subject = { ref: message.ref };
    const items = [
      context.evidence.providerReceipt(
        ["execution"],
        { accepted_at: message.sentAt, recipients: message.recipients.length },
        { subject },
      ),
    ];
    if (
      context.traits.includes("delivery_receipt") ||
      context.invocation.evidence.require.includes("delivery")
    )
      items.push(
        context.evidence.providerReceipt(
          ["delivery"],
          { delivered: message.recipients, delivered_at: message.sentAt },
          { subject },
        ),
      );
    return items;
  };
  const sendOutput = (message: SentMessage): Json => ({
    message: { ref: message.ref },
    accepted_recipients: message.recipients,
  });

  const provider = defineProvider({
    id,
    version: options.version ?? "0.1.0",
    name: "Reference provider",
    description:
      "In-memory reference implementation of communication.send, knowledge.search and reasoning.classify.",
    adapter: { id: "reference-memory", version: "0.1.0", system: "in-memory" },
    capabilities: [
      {
        capability: "communication.send",
        profiles: options.profiles ?? ["email", "chat"],
        traits: ["attachments", "delivery_receipt", "idempotency", "rich_text", "threading"],
        evidence: {
          claims: ["execution", "delivery"],
          types: ["provider_receipt", "state_observation"],
        },
        cost: { estimate: { amount: 0, currency: "USD" } },
        regions: ["local"],
        reconciliation: "supported",
      },
      {
        capability: "knowledge.search",
        evidence: { claims: ["execution"], types: ["provider_receipt"] },
        cost: { estimate: { amount: 0, currency: "USD" } },
        regions: ["local"],
      },
      {
        capability: "reasoning.classify",
        traits: ["batch"],
        evidence: { claims: ["execution"], types: ["provider_receipt"] },
        cost: { estimate: { amount: 0, currency: "USD" } },
        regions: ["local"],
      },
    ],
    credentials: options.credentials ?? { required: true, accepts: ["organization", "runtime"] },
    handlers: {
      "communication.send": async (input, context) => {
        count("communication.send");
        if (options.credentials?.required !== false && (await context.credential()) === undefined)
          throw new ProviderFailure("no credential was provided", {
            code: "credential_unavailable",
          });
        const fault = faults.get("communication.send");
        if (fault !== "lost_response") await applyFault(fault, context);
        const existing = byKey(context.idempotencyKey);
        if (existing)
          return {
            output: sendOutput(existing),
            evidence: sendEvidence(existing, context),
            cost: { amount: 0, currency: "USD" },
          };
        const message: SentMessage = {
          ref: `resource://${id}/outbox/msg-${outbox.length + 1}`,
          recipients: input["recipients"] as string[],
          ...(typeof input["subject"] === "string" ? { subject: input["subject"] } : {}),
          ...(typeof input["content"] === "string" ? { content: input["content"] } : {}),
          ...(context.profile ? { profile: context.profile } : {}),
          ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
          sentAt: context.now().toISOString(),
        };
        outbox.push(message);
        if (fault === "lost_response")
          throw new Error("connection reset after the request was sent");
        return {
          output: sendOutput(message),
          evidence: sendEvidence(message, context),
          cost: { amount: 0, currency: "USD" },
        };
      },
      "knowledge.search": async (input, context) => {
        count("knowledge.search");
        await applyFault(faults.get("knowledge.search"), context);
        const query = new Set(tokens(String(input["query"])));
        const limit = typeof input["limit"] === "number" ? input["limit"] : 5;
        const results = knowledge
          .map((doc) => ({
            doc,
            score: tokens(`${doc.title} ${doc.content}`).filter((t) => query.has(t)).length,
          }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score || (a.doc.ref < b.doc.ref ? -1 : 1))
          .slice(0, limit)
          .map((r) => ({
            source: r.doc.ref,
            title: r.doc.title,
            excerpt: r.doc.content,
            score: r.score,
          }));
        return {
          output: { results },
          evidence: [
            context.evidence.providerReceipt(["execution"], {
              index: "reference",
              hits: results.length,
            }),
          ],
        };
      },
      "reasoning.classify": async (input, context) => {
        count("reasoning.classify");
        await applyFault(faults.get("reasoning.classify"), context);
        const labels = input["labels"] as Array<{ id: string; description?: string }>;
        const classify = (item: unknown) => {
          const text = new Set(tokens(typeof item === "string" ? item : JSON.stringify(item)));
          const scored = labels.map((l) => ({
            id: l.id,
            hits: tokens(`${l.id} ${l.description ?? ""}`).filter((t) => text.has(t)).length,
          }));
          const total = scored.reduce((sum, s) => sum + s.hits, 0);
          return scored
            .filter((s) => s.hits > 0 || total === 0)
            .map((s) => ({
              id: s.id,
              confidence: total === 0 ? 1 / labels.length : Number((s.hits / total).toFixed(4)),
            }))
            .sort((a, b) => b.confidence - a.confidence || (a.id < b.id ? -1 : 1))
            .slice(0, input["multi_label"] === true ? labels.length : 1);
        };
        const output: Json = Array.isArray(input["inputs"])
          ? {
              results: (input["inputs"] as unknown[]).map((item, index) => ({
                index,
                labels: classify(item),
              })),
            }
          : { labels: classify(input["input"]) };
        return {
          output,
          evidence: [
            context.evidence.providerReceipt(["execution"], { method: "keyword-overlap" }),
          ],
        };
      },
    },
    reconcile: {
      "communication.send": async (_input, context) => {
        const message = byKey(context.idempotencyKey);
        if (!message)
          return {
            status: "failed",
            final: true,
            reason: "no message was ever recorded for this idempotency key",
            evidence: [
              context.evidence.stateObservation(
                ["state"],
                { ref: `resource://${id}/outbox` },
                { idempotency_key: context.idempotencyKey ?? null, exists: false },
              ),
            ],
          };
        return {
          status: "completed",
          output: sendOutput(message),
          evidence: [
            context.evidence.stateObservation(
              ["execution", "delivery"],
              { ref: message.ref },
              { state: "delivered", recipients: message.recipients },
            ),
          ],
        };
      },
    },
    health: () => "ok",
  });
  return Object.assign(provider, {
    outbox,
    calls,
    setFault(capability: string, fault: ReferenceFault | undefined) {
      if (fault) faults.set(capability, fault);
      else faults.delete(capability);
    },
  });
}
