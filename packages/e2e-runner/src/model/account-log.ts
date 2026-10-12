import { appendFileSync, existsSync, readFileSync } from "node:fs";

import type { ModelAccountLogEntry } from "./failover";

// The e2e process appends each model call's account usage and failure here (JL_MODEL_ACCOUNT_LOG);
// the runner tails it to stop a run whose accounts ran out of budget and folds it into the report.
// Account ids only, never keys.

export function appendAccountLog(path: string, entry: ModelAccountLogEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readAccountLog(path: string): ModelAccountLogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as ModelAccountLogEntry];
      } catch {
        // A line still being written.
        return [];
      }
    });
}
