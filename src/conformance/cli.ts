#!/usr/bin/env node
/**
 * runtime-conformance runtime [--json <file>]
 *   Runs the bundled runtime/0.1 conformance suite against this SDK's runtime.
 *
 * runtime-conformance provider <module> [--export <name>] [--samples <file>] [--json <file>]
 *   Loads a provider (default export, or the named export; a function is called to
 *   create it) and verifies the provider requirements PC-001–PC-010 with the samples
 *   file (JSON or YAML list of { capability, input, profile?, traits?, credential? }).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import type { Provider } from "../provider.ts";
import { runProviderHarness, type ProviderSample } from "./provider-harness.ts";
import { runConformance } from "./runner.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const json = option("--json");

async function main(): Promise<number> {
  const command = args[0];
  if (command === "runtime") {
    const report = await runConformance();
    for (const r of report.results)
      console.log(
        `${r.passed ? "ok" : "not ok"} ${r.id} ${r.title}${r.passed ? "" : `\n  # ${r.failures.join("\n  # ")}`}`,
      );
    console.log(
      `# runtime/0.1 conformance suite ${report.suite} (protocol ${report.protocol_commit.slice(0, 12)}): ${report.total - report.failed}/${report.total} passed`,
    );
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  }
  if (command === "provider" && args[1]) {
    const module = (await import(pathToFileURL(resolve(args[1])).href)) as Record<string, unknown>;
    const exported = module[option("--export") ?? "default"];
    const provider = (
      typeof exported === "function" ? await (exported as () => unknown)() : exported
    ) as Provider;
    const samplesFile = option("--samples");
    const samples = samplesFile
      ? (parse(readFileSync(samplesFile, "utf8")) as ProviderSample[])
      : [];
    const report = await runProviderHarness(provider, samples);
    for (const r of report.requirements)
      console.log(
        `${r.passed ? "ok" : "not ok"} ${r.id}${r.passed ? "" : `\n  # ${r.details.join("\n  # ")}`}`,
      );
    console.log(
      `# provider ${report.provider.id}@${report.provider.version}: ${report.passed ? "passed" : "failed"}`,
    );
    if (json) writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  }
  console.error(
    "usage: runtime-conformance runtime [--json file] | provider <module> [--export name] [--samples file] [--json file]",
  );
  return 2;
}

process.exit(await main());
