import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { explorationRecordSchema, type ExplorationRecord, type ExplorationResultRequest } from "@jittle-lamp/shared";

import { credentialLoginContext, collectSecretValues, resolveRunConfig, type OrgRunConfig, type ResolvedRunConfig } from "./config/resolve";
import { e2eNodeModulesDir, renderConfigFile } from "./generate/project";
import { e2ePackageDir } from "./paths";
import { createRedactor, redactJson } from "./redact";
import { buildChildEnv } from "./run";

// One exploration for an import item (design.md §7 "General instructions"): `e2e explore` with the
// item's goal against the environment, through the same engine, models and credentials a run
// uses. It writes no test and no cache; its record becomes the item's transcript on the backend.

export type RunExplorationOptions = {
  explorationId: string;
  goal: string;
  maxSteps: number;
  timeoutMs: number;
  org: OrgRunConfig;
  // Profiles the instructions name that the organisation has no credential for.
  missingProfiles?: readonly string[];
  // Working directory; the exploration writes under <cwd>/.e2e/explorations/<id>.
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  headed?: boolean;
  viewport?: { width: number; height: number };
  signal?: AbortSignal;
  log?: (line: string) => void;
};

type ReportJson = { run?: { explore?: unknown } };

// e2e's record, trimmed to the contract: optional fields become null.
export function toExplorationRecord(raw: unknown): ExplorationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { steps?: Array<Record<string, unknown>>; findings?: Array<Record<string, unknown>>; summary?: unknown } & Record<string, unknown>;
  const parsed = explorationRecordSchema.safeParse({
    goal: record.goal,
    ended: record.ended,
    summary: typeof record.summary === "string" ? record.summary : null,
    steps: (record.steps ?? []).map((step) => ({
      index: step.index,
      title: step.title,
      instruction: step.instruction,
      status: step.status,
      summary: typeof step.summary === "string" ? step.summary : null,
      errorCode: typeof step.errorCode === "string" ? step.errorCode : null
    })),
    findings: (record.findings ?? []).map((finding) => ({
      kind: finding.kind,
      severity: finding.severity,
      title: finding.title,
      expected: finding.expected,
      actual: finding.actual
    }))
  });
  return parsed.success ? parsed.data : null;
}

// Before a browser starts: every profile the instructions name must exist with a login identifier
// (the selected public field) and a secret password. Otherwise the agent signs in
// with nothing and guesses accounts (production 2026-10-04, AUTH_CREDENTIAL_UNAVAILABLE).
export function explorationPreflight(config: Pick<ResolvedRunConfig, "credentials"> & Partial<Pick<ResolvedRunConfig, "credentialErrors" | "loginFields">>, missingProfiles: readonly string[] = []): string | null {
  if (missingProfiles.length > 0) {
    return `No login credential named ${missingProfiles.join(", ")} for this environment; add it in Testing settings → Credentials`;
  }
  for (const [profile, fields] of config.credentials) {
    const problem = config.credentialErrors?.get(profile);
    if (problem) return `Credential ${profile}: ${problem}`;
    const identifier = fields.get(config.loginFields?.get(profile) ?? "username");
    if (!identifier?.value || identifier.secret) return `Credential ${profile} needs a public login field`;
    if (!fields.get("password")?.value || !fields.get("password")?.secret) return `Credential ${profile} needs a secret password field; exploration does not support PIN or accessKey login`;
  }
  return null;
}

// The engine bounds its CLI goal to 2,000 characters. Keep a short directive there and
// carry the complete imported instructions and login guidance in its supported agent context,
// which reaches both the planner and the executor. Never truncate a user's expected results.
export function explorationAgentContext(goal: string, config: Pick<ResolvedRunConfig, "agentInstructions" | "credentials" | "loginFields">): string {
  return [config.agentInstructions, `Complete imported test instructions:\n${goal}`, credentialLoginContext(config)]
    .filter(Boolean)
    .join("\n\n");
}

const engineExplorationGoal = "Follow the complete imported test instructions in agent context exactly, including their expected results and restrictions. Finish when those instructions are covered. Do not explore beyond them.";

export async function runExploration(options: RunExplorationOptions): Promise<ExplorationResultRequest> {
  const log = options.log ?? (() => undefined);
  const env = options.env ?? process.env;
  const config = resolveRunConfig({ env, org: options.org });
  const preflight = explorationPreflight(config, options.missingProfiles ?? []);
  if (preflight) {
    log(`not exploring: ${preflight}`);
    return { status: "failed", explore: null, error: preflight };
  }
  const redact = createRedactor(collectSecretValues(config));
  const dir = join(options.cwd, ".e2e", "explorations", options.explorationId);
  const output = join(dir, ".e2e");
  mkdirSync(join(dir, "tests"), { recursive: true });
  const nodeModules = join(dir, "node_modules");
  if (!existsSync(nodeModules)) symlinkSync(e2eNodeModulesDir(), nodeModules, process.platform === "win32" ? "junction" : "dir");

  const baseUrl = config.baseUrl?.value ?? null;
  if (!baseUrl) return { status: "failed", explore: null, error: "The environment has no base URL" };
  const environmentName = config.environmentName?.value ?? "explore";
  const configPath = join(dir, "e2e.config.ts");
  writeFileSync(
    configPath,
    renderConfigFile({
      targetName: environmentName.replace(/[^A-Za-z0-9_-]/g, "-"),
      appIdentity: `jl-env:${environmentName}`,
      fallbackUrl: baseUrl,
      credentialProfiles: [...config.credentials.keys()],
      secretNames: [],
      cacheMode: "off",
      cacheStoreDir: join(dir, "cache"),
      headed: options.headed ?? false,
      viewport: options.viewport ?? { width: 1280, height: 800 },
      timeoutMs: options.timeoutMs
    })
  );
  // e2e loads the configured test files before it registers the exploration body.
  writeFileSync(join(dir, "tests", "case.e2e.ts"), 'import { test } from "e2e";\n\ntest.skip("exploration", async () => {});\n');

  const childEnv = buildChildEnv({ config, plan: { baseUrl, params: {}, agentInstructions: explorationAgentContext(options.goal, config) }, host: env, extra: {} });
  const args = [
    join(e2ePackageDir, "dist/cli/bin.js"),
    "explore",
    engineExplorationGoal,
    "--config",
    configPath,
    "--max-steps",
    String(options.maxSteps),
    "--timeout",
    String(options.timeoutMs),
    "--output",
    output,
    "--reporter",
    "json",
    ...(options.headed ? ["--headed"] : [])
  ];
  log(`e2e explore (${options.maxSteps} steps at most) on ${environmentName}`);
  const outputLog = join(dir, "e2e-output.log");
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const child = spawn(env.JL_NODE ?? "node", args, { cwd: dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: string[] = [];
    child.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.stderr.on("data", (data: Buffer) => chunks.push(data.toString()));
    // e2e stops at its own timeout; the watchdog only catches a hung engine.
    const watchdog = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs + 120_000);
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => undefined);
    child.on("close", (code) => {
      clearTimeout(watchdog);
      options.signal?.removeEventListener("abort", abort);
      writeFileSync(outputLog, redact(chunks.join("")));
      resolvePromise(code);
    });
  });

  const reportPath = join(output, "report.json");
  if (!existsSync(reportPath)) {
    const tail = existsSync(outputLog) ? readFileSync(outputLog, "utf8").trim().split("\n").slice(-3).join(" ") : "";
    return { status: "failed", explore: null, error: `e2e explore wrote no report (exit ${exitCode ?? "killed"})${tail ? `: ${tail.slice(0, 500)}` : ""}` };
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as ReportJson;
  const record = toExplorationRecord(report.run?.explore);
  if (!record) return { status: "failed", explore: null, error: "e2e explore reported no exploration record" };
  // An exploration that found issues still ran; the issues are in the record for the reviewer.
  return { status: "done", explore: redactJson({ ...record, goal: options.goal }, redact), error: null };
}
