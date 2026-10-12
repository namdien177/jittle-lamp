import { describe, expect, it } from "bun:test";
import { modelAccountRemainingUsd, modelAccountStatus, modelCostReportSchema, type ModelAccount } from "@jittle-lamp/shared";

import { accountSeries, accountShareRows, stackedDailyBars } from "../apps/evidence-web/src/test-config/cost-report";
import {
  accountFormFrom,
  accountFormRequest,
  accountStatusView,
  budgetMeter,
  groupAccounts,
  moveAccount,
  neededProviders
} from "../apps/evidence-web/src/test-config/model-accounts-ui";

// Settings → AI model → Accounts and the per-account spend chart (design.md §9.3).

const now = Date.UTC(2026, 9, 13, 12);

const account = (id: string, extra: Partial<ModelAccount> = {}): ModelAccount => ({
  id,
  provider: "openrouter",
  label: id,
  keyConfigured: true,
  keyLast4: "1234",
  baseUrl: null,
  priority: 0,
  enabled: true,
  pausedUntil: null,
  dailyBudgetUsd: null,
  monthlyBudgetUsd: null,
  overBudget: "finish",
  cooldownUntil: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  lastErrorAt: null,
  lastUsedAt: null,
  status: "active",
  usage: { todayUsd: 0, monthUsd: 0 },
  createdAt: 0,
  updatedAt: 0,
  ...extra
});

describe("model account status", () => {
  it("reads disabled, paused, over budget, key errors and rate limits in that order", () => {
    expect(modelAccountStatus(account("a", { enabled: false, pausedUntil: now + 1 }), now)).toBe("disabled");
    expect(modelAccountStatus(account("a", { pausedUntil: now + 1 }), now)).toBe("paused");
    expect(modelAccountStatus(account("a", { pausedUntil: now - 1 }), now)).toBe("active");
    expect(modelAccountStatus(account("a", { dailyBudgetUsd: 5, usage: { todayUsd: 5, monthUsd: 5 }, cooldownUntil: now + 1 }), now)).toBe("over_budget");
    expect(modelAccountStatus(account("a", { cooldownUntil: now + 1, lastErrorCode: "auth_failed" }), now)).toBe("auth_error");
    expect(modelAccountStatus(account("a", { cooldownUntil: now + 1, lastErrorCode: "rate_limited" }), now)).toBe("cooldown");
    expect(accountStatusView(account("a", { cooldownUntil: now + 1, lastErrorCode: "quota_exhausted" }), now).label).toBe("Quota exhausted");
    expect(accountStatusView(account("a", { monthlyBudgetUsd: 10, usage: { todayUsd: 1, monthUsd: 10 } }), now).detail).toContain("Monthly");
  });

  it("leaves the smaller of the daily and monthly budgets", () => {
    expect(modelAccountRemainingUsd(account("a"))).toBeNull();
    expect(modelAccountRemainingUsd(account("a", { dailyBudgetUsd: 5, monthlyBudgetUsd: 100, usage: { todayUsd: 2, monthUsd: 98 } }))).toBe(2);
    expect(modelAccountRemainingUsd(account("a", { dailyBudgetUsd: 5, usage: { todayUsd: 7, monthUsd: 7 } }))).toBe(0);
  });

  it("warns from 80% of a budget and turns red once it is spent", () => {
    expect(budgetMeter(1, null)).toBeNull();
    expect(budgetMeter(1, 10)).toMatchObject({ tone: "ok", ratio: 0.1, label: "$1.00 of $10.00" });
    expect(budgetMeter(8, 10)?.tone).toBe("warning");
    expect(budgetMeter(12, 10)).toMatchObject({ tone: "danger", ratio: 1 });
  });
});

describe("model account list", () => {
  it("lists the providers the models use first, even without accounts, each in priority order", () => {
    const needed = neededProviders("anthropic/claude-opus-5-5", "openrouter/openai/gpt-5");
    expect(needed).toEqual(["anthropic", "openrouter"]);
    expect(neededProviders("mock:fixture.json", "mock:fixture.json")).toEqual([]);
    const groups = groupAccounts(
      [
        account("late", { priority: 1 }),
        account("first", { priority: 0 }),
        account("xai", { provider: "xai" }),
        account("paused", { priority: 2, pausedUntil: now + 1 })
      ],
      needed,
      now
    );
    expect(groups.map((group) => [group.provider, group.needed, group.usable, group.accounts.map((entry) => entry.id)])).toEqual([
      ["anthropic", true, 0, []],
      ["openrouter", true, 2, ["first", "late", "paused"]],
      ["xai", false, 1, ["xai"]]
    ]);
  });

  it("moves an account one place without falling off either end", () => {
    expect(moveAccount(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveAccount(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveAccount(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });

  it("validates the dialog and sends the key only when typed", () => {
    const blank = accountFormRequest(accountFormFrom(null, "anthropic"), null);
    expect(blank.errors).toMatchObject({ label: expect.any(String), apiKey: "Anthropic needs a key." });
    const form = { ...accountFormFrom(null, "anthropic"), label: " Team A ", apiKey: "sk-ant-1234567890", dailyBudget: "$5", monthlyBudget: "100" };
    expect(accountFormRequest(form, null)).toEqual({
      errors: {},
      body: { label: "Team A", apiKey: "sk-ant-1234567890", enabled: true, dailyBudgetUsd: 5, monthlyBudgetUsd: 100, overBudget: "finish" }
    });
    const existing = account("a", { provider: "anthropic" });
    const edit = accountFormRequest({ ...accountFormFrom(existing, "anthropic"), overBudget: "stop" }, existing);
    expect(edit.errors).toEqual({});
    expect(edit.body).not.toHaveProperty("apiKey");
    expect(edit.body.overBudget).toBe("stop");
    expect(accountFormRequest({ ...form, dailyBudget: "200" }, null).errors.dailyBudget).toContain("larger");
    expect(accountFormRequest({ ...form, monthlyBudget: "lots" }, null).errors.monthlyBudget).toBeDefined();
    const compatible = accountFormRequest({ ...accountFormFrom(null, "openai-compatible"), label: "vLLM" }, null);
    expect(compatible.errors).toEqual({ baseUrl: expect.any(String) });
  });
});

describe("spend per account", () => {
  const report = modelCostReportSchema.parse({
    from: Date.UTC(2026, 9, 11),
    to: Date.UTC(2026, 9, 13, 23, 59),
    totalCostUsd: 10,
    runs: 4,
    byUser: [],
    byModel: [],
    byDay: [
      { day: "2026-10-11", costUsd: 4 },
      { day: "2026-10-12", costUsd: 6 }
    ],
    byAccount: [
      { accountId: "a", label: "Team A", provider: "openrouter", keyLast4: "1111", costUsd: 3, calls: 3, tokens: 3000 },
      { accountId: "b", label: "Team B", provider: "openrouter", keyLast4: "2222", costUsd: 5, calls: 1, tokens: 1000 }
    ],
    byDayAccount: [
      { day: "2026-10-11", accountId: "a", costUsd: 3 },
      { day: "2026-10-12", accountId: "b", costUsd: 5 }
    ]
  });

  it("ranks accounts and keeps spend no account was recorded for as its own series", () => {
    expect(accountShareRows(report).map((row) => [row.label, row.share])).toEqual([
      ["Team B · openrouter ····2222", 0.5],
      ["Team A · openrouter ····1111", 0.3]
    ]);
    expect(accountSeries(report).map((entry) => entry.key)).toEqual(["b", "a", "unattributed"]);
  });

  it("stacks each day's bar from its accounts, adding up to the day's total", () => {
    const bars = stackedDailyBars(report);
    expect(bars.map((bar) => bar.day)).toEqual(["2026-10-11", "2026-10-12", "2026-10-13"]);
    expect(bars[0]?.segments.map((segment) => [segment.key, segment.costUsd])).toEqual([
      ["a", 3],
      ["unattributed", 1]
    ]);
    expect(bars[1]?.segments.map((segment) => [segment.key, segment.costUsd])).toEqual([
      ["b", 5],
      ["unattributed", 1]
    ]);
    expect(bars[2]?.segments).toEqual([]);
  });
});
