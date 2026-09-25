/** Shape of the generated protocol bundle (src/protocol/bundle.generated.ts). */
export interface ProtocolBundle {
  protocol: "runtime/0.1";
  source: { repository: string; commit: string };
  /** Protocol schemas by name (schemas/0.1/<name>.schema.json). */
  schemas: Record<string, Record<string, unknown>>;
  registry: {
    manifest: Record<string, unknown>;
    domains: Array<Record<string, unknown>>;
    verbs: Array<Record<string, unknown>>;
    traits: Array<Record<string, unknown>>;
    /** Profiles with per-capability input schemas inlined (`input.schema`). */
    profiles: Array<Record<string, unknown>>;
    /** Capabilities with input and output schemas inlined (`input.schema`, `output.schema`). */
    capabilities: Array<Record<string, unknown>>;
    recipes: Array<Record<string, unknown>>;
  };
  bindings: Record<string, Record<string, unknown>>;
  conformance: {
    suite: Record<string, unknown>;
    /** Case files by path relative to conformance/. */
    cases: Record<string, Array<Record<string, unknown>>>;
    /** Fixture and example documents by path relative to conformance/. */
    documents: Record<string, unknown>;
    schemas: Record<string, Record<string, unknown>>;
  };
}
