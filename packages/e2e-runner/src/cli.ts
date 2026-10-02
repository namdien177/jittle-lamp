#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CacheMode } from "@jittle-lamp/shared";

import { loadEnvFiles } from "./config/env-files";
import { describeResolvedConfig, formatConfigTable, resolveRunConfig } from "./config/resolve";
import { runTranscript } from "./run";

export type ParsedArgs = { command: string; positionals: string[]; flags: Map<string, string[]> };

const booleanFlags = new Set(["code", "headed", "upload", "wait", "help", "json", "with-secrets", "allow-claude-code", "force"]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const value = inline ?? (booleanFlags.has(name) ? "true" : rest[++index]);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { command, positionals, flags };
}

const flag = (args: ParsedArgs, name: string) => args.flags.get(name)?.at(-1);
const flagList = (args: ParsedArgs, name: string) => args.flags.get(name) ?? [];

export function parseVars(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const value of values) {
    const equals = value.indexOf("=");
    if (equals <= 0) throw new Error(`--var expects name=value, got "${value}"`);
    out[value.slice(0, equals)] = value.slice(equals + 1);
  }
  return out;
}

const usage = `jl-e2e: run transcript test cases with an AI agent in a real browser

  jl-e2e run <file.transcript.md> [--env-file .env.e2e] [--var name=value] [--headed]
             [--cache read-write|read-only|off|strict] [--upload] [--record-model-fixture f.json]
  jl-e2e config [--env-file .env.e2e]          resolved names, secrets masked, with sources
  jl-e2e cache ls [--code] | cache clear [--step <stepId>]

Model ids select the provider: anthropic/…, openai/…, openrouter/<vendor>/<model>,
openai-compatible/<model>, gateway/…, claude-code/… (development only, --allow-claude-code),
mock:<fixture.json> (recorded turns, no network).`;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const cwd = process.cwd();

  if (args.command === "config") {
    const config = resolveRunConfig({ env: process.env, envFiles: loadEnvFiles(cwd, flagList(args, "env-file")), params: parseVars(flagList(args, "var")) });
    console.log(formatConfigTable(describeResolvedConfig(config)));
    return 0;
  }

  if (args.command === "cache") {
    const { listCache, clearCache } = await import("./cache/commands");
    const dir = resolve(cwd, flag(args, "dir") ?? process.env.JL_CACHE_DIR ?? ".e2e/cache");
    if (args.positionals[0] === "clear") {
      const removed = clearCache(dir, flag(args, "step") ?? null);
      console.log(`removed ${removed} cached script(s) from ${dir}`);
      return 0;
    }
    for (const entry of listCache(dir)) {
      console.log(`${entry.stepId ?? "(unmapped)"}  ${entry.environment ?? "-"}  ${entry.recordedAt}  ${entry.actions} action(s)  ${entry.keyHash.slice(0, 12)}`);
      if (flag(args, "code") === "true" || args.flags.has("code")) console.log(`${entry.renderedCode.replace(/^/gm, "    ")}`);
    }
    return 0;
  }

  if (args.command === "run") {
    const file = args.positionals[0];
    if (!file) {
      console.error("jl-e2e run needs a transcript file");
      return 2;
    }
    const result = await runTranscript({
      transcript: readFileSync(resolve(cwd, file), "utf8"),
      transcriptPath: file,
      cwd,
      envFiles: flagList(args, "env-file"),
      params: parseVars(flagList(args, "var")),
      headed: flag(args, "headed") === "true",
      ...(flag(args, "cache") ? { cacheMode: flag(args, "cache") as CacheMode } : {}),
      ...(flag(args, "record-model-fixture") ? { recordModelFixture: flag(args, "record-model-fixture") as string } : {}),
      allowClaudeCode: flag(args, "allow-claude-code") === "true",
      log: (line) => console.error(`[jl-e2e] ${line}`),
      onStepEvent: (event) => {
        if (event.type === "step-finished") console.error(`[jl-e2e] ${event.status.padEnd(7)} ${event.stepId}${event.error ? ` ${event.error.code}` : ""}`);
      }
    });
    const { report } = result;
    console.log(
      `${report.outcome.toUpperCase()} ${report.testCase.title}: ${report.totals.stepsTotal} steps, ${report.totals.stepsReplayed} replayed, ${report.totals.stepsAgent} agent, ${report.totals.stepsHandoff} handoff, ${report.totals.usage.modelCalls + report.totals.judgeUsage.modelCalls} model calls`
    );
    if (report.blockedReason) console.log(`blocked: ${report.blockedReason}${report.missing.length ? ` (${report.missing.join(", ")})` : ""}`);
    console.log(`report: ${result.reportPath}`);
    if (flag(args, "upload") === "true") {
      const { uploadRunEvidence } = await import("./evidence/upload");
      const uploaded = await uploadRunEvidence(result, { env: process.env, cwd });
      console.log(`evidence: ${uploaded.evidenceId}${uploaded.url ? ` ${uploaded.url}` : ""}`);
    }
    return report.outcome === "passed" ? 0 : report.outcome === "failed" ? 1 : 3;
  }

  console.log(usage);
  return args.command === "help" ? 0 : 2;
}

if (import.meta.main || process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(4);
    }
  );
}
