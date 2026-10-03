#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CacheMode } from "@jittle-lamp/shared";

import { loadEnvFiles } from "./config/env-files";
import { describeResolvedConfig, formatConfigTable, resolveRunConfig } from "./config/resolve";
import { runTranscript } from "./run";

import { parseArgs, type ParsedArgs } from "./args";

export { parseArgs, type ParsedArgs } from "./args";

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

With JL_API_ORIGIN and JL_API_TOKEN (automation token):
  jl-e2e run --suite <id> | --case <id> [--env <id>] [--wait] [--junit out.xml] [--force]
  jl-e2e env pull <environment> [--with-secrets] [--out .env.e2e]
  jl-e2e export --case <id|key> [--case …] [dir]
  jl-e2e push <file.transcript.md>          creates or updates by Key, then by title

Model ids select the provider, each with its key in the environment or .env.e2e:
  openrouter/<vendor>/<model>   OPENROUTER_API_KEY
  openai-compatible/<model>     OPENAI_COMPATIBLE_BASE_URL (+ optional OPENAI_COMPATIBLE_API_KEY)
  gateway/<provider>/<model>    AI_GATEWAY_API_KEY
  openai/… anthropic/… google/… xai/…
                                OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, XAI_API_KEY
  claude-code/…                 development only, --allow-claude-code
  mock:<fixture.json>           recorded turns, no network`;

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

  if (args.command === "env" || args.command === "export" || args.command === "push" || (args.command === "run" && (args.flags.has("suite") || args.flags.has("case")))) {
    const remote = await import("./remote/commands");
    const env = { ...process.env, ...Object.fromEntries(loadEnvFiles(cwd, flagList(args, "env-file")).flatMap((file) => Object.entries(file.values))), ...process.env };
    const context = remote.remoteContext(env, (line) => console.error(`[jl-e2e] ${line}`));
    if (args.command === "env") {
      const name = args.positionals[1];
      if (args.positionals[0] !== "pull" || !name) {
        console.error("usage: jl-e2e env pull <environment> [--with-secrets] [--out .env.e2e]");
        return 2;
      }
      const out = resolve(cwd, flag(args, "out") ?? ".env.e2e");
      await remote.envPull(context, { environment: name, withSecrets: flag(args, "with-secrets") === "true", out });
      console.log(`wrote ${out}`);
      return 0;
    }
    if (args.command === "export") {
      const dir = resolve(cwd, args.positionals[0] ?? "e2e/cases");
      const written = await remote.exportCases(context, { ids: flagList(args, "case"), dir });
      for (const path of written) console.log(path);
      return 0;
    }
    if (args.command === "push") {
      const file = args.positionals[0];
      if (!file) {
        console.error("usage: jl-e2e push <file.transcript.md>");
        return 2;
      }
      for (const result of await remote.pushCases(context, { file: resolve(cwd, file) })) console.log(`${result.action} ${result.id} ${result.title}`);
      return 0;
    }
    const result = await remote.runRemote(context, {
      ...(flag(args, "suite") ? { suiteId: flag(args, "suite") as string } : {}),
      ...(flag(args, "case") ? { caseId: flag(args, "case") as string } : {}),
      ...(flag(args, "env") ? { environmentId: flag(args, "env") as string } : {}),
      params: parseVars(flagList(args, "var")),
      force: flag(args, "force") === "true",
      failOnBlocked: flag(args, "fail-on-blocked") === "true",
      wait: flag(args, "wait") === "true" || args.flags.has("junit"),
      ...(flag(args, "junit") ? { junit: resolve(cwd, flag(args, "junit") as string) } : {}),
      ...(env.JL_WEB_ORIGIN ? { webOrigin: env.JL_WEB_ORIGIN } : {}),
      ...(flag(args, "cache") ? { cacheMode: flag(args, "cache") as "read-write" | "read-only" | "off" | "strict" } : {})
    });
    for (const runId of result.runIds) console.log(runId);
    return result.exitCode;
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
      if (!result.recordingPath) {
        console.log("evidence: not uploaded, the run produced no recording");
      } else {
        const { uploadRunEvidence } = await import("./evidence/upload");
        const uploaded = await uploadRunEvidence(result, { env: process.env, cwd });
        console.log(`evidence: ${uploaded.evidenceId}${uploaded.url ? ` ${uploaded.url}` : ""}`);
      }
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
