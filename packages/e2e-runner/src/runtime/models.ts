import type { LanguageModelV4 } from "@ai-sdk/provider";

import { resolveModel } from "../model/providers";

// Loaded by the generated e2e.config.ts inside the e2e process: builds the act and judge models
// from the JL_* environment the runner injected. One instance per distinct id, so a `mock:`
// fixture shared by act and judge is consumed in order.
export async function createModelsFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<{
  model: LanguageModelV4;
  judge: LanguageModelV4;
}> {
  const actId = env.JL_MODEL ?? "anthropic/claude-opus-5-5";
  const judgeId = env.JL_JUDGE_MODEL ?? actId;
  const options = {
    keys: env,
    allowClaudeCode: env.JL_ALLOW_CLAUDE_CODE === "1"
  };
  const act = await resolveModel(actId, {
    ...options,
    ...(env.JL_RECORD_MODEL_FIXTURE ? { recordFixture: env.JL_RECORD_MODEL_FIXTURE } : {})
  });
  if (judgeId === actId) return { model: act.model, judge: act.model };
  const judge = await resolveModel(judgeId, {
    ...options,
    ...(env.JL_RECORD_JUDGE_FIXTURE ? { recordFixture: env.JL_RECORD_JUDGE_FIXTURE } : {})
  });
  return { model: act.model, judge: judge.model };
}
