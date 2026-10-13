import { existsSync, readFileSync } from "node:fs";

import type { RunReport } from "@jittle-lamp/shared";

import type { PlannedStep } from "../plan";
import type { CapturedRequest } from "../runtime/capture";
import type { StepLogEvent } from "../runtime/step-log";
import { stepMayRecordApi, type ApiRunConfig } from "./modes";
import { buildApiScripts, type BuilderOutput, type BuilderStep } from "./script-builder";
import type { ApiScriptStore } from "./store";

// After a run (roadmap 2026-10-13 §2.3): the request log and the report decide which passed
// steps get an API script, and the store keeps them for the next run. Only read-write runs
// record, and only steps the browser drove: a step that replayed its API script sent its
// requests from the runner, so the log holds nothing new for it.

export function readRequestLog(path: string): CapturedRequest[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const record = JSON.parse(line) as CapturedRequest;
        return record.kind === "request" ? [record] : [];
      } catch {
        return [];
      }
    });
}

export function outputsFromStepLog(stepLog: readonly StepLogEvent[]): BuilderOutput[] {
  return stepLog.flatMap((event) => (event.type === "output" ? [{ stepId: event.stepId, name: event.name, value: event.value }] : []));
}

export type RecordApiScriptsInput = {
  report: RunReport;
  plan: { steps: readonly PlannedStep[]; params: Readonly<Record<string, string>>; baseUrl: string | null };
  stepLog: readonly StepLogEvent[];
  requestsPath: string;
  config: ApiRunConfig;
  store: ApiScriptStore | null;
  cacheMode: string;
  log?: (line: string) => void;
};

export async function recordApiScripts(input: RecordApiScriptsInput): Promise<string[]> {
  const log = input.log ?? (() => undefined);
  // Only runs that record scripts write API scripts (same rule as the UI cache).
  if (input.cacheMode !== "read-write" || !input.store) return [];
  // API mode needs origins by decision 2; without them nothing is recorded either.
  if (input.config.apiOrigins.length === 0) return [];
  const requests = readRequestLog(input.requestsPath);
  if (requests.length === 0) return [];
  const resultByStep = new Map(input.report.steps.map((step) => [step.stepId, step]));
  const steps: BuilderStep[] = input.plan.steps
    .filter((step) => step.executes)
    .map((step) => {
      const result = resultByStep.get(step.stepId);
      const drivenByBrowser = result?.status === "passed" && result.mode !== "api-replayed";
      return {
        stepId: step.stepId,
        instructionKey: step.instructionKey,
        startedAt: result?.startedAt ?? null,
        finishedAt: result?.finishedAt ?? null,
        eligible: drivenByBrowser && stepMayRecordApi(step, input.config.executionMode)
      };
    });
  const { scripts } = buildApiScripts({
    requests,
    steps,
    baseUrl: input.plan.baseUrl,
    apiOrigins: input.config.apiOrigins,
    apiPolicy: input.config.apiPolicy,
    params: input.plan.params,
    outputs: outputsFromStepLog(input.stepLog),
    recordedAt: input.report.finishedAt
  });
  const written: string[] = [];
  for (const script of scripts) {
    try {
      await input.store.write(script);
      written.push(script.stepId);
    } catch (error) {
      log(`api script for ${script.stepId} not stored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (written.length > 0) log(`api scripts recorded for ${written.length} step${written.length === 1 ? "" : "s"}`);
  return written;
}
