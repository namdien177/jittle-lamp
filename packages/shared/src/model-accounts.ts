import { z } from "zod/v4";

// Model accounts (design.md §9.3, ADR 0002 amendment 2026-10-13): an organisation keeps several
// keys per provider. A run receives the usable accounts of its act and judge providers in
// priority order; the runner fails over to the next one on a rate limit, an exhausted quota or a
// rejected key, and reports per-account usage and those failures back with the run.

// What a run does once an account's remaining budget is spent mid-run: `finish` keeps using it
// until the run ends (the overrun is at most one run), `stop` moves on to the next account and
// stops the run with BUDGET_EXCEEDED when none is left.
export const modelAccountOverBudgetSchema = z.enum(["finish", "stop"]);

export const modelAccountStatusSchema = z.enum(["active", "disabled", "paused", "cooldown", "auth_error", "over_budget"]);

export const modelAccountEventKindSchema = z.enum(["rate_limited", "quota_exhausted", "auth_failed", "budget_exhausted"]);

// One account as the runner receives it (run and exploration config); never shown to a browser.
export const runModelAccountSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  label: z.string(),
  apiKey: z.string().nullable(),
  baseUrl: z.string().nullable().default(null),
  // The smaller of what is left of the daily and monthly budgets when the run started; null when
  // the account has no budget.
  remainingUsd: z.number().nullable().default(null),
  overBudget: modelAccountOverBudgetSchema.default("finish")
});

export const modelAccountEventSchema = z.object({
  accountId: z.string().min(1),
  kind: modelAccountEventKindSchema,
  at: z.string().min(1),
  // From the provider's retry-after header on a rate limit.
  retryAfterMs: z.number().int().nonnegative().nullable().default(null),
  message: z.string().max(1000).default("")
});

export const modelAccountUsageSchema = z.object({
  accountId: z.string().min(1),
  modelId: z.string().min(1),
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable()
});

export const runModelAccountsReportSchema = z.object({
  usage: z.array(modelAccountUsageSchema).default([]),
  events: z.array(modelAccountEventSchema).default([]),
  // The run stopped because every `stop` account ran out of budget.
  stopped: z.boolean().default(false)
});

// ---------------------------------------------------------------------------------------------
// Settings API (GET/POST/PATCH/DELETE /test-model-accounts)
// ---------------------------------------------------------------------------------------------

const budgetSchema = z.number().nonnegative().max(1_000_000).nullable();

export const modelAccountSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  label: z.string(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
  baseUrl: z.string().nullable(),
  // Lower runs first within a provider.
  priority: z.number().int().nonnegative(),
  enabled: z.boolean(),
  pausedUntil: z.number().int().nonnegative().nullable(),
  dailyBudgetUsd: budgetSchema,
  monthlyBudgetUsd: budgetSchema,
  overBudget: modelAccountOverBudgetSchema,
  cooldownUntil: z.number().int().nonnegative().nullable(),
  lastErrorCode: modelAccountEventKindSchema.nullable(),
  lastErrorMessage: z.string().nullable(),
  lastErrorAt: z.number().int().nonnegative().nullable(),
  lastUsedAt: z.number().int().nonnegative().nullable(),
  status: modelAccountStatusSchema,
  // Spend of finished runs in the current UTC day and month.
  usage: z.object({ todayUsd: z.number().nonnegative(), monthUsd: z.number().nonnegative() }),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
});

const modelAccountKeySchema = z.string().min(8).max(500);
const labelSchema = z.string().trim().min(1).max(80);

export const createModelAccountRequestSchema = z.object({
  provider: z.string().trim().min(1).max(40),
  label: labelSchema,
  // Write-only. Optional only for providers whose key is optional (OpenAI-compatible).
  apiKey: modelAccountKeySchema.nullable().optional(),
  baseUrl: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().default(true),
  dailyBudgetUsd: budgetSchema.optional(),
  monthlyBudgetUsd: budgetSchema.optional(),
  overBudget: modelAccountOverBudgetSchema.default("finish")
});

export const updateModelAccountRequestSchema = z.object({
  label: labelSchema.optional(),
  // A string replaces the key; omitted keeps it; null removes it (keyless OpenAI-compatible only).
  apiKey: modelAccountKeySchema.nullable().optional(),
  baseUrl: z.string().trim().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
  // Epoch ms until which runs skip the account; null resumes it.
  pausedUntil: z.number().int().nonnegative().nullable().optional(),
  dailyBudgetUsd: budgetSchema.optional(),
  monthlyBudgetUsd: budgetSchema.optional(),
  overBudget: modelAccountOverBudgetSchema.optional(),
  // Forget a cooldown or key error the runner reported.
  clearCooldown: z.literal(true).optional()
});

// The new order of one provider's accounts, highest priority first. Must list every account of it.
export const reorderModelAccountsRequestSchema = z.object({
  provider: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(100)
});

export type ModelAccountOverBudget = z.infer<typeof modelAccountOverBudgetSchema>;
export type ModelAccountStatus = z.infer<typeof modelAccountStatusSchema>;
export type ModelAccountEventKind = z.infer<typeof modelAccountEventKindSchema>;
export type RunModelAccount = z.infer<typeof runModelAccountSchema>;
export type ModelAccountEvent = z.infer<typeof modelAccountEventSchema>;
export type ModelAccountUsage = z.infer<typeof modelAccountUsageSchema>;
export type RunModelAccountsReport = z.infer<typeof runModelAccountsReportSchema>;
export type ModelAccount = z.infer<typeof modelAccountSchema>;
export type CreateModelAccountRequest = z.infer<typeof createModelAccountRequestSchema>;
export type UpdateModelAccountRequest = z.infer<typeof updateModelAccountRequestSchema>;
// What a client sends (defaults filled in by the server).
export type CreateModelAccountInput = z.input<typeof createModelAccountRequestSchema>;
export type ReorderModelAccountsRequest = z.infer<typeof reorderModelAccountsRequestSchema>;

// Status of an account at `now`; the order of the checks is the order the badge shows them in.
export function modelAccountStatus(
  account: Pick<ModelAccount, "enabled" | "pausedUntil" | "cooldownUntil" | "lastErrorCode" | "dailyBudgetUsd" | "monthlyBudgetUsd" | "usage">,
  now: number
): ModelAccountStatus {
  if (!account.enabled) return "disabled";
  if (account.pausedUntil !== null && account.pausedUntil > now) return "paused";
  if (modelAccountOverBudgetNow(account)) return "over_budget";
  if (account.cooldownUntil !== null && account.cooldownUntil > now) {
    return account.lastErrorCode === "auth_failed" ? "auth_error" : "cooldown";
  }
  return "active";
}

export function modelAccountOverBudgetNow(account: Pick<ModelAccount, "dailyBudgetUsd" | "monthlyBudgetUsd" | "usage">): boolean {
  return (
    (account.dailyBudgetUsd !== null && account.usage.todayUsd >= account.dailyBudgetUsd) ||
    (account.monthlyBudgetUsd !== null && account.usage.monthUsd >= account.monthlyBudgetUsd)
  );
}

// What is left of the tighter budget; null when the account has none.
export function modelAccountRemainingUsd(account: Pick<ModelAccount, "dailyBudgetUsd" | "monthlyBudgetUsd" | "usage">): number | null {
  const left = [
    account.dailyBudgetUsd === null ? null : account.dailyBudgetUsd - account.usage.todayUsd,
    account.monthlyBudgetUsd === null ? null : account.monthlyBudgetUsd - account.usage.monthUsd
  ].filter((value): value is number => value !== null);
  return left.length === 0 ? null : Math.max(0, Math.min(...left));
}
