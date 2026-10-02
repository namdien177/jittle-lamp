import {
  addModelUsage,
  emptyModelUsage,
  runReportSchema,
  type BlockedReason,
  type CacheReason,
  type ModelUsage,
  type RunArtifact,
  type RunnerInfo,
  type RunReport,
  type RunStepResult,
  type TestRunStepMode
} from "@jittle-lamp/shared";

import type { PlannedStep, RunPlan } from "../plan";
import type { StepLogEvent } from "../runtime/step-log";

// Joins what e2e reports (report.json: per-step status, cache mode, token totals; ai-trace.json:
// per-call usage including reasoning tokens) with the runner's own step log (transcript step ids,
// wall-clock times) into one RunReport (design.md §5.3, handover 0.4).

export type E2eReportStep = {
  index: number;
  kind?: string;
  api?: string;
  label?: string;
  status?: string;
  durationMs?: number;
  metrics?: { modelCalls?: number; actionSteps?: number };
  model?: {
    provider?: string;
    model?: string;
    calls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCostUsd?: number;
  };
  cache?: { mode?: string; reason?: string; replayedActions?: number; totalActions?: number };
  error?: { code?: string; message?: string; explanation?: string };
};

export type E2eReport = {
  schemaVersion?: string;
  run?: {
    status?: string;
    exitCode?: number;
    targets?: Array<{ engine?: { name?: string; version?: string } }>;
    results?: Array<{ status?: string; attempts?: Array<{ status?: string; steps?: E2eReportStep[] }> }>;
  };
};

export type AiTrace = {
  runs?: Array<{ id: string; started_at?: string; e2e?: { api?: string; label?: string } }>;
  steps?: Array<{ run_id: string; model_id?: string; provider?: string; usage?: string | Record<string, unknown> | null }>;
};

const e2eApis = new Set(["app.open", "agent.act", "agent.assert", "agent.waitFor", "agent.extract"]);
const callingTypes = new Set(["open", "act", "assert", "wait", "extract", "login", "macro"]);
const agentSideReasons = new Set(["no-entry", "retry", "invalid-entry"]);

function parseUsage(raw: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw;
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// Usage per agent step from ai-trace.json, keyed by "<api>\u0000<label>" with one entry per occurrence.
export function usageFromAiTrace(trace: AiTrace | null): Map<string, ModelUsage[]> {
  const out = new Map<string, ModelUsage[]>();
  if (!trace?.runs) return out;
  const runs = [...trace.runs].sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
  for (const run of runs) {
    let usage = emptyModelUsage();
    for (const step of trace.steps ?? []) {
      if (step.run_id !== run.id) continue;
      const parsed = parseUsage(step.usage);
      const input = parsed.inputTokenDetails as Record<string, unknown> | undefined;
      const output = parsed.outputTokenDetails as Record<string, unknown> | undefined;
      const cacheRead = num(input?.cacheReadTokens);
      usage = addModelUsage(usage, {
        modelId: step.model_id ? `${step.provider ? `${step.provider}:` : ""}${step.model_id}` : null,
        modelCalls: 1,
        inputTokens: Math.max(0, num(parsed.inputTokens) - cacheRead),
        cachedInputTokens: cacheRead,
        outputTokens: Math.max(0, num(parsed.outputTokens) - num(output?.reasoningTokens)),
        reasoningTokens: num(output?.reasoningTokens),
        costUsd: null
      });
    }
    const key = `${run.e2e?.api ?? ""}\u0000${run.e2e?.label ?? ""}`;
    out.set(key, [...(out.get(key) ?? []), usage]);
  }
  return out;
}

function usageFromReportStep(step: E2eReportStep | undefined): ModelUsage {
  const model = step?.model;
  if (!model || !model.calls) return emptyModelUsage();
  const cacheRead = num(model.cacheReadTokens);
  return {
    modelId: model.model ? `${model.provider ? `${model.provider}:` : ""}${model.model}` : null,
    modelCalls: num(model.calls),
    inputTokens: Math.max(0, num(model.inputTokens) - cacheRead),
    cachedInputTokens: cacheRead,
    outputTokens: num(model.outputTokens),
    reasoningTokens: 0,
    costUsd: typeof model.estimatedCostUsd === "number" ? model.estimatedCostUsd : null
  };
}

export function modeOf(step: PlannedStep, e2eStep: E2eReportStep | undefined): { mode: TestRunStepMode | null; cacheReason: CacheReason | null } {
  if (step.type === "open" || step.type === "screenshot" || step.type === "note") return { mode: "deterministic", cacheReason: "not-cacheable" };
  if (step.type !== "act") return { mode: "agent", cacheReason: "not-cacheable" };
  const cache = e2eStep?.cache;
  if (!cache?.mode) return { mode: "agent", cacheReason: "no-entry" };
  if (cache.mode === "self-finalized") return { mode: "replayed", cacheReason: "hit" };
  const reason = (cache.reason ?? "no-entry") as string;
  const known: CacheReason[] = ["no-entry", "wrong-context", "target-not-found", "target-ambiguous", "end-mismatch", "action-failed"];
  const cacheReason = (known as string[]).includes(reason) ? (reason as CacheReason) : reason === "retry" || reason === "invalid-entry" ? "no-entry" : "action-failed";
  if (cache.mode === "agent-concluded") return { mode: "handoff", cacheReason };
  return { mode: agentSideReasons.has(reason) ? "agent" : "handoff", cacheReason };
}

export type BuildReportInput = {
  plan: RunPlan;
  runId: string | null;
  testCaseId: string | null;
  transcriptVersion: number | null;
  environmentId: string | null;
  runner: RunnerInfo;
  model: { act: string | null; judge: string | null; provider: string | null };
  e2eReport: E2eReport | null;
  aiTrace: AiTrace | null;
  stepLog: StepLogEvent[];
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
  artifacts: RunArtifact[];
  blocked?: { reason: BlockedReason; message: string } | null;
  attempt?: number;
};

export function buildRunReport(input: BuildReportInput): RunReport {
  const { plan } = input;
  const attemptStarted = input.stepLog.find((event) => event.type === "attempt-started");
  const videoStartMs = attemptStarted ? Date.parse(attemptStarted.videoStartedAt) : null;

  const started = new Map<string, Extract<StepLogEvent, { type: "step-started" }>>();
  const finished = new Map<string, Extract<StepLogEvent, { type: "step-finished" }>>();
  const screenshots = new Map<string, string>();
  for (const event of input.stepLog) {
    if (event.type === "step-started") started.set(event.stepId, event);
    if (event.type === "step-finished") finished.set(event.stepId, event);
    if (event.type === "screenshot") screenshots.set(event.stepId, event.path);
  }

  const e2eSteps = (input.e2eReport?.run?.results?.[0]?.attempts?.at(-1)?.steps ?? []).filter((step) => e2eApis.has(step.api ?? ""));
  const traceUsage = usageFromAiTrace(input.aiTrace);
  const traceSeen = new Map<string, number>();

  // e2e reports one step per open/act/assert/waitFor/extract call, in the order the test made them.
  let e2eCursor = 0;
  const steps: RunStepResult[] = plan.steps.map((step) => {
    const begin = started.get(step.stepId);
    const end = finished.get(step.stepId);
    const executesCall = step.executes && callingTypes.has(step.type) && step.type !== "login" && step.type !== "macro";
    const e2eStep = executesCall && begin ? e2eSteps[e2eCursor++] : undefined;

    let usage = emptyModelUsage();
    if (e2eStep && (e2eStep.metrics?.modelCalls ?? e2eStep.model?.calls ?? 0) > 0) {
      const key = `${e2eStep.api ?? ""}\u0000${e2eStep.label ?? ""}`;
      const occurrence = traceSeen.get(key) ?? 0;
      traceSeen.set(key, occurrence + 1);
      const fromTrace = traceUsage.get(key)?.[occurrence];
      const fromReport = usageFromReportStep(e2eStep);
      usage = fromTrace && fromTrace.modelCalls > 0 ? { ...fromTrace, costUsd: fromReport.costUsd } : fromReport;
    }

    const { mode, cacheReason } = begin ? modeOf(step, e2eStep) : { mode: null, cacheReason: null };
    const startedAt = begin?.at ?? null;
    const finishedAt = end?.at ?? null;
    const status: RunStepResult["status"] = !begin ? "skipped" : !end ? "failed" : end.status;
    return {
      stepId: step.stepId,
      parentStepId: step.parentStepId,
      ordinal: step.ordinal,
      type: step.type,
      label: step.instruction || step.type,
      checkpointId: step.checkpointId,
      status,
      mode,
      cacheReason,
      startedAt,
      finishedAt,
      durationMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
      videoOffsetMs: startedAt && videoStartMs !== null ? Math.max(0, Date.parse(startedAt) - videoStartMs) : null,
      observed: end?.observed ?? (e2eStep?.error?.explanation ?? null),
      error: end?.error ?? (e2eStep?.error?.code ? { code: e2eStep.error.code, message: e2eStep.error.message ?? "" } : null),
      screenshot: screenshots.get(step.stepId) ?? null,
      actions: e2eStep?.metrics?.actionSteps ?? e2eStep?.cache?.totalActions ?? 0,
      usage: usage.modelId === null && usage.modelCalls === 0 ? emptyModelUsage() : usage,
      visionInput: false
    };
  });

  // Macro calls report the mode of their expanded steps: replayed only if every child act replayed.
  for (const group of steps) {
    if (group.type !== "login" && group.type !== "macro") continue;
    const children = steps.filter((step) => step.parentStepId === group.stepId && step.status !== "skipped");
    const acts = children.filter((step) => step.type === "act");
    group.cacheReason = null;
    group.mode =
      children.length === 0
        ? null
        : acts.some((step) => step.mode === "handoff")
          ? "handoff"
          : acts.some((step) => step.mode === "agent")
            ? "agent"
            : acts.length > 0
              ? "replayed"
              : "deterministic";
  }

  const leaf = steps.filter((step) => step.type !== "login" && step.type !== "macro");
  const acts = leaf.filter((step) => step.type === "act" && step.status !== "skipped");
  const actUsage = leaf.filter((step) => step.type === "act").reduce((sum, step) => addModelUsage(sum, step.usage), emptyModelUsage(input.model.act));
  const judgeUsage = leaf
    .filter((step) => step.type === "assert" || step.type === "wait" || step.type === "extract")
    .reduce((sum, step) => addModelUsage(sum, step.usage), emptyModelUsage(input.model.judge));

  const failedStep = leaf.find((step) => step.status === "failed");
  const blockedStep = leaf.find((step) => step.status === "blocked");
  let blockedReason: BlockedReason | null = input.blocked?.reason ?? null;
  const errors: RunReport["errors"] = input.blocked ? [{ code: input.blocked.reason, message: input.blocked.message }] : [];
  if (!input.blocked && input.exitCode !== null && input.exitCode >= 2 && !failedStep) {
    blockedReason = blockedStep?.error?.code === "MODEL_UNAVAILABLE" ? "MODEL_UNAVAILABLE" : "ENGINE_ERROR";
    errors.push({ code: blockedReason, message: `e2e exited with code ${input.exitCode}` });
  }
  if (!input.blocked && !input.e2eReport && input.exitCode !== null) {
    blockedReason = "ENGINE_ERROR";
    errors.push({ code: "ENGINE_ERROR", message: "e2e wrote no report.json" });
  }
  if (blockedStep && !blockedReason) {
    const code = blockedStep.error?.code ?? "INCONCLUSIVE";
    blockedReason = (["APP_UNREACHABLE", "AUTH_CREDENTIAL_UNAVAILABLE", "STEP_BUDGET_EXHAUSTED", "MODEL_UNAVAILABLE", "REPLAY_STALE"] as const).find(
      (reason) => reason === code
    ) ?? "INCONCLUSIVE";
  }
  for (const step of leaf) if (step.error) errors.push({ code: step.error.code, message: step.error.message });

  const outcome: RunReport["outcome"] = blockedReason ? "blocked" : failedStep ? "failed" : "passed";

  return runReportSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    testCase: {
      id: input.testCaseId,
      key: plan.testCase.metadata.key,
      title: plan.title,
      transcriptVersion: input.transcriptVersion,
      fingerprint: plan.fingerprint
    },
    environment: { id: input.environmentId, name: plan.environmentName, baseUrl: plan.baseUrl },
    params: plan.params,
    runner: input.runner,
    model: input.model,
    status: blockedReason && !input.e2eReport ? "failed" : "completed",
    outcome,
    blockedReason,
    missing: plan.missing,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    steps,
    totals: {
      stepsTotal: leaf.length,
      stepsReplayed: acts.filter((step) => step.mode === "replayed").length,
      stepsAgent: acts.filter((step) => step.mode === "agent").length,
      stepsHandoff: acts.filter((step) => step.mode === "handoff").length,
      usage: actUsage,
      judgeUsage
    },
    priceTableVersion: [...steps].some((step) => step.usage.costUsd !== null) ? "e2e-estimate" : null,
    flaky: false,
    attempt: input.attempt ?? 1,
    artifacts: input.artifacts,
    errors
  });
}
