import { ProtocolError } from "./errors.ts";
import { isRecord } from "./json.ts";
import { Registry } from "./registry.ts";
import type { ExecutionOutcome } from "./runtime.ts";
import type { RequestShorthand } from "./client.ts";
import type { Json, Recipe } from "./types.ts";

/** Checks a recipe against the registry (spec/0.1/capabilities.md §6). Returns problems. */
export function validateRecipe(recipe: Recipe, registry: Registry = Registry.core()): string[] {
  const problems = registry.schemas.validate("recipe", recipe);
  if (problems.length > 0) return problems;
  if (registry.capability(recipe.id))
    problems.push(`recipe ${recipe.id} collides with a capability`);
  const earlier = new Set<string>();
  for (const step of recipe.steps) {
    const capability = registry.capability(registry.normalize(step.capability).id);
    if (!capability) problems.push(`step ${step.id}: unknown capability ${step.capability}`);
    else if (step.profile && !capability.profiles.includes(step.profile))
      problems.push(`step ${step.id}: ${step.capability} does not accept profile ${step.profile}`);
    for (const path of bindings(step.input)) {
      const [head, name, next] = path.split(".");
      const ok =
        (head === "inputs" && name) ||
        (head === "steps" && name && earlier.has(name) && next === "output");
      if (!ok) problems.push(`step ${step.id}: invalid binding $from: ${path}`);
    }
    earlier.add(step.id);
  }
  return problems;
}

function bindings(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) bindings(item, out);
  else if (isRecord(value)) {
    if (typeof value["$from"] === "string" && Object.keys(value).length === 1)
      out.push(value["$from"]);
    else for (const item of Object.values(value)) bindings(item, out);
  }
  return out;
}

function lookup(scope: Json, path: string): unknown {
  let node: unknown = scope;
  for (const key of path.split(".")) {
    if (!isRecord(node)) return undefined;
    node = node[key];
  }
  return node;
}

function bind(value: unknown, scope: Json): unknown {
  if (Array.isArray(value)) return value.map((item) => bind(item, scope));
  if (isRecord(value)) {
    if (typeof value["$from"] === "string" && Object.keys(value).length === 1)
      return lookup(scope, value["$from"]);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bind(v, scope)]));
  }
  return value;
}

export interface RecipeRun {
  completed: boolean;
  steps: Array<{ id: string; outcome: ExecutionOutcome }>;
}

/**
 * Runs a recipe sequentially. Every step is an independent capability request with
 * its own authority, policy, resolution, evidence and receipt; the run stops at the
 * first step that does not complete.
 */
export async function runRecipe(
  recipe: Recipe,
  inputs: Json,
  runtime: { execute(input: RequestShorthand): Promise<ExecutionOutcome>; registry: Registry },
  base: Omit<RequestShorthand, "capability" | "input"> = {},
): Promise<RecipeRun> {
  const problems = validateRecipe(recipe, runtime.registry);
  if (problems.length > 0)
    throw new ProtocolError("invalid_request", `Invalid recipe: ${problems[0]}`, {
      detail: "invalid_recipe",
    });
  const scope: Json = { inputs, steps: {} };
  const run: RecipeRun = { completed: false, steps: [] };
  for (const step of recipe.steps) {
    const outcome = await runtime.execute({
      ...base,
      capability: step.version ? { id: step.capability, version: step.version } : step.capability,
      input: bind(step.input, scope) as Json,
      ...(step.profile ? { profile: step.profile } : {}),
      ...(step.traits ? { traits: step.traits } : {}),
      ...(base.request_id ? { request_id: `${base.request_id}.${step.id}` } : {}),
    });
    run.steps.push({ id: step.id, outcome });
    (scope["steps"] as Json)[step.id] = { output: outcome.execution.output ?? {} };
    if (outcome.execution.state !== "completed") return run;
  }
  run.completed = true;
  return run;
}
