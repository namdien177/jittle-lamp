import { parseTestCaseTranscript, sha256Hex, useCaseKeyArg, type LinkedCase, type ReusePolicy } from "@jittle-lamp/shared";

import type { PlannedStep, RunPlan } from "../plan";

// Reuse window (roadmap 2026-10-13 §2.6, §4.4): a [Use] block of a case with `Reuse: within …`
// first looks for a passed run of that case, same environment and params, inside the window. On
// a hit the block's steps are skipped and the run's outputs stand in under the block's alias.

export type ReuseHit = { runId: string; outputs: Record<string, string> };
export type ReuseLookup = (input: { caseKey: string; paramsHash: string; withinMs: number }) => Promise<ReuseHit | null>;

export type ReuseResult = {
  // Steps the generated test leaves out: the [Use] step and everything expanded under it.
  skippedStepIds: Set<string>;
  // Outputs injected before the run starts, namespaced by alias.
  outputs: Record<string, string>;
  reusedFromRunIds: string[];
  blocks: Array<{ stepId: string; caseKey: string; runId: string }>;
};

export const emptyReuse = (): ReuseResult => ({ skippedStepIds: new Set(), outputs: {}, reusedFromRunIds: [], blocks: [] });

// The backend hashes the params a run was requested with (`computeParamsHash`): sorted keys,
// JSON, sha256. A [Use] block's explicit arguments are those params.
export function paramsHashOf(params: Readonly<Record<string, string>>): string {
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `sha256:${sha256Hex(JSON.stringify(sorted))}`;
}

// Explicit arguments of `[Use: KEY, a=1, 2]` as the linked case's params (defaults excluded).
export function useBlockParams(step: Pick<PlannedStep, "args">, linked: Pick<LinkedCase, "params">): Record<string, string> {
  const values: Record<string, string> = {};
  const keyArgument = step.args.find((arg) => arg.name?.toLowerCase() === "case") ?? step.args.find((arg) => arg.name === null);
  let positional = 0;
  for (const arg of step.args) {
    if (arg === keyArgument || arg.name?.toLowerCase() === "mode") continue;
    if (arg.name === null) {
      const param = linked.params[positional];
      positional += 1;
      if (param) values[param.name] = arg.value;
      continue;
    }
    const param = linked.params.find((candidate) => candidate.name.toLowerCase() === arg.name?.toLowerCase());
    if (param) values[param.name] = arg.value;
  }
  return values;
}

export function reusePolicyOf(linked: Pick<LinkedCase, "transcript">): ReusePolicy {
  return parseTestCaseTranscript(linked.transcript).testCase.metadata.reuse;
}

export async function applyReuse(
  plan: Pick<RunPlan, "steps">,
  cases: readonly LinkedCase[],
  lookup: ReuseLookup,
  log: (line: string) => void = () => undefined
): Promise<ReuseResult> {
  const result = emptyReuse();
  const byKey = new Map(cases.map((linked) => [linked.key.toLowerCase(), linked]));
  for (const step of plan.steps) {
    if (step.type !== "use" || step.macroVersion === null) continue;
    // A block inside a reused block is already covered by the outer run's outputs.
    if ([...result.skippedStepIds].some((skipped) => step.stepId.startsWith(`${skipped}.`))) continue;
    const key = useCaseKeyArg(step.args);
    const linked = key === null ? undefined : byKey.get(key.toLowerCase());
    if (!linked) continue;
    const policy = reusePolicyOf(linked);
    if (policy.kind !== "within") continue;
    const paramsHash = paramsHashOf(useBlockParams(step, linked));
    let hit: ReuseHit | null = null;
    try {
      hit = await lookup({ caseKey: linked.key, paramsHash, withinMs: policy.ms });
    } catch (error) {
      log(`reuse lookup for ${linked.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!hit) continue;
    result.skippedStepIds.add(step.stepId);
    for (const candidate of plan.steps) if (candidate.stepId.startsWith(`${step.stepId}.`)) result.skippedStepIds.add(candidate.stepId);
    const prefix = step.alias ? `${step.alias}.` : "";
    for (const [name, value] of Object.entries(hit.outputs)) result.outputs[`${prefix}${name}`] = value;
    if (!result.reusedFromRunIds.includes(hit.runId)) result.reusedFromRunIds.push(hit.runId);
    result.blocks.push({ stepId: step.stepId, caseKey: linked.key, runId: hit.runId });
    log(`reusing run ${hit.runId} for [Use: ${linked.key}]`);
  }
  return result;
}
