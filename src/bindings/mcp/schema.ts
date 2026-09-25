import { isRecord } from "../../json.ts";
import type { Registry } from "../../registry.ts";

function pointer(document: unknown, fragment: string): unknown {
  let node = document;
  for (const raw of fragment.replace(/^\/?/, "").split("/").filter(Boolean)) {
    if (!isRecord(node)) return undefined;
    node = node[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

/**
 * Returns a self-contained copy of a schema: every `$ref` into the protocol schemas is
 * replaced by its target, so MCP hosts need no URN resolution.
 */
export function inlineSchema(
  schema: unknown,
  registry: Registry,
  base?: unknown,
  depth = 0,
): unknown {
  if (depth > 32) return {};
  if (Array.isArray(schema))
    return schema.map((item) => inlineSchema(item, registry, base, depth + 1));
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$ref" && typeof value === "string") {
      const [id, fragment] = value.split("#");
      const document = id ? registry.schemas.ajv.getSchema(id)?.schema : base;
      const target = fragment ? pointer(document, fragment) : document;
      const inlined = inlineSchema(target, registry, document, depth + 1);
      if (isRecord(inlined)) Object.assign(out, inlined);
    } else if (key !== "$id" && key !== "$schema" && key !== "$defs") {
      out[key] = inlineSchema(value, registry, base ?? schema, depth + 1);
    }
  }
  return out;
}
