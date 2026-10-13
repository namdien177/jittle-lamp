import { appendFileSync } from "node:fs";

// Events the generated test writes while it runs. The runner tails this file for live progress
// and joins it with e2e's report.json afterwards. Never contains secret values.
export type StepLogEvent =
  | { type: "attempt-started"; at: string; videoStartedAt: string }
  | {
      type: "step-started";
      at: string;
      stepId: string;
      parentStepId: string | null;
      ordinal: number;
      kind: string;
      label: string;
    }
  | {
      type: "step-finished";
      at: string;
      stepId: string;
      status: "passed" | "failed" | "blocked";
      error: { code: string; message: string } | null;
      screenshot: string | null;
      observed: string | null;
      // Asserts only: what the deterministic check did (runtime/assert-check.ts).
      check?: { status: "hit" | "stale" | "recorded"; locator: string; reason?: string };
    }
  | { type: "screenshot"; at: string; stepId: string; path: string; label: string }
  | { type: "takeover"; at: string; action: "start" | "end"; stepId: string | null }
  | { type: "takeover-input"; at: string; stepId: string | null; kind: string; detail: string }
  // A variable the step produced (roadmap 2026-10-13 §2.6); `name` is namespaced inside a [Use] block.
  | { type: "output"; at: string; stepId: string; name: string; value: string }
  // An API script replayed for the step, or stopped at `seq` and handed to the UI (§2.4).
  | {
      type: "api-replay";
      at: string;
      stepId: string;
      outcome: "replayed" | "handoff";
      count: number;
      mutations: number;
      items: Array<{ seq: number; method: string; path: string; status: number | null; durationMs: number | null; mutation: boolean; error: string | null }>;
      seq: number | null;
      reason: string | null;
    }
  // One [Query] step's SQL and outcome (roadmap §5.4): the statement and sample are redacted by
  // column name before they are written; `tier` says which execution tier produced the SQL.
  | QueryStepLogEvent;

export type QueryStepLogEvent = {
  type: "query";
  at: string;
  stepId: string;
  profile: string;
  tier: "cached" | "saved" | "agent";
  statement: string;
  rowCount: number;
  sample: Array<Record<string, unknown>>;
  durationMs: number;
  // Tokens the agent tier spent writing the SQL; zero for the other tiers.
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; modelId: string | null };
};

export function writeStepLog(event: StepLogEvent): void {
  const path = process.env.JL_STEP_LOG;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}
