import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname, homedir } from "node:os";
import { dirname, join } from "node:path";

import { zipSync } from "fflate";

import { macroDefinitionSchema, type ClaimedRun, type RunStepResult, type TestRunProgressRequest } from "@jittle-lamp/shared";

import type { OrgRunConfig } from "../config/resolve";
import { writeEvidenceBundle } from "../evidence/upload";
import { runnerVersion } from "../paths";
import { runTranscript, type RunTranscriptResult } from "../run";
import type { StepLogEvent } from "../runtime/step-log";
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
};

// The organisation's configuration comes from the backend; JL_* names and model keys in the
// daemon's own environment must not override it.
export function hostEnvForRuns(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith("JL_") && !/_API_KEY$|^ANTHROPIC_|^OPENAI_|^OPENROUTER_|^AI_GATEWAY_|^E2E_SECRET_|^E2E_USER_/.test(name))
  );
}

export function defaultStatePath(apiOrigin: string): string {
  const host = new URL(apiOrigin).host.replace(/[^A-Za-z0-9.-]/g, "_");
  return join(homedir(), ".config", "jittle-lamp", "runner", `${host}.json`);
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

export async function ensureRegistered(client: BackendClient, options: WorkerOptions): Promise<WorkerState> {
  const statePath = options.statePath ?? defaultStatePath(options.apiOrigin);
  const existing = readState(statePath);
  if (existing && existing.apiOrigin === options.apiOrigin && !options.registrationToken) return existing;
  if (!options.registrationToken) {
    throw new Error(`No worker registration in ${statePath}; start once with --token <registration token>.`);
  }
  const registered = await client.register(options.registrationToken, {
    hostname: osHostname(),
    version: runnerVersion,
    capabilities: { browsers: ["chromium"], headed: options.headed ?? false, liveView: true }
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
      agentInstructions: instructions.length > 0 ? instructions : null
    },
    credentials: config.credentials,
    model: config.model
  };
}

function stepUpdate(event: Extract<StepLogEvent, { type: "step-started" | "step-finished" }>): TestRunProgressRequest["steps"][number] {
  if (event.type === "step-started") return { stepId: event.stepId, status: "running", startedAt: event.at };
  return {
    stepId: event.stepId,
    status: event.status,
    finishedAt: event.at,
    error: event.error,
    observed: event.observed
  };
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
}): Promise<{ result: RunTranscriptResult | null; evidenceId: string | null }> {
  const { client, claimed, log } = input;
  const config = await client.config(claimed.runId, claimed.runToken);
  const controller = new AbortController();
  let pending: Promise<unknown> = Promise.resolve();
  let lastSentAt = 0;

  // Progress goes out in order; a cancel request from the backend aborts the run.
  const send = (body: TestRunProgressRequest) => {
    pending = pending
      .then(() => client.progress(claimed.runId, claimed.runToken, body))
      .then((response) => {
        if ((response as { cancelRequested?: boolean }).cancelRequested) controller.abort();
      })
      .catch((error: unknown) => log(`progress for ${claimed.runId} failed: ${error instanceof Error ? error.message : String(error)}`));
    lastSentAt = Date.now();
  };
  send({ status: "running", currentStepId: null, steps: [] });
  const keepAlive = setInterval(() => {
    if (Date.now() - lastSentAt > 8_000) send({ steps: [] });
  }, 2_000);

  // Live view relay: backend control and input → JL_LIVE_DIR → e2e worker; frames back.
  const liveDir = join(input.workDir, ".live", claimed.runId);
  mkdirSync(liveDir, { recursive: true });
  writeFileSync(join(liveDir, "control.json"), JSON.stringify({ live: false, takeover: false }));
  let liveSeq = -1;
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
      writeFileSync(join(liveDir, "control.json"), JSON.stringify({ live: control.live || control.takeover, takeover: control.takeover }));
      const fresh = control.inputs.filter((event) => event.seq > liveSeq).sort((a, b) => a.seq - b.seq);
      if (fresh.length > 0) {
        appendFileSync(join(liveDir, "inputs.jsonl"), fresh.map((event) => `${JSON.stringify(event)}\n`).join(""));
        liveSeq = fresh.at(-1)?.seq ?? liveSeq;
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

  let result: RunTranscriptResult | null = null;
  try {
    result = await runTranscript({
      transcript: claimed.transcript,
      cwd: input.workDir,
      env: input.hostEnv,
      org: toOrgConfig(config),
      params: claimed.params,
      macros: claimed.macros.map((macro) => macroDefinitionSchema.parse({ ...macro, status: "active" })),
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
  } finally {
    clearInterval(keepAlive);
    clearInterval(liveLoop);
    await pending;
  }

  let evidenceId: string | null = null;
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
      evidenceId = await client.uploadEvidence(claimed.runId, claimed.runToken, zipSync(files, { level: 6 }));
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
  await client.finalize(claimed.runId, claimed.runToken, { report, evidenceId });
  log(`[${claimed.runId}] ${report.outcome}${report.blockedReason ? ` (${report.blockedReason})` : ""}${evidenceId ? ` evidence ${evidenceId}` : ""}`);
  return { result, evidenceId };
}

export async function startWorker(options: WorkerOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.error(`[jl-e2e-runner] ${line}`));
  const client = new BackendClient({ origin: options.apiOrigin, ...(options.fetch ? { fetch: options.fetch } : {}), userAgent: `jl-e2e-runner/${runnerVersion}` });
  const state = await ensureRegistered(client, options);
  const concurrency = Math.max(1, options.concurrency ?? 1);
  const pollMs = options.pollMs ?? 3_000;
  const active = new Map<string, Promise<void>>();
  let stopping = false;
  log(`registered as worker ${state.workerId} in pool ${state.poolId}; concurrency ${concurrency}`);

  const heartbeat = setInterval(() => {
    void client.heartbeat(state.workerToken, [...active.keys()][0] ?? null, active.size).catch((error: unknown) => {
      log(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, state.heartbeatMs);
  await client.heartbeat(state.workerToken, null, 0).catch(() => undefined);

  const stop = () => {
    stopping = true;
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    while (!stopping) {
      if (active.size >= concurrency) {
        await Promise.race(active.values());
        continue;
      }
      let claimed: ClaimedRun | null = null;
      try {
        claimed = await client.claim(state.workerToken);
      } catch (error) {
        if (error instanceof BackendError && (error.status === 401 || error.status === 403)) throw error;
        log(`claim failed: ${error instanceof Error ? error.message : String(error)}`);
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
        hostEnv: hostEnvForRuns(options.hostEnv ?? process.env),
        log
      })
        .then(() => undefined)
        .catch((error: unknown) => log(`run ${run.runId} crashed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => active.delete(run.runId));
      active.set(run.runId, task);
      if (options.once) {
        await task;
        break;
      }
    }
    await Promise.all(active.values());
  } finally {
    clearInterval(heartbeat);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
