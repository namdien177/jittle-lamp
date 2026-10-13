import { apiRequestScriptSchema, type ApiPolicy, type ApiRequestScript, type ExecutionMode } from "@jittle-lamp/shared";

import type { PlannedStep } from "../plan";
import type { ApiScriptStore } from "./store";

// Which steps run through their API script (roadmap 2026-10-13 §2.5): under `api` every act of
// the case; inside a [Use] block the block's `mode=` decides, with `auto` following the run's
// mode (`hybrid` and `api` replay, `full` drives the UI). Open steps navigate the browser and
// stay UI; asserts, waits and extracts are judgements and stay UI too.

export type ApiRunConfig = {
  executionMode: ExecutionMode;
  apiOrigins: readonly string[];
  apiPolicy: ApiPolicy;
};

export const apiEligibleTypes = new Set<PlannedStep["type"]>(["act"]);

// True when the step's effective mode is API (a script would be replayed if one exists).
export function stepPrefersApi(step: Pick<PlannedStep, "type" | "executes" | "useMode">, executionMode: ExecutionMode): boolean {
  if (!step.executes) return false;
  if (!apiEligibleTypes.has(step.type)) return false;
  // Inside a [Use] block the block's mode wins; `auto` follows the run.
  if (step.useMode === "api") return true;
  if (step.useMode === "ui") return false;
  if (step.useMode === "auto") return executionMode !== "full";
  // The case's own steps replay only under API-only runs.
  return executionMode === "api";
}

// Whether a passed step may record an API script afterwards: the same steps that would replay
// one, plus every act inside a [Use] block (so a full run of the parent prepares the hybrid run).
export function stepMayRecordApi(step: Pick<PlannedStep, "type" | "executes" | "useMode">, executionMode: ExecutionMode): boolean {
  if (!step.executes || !apiEligibleTypes.has(step.type)) return false;
  if (step.useMode === "ui") return false;
  if (step.useMode !== null) return true;
  return executionMode === "api";
}

export type ResolvedApiSteps = { scripts: Record<string, ApiRequestScript>; preferred: string[] };

// Active API scripts of the steps that prefer API, looked up before the run so the generated test
// knows which steps call `jl.replayApiOrFallback`.
export async function resolveApiSteps(
  steps: readonly PlannedStep[],
  config: ApiRunConfig,
  store: ApiScriptStore | null,
  log: (line: string) => void = () => undefined
): Promise<ResolvedApiSteps> {
  const preferred = steps.filter((step) => stepPrefersApi(step, config.executionMode)).map((step) => step.stepId);
  const scripts: Record<string, ApiRequestScript> = {};
  // API mode needs origins by decision 2; a run without them replays nothing.
  if (!store || config.apiOrigins.length === 0) return { scripts, preferred };
  for (const stepId of preferred) {
    try {
      const script = await store.read(stepId);
      if (!script) continue;
      const parsed = apiRequestScriptSchema.safeParse(script);
      if (!parsed.success) {
        log(`api script for ${stepId} is malformed; the step runs through the UI`);
        continue;
      }
      scripts[stepId] = parsed.data;
    } catch (error) {
      log(`api script lookup for ${stepId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { scripts, preferred };
}
