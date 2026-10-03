import type { RunStepListStep } from "@jittle-lamp/ui";
import { parseTranscriptDocument, type TestRunDetail, type TestRunMetrics, type TestRunStep, type TestRunSummary } from "@jittle-lamp/shared";

// Pure helpers for the run detail page and the Test sessions table (design.md §7 "Run detail",
// §10.4 "What the UI shows").

export const activeRunStatuses = ["queued", "claimed", "running", "paused"] as const;

export function isRunActive(status: TestRunSummary["status"]): boolean {
  return (activeRunStatuses as readonly string[]).includes(status);
}

// GET /test-runs/:id every 2 s while the run is queued or executing; stop once it finished.
// Failed polls back off (4 s, 8 s, 16 s, capped at 30 s) and the next success resets the pace.
export const runPollIntervalMs = 2_000;
export const runPollMaxIntervalMs = 30_000;
export function runPollInterval(run: Pick<TestRunSummary, "status"> | undefined, consecutiveFailures = 0): number | false {
  if (consecutiveFailures > 0) {
    if (run && !isRunActive(run.status)) return false;
    return Math.min(runPollMaxIntervalMs, runPollIntervalMs * 2 ** consecutiveFailures);
  }
  if (!run) return false;
  return isRunActive(run.status) ? runPollIntervalMs : false;
}

const blockedExplanations: Record<NonNullable<TestRunSummary["blockedReason"]>, string> = {
  MISSING_VARIABLE: "A variable the case uses has no value in this environment or run params. Add it to the environment or declare a default.",
  MISSING_CREDENTIAL: "A credential profile the case logs in with does not exist for this environment. Create it in Settings → Credentials.",
  MODEL_UNAVAILABLE: "The model provider did not answer. The app was not judged; run again later.",
  MODEL_KEY_MISSING: "No model key is configured for the organisation. Add one in Settings → AI model.",
  APP_UNREACHABLE: "The runner could not reach the environment's base URL. Check VPN, DNS or the runner pool of this environment.",
  AUTH_CREDENTIAL_UNAVAILABLE: "The runner could not read the credential secrets for this run.",
  STEP_BUDGET_EXHAUSTED: "The agent ran out of actions for one step before it finished. Split the step or make it more specific.",
  REPLAY_STALE: "Strict cache mode: a cached script no longer matched the screen and the agent was not allowed to take over.",
  NO_RUNNER: "No runner in the environment's pool is online to take the run.",
  RUNNER_LOST: "The runner stopped heartbeating three times; the run was given up.",
  BUDGET_EXCEEDED: "The organisation's daily model budget is used up. An admin can raise it in Settings → Test runs.",
  MACRO_ERROR: "A macro the case calls is missing or got the wrong arguments.",
  TRANSCRIPT_INVALID: "The transcript has lint errors that stop a run. Fix them in the Steps tab.",
  ENGINE_ERROR: "The execution engine failed before the app could be judged. The runner log has details.",
  CANCELLED: "The run was cancelled before it finished.",
  INCONCLUSIVE: "The judge could not decide from the screen whether the assert holds."
};

export function explainBlockedReason(reason: TestRunSummary["blockedReason"]): string | null {
  return reason === null ? null : blockedExplanations[reason];
}

// While a run executes, progress rows of expanded macro steps (`<parent>.<n>`) can arrive before
// finalisation fills in their parent, ordinal and label. Re-attach them to their parent so the list
// does not show them as unnamed top-level steps.
// Rows the backend created from a progress update before finalisation can also lack ordinal, type
// and label; the run's transcript (same step ids) fills them in.
export function normalizeRunSteps(steps: readonly TestRunStep[], transcript?: string): TestRunStep[] {
  const planned = new Map<string, { ordinal: number; type: TestRunStep["type"]; label: string; checkpointId: string | null }>();
  if (transcript && steps.some((step) => step.label.length === 0)) {
    for (const step of parseTranscriptDocument(transcript).cases[0]?.steps ?? []) {
      const label = step.text.length > 0 ? step.text : step.args.map((arg) => arg.value).join(", ");
      planned.set(step.stepId, { ordinal: step.ordinal, type: step.type, label, checkpointId: step.checkpointId });
    }
  }
  const filled = steps.map((step) => {
    const plan = step.label.length === 0 ? planned.get(step.stepId) : undefined;
    return plan ? { ...step, ...plan } : step;
  });
  const byId = new Map(filled.map((step) => [step.stepId, step]));
  const fixed = filled.map((step) => {
    if (step.parentStepId !== null) return step;
    const match = /^(.+)\.(\d+)$/.exec(step.stepId);
    const parent = match?.[1] ? byId.get(match[1]) : undefined;
    if (!parent) return step;
    return { ...step, parentStepId: parent.stepId, ordinal: parent.ordinal, checkpointId: step.checkpointId ?? parent.checkpointId, label: step.label || `${parent.label} · step ${match?.[2] ?? ""}` };
  });
  // Stable order: by top-level ordinal, children right after their parent in step id order.
  const rank = (step: TestRunStep) => [step.ordinal, step.parentStepId === null ? -1 : Number(/\.(\d+)$/.exec(step.stepId)?.[1] ?? 0)] as const;
  return fixed.sort((a, b) => {
    const [ao, ac] = rank(a);
    const [bo, bc] = rank(b);
    return ao - bo || ac - bc;
  });
}

export function toRunStepListSteps(steps: readonly TestRunStep[], transcript?: string): RunStepListStep[] {
  return normalizeRunSteps(steps, transcript)
    .map((step) => ({
      stepId: step.stepId,
      parentStepId: step.parentStepId,
      ordinal: step.ordinal,
      type: step.type,
      label: step.label,
      status: step.status,
      mode: step.mode,
      cacheReason: step.cacheReason,
      durationMs: step.durationMs,
      videoOffsetMs: step.videoOffsetMs,
      observed: step.observed,
      error: step.error,
      screenshotUrl: step.screenshotUrl,
      usage: { modelCalls: step.usage.modelCalls, costUsd: step.usage.costUsd }
    }));
}

// The backend reports queuePosition 0-based (0 = next to start); people read "#1 of 3".
export function formatQueuePosition(run: { queuePosition: number | null; queueDepth?: number | null | undefined }): string | null {
  if (run.queuePosition === null) return null;
  const depth = run.queueDepth ? Math.max(run.queueDepth, run.queuePosition + 1) : null;
  return `#${run.queuePosition + 1}${depth ? ` of ${depth}` : ""}`;
}

export function formatQueuePill(
  run: Pick<TestRunSummary, "status" | "queuePosition" | "estimatedStartAt"> & { queueDepth?: number | null | undefined },
  now = Date.now()
): string | null {
  if (run.status !== "queued") return null;
  const place = formatQueuePosition(run);
  const position = place === null ? "queued" : `queued · ${place}`;
  if (run.estimatedStartAt === null) return position;
  const seconds = Math.max(0, Math.round((run.estimatedStartAt - now) / 1000));
  if (seconds <= 5) return `${position} · starts soon`;
  const eta = seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
  return `${position} · starts in ~${eta}`;
}

export function cacheHitRatio(metrics: Pick<TestRunMetrics, "stepsTotal" | "stepsReplayed">): number | null {
  if (metrics.stepsTotal === 0) return null;
  return metrics.stepsReplayed / metrics.stepsTotal;
}

// Mock model ids carry a fixture path; show the file name only.
export function formatModelId(modelId: string | null): string {
  if (modelId === null) return "—";
  if (modelId.startsWith("mock:")) return `mock:${modelId.slice(5).split(/[\\/]/).pop() ?? ""}`;
  return modelId;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// Cancel is for the person who requested the run; subscribers who attached to it only follow it.
export function canCancelRun(run: Pick<TestRunSummary, "status" | "createdBy">, currentUserId: string | null, canCancelAny = false): boolean {
  if (!isRunActive(run.status)) return false;
  return canCancelAny || (currentUserId !== null && run.createdBy === currentUserId);
}

export type FailedAssert = { stepId: string; expected: string; observed: string | null; screenshotUrl: string | null; error: string | null };

// Failed asserts show what the transcript expected next to what the judge saw.
export function failedAsserts(steps: readonly TestRunStep[]): FailedAssert[] {
  return steps
    .filter((step) => step.status === "failed" && (step.type === "assert" || step.type === "wait"))
    .map((step) => ({
      stepId: step.stepId,
      expected: step.label,
      observed: step.observed,
      screenshotUrl: step.screenshotUrl,
      error: step.error ? `${step.error.code}: ${step.error.message}` : null
    }));
}

// Latest screenshot while the run executes: the running step's, else the last finished one's.
export function liveScreenshot(run: Pick<TestRunDetail, "steps" | "currentStepId"> & { transcript?: string }): { stepId: string; url: string; label: string } | null {
  const ordered = normalizeRunSteps(run.steps, run.transcript);
  const current = ordered.find((step) => step.stepId === run.currentStepId && step.screenshotUrl);
  if (current?.screenshotUrl) return { stepId: current.stepId, url: current.screenshotUrl, label: current.label };
  const finished = ordered.filter((step) => step.screenshotUrl !== null && step.status !== "pending");
  const last = finished[finished.length - 1];
  return last?.screenshotUrl ? { stepId: last.stepId, url: last.screenshotUrl, label: last.label } : null;
}

export function runProgress(steps: readonly TestRunStep[], transcript?: string): { done: number; total: number } {
  const top = normalizeRunSteps(steps, transcript).filter((step) => step.parentStepId === null);
  return { done: top.filter((step) => step.status !== "pending" && step.status !== "running").length, total: top.length };
}

export type RunTone = "success" | "danger" | "warning" | "muted" | "brand";

export function runTone(run: Pick<TestRunSummary, "status" | "outcome">): RunTone {
  if (run.outcome === "passed") return "success";
  if (run.outcome === "failed") return "danger";
  if (run.outcome === "blocked") return "warning";
  if (run.status === "running" || run.status === "claimed") return "brand";
  return "muted";
}

export function runLabel(run: Pick<TestRunSummary, "status" | "outcome">): string {
  return run.outcome ?? run.status;
}
