import { z } from "zod/v4";

import { isoTimestampSchema } from "./session";
import { transcriptStepTypeSchema } from "./test-case";

// Run results that cross runner ↔ backend ↔ web ↔ MCP (design.md §3, §5.3; ADR 0002 decisions 5, 6).

export const testRunStatusSchema = z.enum(["queued", "claimed", "running", "paused", "completed", "failed", "cancelled"]);
export const testRunOutcomeSchema = z.enum(["passed", "failed", "blocked"]);
export const testRunStepStatusSchema = z.enum(["passed", "failed", "blocked", "skipped"]);
export const testRunStepModeSchema = z.enum(["agent", "replayed", "handoff", "deterministic"]);
export const cacheModeSchema = z.enum(["read-write", "read-only", "off", "strict"]);
export const testRunTriggerSchema = z.enum(["manual", "cli", "mcp", "ci", "webhook"]);
export const testRunnerKindSchema = z.enum(["cloud", "self-hosted", "cli"]);

// Why a step did not replay from its cached script.
export const cacheReasonSchema = z.enum([
  "hit",
  "no-entry",
  "wrong-context",
  "target-not-found",
  "target-ambiguous",
  "end-mismatch",
  "action-failed",
  "cache-off",
  "not-cacheable"
]);

// Error codes a run or step can be blocked with. Setup, credential and runner problems are
// `blocked`, never `failed` (ADR 0002 decision 6).
export const blockedReasonSchema = z.enum([
  "MISSING_VARIABLE",
  "MISSING_CREDENTIAL",
  "MODEL_UNAVAILABLE",
  "MODEL_KEY_MISSING",
  "APP_UNREACHABLE",
  "AUTH_CREDENTIAL_UNAVAILABLE",
  "STEP_BUDGET_EXHAUSTED",
  "REPLAY_STALE",
  "NO_RUNNER",
  "RUNNER_LOST",
  "BUDGET_EXCEEDED",
  "MACRO_ERROR",
  "TRANSCRIPT_INVALID",
  "ENGINE_ERROR",
  "CANCELLED",
  "INCONCLUSIVE"
]);

export const modelUsageSchema = z.object({
  modelId: z.string().min(1).nullable(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  // Provider-reported cost when available (OpenRouter); otherwise computed from test_model_prices.
  costUsd: z.number().nonnegative().nullable()
});

export const emptyModelUsage = (modelId: string | null = null): ModelUsage => ({
  modelId,
  modelCalls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: null
});

export const runStepResultSchema = z.object({
  stepId: z.string().min(1),
  parentStepId: z.string().min(1).nullable(),
  ordinal: z.number().int().positive(),
  type: transcriptStepTypeSchema,
  label: z.string(),
  checkpointId: z.string().min(1).nullable(),
  status: testRunStepStatusSchema,
  mode: testRunStepModeSchema.nullable(),
  cacheReason: cacheReasonSchema.nullable(),
  startedAt: isoTimestampSchema.nullable(),
  finishedAt: isoTimestampSchema.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  videoOffsetMs: z.number().nonnegative().nullable(),
  // Agent summary for an Act, the observed state for a failed Assert.
  observed: z.string().nullable(),
  error: z.object({ code: z.string().min(1), message: z.string() }).nullable(),
  screenshot: z.string().min(1).nullable(),
  actions: z.number().int().nonnegative(),
  usage: modelUsageSchema,
  visionInput: z.boolean()
});

export const runArtifactSchema = z.object({
  kind: z.enum(["recording", "archive", "run-report", "screenshot", "trace", "agent-transcript", "junit"]),
  path: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().nonnegative().optional()
});

export const runnerInfoSchema = z.object({
  runner: z.string().min(1),
  runnerVersion: z.string().min(1),
  engine: z.string().min(1),
  engineVersion: z.string().min(1),
  browser: z.string().min(1).nullable(),
  browserVersion: z.string().min(1).nullable(),
  headless: z.boolean(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  cacheMode: cacheModeSchema,
  host: testRunnerKindSchema
});

export const runReportSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1).nullable(),
  testCase: z.object({
    id: z.string().min(1).nullable(),
    key: z.string().min(1).nullable(),
    title: z.string(),
    transcriptVersion: z.number().int().positive().nullable(),
    fingerprint: z.string().min(1)
  }),
  environment: z.object({ id: z.string().min(1).nullable(), name: z.string().min(1).nullable(), baseUrl: z.string().nullable() }),
  params: z.record(z.string(), z.string()),
  runner: runnerInfoSchema,
  model: z.object({ act: z.string().min(1).nullable(), judge: z.string().min(1).nullable(), provider: z.string().min(1).nullable() }),
  status: z.enum(["completed", "failed", "cancelled"]),
  outcome: testRunOutcomeSchema,
  blockedReason: blockedReasonSchema.nullable(),
  // Names only, never values (design.md §9.2).
  missing: z.array(z.string().min(1)),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  durationMs: z.number().nonnegative(),
  steps: z.array(runStepResultSchema),
  totals: z.object({
    stepsTotal: z.number().int().nonnegative(),
    stepsReplayed: z.number().int().nonnegative(),
    stepsAgent: z.number().int().nonnegative(),
    stepsHandoff: z.number().int().nonnegative(),
    usage: modelUsageSchema,
    judgeUsage: modelUsageSchema
  }),
  priceTableVersion: z.string().min(1).nullable(),
  flaky: z.boolean(),
  attempt: z.number().int().positive(),
  artifacts: z.array(runArtifactSchema),
  errors: z.array(z.object({ code: z.string().min(1), message: z.string() }))
});

export type TestRunStatus = z.infer<typeof testRunStatusSchema>;
export type TestRunOutcome = z.infer<typeof testRunOutcomeSchema>;
export type TestRunStepStatus = z.infer<typeof testRunStepStatusSchema>;
export type TestRunStepMode = z.infer<typeof testRunStepModeSchema>;
export type CacheMode = z.infer<typeof cacheModeSchema>;
export type CacheReason = z.infer<typeof cacheReasonSchema>;
export type BlockedReason = z.infer<typeof blockedReasonSchema>;
export type ModelUsage = z.infer<typeof modelUsageSchema>;
export type RunStepResult = z.infer<typeof runStepResultSchema>;
export type RunArtifact = z.infer<typeof runArtifactSchema>;
export type RunnerInfo = z.infer<typeof runnerInfoSchema>;
export type RunReport = z.infer<typeof runReportSchema>;

export function addModelUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    modelId: a.modelId ?? b.modelId,
    modelCalls: a.modelCalls + b.modelCalls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0)
  };
}
