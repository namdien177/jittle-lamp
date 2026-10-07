import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { dirname, join } from "node:path";

import { zipSync } from "fflate";

import {
  macroDefinitionSchema,
  modelProviderEnvNames,
  type ClaimedExploration,
  type ClaimedRun,
  type ExplorationResultRequest,
  type FinalizeTestRunRequest,
  type RunReport,
  type RunStepResult,
  type TestRunProgressRequest,
  transcriptStepTypeSchema
} from "@jittle-lamp/shared";

import { resolveRunConfig, type OrgRunConfig } from "../config/resolve";
import { writeEvidenceBundle } from "../evidence/upload";
import { engineVersion, runnerVersion } from "../paths";
import { buildRunPlan } from "../plan";
import { buildRunReport } from "../report/build";
import { runTranscript, type RunTranscriptResult } from "../run";
import { FRAMES_HIDDEN_MARKER } from "../runtime/live";
import type { StepLogEvent } from "../runtime/step-log";
import { runExploration } from "../explore";
import { BackendClient, BackendError } from "./api";

// jl-e2e-runner: registers with a pool, heartbeats, claims runs, executes them with the
// organisation's configuration and uploads evidence (design.md §5.4, §9.3, handover 1b.1).

export type WorkerState = { apiOrigin: string; workerId: string; poolId: string; workerToken: string; heartbeatMs: number; leaseMs: number };

export type WorkerOptions = {
  apiOrigin: string;
  registrationToken?: string;
  statePath?: string;
  workDir: string;
  concurrency?: number;
  pollMs?: number;
  headed?: boolean;
  allowClaudeCode?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  // Host environment for the browser child (proxies, display); JL_* and keys come from the backend.
  hostEnv?: Readonly<Record<string, string | undefined>>;
  once?: boolean;
  // Keep run directories (video, trace) after finalisation, for debugging.
  keepRunDirs?: boolean;
  managedUpdates?: boolean;
};

// The organisation's configuration comes from the backend; JL_* names and model keys in the
// daemon's own environment must not override it.
// With --allow-claude-code (development only) the claude CLI's own login variables pass through.
const providerEnvNames = new Set(modelProviderEnvNames);
const claudeCodeLogin = new Set(["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]);
export function hostEnvForRuns(env: Readonly<Record<string, string | undefined>>, options: { allowClaudeCode?: boolean } = {}): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        (options.allowClaudeCode && claudeCodeLogin.has(name)) ||
        (!name.startsWith("JL_") &&
          !providerEnvNames.has(name) &&
          !/_API_KEY$|^ANTHROPIC_|^OPENAI_|^OPENROUTER_|^AI_GATEWAY_|^XAI_|^GOOGLE_GENERATIVE_AI_|^E2E_SECRET_|^E2E_USER_/.test(name))
    )
  );
}

// One credential per API and host name, so replicas sharing a state volume stay distinct workers.
export function defaultStatePath(apiOrigin: string): string {
  const api = new URL(apiOrigin).host.replace(/[^A-Za-z0-9.-]/g, "_");
  const host = osHostname().replace(/[^A-Za-z0-9.-]/g, "_");
  return join(homedir(), ".config", "jittle-lamp", "runner", `${api}-${host}.json`);
}

function readState(path: string): WorkerState | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as WorkerState;
  } catch {
    return null;
  }
}

function writeState(path: string, state: WorkerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// A stored credential always wins; the registration token is only used when this host has none
// (a pool registration token registers any number of workers, so keeping it set is harmless).
export async function ensureRegistered(client: BackendClient, options: WorkerOptions): Promise<WorkerState> {
  const statePath = options.statePath ?? defaultStatePath(options.apiOrigin);
  const existing = readState(statePath);
  if (existing && existing.apiOrigin === options.apiOrigin) return existing;
  if (!options.registrationToken) {
    throw new Error(`No worker registration in ${statePath}; start once with --token <registration token>.`);
  }
  const registered = await client.register(options.registrationToken, {
    hostname: osHostname(),
    version: runnerVersion,
    capabilities: { browsers: ["chromium"], headed: options.headed ?? false, liveView: true, managedUpdates: options.managedUpdates ?? process.env.JL_RUNNER_MANAGED_UPDATES === "1" }
  });
  const state: WorkerState = { apiOrigin: options.apiOrigin, ...registered };
  writeState(statePath, state);
  return state;
}

function toOrgConfig(config: Awaited<ReturnType<BackendClient["config"]>>): OrgRunConfig {
  const notes = config.agentNotes?.trim();
  const instructions = [notes, config.environment.agentInstructions?.trim()].filter((part): part is string => Boolean(part)).join("\n\n");
  return {
    environment: {
      name: config.environment.name,
      baseUrl: config.environment.baseUrl,
      variables: config.environment.variables,
      agentInstructions: instructions.length > 0 ? instructions : null,
      dataLocale: config.environment.dataLocale
    },
    credentials: config.credentials,
    model: config.model
  };
}

function stepUpdate(event: Extract<StepLogEvent, { type: "step-started" | "step-finished" }>): TestRunProgressRequest["steps"][number] {
  if (event.type === "step-started") {
    // Name the step on its first update: the backend creates the row from this patch.
    const type = transcriptStepTypeSchema.safeParse(event.kind);
    return {
      stepId: event.stepId,
      parentStepId: event.parentStepId,
      ordinal: event.ordinal,
      ...(type.success ? { type: type.data } : {}),
      label: event.label,
      status: "running",
      startedAt: event.at
    };
  }
  return {
    stepId: event.stepId,
    status: event.status,
    finishedAt: event.at,
    error: event.error,
    observed: event.observed
  };
}

const lostLease = (error: unknown) =>
  error instanceof BackendError && (error.status === 401 || error.status === 403 || error.status === 409 || error.status === 410);

async function withRetry<T>(label: string, action: () => Promise<T>, log: (line: string) => void, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      // Network failures and server errors are retried; a rejected or malformed request is not.
      const network = error instanceof Error && (error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError");
      const retryable = error instanceof BackendError ? error.status >= 500 || error.status === 429 : network;
      if (!retryable || attempt >= attempts) throw error;
      const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      log(`${label} failed (${error instanceof Error ? error.message : String(error)}); retrying in ${delay} ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

// A run that cannot start (config fetch failed, runner crashed before e2e) is reported as blocked
// rather than left to expire into RUNNER_LOST.
function blockedReport(claimed: ClaimedRun, message: string): RunReport {
  const plan = buildRunPlan({
    transcript: claimed.transcript,
    config: resolveRunConfig({ env: {} }),
    macros: claimed.macros.map((macro) => macroDefinitionSchema.parse({ ...macro, status: "active" })),
    cases: claimed.cases,
    previousSteps: claimed.steps
  });
  const now = new Date().toISOString();
  return buildRunReport({
    plan,
    runId: claimed.runId,
    testCaseId: claimed.testCaseId,
    transcriptVersion: claimed.transcriptVersion,
    environmentId: claimed.environmentId,
    runner: {
      runner: "jl-e2e-runner",
      runnerVersion,
      engine: "e2e",
      engineVersion,
      browser: "chromium",
      browserVersion: null,
      headless: true,
      viewport: { width: 1440, height: 900 },
      cacheMode: claimed.cacheMode,
      host: "self-hosted"
    },
    model: { act: null, judge: null, provider: null },
    e2eReport: null,
    aiTrace: null,
    stepLog: [],
    exitCode: null,
    startedAt: now,
    finishedAt: now,
    artifacts: [],
    blocked: { reason: "ENGINE_ERROR", message }
  });
}

// Executes one claimed run end to end. Exported for tests.
export async function executeClaimedRun(input: {
  client: BackendClient;
  claimed: ClaimedRun;
  apiOrigin: string;
  workDir: string;
  headed?: boolean;
  allowClaudeCode?: boolean;
  hostEnv: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  keepRunDirs?: boolean;
  managedUpdates?: boolean;
}): Promise<{ result: RunTranscriptResult | null; evidenceId: string | null }> {
  const { client, claimed, log } = input;
  const controller = new AbortController();
  let pending: Promise<unknown> = Promise.resolve();
  let lastSentAt = 0;
  let leaseLost = false;

  // Progress goes out in order; a cancel request or a lost lease aborts the run.
  const send = (body: TestRunProgressRequest) => {
    pending = pending
      .then(() => client.progress(claimed.runId, claimed.runToken, body))
      .then((response) => {
        if ((response as { cancelRequested?: boolean }).cancelRequested) controller.abort();
      })
      .catch((error: unknown) => {
        if (lostLease(error)) {
          leaseLost = true;
          controller.abort();
        }
        log(`progress for ${claimed.runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    lastSentAt = Date.now();
  };
  send({ status: "running", currentStepId: null, steps: [] });
  // Keeps the lease alive through the run, the evidence upload and finalisation.
  const keepAlive = setInterval(() => {
    if (Date.now() - lastSentAt > 8_000) send({ steps: [] });
  }, 2_000);

  // Every attempt starts clean: a retried run (same id) must not see the last attempt's files.
  const liveDir = join(input.workDir, ".live", claimed.runId);
  const runDir = join(input.workDir, ".e2e", "runs", claimed.runId);
  rmSync(liveDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, "control.json"), JSON.stringify({ live: false, takeover: false }));

  // Live view relay: backend control and input → JL_LIVE_DIR → e2e worker; frames back.
    let liveSeq = -1;
  // Take-over epoch: bumped when a take-over starts; input lines carry it (runtime/live.ts).
  let takeoverEpoch = 0;
  let inTakeover = false;
  let framesHiddenSent = false;
  let liveEnabled = true;
  let lastFrameMtime = 0;
  let liveBusy = false;
  const liveLoop = setInterval(() => {
    if (!liveEnabled || liveBusy) return;
    liveBusy = true;
    void (async () => {
      const control = await client.liveControl(claimed.runId, claimed.runToken, liveSeq);
      if (!control) {
        liveEnabled = false;
        return;
      }
      if (control.cancelRequested) controller.abort();
      // Input first, then the state: input sent together with "stop" must not wait for the next take-over.
            if (control.takeover && !inTakeover) takeoverEpoch += 1;
      inTakeover = control.takeover;
      const fresh = control.inputs.filter((event) => event.seq > liveSeq).sort((a, b) => a.seq - b.seq);
      if (fresh.length > 0) {
        // Input that arrives with the release belongs to the take-over that just ended.
        appendFileSync(join(liveDir, "inputs.jsonl"), fresh.map((event) => `${JSON.stringify({ ...event, takeover: takeoverEpoch })}\n`).join(""));
        liveSeq = fresh.at(-1)?.seq ?? liveSeq;
      }
      writeFileSync(join(liveDir, "control.json"), JSON.stringify({ live: control.live || control.takeover, takeover: control.takeover, epoch: takeoverEpoch }));
      if (existsSync(join(liveDir, FRAMES_HIDDEN_MARKER))) {
        if (!framesHiddenSent) {
          framesHiddenSent = true;
          await client.liveFramesHidden(claimed.runId, claimed.runToken);
        }
        return;
      }
      const framePath = join(liveDir, "frame.jpg");
      if ((control.live || control.takeover) && existsSync(framePath)) {
        const mtime = statSync(framePath).mtimeMs;
        if (mtime !== lastFrameMtime) {
          lastFrameMtime = mtime;
          await client.liveFrame(claimed.runId, claimed.runToken, new Uint8Array(readFileSync(framePath)));
        }
      }
    })()
      .catch((error: unknown) => log(`live relay for ${claimed.runId}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        liveBusy = false;
      });
  }, Number(process.env.JL_LIVE_POLL_MS ?? 1_000));

  const cleanup = () => {
    clearInterval(keepAlive);
    clearInterval(liveLoop);
    // inputs.jsonl may hold what a person typed during a take-over: never keep it.
    rmSync(liveDir, { recursive: true, force: true });
    if (!input.keepRunDirs) rmSync(runDir, { recursive: true, force: true });
  };

  let result: RunTranscriptResult | null = null;
  let evidenceId: string | null = null;
  try {
    let config: Awaited<ReturnType<BackendClient["config"]>>;
    try {
      config = await withRetry("config", () => client.config(claimed.runId, claimed.runToken), log);
    } catch (error) {
      const report = blockedReport(claimed, `Could not fetch the run configuration: ${error instanceof Error ? error.message : String(error)}`);
      clearInterval(liveLoop);
      await pending;
      if (!leaseLost) await withRetry("finalize", () => finalizeOnce(client, claimed, { report, evidenceId: null }), log);
      return { result: null, evidenceId: null };
    }

    result = await runTranscript({
      transcript: claimed.transcript,
      cwd: input.workDir,
      env: input.hostEnv,
      org: toOrgConfig(config),
      params: claimed.params,
      macros: claimed.macros.map((macro) => macroDefinitionSchema.parse({ ...macro, status: "active" })),
      cases: claimed.cases,
      previousSteps: claimed.steps,
      cacheMode: claimed.cacheMode,
      runId: claimed.runId,
      testCaseId: claimed.testCaseId,
      transcriptVersion: claimed.transcriptVersion,
      environmentId: claimed.environmentId,
      host: "self-hosted",
      headed: input.headed ?? false,
      allowClaudeCode: input.allowClaudeCode ?? false,
      prices: config.prices,
      ...(config.priceTableVersion ? { priceTableVersion: config.priceTableVersion } : {}),
      backend: { apiUrl: input.apiOrigin, runId: claimed.runId, runToken: claimed.runToken },
      progressScreenshots: true,
      liveDir,
      signal: controller.signal,
      log: (line) => log(`[${claimed.runId}] ${line}`),
      onStepEvent: (event) => {
        if (event.type === "takeover") {
          send({ status: event.action === "start" ? "paused" : "running", steps: [] });
          return;
        }
        if (event.type !== "step-started" && event.type !== "step-finished") return;
        const screenshot =
          event.type === "step-finished" && event.screenshot && existsSync(event.screenshot)
            ? { stepId: event.stepId, mimeType: "image/jpeg" as const, base64: readFileSync(event.screenshot).toString("base64") }
            : undefined;
        send({
          currentStepId: event.type === "step-started" ? event.stepId : null,
          steps: [stepUpdate(event)],
          ...(screenshot && screenshot.base64.length <= 400_000 ? { screenshot } : {})
        });
      }
    });
    clearInterval(liveLoop);

    if (leaseLost) {
      log(`[${claimed.runId}] lease lost; the backend re-queues the run, nothing is finalised from here`);
      return { result, evidenceId: null };
    }

    if (result.recordingPath) {
      try {
        const bundle = writeEvidenceBundle(result);
        const files: Record<string, Uint8Array> = {
          "session.archive.json": new Uint8Array(readFileSync(bundle.archivePath)),
          "recording.webm": new Uint8Array(readFileSync(bundle.recordingPath)),
          "run-report.json": new Uint8Array(readFileSync(bundle.reportPath))
        };
        for (const step of bundle.report.steps) {
          if (step.screenshot && existsSync(step.screenshot)) files[`screenshots/${step.stepId}.png`] = new Uint8Array(readFileSync(step.screenshot));
        }
        const zip = zipSync(files, { level: 6 });
        evidenceId = await withRetry("evidence upload", () => client.uploadEvidence(claimed.runId, claimed.runToken, zip), log, 4);
        result = { ...result, report: bundle.report };
      } catch (error) {
        log(`[${claimed.runId}] evidence upload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = {
      ...result.report,
      // Screenshot paths are local to this host; the evidence carries the files.
      steps: result.report.steps.map((step: RunStepResult) => ({ ...step, screenshot: step.screenshot ? `screenshots/${step.stepId}.png` : null }))
    };
    await withRetry("finalize", () => finalizeOnce(client, claimed, { report, evidenceId }), log);
    log(`[${claimed.runId}] ${report.outcome}${report.blockedReason ? ` (${report.blockedReason})` : ""}${evidenceId ? ` evidence ${evidenceId}` : ""}`);
    return { result, evidenceId };
  } catch (error) {
    // The runner itself failed: report the run blocked instead of leaving it to expire.
    if (!leaseLost && !(error instanceof BackendError)) {
      await withRetry("finalize", () => finalizeOnce(client, claimed, { report: blockedReport(claimed, error instanceof Error ? error.message : String(error)), evidenceId }), log).catch(
        () => undefined
      );
    }
    throw error;
  } finally {
    await pending;
    cleanup();
  }
}

// Explores one import item and posts the record; the backend writes the transcript.
// Exported for tests.
export async function executeClaimedExploration(input: {
  client: BackendClient;
  workerToken: string;
  claimed: ClaimedExploration;
  workDir: string;
  headed: boolean;
  hostEnv: Record<string, string | undefined>;
  log: (line: string) => void;
}): Promise<ExplorationResultRequest> {
  const { client, claimed, log } = input;
  let result: ExplorationResultRequest;
  try {
    const config = await withRetry("exploration config", () => client.explorationConfig(input.workerToken, claimed.explorationId), log);
    result = await runExploration({
      explorationId: claimed.explorationId,
      goal: claimed.goal,
      maxSteps: claimed.maxSteps,
      timeoutMs: claimed.timeoutMs,
      org: {
        environment: config.environment,
        credentials: config.credentials,
        model: config.model
      },
      missingProfiles: config.missingProfiles,
      cwd: input.workDir,
      env: input.hostEnv,
      headed: input.headed,
      log: (line) => log(`[${claimed.explorationId}] ${line}`)
    });
  } catch (error) {
    if (error instanceof BackendError && error.status === 409) throw error;
    result = { status: "failed", explore: null, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    await withRetry("exploration result", () => client.explorationResult(input.workerToken, claimed.explorationId, result), log);
  } catch (error) {
    // 409: the lease moved on (expired and re-queued); the other attempt reports.
    if (!(error instanceof BackendError && error.status === 409)) throw error;
  }
  log(`[${claimed.explorationId}] exploration ${result.status}${result.explore ? ` (${result.explore.steps.length} steps, ${result.explore.ended})` : result.error ? `: ${result.error}` : ""}`);
  return result;
}

// A second finalize after a lost response is answered 409 by the backend: already done.
async function finalizeOnce(client: BackendClient, claimed: ClaimedRun, body: FinalizeTestRunRequest): Promise<void> {
  try {
    await client.finalize(claimed.runId, claimed.runToken, body);
  } catch (error) {
    if (error instanceof BackendError && error.status === 409) return;
    throw error;
  }
}

export async function startWorker(options: WorkerOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.error(`[jl-e2e-runner] ${line}`));
  const client = new BackendClient({ origin: options.apiOrigin, ...(options.fetch ? { fetch: options.fetch } : {}), userAgent: `jl-e2e-runner/${runnerVersion}` });
  const state = await ensureRegistered(client, options);
  const requested = Number(options.concurrency ?? 1);
  const concurrency = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.floor(requested))) : 1;
  const pollMs = options.pollMs ?? 3_000;
  const active = new Map<string, Promise<void>>();
  // Heartbeats name a run the worker holds; explorations are not runs.
  const activeRuns = new Set<string>();
  let stopping = false;
  let fatal: unknown = null;
  log(`registered as worker ${state.workerId} in pool ${state.poolId}; concurrency ${concurrency}`);

  const managedUpdates = options.managedUpdates ?? process.env.JL_RUNNER_MANAGED_UPDATES === "1";
  let drainingVersion: string | null = null;
  let drainingUpdateId: number | null = null;
  let claimInFlight = false;
  let lastServerVersion: string | undefined;
  let heartbeatBusy = false;
  const sendHeartbeat = async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    try {
      const response = await client.heartbeat(state.workerToken, [...activeRuns][0] ?? null, active.size + (claimInFlight ? 1 : 0), { version: runnerVersion, managedUpdates, drainingVersion, drainingUpdateId });
      if (response.serverVersion !== lastServerVersion) {
        lastServerVersion = response.serverVersion;
        if (lastServerVersion && lastServerVersion !== runnerVersion) log(`version skew: runner ${runnerVersion}, server ${lastServerVersion}; update in Settings → Runner pools`);
      }
      const target = managedUpdates && response.targetVersion && response.targetVersion !== runnerVersion ? response.targetVersion : null;
      if (target !== drainingVersion) log(target ? `draining for update to ${target}` : "runner update drain cleared");
      drainingVersion = target;
      drainingUpdateId = target ? response.updateId ?? null : null;
    } catch (error) {
      log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { heartbeatBusy = false; }
  };
  const heartbeat = setInterval(() => void sendHeartbeat(), state.heartbeatMs);
  await sendHeartbeat();

  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    while (!stopping) {
      if (drainingVersion) {
        if (options.once && active.size === 0) break;
        await new Promise(resolve => setTimeout(resolve, pollMs));
        continue;
      }
      if (active.size >= concurrency) {
        await Promise.race(active.values());
        continue;
      }
      let claimed: ClaimedRun | null = null;
      let exploration: ClaimedExploration | null = null;
      try {
        claimInFlight = true;
        const work = await client.claimWork(state.workerToken);
        claimed = work.run;
        exploration = work.exploration;
      } catch (error) {
        if (error instanceof BackendError && (error.status === 401 || error.status === 403)) {
          // The worker was removed from its pool: stop claiming, let running cases finish.
          log(`worker credential rejected (${error.status}); stopping after ${active.size} active run(s)`);
          stopping = true;
          fatal = error;
          continue;
        }
        log(`claim failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      finally { claimInFlight = false; }
      if (!claimed && exploration) {
        const item = exploration;
        log(`claimed exploration ${item.explorationId}`);
        const workDir = join(options.workDir, "explorations");
        mkdirSync(workDir, { recursive: true });
        const task = executeClaimedExploration({
          client,
          workerToken: state.workerToken,
          claimed: item,
          workDir,
          headed: options.headed ?? false,
          hostEnv: hostEnvForRuns(options.hostEnv ?? process.env),
          log
        })
          .then(() => undefined)
          .catch((error: unknown) => log(`exploration ${item.explorationId} crashed: ${error instanceof Error ? error.message : String(error)}`))
          .finally(() => active.delete(item.explorationId));
        active.set(item.explorationId, task);
        if (options.once) {
          await task;
          break;
        }
        continue;
      }
      if (!claimed) {
        if (options.once && active.size === 0) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const run = claimed;
      log(`claimed ${run.runId} (${run.testCaseKey}, attempt ${run.attempt})`);
      const workDir = join(options.workDir, "runs");
      mkdirSync(workDir, { recursive: true });
      const task = executeClaimedRun({
        client,
        claimed: run,
        apiOrigin: options.apiOrigin,
        workDir,
        headed: options.headed ?? false,
        allowClaudeCode: options.allowClaudeCode ?? false,
        hostEnv: hostEnvForRuns(options.hostEnv ?? process.env, { allowClaudeCode: options.allowClaudeCode ?? false }),
        log,
        keepRunDirs: options.keepRunDirs ?? process.env.JL_RUNNER_KEEP_RUNS === "1"
      })
        .then(() => undefined)
        .catch((error: unknown) => log(`run ${run.runId} crashed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          active.delete(run.runId);
          activeRuns.delete(run.runId);
        });
      active.set(run.runId, task);
      activeRuns.add(run.runId);
      if (options.once) {
        await task;
        break;
      }
    }
    await Promise.all(active.values());
    if (fatal) throw fatal;
  } finally {
    clearInterval(heartbeat);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
