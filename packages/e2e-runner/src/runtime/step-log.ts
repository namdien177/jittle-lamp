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
    }
  | { type: "screenshot"; at: string; stepId: string; path: string; label: string }
  | { type: "takeover"; at: string; action: "start" | "end"; stepId: string | null }
  | { type: "takeover-input"; at: string; stepId: string | null; kind: string; detail: string };

export function writeStepLog(event: StepLogEvent): void {
  const path = process.env.JL_STEP_LOG;
  if (!path) return;
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}
