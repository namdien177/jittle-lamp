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

// Global default prices (USD per million tokens), seeded into test_model_prices with org_id null.
// Source: Anthropic first-party API rates, Claude API reference cached 2026-09-25. Haiku 4.5's
// cache-read rate is not listed there; 0.1× input is the documented cache-read multiplier.
// claude-code/ aliases are priced at the API rate of the model they run, as an API-equivalent
// estimate: that path is a subscription and is billed per seat, not per token.
export const modelPriceSchema = z.object({
  modelId: z.string().min(1),
  inputUsdPerMtok: z.number().nonnegative(),
  cachedInputUsdPerMtok: z.number().nonnegative(),
  outputUsdPerMtok: z.number().nonnegative()
});
export type ModelPrice = z.infer<typeof modelPriceSchema>;

export const defaultPriceTableVersion = "seed-2026-10-03";

const anthropicPrices: Array<[string, number, number, number]> = [
  ["claude-opus-5-5", 4, 0.2, 20],
  ["claude-sonnet-5-5", 2, 0.2, 10],
  ["claude-haiku-4-5", 1, 0.1, 5]
];

export const defaultModelPrices: ModelPrice[] = anthropicPrices.flatMap(([model, input, cached, output]) => {
  const alias = model.includes("opus") ? "opus" : model.includes("sonnet") ? "sonnet" : "haiku";
  return [`anthropic/${model}`, `gateway/anthropic/${model}`, `claude-code/${alias}`, `claude-code/${model}`].map((modelId) => ({
    modelId,
    inputUsdPerMtok: input,
    cachedInputUsdPerMtok: cached,
    outputUsdPerMtok: output
  }));
}).concat([{
  // AI Gateway model catalog, checked 2026-10-03 (USD per million tokens).
  modelId: "zai/glm-5.3-flash",
  inputUsdPerMtok: 0.15,
  cachedInputUsdPerMtok: 0.03,
  outputUsdPerMtok: 0.50
}, {
  // Base tier up to 32k context tokens; Gateway-reported cost wins over this estimate.
  modelId: "alibaba/qwen3.7-flash",
  inputUsdPerMtok: 0.03,
  cachedInputUsdPerMtok: 0.006,
  outputUsdPerMtok: 0.13
}]);

// Ids a price row may be stored under for one model id, most specific first:
//   - the id itself, and the slash form of "claude-code:sonnet";
//   - for a router id (`openrouter/<vendor>/<model>`, `gateway/<vendor>/<model>`), the vendor's
//     own id `<vendor>/<model>`, so `openrouter/anthropic/claude-sonnet-5-5` is priced like
//     `anthropic/claude-sonnet-5-5` unless the organisation priced the router id itself;
//   - each of those with dotted versions dashed (OpenRouter lists `claude-sonnet-5.5`).
const routerPrefixes = ["openrouter/", "gateway/"];

export function modelPriceCandidates(modelId: string): string[] {
  const ids: string[] = [];
  const add = (id: string) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  const base = [modelId, modelId.replace(/^([a-z-]+):/, "$1/")];
  for (const id of base) add(id);
  for (const id of base) {
    const router = routerPrefixes.find((prefix) => id.startsWith(prefix));
    const vendorId = router ? id.slice(router.length) : null;
    if (vendorId && vendorId.includes("/")) add(vendorId);
  }
  for (const id of [...ids]) add(id.replace(/(\d)\.(\d)/g, "$1-$2"));
  return ids;
}

// The price row a model id is charged at and the id it was found under, or null (cost unknown).
export function resolveModelPrice(prices: readonly ModelPrice[], modelId: string | null): { price: ModelPrice; matchedModelId: string } | null {
  if (!modelId) return null;
  for (const candidate of modelPriceCandidates(modelId)) {
    const price = prices.find((entry) => entry.modelId === candidate);
    if (price) return { price, matchedModelId: candidate };
  }
  return null;
}

export function findModelPrice(prices: readonly ModelPrice[], modelId: string | null): ModelPrice | null {
  return resolveModelPrice(prices, modelId)?.price ?? null;
}

// Reasoning tokens bill as output tokens.
export function computeCostUsd(usage: Pick<ModelUsage, "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens">, price: ModelPrice): number {
  const cost =
    (usage.inputTokens * price.inputUsdPerMtok +
      usage.cachedInputTokens * price.cachedInputUsdPerMtok +
      (usage.outputTokens + usage.reasoningTokens) * price.outputUsdPerMtok) /
    1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// Fills in cost where the provider reported none; returns the table version used, if any.
export function priceRunReport(report: RunReport, prices: readonly ModelPrice[], version: string, fallbackModelId: { act: string | null; judge: string | null }): RunReport {
  let priced = false;
  const price = (usage: ModelUsage, fallback: string | null): ModelUsage => {
    if (usage.costUsd !== null || usage.modelCalls === 0) return usage;
    const found = findModelPrice(prices, usage.modelId) ?? findModelPrice(prices, fallback);
    if (!found) return usage;
    priced = true;
    return { ...usage, costUsd: computeCostUsd(usage, found) };
  };
  const steps = report.steps.map((step) => ({
    ...step,
    usage: price(step.usage, step.type === "act" ? fallbackModelId.act : fallbackModelId.judge)
  }));
  const sum = (types: readonly string[], modelId: string | null) =>
    steps.filter((step) => types.includes(step.type)).reduce((total, step) => addModelUsage(total, step.usage), emptyModelUsage(modelId));
  return {
    ...report,
    steps,
    totals: {
      ...report.totals,
      usage: sum(["act"], report.totals.usage.modelId),
      judgeUsage: sum(["assert", "wait", "extract"], report.totals.judgeUsage.modelId)
    },
    priceTableVersion: priced ? version : report.priceTableVersion
  };
}
