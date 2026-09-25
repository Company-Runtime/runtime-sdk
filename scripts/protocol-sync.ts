/**
 * Generates src/protocol/bundle.generated.ts from a runtime-protocol checkout and
 * pins it in protocol.lock.json.
 *
 *   node scripts/protocol-sync.ts [--from ../runtime-protocol]   regenerate and update the lock
 *   node scripts/protocol-sync.ts --check [--from <checkout>]    verify bundle and lock against the checkout
 *
 * The checkout must be clean. `--check` also requires it to be at the locked commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { digest } from "../src/json.ts";
import type { ProtocolBundle } from "../src/protocol/types.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE_FILE = join(ROOT, "src", "protocol", "bundle.generated.ts");
const LOCK_FILE = join(ROOT, "protocol.lock.json");
const REPOSITORY = "https://github.com/Company-Runtime/runtime-protocol";

const args = process.argv.slice(2);
const check = args.includes("--check");
const fromIndex = args.indexOf("--from");
const from = resolve(fromIndex >= 0 ? args[fromIndex + 1]! : join(ROOT, "..", "runtime-protocol"));

const read = (path: string): unknown => {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json")
    ? JSON.parse(text)
    : parse(text, { uniqueKeys: true, strict: true });
};
const walk = (dir: string, ext: string[]): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path, ext));
    else if (ext.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
};
const git = (...cmd: string[]) => execFileSync("git", cmd, { cwd: from, encoding: "utf8" }).trim();

function inline(definitionFile: string, source: Record<string, unknown>): Record<string, unknown> {
  if (typeof source["schema_ref"] !== "string") return source;
  return { schema: read(join(dirname(definitionFile), source["schema_ref"])) };
}

function build(commit: string): ProtocolBundle {
  const schemas: ProtocolBundle["schemas"] = {};
  for (const file of walk(join(from, "schemas", "0.1"), [".schema.json"]))
    schemas[basename(file, ".schema.json")] = read(file) as Record<string, unknown>;
  const yamlIn = (dir: string, name?: string) =>
    walk(join(from, "registry", dir), [".yaml"]).filter((f) => !name || basename(f) === name);
  const capabilities = yamlIn("capabilities", "capability.yaml").map((file) => {
    const doc = read(file) as Record<string, unknown>;
    return {
      ...doc,
      input: inline(file, doc["input"] as Record<string, unknown>),
      output: inline(file, doc["output"] as Record<string, unknown>),
    };
  });
  const profiles = yamlIn("profiles", "profile.yaml").map((file) => {
    const doc = read(file) as Record<string, unknown>;
    const appliesTo = (doc["applies_to"] as Array<Record<string, unknown>>).map((entry) =>
      entry["input"]
        ? { ...entry, input: inline(file, entry["input"] as Record<string, unknown>) }
        : entry,
    );
    return { ...doc, applies_to: appliesTo };
  });
  const conformanceDir = join(from, "conformance");
  const suite = read(join(conformanceDir, "suite.yaml")) as { files: string[] };
  const cases: ProtocolBundle["conformance"]["cases"] = {};
  const documents: ProtocolBundle["conformance"]["documents"] = {};
  for (const file of suite.files)
    cases[file] = read(join(conformanceDir, file)) as Array<Record<string, unknown>>;
  for (const file of walk(join(conformanceDir, "fixtures"), [".yaml"]))
    documents[relative(conformanceDir, file)] = read(file);
  const referenced = JSON.stringify(cases).match(/"\.\.\/examples\/[^"]+"/g) ?? [];
  for (const quoted of new Set(referenced)) {
    const path = JSON.parse(quoted) as string;
    documents[path] = read(join(conformanceDir, path));
  }
  const conformanceSchemas: Record<string, Record<string, unknown>> = {};
  for (const file of walk(join(conformanceDir, "schemas"), [".json"]))
    conformanceSchemas[basename(file, ".schema.json")] = read(file) as Record<string, unknown>;
  const bindings: ProtocolBundle["bindings"] = {};
  for (const file of walk(join(from, "bindings"), [".schema.json"]))
    bindings[relative(join(from, "bindings"), file)] = read(file) as Record<string, unknown>;
  return {
    protocol: "runtime/0.1",
    source: { repository: REPOSITORY, commit },
    schemas,
    registry: {
      manifest: read(join(from, "registry", "registry.yaml")) as Record<string, unknown>,
      domains: yamlIn("domains").map((f) => read(f) as Record<string, unknown>),
      verbs: yamlIn("verbs").map((f) => read(f) as Record<string, unknown>),
      traits: yamlIn("traits").map((f) => read(f) as Record<string, unknown>),
      profiles,
      capabilities,
      recipes: walk(join(from, "recipes"), [".yaml"]).map(
        (f) => read(f) as Record<string, unknown>,
      ),
    },
    bindings,
    conformance: {
      suite: suite as Record<string, unknown>,
      cases,
      documents,
      schemas: conformanceSchemas,
    },
  };
}

function render(bundle: ProtocolBundle): string {
  return [
    `// Generated by scripts/protocol-sync.ts from ${bundle.source.repository} at ${bundle.source.commit}.`,
    "// Do not edit: run `pnpm protocol:sync` against a runtime-protocol checkout instead.",
    'import type { ProtocolBundle } from "./types.ts";',
    "",
    `export const bundle: ProtocolBundle = ${JSON.stringify(bundle, null, 2)};`,
    "",
  ].join("\n");
}

if (git("status", "--porcelain")) {
  console.error(`✗ ${from} has uncommitted changes; the bundle must come from a commit`);
  process.exit(1);
}
const commit = git("rev-parse", "HEAD");
const bundle = build(commit);
const rendered = render(bundle);
const lock = {
  repository: REPOSITORY,
  commit,
  protocol: bundle.protocol,
  suite: (bundle.conformance.suite["version"] as string) ?? "unknown",
  digest: digest(bundle),
};

if (check) {
  const current = existsSync(LOCK_FILE)
    ? (JSON.parse(readFileSync(LOCK_FILE, "utf8")) as typeof lock)
    : undefined;
  const problems: string[] = [];
  if (current?.commit !== commit)
    problems.push(`checkout is at ${commit}, lock pins ${current?.commit ?? "nothing"}`);
  if (current?.digest !== lock.digest)
    problems.push("lock digest differs from the regenerated bundle");
  if (!existsSync(BUNDLE_FILE) || readFileSync(BUNDLE_FILE, "utf8") !== rendered)
    problems.push("src/protocol/bundle.generated.ts differs from the regenerated bundle");
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`✓ protocol bundle matches runtime-protocol@${commit.slice(0, 12)}`);
} else {
  writeFileSync(BUNDLE_FILE, rendered);
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`✓ bundled runtime-protocol@${commit.slice(0, 12)} (${lock.digest})`);
}
