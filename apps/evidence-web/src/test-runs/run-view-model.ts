import type { TestRunDetail, TestRunStep } from "@jittle-lamp/shared";
import { formatStepDuration } from "@jittle-lamp/ui";

import { formatQueuePill } from "../test-cases/run-model";

// Pure helpers of the run view (roadmap 2026-10-13 §3.5): which step the strip shows, what its
// meta line says, and the per-device memory of the Details drawer. Free of React for the tests.

const typeLabel: Record<string, string> = {
  act: "Act",
  assert: "Assert",
  wait: "Wait",
  open: "Open",
  login: "Login",
  extract: "Extract",
  query: "Query"
};

const modeLabel: Record<NonNullable<TestRunStep["mode"]>, string> = {
  agent: "agent",
  replayed: "replayed",
  handoff: "hand-off",
  deterministic: "direct",
  "api-replayed": "API replayed",
  "api-handoff": "API hand-off",
  query: "query"
};

// The step in focus: the selection, else the step under the playhead, else the one running, else
// the first failure, else the first step. Only top-level steps are candidates.
export function shownStepId(input: {
  steps: readonly Pick<TestRunStep, "stepId" | "parentStepId" | "status">[];
  activeStepId: string | null;
  playingStepId: string | null;
  currentStepId: string | null;
}): string | null {
  const top = input.steps.filter((step) => step.parentStepId === null);
  const has = (id: string | null) => id !== null && top.some((step) => step.stepId === id);
  if (has(input.activeStepId)) return input.activeStepId;
  if (has(input.playingStepId)) return input.playingStepId;
  if (has(input.currentStepId)) return input.currentStepId;
  // A macro's child may be the one running; its parent is the top-level step to show.
  const runningChild = input.steps.find((step) => step.stepId === input.currentStepId && step.parentStepId !== null);
  if (runningChild && has(runningChild.parentStepId)) return runningChild.parentStepId;
  return top.find((step) => step.status === "failed")?.stepId ?? top[0]?.stepId ?? null;
}

// "Step 7 of 12 · Act · replayed · 1.2 s", plus the error code when the step failed.
export function stepStripMeta(step: Pick<TestRunStep, "ordinal" | "type" | "mode" | "durationMs" | "status" | "error">, total: number): string {
  const parts = [`Step ${step.ordinal} of ${total}`, typeLabel[step.type] ?? step.type];
  if (step.mode) parts.push(modeLabel[step.mode]);
  const duration = formatStepDuration(step.durationMs);
  if (duration) parts.push(duration);
  if ((step.status === "failed" || step.status === "blocked") && step.error) parts.push(step.error.code);
  return parts.join(" · ");
}

// The step column's meta per row (roadmap §3.5): how the step ran and what it produced, in words.
// "replayed", "agent", "API · 2 requests", "query · 1 row", "3 steps · agent".
export function stepRowMeta(step: Pick<TestRunStep, "type" | "mode" | "status" | "requests" | "outputs">, childCount: number): string {
  const parts: string[] = [];
  if (childCount > 0) parts.push(`${childCount} step${childCount === 1 ? "" : "s"}`);
  if (step.mode === "api-replayed" || step.mode === "api-handoff") {
    const count = step.requests?.count ?? 0;
    parts.push(`${step.mode === "api-replayed" ? "API" : "API hand-off"} · ${count} request${count === 1 ? "" : "s"}`);
  } else if (step.mode === "query") {
    const rows = queryStepView(step)?.rowCount ?? null;
    parts.push(rows === null ? "query" : `query · ${rows} row${rows === 1 ? "" : "s"}`);
  } else if (step.mode) {
    parts.push(modeLabel[step.mode]);
  } else if (step.status === "skipped") {
    parts.push("skipped");
  }
  return parts.join(" · ");
}

// The media box takes the pane's width at 16:9 plus the player's controls, and never more than
// about three fifths of the pane, so the step column under it always has room.
export function mediaHeightFor(pane: { width: number; height: number }, controls = 84): number {
  const byWidth = Math.round((pane.width * 9) / 16) + controls;
  const cap = Math.round(pane.height * 0.6);
  return Math.max(180, Math.min(byWidth, cap));
}

// One muted line under the instruction of a failed or blocked step: what the judge saw, else the
// error message. Passed steps keep their observation for the drawer.
export function stepOutcomeLine(step: Pick<TestRunStep, "status" | "observed" | "error">): string | null {
  if (step.status !== "failed" && step.status !== "blocked") return null;
  return step.observed ?? step.error?.message ?? null;
}

// "Queued · #2 of 3 · starts in ~20 s" for the strip while the run waits for a runner.
export function queuedStripMeta(run: Parameters<typeof formatQueuePill>[0], now = Date.now()): string {
  const pill = formatQueuePill(run, now) ?? "queued";
  return pill.charAt(0).toUpperCase() + pill.slice(1);
}

// Another agent adds `cacheDetail` to the step result; until the schema carries it, read it
// defensively so the drawer shows it as soon as the API does.
export function cacheDetailOf(step: object): string | null {
  const detail = (step as { cacheDetail?: unknown }).cacheDetail ?? null;
  if (detail === null || detail === undefined) return null;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

// A [Query] step shows its statement and the row it bound instead of a video segment (roadmap
// §5.4). The statement travels in `cacheDetail` ("<sql>\n-- 1 row · agent · PROFILE · 42ms"), the
// bound row in `outputs` under the binding name; `<name>.rows` is the whole result.
export type QueryStepView = { statement: string; meta: string | null; binding: string | null; row: Record<string, unknown> | null; rowCount: number | null };

export function queryStepView(step: Pick<TestRunStep, "type" | "outputs">): QueryStepView | null {
  // Only query steps have a statement to show.
  if (step.type !== "query") return null;
  const detail = cacheDetailOf(step);
  const lines = detail?.split("\n") ?? [];
  const metaLine = lines.length > 1 && lines[lines.length - 1]?.startsWith("-- ") ? (lines[lines.length - 1] ?? "").slice(3) : null;
  const statement = metaLine === null ? (detail ?? "") : lines.slice(0, -1).join("\n");
  const rowCountMatch = metaLine ? /^(\d+) rows?/.exec(metaLine) : null;
  const outputs = step.outputs ?? {};
  const binding = Object.keys(outputs).find((name) => !name.endsWith(".rows")) ?? null;
  let row: Record<string, unknown> | null = null;
  if (binding) {
    try {
      const parsed: unknown = JSON.parse(outputs[binding] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) row = parsed as Record<string, unknown>;
    } catch {
      row = null;
    }
  }
  return { statement, meta: metaLine, binding, row, rowCount: rowCountMatch ? Number(rowCountMatch[1]) : null };
}

export const DETAILS_OPEN_KEY = "jl-run-details-open";

// Closed by default; whatever the reviewer chose last is remembered on this device.
export function readDetailsOpen(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(DETAILS_OPEN_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeDetailsOpen(storage: Pick<Storage, "setItem"> | null, open: boolean): void {
  try {
    storage?.setItem(DETAILS_OPEN_KEY, String(open));
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this view.
  }
}

export type RunInfoRow = [label: string, value: string];

// Everything about the run that is not needed to review it: the drawer's Info tab.
export function runInfoRows(run: TestRunDetail, who: string, format: { tokens: (count: number) => string; cost: (usd: number | null) => string; duration: (ms: number | null) => string }): RunInfoRow[] {
  const metrics = run.metrics;
  const models: RunInfoRow[] =
    metrics.modelId === metrics.judgeModelId
      ? [["Model", metrics.modelId ?? "—"]]
      : [
          ["Act model", metrics.modelId ?? "—"],
          ["Judge model", metrics.judgeModelId ?? "—"]
        ];
  return [
    ["Version", `v${run.transcriptVersion}`],
    ["Trigger", `${run.trigger} by ${who}`],
    ["Environment", run.environmentName ?? "none"],
    ["Runner", `pool ${run.runnerPool} · cache ${run.cacheMode}`],
    ...(run.repairRunId ? ([["Cache", "stale, repair queued"]] as RunInfoRow[]) : []),
    ...models,
    ["Tokens", `${format.tokens(metrics.inputTokens)} in · ${format.tokens(metrics.outputTokens)} out · ${metrics.modelCalls} calls`],
    ["Cost", metrics.costUsd === null ? "—" : format.cost(metrics.costUsd)],
    ["Duration", format.duration(metrics.durationMs) || "—"],
    ["Steps", `${metrics.stepsReplayed}/${metrics.stepsTotal} replayed · ${metrics.stepsAgent} agent · ${metrics.stepsHandoff} hand-off`],
    ...reuseRows(run)
  ];
}

// "Preconditions reused from run X" when [Use] blocks took a recent run's outputs (roadmap §2.6).
export function reuseRows(run: Pick<TestRunDetail, "reusedFromRunIds">): RunInfoRow[] {
  const ids = run.reusedFromRunIds ?? [];
  if (ids.length === 0) return [];
  return [["Preconditions", `reused from run ${ids.join(", ")}`]];
}
