import { NAMESPACES } from "./constants.ts";

const SEGMENT = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const OWNER = /^[a-z0-9][a-z0-9-]*$/;

export type Namespace = (typeof NAMESPACES)[number];

export interface ParsedCapabilityId {
  namespace: Namespace;
  owner?: string;
  /** The `<domain>.<verb>` or `<domain>.<object>.<verb>` part. */
  local: string[];
}

/** Parses a capability identifier (spec/0.1/extensions.md), or returns why it is invalid. */
export function parseCapabilityId(id: string): ParsedCapabilityId | { error: string } {
  const parts = id.split(".");
  const first = parts[0] ?? "";
  if (first === "core")
    return { error: "the core namespace is implicit; 'core.' must not be written" };
  if (first === "experimental") {
    const local = parts.slice(1);
    if (local.length < 2 || local.length > 3 || !local.every((p) => SEGMENT.test(p)))
      return { error: "experimental identifiers are experimental.<domain>[.<object>].<verb>" };
    return { namespace: "experimental", local };
  }
  if (first === "community" || first === "vendor" || first === "org") {
    const owner = parts[1] ?? "";
    const local = parts.slice(2);
    if (!OWNER.test(owner)) return { error: `${first} identifiers need an owner segment` };
    if (local.length < 2 || local.length > 3 || !local.every((p) => SEGMENT.test(p)))
      return { error: `${first} identifiers are ${first}.<owner>.<domain>[.<object>].<verb>` };
    return { namespace: first, owner, local };
  }
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => SEGMENT.test(p)))
    return { error: "core identifiers are <domain>.<verb> or <domain>.<object>.<verb>" };
  if ((NAMESPACES as readonly string[]).includes(first))
    return { error: `'${first}' is a reserved namespace word` };
  return { namespace: "core", local: parts };
}

export function isCoreId(id: string): boolean {
  const parsed = parseCapabilityId(id);
  return !("error" in parsed) && parsed.namespace === "core";
}

/** Namespace isolation: an extension identifier whose local part is a core capability shadows it. */
export function shadowsCore(parsed: ParsedCapabilityId, coreIds: ReadonlySet<string>): boolean {
  return parsed.namespace !== "core" && coreIds.has(parsed.local.join("."));
}

/** mcp/0.1 tool name: every "." becomes "__" (reversible because segments never contain "__"). */
export const toolName = (capabilityId: string): string => capabilityId.replaceAll(".", "__");
export const capabilityFromToolName = (name: string): string => name.replaceAll("__", ".");
