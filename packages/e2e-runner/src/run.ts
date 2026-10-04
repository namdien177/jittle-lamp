import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  defaultModelPrices,
  defaultPriceTableVersion,
  priceRunReport,
  sha256Hex,
  type BlockedReason,
  type LinkedCase,
  type MacroDefinition,
  type ModelPrice,
  type TranscriptStep, type CacheMode, type RunArtifact, type RunnerInfo, type RunReport } from "@jittle-lamp/shared";

import { loadEnvFiles, type EnvFile } from "./config/env-files";
import { credentialLoginContext, collectSecretValues, resolveRunConfig, type OrgRunConfig, type ResolvedRunConfig } from "./config/resolve";
import { generateProject, type GeneratedProject } from "./generate/project";
import { e2ePackageDir, engineVersion, runnerVersion } from "./paths";
import { ModelResolutionError, resolveModel } from "./model/providers";
import { buildRunPlan, loadCaseDir, loadMacros, type RunPlan } from "./plan";
import { createRedactor, redactJson } from "./redact";
import { buildRunReport, type AiTrace, type E2eReport } from "./report/build";
import type { StepLogEvent } from "./runtime/step-log";

export { engineVersion, runnerVersion };

export type RunTranscriptOptions = {
  transcript: string;
  transcriptPath?: string;
  cwd: string;
  envFiles?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  org?: OrgRunConfig | null;
  params?: Readonly<Record<string, string>>;
  macroDirs?: readonly string[];
  headed?: boolean;
  cacheMode?: CacheMode;
  cacheDir?: string;
  runId?: string;
  testCaseId?: string | null;
  transcriptVersion?: number | null;
  environmentId?: string | null;
  host?: RunnerInfo["host"];
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  recordModelFixture?: string;
  allowClaudeCode?: boolean;
  signal?: AbortSignal;
  onStepEvent?: (event: StepLogEvent) => void;
  prices?: readonly ModelPrice[];
  // Organisation macros (runner daemon); local runs read macro files instead.
  macros?: readonly MacroDefinition[];
  // Cases [Use: KEY] runs inline (runner daemon); local runs read the transcripts next to this one.
  cases?: readonly LinkedCase[];
  // Steps as the backend stored them, so step ids match the server's.
  previousSteps?: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[];
  // Backend cache store and progress screenshots for daemon runs.
  backend?: { apiUrl: string; runId: string; runToken: string };
  progressScreenshots?: boolean;
  // Live view: directory the daemon relays control and input through (design.md §5.4).
  liveDir?: string;
  priceTableVersion?: string;
  log?: (line: string) => void;
};

export type RunTranscriptResult = {
  report: RunReport;
  plan: RunPlan;
  runDir: string;
  reportPath: string;
  recordingPath: string | null;
  tracePath: string | null;
  screenshotDir: string;
  project: GeneratedProject | null;
  redact: (text: string) => string;
  config: ResolvedRunConfig;
};

const defaultViewport = { width: 1440, height: 900 };
const claudeCodeAuthNames = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

function newRunId(): string {
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function findFiles(root: string, name: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === name) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readStepLog(path: string): StepLogEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as StepLogEvent];
      } catch {
        return [];
      }
    });
}

// Host names the browser run needs: paths, locale, display, proxies and CA bundles (VPN and
// self-hosted runners), and the Windows profile variables Playwright uses to find browsers.
const hostEnvNames = [
  "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "PLAYWRIGHT_BROWSERS_PATH", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
  "SystemRoot", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "PATHEXT", "ComSpec", "windir"
] as const;

// The e2e process sees only what it needs: a minimal host environment plus the resolved JL_*
// names. Nothing else from the caller's environment leaks into the browser run.
export function buildChildEnv(input: {
  config: ResolvedRunConfig;
  plan: Pick<RunPlan, "baseUrl" | "params" | "agentInstructions">;
  host: Readonly<Record<string, string | undefined>>;
  extra: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of hostEnvNames) {
    const value = input.host[name];
    if (value !== undefined) env[name] = value;
  }
  if (input.config.environmentName) env.JL_ENV_NAME = input.config.environmentName.value;
  if (input.plan.baseUrl) env.JL_ENV_BASE_URL = input.plan.baseUrl;
  for (const [name, value] of input.config.vars) env[`JL_VAR_${name}`] = value.value;
  for (const [name, value] of Object.entries(input.plan.params)) env[`JL_VAR_${name}`] = value;
  for (const [profile, fields] of input.config.credentials) {
    for (const [field, value] of fields) env[`JL_CRED_${profile}_${field.toUpperCase()}`] = value.value;
    const loginField = input.config.loginFields.get(profile);
    if (loginField) env[`JL_LOGIN_${profile}_IDENTIFIER`] = fields.get(loginField)!.value;
  }
  for (const [name, value] of input.config.providerKeys) env[name] = value.value;
  if (input.config.actModel) env.JL_MODEL = input.config.actModel.value;
  if (input.config.judgeModel) env.JL_JUDGE_MODEL = input.config.judgeModel.value;
  if (input.plan.agentInstructions) env.JL_AGENT_INSTRUCTIONS = input.plan.agentInstructions;
  env.E2E_TELEMETRY_DISABLED = "1";
  return { ...env, ...input.extra };
}

// sha256 of the instruction e2e sees, as e2e digests it (cache/identity.js normalizeInstruction).
export function e2eInstructionDigest(template: string): string {
  return sha256Hex(template.replace(/\r\n?/g, "\n").normalize("NFC").trim());
}

export async function runTranscript(options: RunTranscriptOptions): Promise<RunTranscriptResult> {
  const startedAt = new Date().toISOString();
  const env = options.env ?? process.env;
  const envFiles: EnvFile[] = loadEnvFiles(options.cwd, options.envFiles ?? []);
  const config = resolveRunConfig({ params: options.params ?? {}, env, envFiles, org: options.org ?? null });
  const cacheMode = options.cacheMode ?? config.cacheMode;
  const runId = options.runId ?? newRunId();
  const e2eRoot = resolve(options.cwd, ".e2e");
  const runDir = join(e2eRoot, "runs", runId);
  const screenshotDir = join(runDir, "screenshots");
  mkdirSync(runDir, { recursive: true });

  const transcriptDir = options.transcriptPath ? dirname(resolve(options.cwd, options.transcriptPath)) : options.cwd;
  const macros = options.macros
    ? [...loadMacros([]).filter((macro) => !options.macros?.some((org) => org.name.toLowerCase() === macro.name.toLowerCase())), ...options.macros]
    : loadMacros([...(options.macroDirs ?? []), join(transcriptDir, "../macros"), join(options.cwd, "e2e/macros")]);
  const cases = options.cases ?? loadCaseDir(transcriptDir);
  config.agentInstructions = [config.agentInstructions, credentialLoginContext(config)].filter(Boolean).join("\n\n") || null;
  const plan = buildRunPlan({
    transcript: options.transcript,
    config,
    macros,
    cases,
    params: options.params ?? {},
    ...(options.previousSteps ? { previousSteps: options.previousSteps } : {})
  });
  const allowClaudeCode = options.allowClaudeCode ?? env.JL_ALLOW_CLAUDE_CODE === "1";
  // claude-code/ models (development only) spawn the `claude` CLI, which authenticates with the
  // host's ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN; only those pass through, redacted.
  const claudeCodeEnv: Record<string, string> = {};
  if (allowClaudeCode && [config.actModel?.value, config.judgeModel?.value].some((id) => id?.startsWith("claude-code/"))) {
    for (const name of claudeCodeAuthNames) {
      const value = env[name];
      if (value) claudeCodeEnv[name] = value;
    }
  }
  const redact = createRedactor([
    ...collectSecretValues(config),
    ...Object.values(claudeCodeEnv).filter((value) => !/^https?:/.test(value)),
    ...(options.backend ? [options.backend.runToken] : [])
  ]);
  const log = (line: string) => options.log?.(redact(line));

  const viewport = options.viewport ?? defaultViewport;
  const runner: RunnerInfo = {
    runner: "jl-e2e",
    runnerVersion,
    engine: "e2e",
    engineVersion,
    browser: "chromium",
    browserVersion: null,
    headless: !options.headed,
    viewport,
    cacheMode,
    host: options.host ?? "cli"
  };
  const model = {
    act: config.actModel?.value ?? null,
    judge: config.judgeModel?.value ?? null,
    provider: config.actModel ? (config.actModel.value.startsWith("mock:") ? "mock" : (config.actModel.value.split("/")[0] ?? null)) : null
  };
  const reportPath = join(runDir, "run-report.json");
  // Local runs price tokens with the seeded default table; the backend reprices from the org's
  // test_model_prices at finalisation (design.md §3.1).
  const priceReport = (report: RunReport) =>
    priceRunReport(report, options.prices ?? defaultModelPrices, options.priceTableVersion ?? defaultPriceTableVersion, model);

  const finish = (input: {
    blocked?: { reason: BlockedReason; message: string } | null;
    cancelled?: boolean;
    e2eReport?: E2eReport | null;
    aiTrace?: AiTrace | null;
    stepLog?: StepLogEvent[];
    exitCode?: number | null;
    artifacts?: RunArtifact[];
    project?: GeneratedProject | null;
    recordingPath?: string | null;
    tracePath?: string | null;
  }): RunTranscriptResult => {
    const report = redactJson(
      priceReport(buildRunReport({
        plan,
        runId,
        testCaseId: options.testCaseId ?? null,
        transcriptVersion: options.transcriptVersion ?? null,
        environmentId: options.environmentId ?? null,
        runner,
        model,
        e2eReport: input.e2eReport ?? null,
        aiTrace: input.aiTrace ?? null,
        stepLog: input.stepLog ?? [],
        exitCode: input.exitCode ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        artifacts: input.artifacts ?? [],
        blocked: input.blocked ?? null,
        cancelled: input.cancelled ?? false
      })),
      redact
    );
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    mkdirSync(e2eRoot, { recursive: true });
    writeFileSync(join(e2eRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return {
      report,
      plan,
      runDir,
      reportPath,
      recordingPath: input.recordingPath ?? null,
      tracePath: input.tracePath ?? null,
      screenshotDir,
      project: input.project ?? null,
      redact,
      config
    };
  };

  if (plan.blockedReason) {
    log(`blocked: ${plan.blockedReason} ${plan.blockedMessage ?? ""}`);
    return finish({ blocked: { reason: plan.blockedReason, message: plan.blockedMessage ?? plan.blockedReason } });
  }

  const needsModel = plan.steps.some((step) => step.executes && ["act", "assert", "wait", "extract"].includes(step.type));
  if (needsModel) {
    const keys = Object.fromEntries([...config.providerKeys].map(([name, value]) => [name, value.value]));
    try {
      for (const id of new Set([model.act, model.judge].filter((value): value is string => value !== null))) {
        await resolveModel(id, { keys, allowClaudeCode });
      }
    } catch (error) {
      if (error instanceof ModelResolutionError) return finish({ blocked: { reason: error.code, message: error.message } });
      throw error;
    }
  }

  const cacheDir = resolve(options.cwd, options.cacheDir ?? config.cacheDir ?? join(".e2e", "cache"));
  const project = generateProject({
    dir: join(runDir, "project"),
    plan,
    config,
    cacheMode,
    cacheStoreDir: cacheDir,
    headed: options.headed ?? false,
    viewport,
    timeoutMs: options.timeoutMs ?? 15 * 60_000
  });

  // instructionDigest → transcript step, so cache files say which step they belong to.
  // Two act steps with the same instruction share a digest; the store lists every candidate.
  const cacheIndex: Record<string, Array<{ stepId: string; instructionKey: string }>> = {};
  for (const item of project.compiled) {
    if (item.call !== "act") continue;
    const digest = e2eInstructionDigest(item.template);
    cacheIndex[digest] = [...(cacheIndex[digest] ?? []), { stepId: item.step.stepId, instructionKey: item.step.instructionKey }];
  }
  const cacheIndexPath = join(runDir, "cache-index.json");
  writeFileSync(cacheIndexPath, JSON.stringify(cacheIndex, null, 2));

  const stepLogPath = join(runDir, "steps.jsonl");
  const progressPath = join(runDir, "progress.jsonl");
  const childEnv = buildChildEnv({
    config,
    plan,
    host: env,
    extra: {
      ...claudeCodeEnv,
      JL_STEP_LOG: stepLogPath,
      JL_PROGRESS_LOG: progressPath,
      JL_SCREENSHOT_DIR: screenshotDir,
      JL_CACHE_INDEX: cacheIndexPath,
      ...(options.backend ? { JL_CACHE_API_URL: options.backend.apiUrl, JL_RUN_ID: options.backend.runId, JL_RUN_TOKEN: options.backend.runToken } : {}),
      ...(options.progressScreenshots ? { JL_PROGRESS_SCREENSHOTS: "1" } : {}),
      ...(options.liveDir ? { JL_LIVE_DIR: options.liveDir } : {}),
      ...(allowClaudeCode ? { JL_ALLOW_CLAUDE_CODE: "1" } : {}),
      ...(options.recordModelFixture ? { JL_RECORD_MODEL_FIXTURE: resolve(options.cwd, options.recordModelFixture) } : {})
    }
  });

  const e2eBin = join(e2ePackageDir, "dist/cli/bin.js");
  const args = [e2eBin, "run", "--config", project.configPath, "--ai-trace", ...(options.headed ? ["--headed"] : [])];
  log(`e2e run (${plan.steps.filter((step) => step.executes).length} steps, cache ${cacheMode})`);

  const outputLog = join(runDir, "e2e-output.log");
  const timeoutMs = (options.timeoutMs ?? 15 * 60_000) + 120_000;
  let spawnError: Error | null = null;
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const child = spawn(env.JL_NODE ?? "node", args, { cwd: project.dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let seen = 0;
    const poll = setInterval(() => {
      const events = readStepLog(stepLogPath);
      for (const event of events.slice(seen)) options.onStepEvent?.(redactJson(event, redact));
      seen = events.length;
    }, 300);
    // Watchdog above e2e's own attempt deadline: a hung engine must not hold a runner slot.
    const watchdog = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const chunks: string[] = [];
    child.stdout.on("data", (data: Buffer) => chunks.push(data.toString()));
    child.stderr.on("data", (data: Buffer) => chunks.push(data.toString()));
    const abort = () => child.kill("SIGTERM");
    options.signal?.addEventListener("abort", abort, { once: true });
    // A cancel that arrived before the child existed.
    if (options.signal?.aborted) abort();
    const done = (code: number | null) => {
      clearInterval(poll);
      clearTimeout(watchdog);
      const events = readStepLog(stepLogPath);
      for (const event of events.slice(seen)) options.onStepEvent?.(redactJson(event, redact));
      options.signal?.removeEventListener("abort", abort);
      // Redact the whole log at once: a secret can straddle two chunks.
      writeFileSync(outputLog, redact(chunks.join("")));
      resolvePromise(code);
    };
    child.on("error", (error) => {
      spawnError = error;
      done(null);
    });
    child.on("close", (code) => done(code));
  });

  const e2eReport = readJson<E2eReport>(join(project.outputDir, "report.json"));
  const aiTrace = readJson<AiTrace>(join(project.outputDir, "ai-trace.json"));
  const stepLog = readStepLog(stepLogPath);

  const artifacts: RunArtifact[] = [];
  const artifactDir = join(runDir, "artifacts");
  mkdirSync(artifactDir, { recursive: true });
  const video = findFiles(join(project.outputDir, "artifacts"), "video.webm").at(-1);
  const trace = findFiles(join(project.outputDir, "artifacts"), "trace.zip").at(-1);
  let recordingPath: string | null = null;
  let tracePath: string | null = null;
  if (video) {
    recordingPath = join(artifactDir, "recording.webm");
    copyFileSync(video, recordingPath);
    artifacts.push({ kind: "recording", path: "recording.webm", mimeType: "video/webm", bytes: statSync(recordingPath).size });
  }
  if (trace) {
    tracePath = join(artifactDir, "trace.zip");
    copyFileSync(trace, tracePath);
    artifacts.push({ kind: "trace", path: "trace.zip", mimeType: "application/zip", bytes: statSync(tracePath).size });
  }
  for (const event of stepLog) {
    if (event.type === "screenshot" && existsSync(event.path)) {
      artifacts.push({ kind: "screenshot", path: `screenshots/${event.stepId}.png`, mimeType: "image/png", bytes: statSync(event.path).size });
    }
  }

  log(`e2e exited with ${exitCode}`);
  if (options.signal?.aborted) {
    // e2e traps SIGTERM and exits 130.
    return finish({ blocked: { reason: "CANCELLED", message: "Run cancelled." }, cancelled: true, e2eReport, aiTrace, stepLog, exitCode, artifacts, project, recordingPath, tracePath });
  }
  if (spawnError || timedOut) {
    const message = timedOut ? `e2e did not finish within ${timeoutMs} ms` : `could not start e2e: ${(spawnError as Error | null)?.message ?? "unknown error"}`;
    return finish({ blocked: { reason: "ENGINE_ERROR", message }, e2eReport, aiTrace, stepLog, exitCode, artifacts, project, recordingPath, tracePath });
  }
  return finish({ e2eReport, aiTrace, stepLog, exitCode, artifacts, project, recordingPath, tracePath });
}
