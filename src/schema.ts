import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { SCHEMA_PREFIX } from "./constants.ts";
import { bundle } from "./protocol/bundle.generated.ts";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/** JSON Schema validation over the bundled protocol schemas (Draft 2020-12). */
export class SchemaSet {
  readonly ajv: Ajv2020;
  readonly #cache = new Map<string, ValidateFunction>();

  constructor() {
    this.ajv = new Ajv2020({
      strictSchema: true,
      strictNumbers: true,
      strictTypes: false,
      strictTuples: false,
      strictRequired: false,
      allErrors: true,
      allowUnionTypes: true,
    });
    addFormats(this.ajv);
    for (const schema of Object.values(bundle.schemas)) this.ajv.addSchema(schema);
    for (const schema of Object.values(bundle.bindings)) this.ajv.addSchema(schema);
  }

  /** Registers a schema unless its `$id` is already known. */
  add(schema: Record<string, unknown>): string {
    const id = String(schema["$id"]);
    if (!this.ajv.getSchema(id)) this.ajv.addSchema(schema);
    return id;
  }

  has(id: string): boolean {
    return this.ajv.getSchema(id) !== undefined;
  }

  validator(name: string): ValidateFunction {
    const id = name.includes(":") ? name : SCHEMA_PREFIX + name;
    let fn = this.#cache.get(id);
    if (!fn) {
      const found = this.ajv.getSchema(id);
      if (!found) throw new Error(`unknown schema ${id}`);
      fn = found;
      this.#cache.set(id, fn);
    }
    return fn;
  }

  /** Returns human-readable errors; an empty list means valid. */
  validate(name: string, document: unknown): string[] {
    const fn = this.validator(name);
    return fn(document) ? [] : formatErrors(fn.errors);
  }
}

export function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  const lines = errors
    .filter((e) => e.keyword !== "if")
    .map((e) => {
      const where = e.instancePath === "" ? "(root)" : e.instancePath;
      const params = e.params as Record<string, unknown>;
      const extra =
        e.keyword === "additionalProperties" || e.keyword === "unevaluatedProperties"
          ? ` '${String(params["additionalProperty"] ?? params["unevaluatedProperty"])}'`
          : e.keyword === "enum"
            ? ` ${JSON.stringify(params["allowedValues"])}`
            : "";
      return `${where} ${e.message ?? e.keyword}${extra}`;
    });
  return [...new Set(lines)];
}
