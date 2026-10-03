import { appendFileSync } from "node:fs";

import type { Reporter } from "e2e";

// Forwards e2e's step events to a JSONL file the runner tails for live progress (design.md §5.4).
export function createProgressReporter(path: string | undefined): Reporter {
  return {
    name: "jl-progress",
    onEvent(event) {
      if (!path) return;
      if (event.type !== "step" && event.type !== "test-finished" && event.type !== "run-finished" && event.type !== "run-error") return;
      try {
        appendFileSync(path, `${JSON.stringify(event)}\n`);
      } catch {
        // A reporter must not throw.
      }
    }
  };
}
