import type { LanguageModelV4 } from "@ai-sdk/provider";
import { modelPriceSchema, runModelAccountSchema } from "@jittle-lamp/shared";
import { z } from "zod/v4";

import { appendAccountLog } from "../model/account-log";
import { createAccountLedger } from "../model/failover";
import { resolveModel } from "../model/providers";

declare global {
  var __jlActModel: { id: string; model: LanguageModelV4 } | undefined;
}

// Loaded by the generated e2e.config.ts inside the e2e process: builds the act and judge models
// from the JL_* environment the runner injected. One instance per distinct id, so a `mock:`
// fixture shared by act and judge is consumed in order. With JL_MODEL_ACCOUNTS the provider's
// accounts fail over between each other and log their usage to JL_MODEL_ACCOUNT_LOG.
export async function createModelsFromEnv(env: Readonly<Record<string, string | undefined>>): Promise<{
  model: LanguageModelV4;
  judge: LanguageModelV4;
}> {
  const actId = env.JL_MODEL ?? "anthropic/claude-opus-5-5";
  const judgeId = env.JL_JUDGE_MODEL ?? actId;
  const accounts = env.JL_MODEL_ACCOUNTS ? z.array(runModelAccountSchema).parse(JSON.parse(env.JL_MODEL_ACCOUNTS)) : [];
  const prices = env.JL_MODEL_PRICES ? z.array(modelPriceSchema).parse(JSON.parse(env.JL_MODEL_PRICES)) : undefined;
  const accountLog = env.JL_MODEL_ACCOUNT_LOG;
  const options = {
    keys: env,
    allowClaudeCode: env.JL_ALLOW_CLAUDE_CODE === "1",
    ...(accounts.length > 0 ? { accounts, accountLedger: createAccountLedger() } : {}),
    ...(prices ? { prices } : {}),
    ...(accountLog ? { onAccountLog: (entry: Parameters<typeof appendAccountLog>[1]) => appendAccountLog(accountLog, entry) } : {})
  };
  const act = await resolveModel(actId, {
    ...options,
    ...(env.JL_RECORD_MODEL_FIXTURE ? { recordFixture: env.JL_RECORD_MODEL_FIXTURE } : {})
  });
  // [Query] steps (runtime/query.ts) write SQL with the same act model instance, so a `mock:`
  // fixture is consumed in order and one account ledger counts every call.
  globalThis.__jlActModel = { id: actId, model: act.model };
  if (judgeId === actId) return { model: act.model, judge: act.model };
  const judge = await resolveModel(judgeId, {
    ...options,
    ...(env.JL_RECORD_JUDGE_FIXTURE ? { recordFixture: env.JL_RECORD_JUDGE_FIXTURE } : {})
  });
  return { model: act.model, judge: judge.model };
}
