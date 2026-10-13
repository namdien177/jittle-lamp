import {
  addModelUsage,
  cacheReasonSchema,
  emptyModelUsage,
  runReportSchema,
  type BlockedReason,
  type CacheReason,
  type ExecutionMode,
  type ModelUsage,
  type RunArtifact,
  type RunnerInfo,
  type RunReport,
  type RunStepResult,
  type TestRunStepMode
} from "@jittle-lamp/shared";

import type { PlannedStep, RunPlan } from "../plan";
import type { QueryStepLogEvent, StepLogEvent } from "../runtime/step-log";

// Joins what e2e reports (report.json: per-step status, cache mode, token totals; ai-trace.json:
// per-call usage including reasoning tokens) with the runner's own step log (transcript step ids,
// wall-clock times) into one RunReport (design.md §5.3, handover 0.4).

export type E2eReportStep = {
  index: number;
  startedAt?: string;
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
  // report-1 since e2e 0.19: `entry` is the cache key, `detail` says where a replay stopped,
  // `write` what became of the recording when the attempt settled.
  cache?: {
    mode?: string;
    reason?: string;
    detail?: string;
    entry?: string;
    derived?: string;
    notRecorded?: string;
    write?: Record<string, unknown>;
    replayedActions?: number;
    totalActions?: number;
  };
  screen?: Record<string, unknown>;
  error?: { code?: string; message?: string; explanation?: string };
};

export type E2eReportArtifact = { id?: string; kind?: string; mediaType?: string; path?: string; startedAt?: string };
export type E2eAppLogLine = { source?: string; level?: string; text?: string; at?: string; step?: number };

export type E2eReport = {
  schemaVersion?: string;
  run?: {
    status?: string;
    exitCode?: number;
    targets?: Array<{ engine?: { name?: string; version?: string } }>;
    results?: Array<{
      status?: string;
      attempts?: Array<{ status?: string; steps?: E2eReportStep[]; artifacts?: E2eReportArtifact[]; appLog?: E2eAppLogLine[] }>;
    }>;
  };
};

export type AiTrace = {
  runs?: Array<{ id: string; started_at?: string; e2e?: { api?: string; label?: string } }>;
  steps?: Array<{ run_id: string; model_id?: string; provider?: string; usage?: string | Record<string, unknown> | null }>;
};

const e2eApis = new Set(["app.open", "agent.act", "agent.assert", "agent.waitFor", "agent.extract"]);
const callingTypes = new Set(["open", "act", "assert", "wait", "extract", "login", "macro", "use"]);
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

// e2e 0.20 reason tokens (cache.mdx), kept as they are; `retry` never happens with retries: 0 and
// means the same as no entry; anything newer than this list is reported as a failed action.
const knownReasons = new Set<string>(cacheReasonSchema.options);

type CheckOutcome = NonNullable<Extract<StepLogEvent, { type: "step-finished" }>["check"]>;

// An Assert with a deterministic check (roadmap 2026-10-13 §4.1): replayed from the check with
// no model call, or judged again because the check went stale, or judged and then recorded.
export function assertModeOf(check: CheckOutcome): { mode: TestRunStepMode; cacheReason: CacheReason; cacheDetail: string } {
  switch (check.status) {
    case "hit":
      return { mode: "deterministic", cacheReason: "hit", cacheDetail: `check ${check.locator}` };
    case "stale":
      return { mode: "agent", cacheReason: "action-failed", cacheDetail: `check ${check.locator} no longer holds${check.reason ? `: ${check.reason}` : ""}` };
    case "recorded":
      return { mode: "agent", cacheReason: "no-entry", cacheDetail: `check recorded: ${check.locator}` };
  }
}

export function modeOf(step: PlannedStep, e2eStep: E2eReportStep | undefined, check?: CheckOutcome | undefined, query?: QueryStepLogEvent | null): { mode: TestRunStepMode | null; cacheReason: CacheReason | null } {
  if (step.type === "open" || step.type === "screenshot" || step.type === "note") return { mode: "deterministic", cacheReason: "not-cacheable" };
  if (step.type === "assert" && check) return assertModeOf(check);
  // [Query] steps (roadmap §5.2): a cached or saved statement is a hit, agent-written SQL is not.
  if (step.type === "query") return { mode: "query", cacheReason: !query ? null : query.tier === "agent" ? "no-entry" : "hit" };
  if (step.type !== "act") return { mode: "agent", cacheReason: "not-cacheable" };
  const cache = e2eStep?.cache;
  if (!cache?.mode) return { mode: "agent", cacheReason: "no-entry" };
  if (cache.mode === "self-finalized") return { mode: "replayed", cacheReason: "hit" };
  const reason = (cache.reason ?? "no-entry") as string;
  const cacheReason: CacheReason = knownReasons.has(reason) ? (reason as CacheReason) : reason === "retry" ? "no-entry" : "action-failed";
  if (cache.mode === "agent-concluded") return { mode: "handoff", cacheReason };
  return { mode: agentSideReasons.has(reason) ? "agent" : "handoff", cacheReason };
}

const blockedReasonByCode: Record<string, BlockedReason> = {
  ASSERTION_INCONCLUSIVE: "INCONCLUSIVE",
  MODEL_PROVIDER_FAILED: "MODEL_UNAVAILABLE",
  MODEL_OUTPUT_INVALID: "MODEL_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  APP_UNREACHABLE: "APP_UNREACHABLE",
  APP_NOT_OPEN: "APP_UNREACHABLE",
  SEED_DATA_MISSING: "INCONCLUSIVE",
  TEST_SETUP_FAILED: "ENGINE_ERROR",
  POLICY_DENIED: "ENGINE_ERROR",
  AUTOMATION_UNSUPPORTED: "ENGINE_ERROR",
  ENVIRONMENT_UNAVAILABLE: "APP_UNREACHABLE",
  AUTH_CREDENTIAL_UNAVAILABLE: "AUTH_CREDENTIAL_UNAVAILABLE",
  AUTH_CREDENTIAL_INVALID: "AUTH_CREDENTIAL_UNAVAILABLE",
  SECRET_UNAVAILABLE: "MISSING_CREDENTIAL",
  MISSING_CREDENTIAL: "MISSING_CREDENTIAL",
  MISSING_VARIABLE: "MISSING_VARIABLE",
  STEP_BUDGET_EXHAUSTED: "STEP_BUDGET_EXHAUSTED",
  REPLAY_STALE: "REPLAY_STALE",
  // [Query] steps (roadmap §5.3)
  DATABASE_UNREACHABLE: "DATABASE_UNREACHABLE",
  QUERY_REJECTED: "QUERY_REJECTED"
};

// The statement a [Query] step ran and what came back, for the step list and the run page.
export function queryCacheDetail(query: QueryStepLogEvent): string {
  const rows = query.rowCount === 1 ? "1 row" : `${query.rowCount} rows`;
  return `${query.statement}\n-- ${rows} · ${query.tier} · ${query.profile} · ${Math.round(query.durationMs)}ms`;
}

export function blockedReasonFor(code: string | null): BlockedReason {
  return (code && blockedReasonByCode[code]) || "INCONCLUSIVE";
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
  cancelled?: boolean;
  attempt?: number;
  executionMode?: ExecutionMode;
  // [Use] blocks a reused run stood in for (api/reuse.ts): their steps are skipped, not missing.
  reused?: { stepIds: ReadonlySet<string>; blocks: ReadonlyArray<{ stepId: string; runId: string }>; runIds: readonly string[] };
};

export function buildRunReport(input: BuildReportInput): RunReport {
  const { plan } = input;
  const attemptStarted = input.stepLog.find((event) => event.type === "attempt-started");
  const videoStartMs = attemptStarted ? Date.parse(attemptStarted.videoStartedAt) : null;

  const started = new Map<string, Extract<StepLogEvent, { type: "step-started" }>>();
  const finished = new Map<string, Extract<StepLogEvent, { type: "step-finished" }>>();
  const screenshots = new Map<string, string>();
  const outputsByStep = new Map<string, Record<string, string>>();
  const runOutputs: Record<string, string> = {};
  const apiReplays = new Map<string, Extract<StepLogEvent, { type: "api-replay" }>>();
  const queries = new Map<string, QueryStepLogEvent>();
  for (const event of input.stepLog) {
    if (event.type === "step-started") started.set(event.stepId, event);
    if (event.type === "step-finished") finished.set(event.stepId, event);
    if (event.type === "screenshot") screenshots.set(event.stepId, event.path);
    if (event.type === "output") {
      outputsByStep.set(event.stepId, { ...(outputsByStep.get(event.stepId) ?? {}), [event.name]: event.value });
      runOutputs[event.name] = event.value;
    }
    if (event.type === "api-replay") apiReplays.set(event.stepId, event);
    // The last query event of a step wins: a cached replay that handed off is followed by the
    // agent's statement.
    if (event.type === "query") queries.set(event.stepId, event);
  }
  const reusedBlockOf = (stepId: string) => input.reused?.blocks.find((block) => stepId === block.stepId || stepId.startsWith(`${block.stepId}.`)) ?? null;

  const e2eSteps = (input.e2eReport?.run?.results?.[0]?.attempts?.at(-1)?.steps ?? []).filter((step) => e2eApis.has(step.api ?? ""));
  const traceUsage = usageFromAiTrace(input.aiTrace);
  const traceSeen = new Map<string, number>();

  // e2e reports one step per open/act/assert/waitFor/extract call. Each belongs to the transcript
  // step whose window contains its start; a re-judged assert yields two e2e steps for one of ours.
  const windows = plan.steps.flatMap((step) => {
    const begin = started.get(step.stepId);
    if (!begin || !step.executes) return [];
    const end = finished.get(step.stepId);
    return [{ stepId: step.stepId, start: Date.parse(begin.at), end: end ? Date.parse(end.at) : Number.POSITIVE_INFINITY }];
  });
  const e2eByStep = new Map<string, E2eReportStep[]>();
  e2eSteps.forEach((e2eStep, position) => {
    const at = e2eStep.startedAt ? Date.parse(e2eStep.startedAt) : Number.NaN;
    // Fallback without timestamps: the n-th e2e call belongs to the n-th executing step.
    const owner = Number.isNaN(at)
      ? windows.filter((window) => callingTypes.has(plan.steps.find((step) => step.stepId === window.stepId)?.type ?? ""))[position]
      : windows.filter((window) => at >= window.start - 5 && at <= window.end).at(-1);
    if (owner) e2eByStep.set(owner.stepId, [...(e2eByStep.get(owner.stepId) ?? []), e2eStep]);
  });

  const steps: RunStepResult[] = plan.steps.map((step) => {
    const begin = started.get(step.stepId);
    const end = finished.get(step.stepId);
    const ownSteps = e2eByStep.get(step.stepId) ?? [];
    const e2eStep = ownSteps.at(-1);

    let usage = emptyModelUsage();
    for (const own of ownSteps) {
      if ((own.metrics?.modelCalls ?? own.model?.calls ?? 0) === 0) continue;
      const key = `${own.api ?? ""}\u0000${own.label ?? ""}`;
      const occurrence = traceSeen.get(key) ?? 0;
      traceSeen.set(key, occurrence + 1);
      const fromTrace = traceUsage.get(key)?.[occurrence];
      const fromReport = usageFromReportStep(own);
      usage = addModelUsage(usage, fromTrace && fromTrace.modelCalls > 0 ? { ...fromTrace, costUsd: fromReport.costUsd } : fromReport);
    }

    const query = queries.get(step.stepId) ?? null;
    const ui = begin ? modeOf(step, e2eStep, end?.check, query) : { mode: null, cacheReason: null };
    // An API step (roadmap §2.4): replayed from its script, or handed to the UI call after a
    // failed check; the hand-off keeps the UI mode's cache reason.
    const api = apiReplays.get(step.stepId);
    const { mode, cacheReason } = api ? { mode: api.outcome === "replayed" ? ("api-replayed" as const) : ("api-handoff" as const), cacheReason: api.outcome === "replayed" ? ("hit" as const) : ui.cacheReason } : ui;
    const reused = reusedBlockOf(step.stepId);
    // Tokens the agent tier spent writing SQL; e2e's trace never sees that call.
    if (query && query.usage.modelCalls > 0) {
      usage = addModelUsage(usage, { modelId: query.usage.modelId, modelCalls: query.usage.modelCalls, inputTokens: query.usage.inputTokens, cachedInputTokens: 0, outputTokens: query.usage.outputTokens, reasoningTokens: 0, costUsd: null });
    }
    const startedAt = begin?.at ?? null;
    const finishedAt = end?.at ?? null;
    const status: RunStepResult["status"] = !begin ? "skipped" : !end ? "failed" : end.status;
    const outputs = outputsByStep.get(step.stepId);
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
      cacheDetail: reused
        ? `reused from run ${reused.runId}`
        : api?.outcome === "handoff"
          ? `API replay stopped at request ${api.seq}: ${api.reason}`
          : begin
            ? query
              ? queryCacheDetail(query)
              : end?.check
                ? assertModeOf(end.check).cacheDetail
                : (e2eStep?.cache?.detail ?? null)
            : null,
      startedAt,
      finishedAt,
      durationMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
      videoOffsetMs: startedAt && videoStartMs !== null ? Math.max(0, Date.parse(startedAt) - videoStartMs) : null,
      observed: end?.observed ?? (e2eStep?.error?.explanation ?? null),
      error: end?.error ?? (e2eStep?.error?.code ? { code: e2eStep.error.code, message: e2eStep.error.message ?? "" } : null),
      screenshot: screenshots.get(step.stepId) ?? null,
      actions: e2eStep?.metrics?.actionSteps ?? e2eStep?.cache?.totalActions ?? 0,
      usage: usage.modelId === null && usage.modelCalls === 0 ? emptyModelUsage() : usage,
      visionInput: false,
      ...(outputs ? { outputs } : {}),
      ...(api ? { requests: { count: api.count, mutations: api.mutations, items: api.items } } : {})
    };
  });

  // Macro calls report the mode of their expanded steps: replayed only if every child act replayed.
  for (const group of steps) {
    if (group.type !== "login" && group.type !== "macro") continue;
    const children = steps.filter((step) => step.parentStepId === group.stepId && step.status !== "skipped");
    const acts = children.filter((step) => step.type === "act");
    group.cacheReason = null;
    group.cacheDetail = null;
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
  // A blocked step names the reason; only without one does a non-zero e2e exit become ENGINE_ERROR.
  if (!input.blocked && blockedStep) blockedReason = blockedReasonFor(blockedStep.error?.code ?? null);
  if (!input.blocked && !blockedStep && !failedStep && input.exitCode !== null && input.exitCode >= 2) {
    blockedReason = "ENGINE_ERROR";
    errors.push({ code: blockedReason, message: `e2e exited with code ${input.exitCode}` });
  }
  // A run where steps that should have executed never did cannot pass; steps a reused run stood
  // in for were never meant to.
  const unfinished = leaf.some((step) => step.status === "skipped" && !reusedBlockOf(step.stepId)) && !failedStep && !blockedStep;
  if (!input.blocked && !blockedReason && unfinished && input.e2eReport !== null) {
    blockedReason = "ENGINE_ERROR";
    errors.push({ code: blockedReason, message: "Some steps never ran." });
  }
  if (!input.blocked && !input.e2eReport && input.exitCode !== null) {
    blockedReason = "ENGINE_ERROR";
    errors.push({ code: "ENGINE_ERROR", message: "e2e wrote no report.json" });
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
    status: input.cancelled ? "cancelled" : blockedReason && !input.e2eReport ? "failed" : "completed",
    outcome,
    blockedReason,
    missing: plan.missing,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    steps,
    totals: {
      stepsTotal: leaf.length,
      stepsReplayed: acts.filter((step) => step.mode === "replayed" || step.mode === "api-replayed").length,
      stepsAgent: acts.filter((step) => step.mode === "agent").length,
      stepsHandoff: acts.filter((step) => step.mode === "handoff" || step.mode === "api-handoff").length,
      usage: actUsage,
      judgeUsage
    },
    priceTableVersion: [...steps].some((step) => step.usage.costUsd !== null) ? "e2e-estimate" : null,
    flaky: false,
    attempt: input.attempt ?? 1,
    artifacts: input.artifacts,
    errors,
    ...(input.executionMode ? { executionMode: input.executionMode } : {}),
    ...(Object.keys(runOutputs).length > 0 ? { outputs: runOutputs } : {}),
    ...(input.reused && input.reused.runIds.length > 0 ? { reusedFromRunIds: [...input.reused.runIds] } : {})
  });
}
