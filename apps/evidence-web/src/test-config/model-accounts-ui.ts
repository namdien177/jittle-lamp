import {
  findModelProvider,
  modelAccountStatus,
  modelProviders,
  type ModelAccount,
  type ModelAccountOverBudget,
  type ModelProvider
} from "@jittle-lamp/shared";

import { formatUsd } from "./cost-report";

// Settings → AI model → Accounts (design.md §9.3): several keys per provider, tried in priority
// order; budgets, pauses and the cooldowns the runner reports.

// Providers an account can be added for, in the order the picker lists them.
export const accountProviderOptions: readonly ModelProvider[] = modelProviders.filter(
  (provider) => !provider.development && (provider.keyEnv || provider.baseUrlEnv)
);

export function providerLabel(prefix: string): string {
  return modelProviders.find((provider) => provider.prefix === prefix)?.label ?? prefix;
}

// Providers the act and judge models take keys or an endpoint from.
export function neededProviders(actModel: string, judgeModel: string): string[] {
  const prefixes: string[] = [];
  for (const id of [actModel, judgeModel]) {
    const provider = findModelProvider(id);
    if (provider && (provider.keyEnv || provider.baseUrlEnv) && !prefixes.includes(provider.prefix)) prefixes.push(provider.prefix);
  }
  return prefixes;
}

export type ProviderGroup = { provider: string; label: string; needed: boolean; usable: number; accounts: ModelAccount[] };

// Accounts grouped by provider: the providers the models use first (even without accounts, so
// the page shows what is missing), then the rest alphabetically. Each group in priority order.
export function groupAccounts(accounts: readonly ModelAccount[], needed: readonly string[], now: number): ProviderGroup[] {
  const prefixes = [...needed, ...[...new Set(accounts.map((account) => account.provider))].filter((prefix) => !needed.includes(prefix)).sort()];
  return prefixes.map((provider) => {
    const own = accounts.filter((account) => account.provider === provider).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    return {
      provider,
      label: providerLabel(provider),
      needed: needed.includes(provider),
      usable: own.filter((account) => ["active", "cooldown", "auth_error"].includes(modelAccountStatus(account, now))).length,
      accounts: own
    };
  });
}

// The ids of a provider's accounts after moving one up (-1) or down (+1).
export function moveAccount(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export type StatusView = { label: string; tone: "success" | "warning" | "danger" | "muted"; detail: string | null };

const timeFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function formatUntil(epochMs: number): string {
  return timeFormat.format(new Date(epochMs));
}

export function accountStatusView(account: ModelAccount, now: number): StatusView {
  const status = modelAccountStatus(account, now);
  switch (status) {
    case "active":
      return { label: "Active", tone: "success", detail: null };
    case "disabled":
      return { label: "Disabled", tone: "muted", detail: "Runs never use it" };
    case "paused":
      return { label: "Paused", tone: "muted", detail: account.pausedUntil ? `Until ${formatUntil(account.pausedUntil)}` : null };
    case "over_budget":
      return {
        label: "Over budget",
        tone: "danger",
        detail: account.dailyBudgetUsd !== null && account.usage.todayUsd >= account.dailyBudgetUsd ? "Daily budget spent; back tomorrow (UTC)" : "Monthly budget spent; back next month (UTC)"
      };
    case "auth_error":
      return { label: "Key rejected", tone: "danger", detail: account.cooldownUntil ? `Tried last until ${formatUntil(account.cooldownUntil)}` : null };
    case "cooldown":
      return {
        label: account.lastErrorCode === "quota_exhausted" ? "Quota exhausted" : "Rate limited",
        tone: "warning",
        detail: account.cooldownUntil ? `Tried last until ${formatUntil(account.cooldownUntil)}` : null
      };
  }
}

export type BudgetMeterView = { ratio: number; tone: "ok" | "warning" | "danger"; label: string };

// Spend against a budget; warning from 80%, danger once spent.
export function budgetMeter(spentUsd: number, budgetUsd: number | null): BudgetMeterView | null {
  if (budgetUsd === null) return null;
  const ratio = budgetUsd > 0 ? spentUsd / budgetUsd : spentUsd > 0 ? 1 : 0;
  return {
    ratio: Math.min(1, ratio),
    tone: ratio >= 1 ? "danger" : ratio >= 0.8 ? "warning" : "ok",
    label: `${formatUsd(spentUsd)} of ${formatUsd(budgetUsd)}`
  };
}

export const pausePresets = [
  { label: "Pause for 1 hour", ms: 3_600_000 },
  { label: "Pause for 24 hours", ms: 86_400_000 },
  { label: "Pause for 7 days", ms: 7 * 86_400_000 }
] as const;

export const overBudgetOptions: Array<{ value: ModelAccountOverBudget; label: string; description: string }> = [
  {
    value: "finish",
    label: "Let the run finish",
    description: "A run that started under budget keeps this account until it ends; new runs skip it once the budget is spent."
  },
  {
    value: "stop",
    label: "Stop at the budget",
    description: "Mid-run, calls move to the next account once the budget is spent; with none left the run stops with BUDGET_EXCEEDED."
  }
];

export type AccountForm = {
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  dailyBudget: string;
  monthlyBudget: string;
  enabled: boolean;
  overBudget: ModelAccountOverBudget;
};

export function accountFormFrom(account: ModelAccount | null, provider: string): AccountForm {
  return {
    provider: account?.provider ?? provider,
    label: account?.label ?? "",
    apiKey: "",
    baseUrl: account?.baseUrl ?? "",
    dailyBudget: account?.dailyBudgetUsd === null || account?.dailyBudgetUsd === undefined ? "" : String(account.dailyBudgetUsd),
    monthlyBudget: account?.monthlyBudgetUsd === null || account?.monthlyBudgetUsd === undefined ? "" : String(account.monthlyBudgetUsd),
    enabled: account?.enabled ?? true,
    overBudget: account?.overBudget ?? "finish"
  };
}

type BudgetResult = { value: number | null; error?: string };

function parseBudget(text: string): BudgetResult {
  const trimmed = text.trim().replace(/^\$/, "");
  if (!trimmed) return { value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return { value: null, error: "Enter an amount in USD, or leave it empty for no limit." };
  return { value: Math.round(value * 100) / 100 };
}

export type AccountFormResult = {
  errors: Partial<Record<"label" | "apiKey" | "baseUrl" | "dailyBudget" | "monthlyBudget", string>>;
  body: {
    label: string;
    apiKey?: string;
    baseUrl?: string;
    enabled: boolean;
    dailyBudgetUsd: number | null;
    monthlyBudgetUsd: number | null;
    overBudget: ModelAccountOverBudget;
  };
};

// Validates the dialog and builds the POST/PATCH body; the key only when typed.
export function accountFormRequest(form: AccountForm, existing: ModelAccount | null): AccountFormResult {
  const provider = modelProviders.find((entry) => entry.prefix === form.provider);
  const errors: AccountFormResult["errors"] = {};
  const label = form.label.trim();
  if (!label) errors.label = "Name the account, e.g. Team A or Backup.";
  const apiKey = form.apiKey.trim();
  if (apiKey && apiKey.length < 8) errors.apiKey = "The key looks too short.";
  if (!apiKey && provider?.keyRequired && !existing?.keyConfigured) errors.apiKey = `${provider.label} needs a key.`;
  const baseUrl = form.baseUrl.trim();
  if (provider?.baseUrlEnv) {
    if (!baseUrl) errors.baseUrl = "Enter the endpoint's OpenAI-compatible API root.";
    else if (!/^https?:\/\/\S+$/i.test(baseUrl)) errors.baseUrl = "Use an http or https URL.";
  }
  const daily = parseBudget(form.dailyBudget);
  const monthly = parseBudget(form.monthlyBudget);
  if (daily.error) errors.dailyBudget = daily.error;
  if (monthly.error) errors.monthlyBudget = monthly.error;
  if (!daily.error && !monthly.error && daily.value !== null && monthly.value !== null && daily.value > monthly.value) {
    errors.dailyBudget = "The daily budget is larger than the monthly one.";
  }
  return {
    errors,
    body: {
      label,
      ...(apiKey ? { apiKey } : {}),
      ...(provider?.baseUrlEnv && baseUrl && baseUrl !== (existing?.baseUrl ?? "") ? { baseUrl } : {}),
      enabled: form.enabled,
      dailyBudgetUsd: daily.value,
      monthlyBudgetUsd: monthly.value,
      overBudget: form.overBudget
    }
  };
}
