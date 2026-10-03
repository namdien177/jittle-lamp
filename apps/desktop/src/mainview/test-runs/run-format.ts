import { formatCostUsd, formatStepDuration } from "@jittle-lamp/ui";
import type { TestRunMetrics } from "@jittle-lamp/shared";

export { formatCostUsd, formatStepDuration };

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function summarizeMetrics(metrics: TestRunMetrics): Array<{ label: string; value: string }> {
  const tokens = metrics.inputTokens + metrics.outputTokens + metrics.reasoningTokens;
  return [
    { label: "Duration", value: metrics.durationMs === null ? "—" : formatStepDuration(metrics.durationMs) },
    { label: "Model", value: metrics.modelId ?? "—" },
    { label: "Model calls", value: String(metrics.modelCalls) },
    { label: "Tokens", value: `${formatTokens(tokens)}${metrics.cachedInputTokens > 0 ? ` (${formatTokens(metrics.cachedInputTokens)} cached)` : ""}` },
    { label: "Cost", value: metrics.costUsd === null ? "—" : formatCostUsd(metrics.costUsd) },
    {
      label: "Steps",
      value: `${metrics.stepsReplayed} replayed · ${metrics.stepsAgent} agent${metrics.stepsHandoff > 0 ? ` · ${metrics.stepsHandoff} hand-off` : ""}`
    }
  ];
}

const blockedReasonText: Record<string, string> = {
  MISSING_VARIABLE: "A variable the case needs is not configured for this environment.",
  MISSING_CREDENTIAL: "A credential profile the case needs is missing.",
  MODEL_UNAVAILABLE: "The model provider was unavailable.",
  MODEL_KEY_MISSING: "The organisation has no model key configured.",
  APP_UNREACHABLE: "The runner could not reach the application under test.",
  AUTH_CREDENTIAL_UNAVAILABLE: "The login credential could not be used.",
  STEP_BUDGET_EXHAUSTED: "A step ran out of its action budget.",
  REPLAY_STALE: "A cached step no longer matches the page and strict cache mode is on.",
  NO_RUNNER: "No runner in this environment's pool is online.",
  RUNNER_LOST: "The runner stopped responding three times.",
  BUDGET_EXCEEDED: "The organisation's daily model budget is used up.",
  MACRO_ERROR: "A macro could not be expanded.",
  TRANSCRIPT_INVALID: "The transcript has errors.",
  ENGINE_ERROR: "The test engine failed.",
  CANCELLED: "The run was cancelled.",
  INCONCLUSIVE: "The judge could not decide whether a check passed."
};

export function describeBlockedReason(reason: string): string {
  return blockedReasonText[reason] ?? reason;
}
