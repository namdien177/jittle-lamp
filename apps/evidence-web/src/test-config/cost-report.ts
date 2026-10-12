import type { ModelCostReport } from "@jittle-lamp/shared";

// Model spend view (ops.4): period presets, formatting and chart rows for the cost report.

export const costPeriods = [7, 30, 90] as const;
export type CostPeriod = (typeof costPeriods)[number];

const dayMs = 86_400_000;

// `days` whole UTC days ending today (inclusive).
export function costPeriodRange(days: CostPeriod, now: number): { from: number; to: number } {
  const endOfToday = Math.floor(now / dayMs) * dayMs + dayMs - 1;
  const from = endOfToday + 1 - days * dayMs;
  return { from, to: Math.min(endOfToday, Math.max(now, from)) };
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

function isoDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export type DayBar = { day: string; costUsd: number; ratio: number; label: string };

// Every day of the period, zero-filled, with its height relative to the busiest day.
export function dailyBars(report: Pick<ModelCostReport, "from" | "to" | "byDay">): DayBar[] {
  const byDay = new Map<string, number>();
  for (const entry of report.byDay) byDay.set(entry.day.slice(0, 10), (byDay.get(entry.day.slice(0, 10)) ?? 0) + entry.costUsd);
  const days: string[] = [];
  const start = Math.floor(report.from / dayMs) * dayMs;
  for (let cursor = start; cursor <= report.to && days.length < 400; cursor += dayMs) days.push(isoDay(cursor));
  for (const day of byDay.keys()) if (!days.includes(day)) days.push(day);
  days.sort();
  const max = Math.max(0, ...days.map((day) => byDay.get(day) ?? 0));
  return days.map((day) => {
    const costUsd = byDay.get(day) ?? 0;
    return {
      day,
      costUsd,
      ratio: max > 0 ? costUsd / max : 0,
      label: `${formatDayLabel(day)}: ${formatUsd(costUsd)}`
    };
  });
}

export function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export type ShareRow = { key: string; label: string; costUsd: number; share: number; detail: string };

// The report may carry user ids without names; the viewer's own row reads "You".
function userLabel(entry: { userId: string | null; name: string | null }, currentUserId: string | null): string {
  if (entry.name) return entry.userId && entry.userId === currentUserId ? `${entry.name} (you)` : entry.name;
  if (!entry.userId) return "Automation and deleted users";
  if (entry.userId === currentUserId) return "You";
  return `User ${entry.userId.slice(0, 8)}`;
}

export function userShareRows(report: Pick<ModelCostReport, "byUser" | "totalCostUsd">, options: { currentUserId?: string | null } = {}): ShareRow[] {
  return [...report.byUser]
    .sort((left, right) => right.costUsd - left.costUsd)
    .map((entry, index) => ({
      key: entry.userId ?? `unknown-${index}`,
      label: userLabel(entry, options.currentUserId ?? null),
      costUsd: entry.costUsd,
      share: report.totalCostUsd > 0 ? entry.costUsd / report.totalCostUsd : 0,
      detail: `${entry.runs} run${entry.runs === 1 ? "" : "s"}`
    }));
}

export function modelShareRows(report: Pick<ModelCostReport, "byModel" | "totalCostUsd">): ShareRow[] {
  return [...report.byModel]
    .sort((left, right) => right.costUsd - left.costUsd)
    .map((entry) => ({
      key: entry.modelId,
      label: entry.modelId,
      costUsd: entry.costUsd,
      share: report.totalCostUsd > 0 ? entry.costUsd / report.totalCostUsd : 0,
      detail: `${formatTokens(entry.tokens)} tokens`
    }));
}

export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  if (share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

export function averagePerRun(report: Pick<ModelCostReport, "totalCostUsd" | "runs">): number | null {
  return report.runs > 0 ? report.totalCostUsd / report.runs : null;
}

// ---------------------------------------------------------------------------------------------
// Spend per model account (design.md §9.3)
// ---------------------------------------------------------------------------------------------

// Series colours for accounts, distinguishable in light and dark themes; the last is "other".
export const accountSeriesColors = ["#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#ef4444", "#14b8a6"] as const;
export const otherSeriesColor = "#94a3b8";
const maxSeries = accountSeriesColors.length;

const accountKey = (accountId: string | null) => accountId ?? "deleted";

function accountName(entry: { label: string; provider: string | null; keyLast4: string | null }): string {
  const key = entry.keyLast4 ? ` ····${entry.keyLast4}` : "";
  return entry.provider ? `${entry.label} · ${entry.provider}${key}` : entry.label;
}

export function accountShareRows(report: Pick<ModelCostReport, "byAccount" | "totalCostUsd">): ShareRow[] {
  return [...report.byAccount]
    .sort((left, right) => right.costUsd - left.costUsd)
    .map((entry) => ({
      key: accountKey(entry.accountId),
      label: accountName(entry),
      costUsd: entry.costUsd,
      share: report.totalCostUsd > 0 ? entry.costUsd / report.totalCostUsd : 0,
      detail: `${entry.calls.toLocaleString()} call${entry.calls === 1 ? "" : "s"} · ${formatTokens(entry.tokens)} tokens`
    }));
}

export type AccountSeries = { key: string; label: string; color: string };
export type StackedSegment = { key: string; costUsd: number; color: string };
export type StackedDayBar = DayBar & { segments: StackedSegment[] };

// The accounts the daily chart shows: the costliest six, then "Other accounts", then spend no
// account was recorded for (runs before model accounts, or runners that do not report them).
export function accountSeries(report: Pick<ModelCostReport, "byAccount" | "byDay" | "byDayAccount">): AccountSeries[] {
  const ranked = [...report.byAccount].sort((left, right) => right.costUsd - left.costUsd);
  const series: AccountSeries[] = ranked.slice(0, maxSeries).map((entry, index) => ({
    key: accountKey(entry.accountId),
    label: accountName(entry),
    color: accountSeriesColors[index] ?? otherSeriesColor
  }));
  if (ranked.length > maxSeries) series.push({ key: "other", label: "Other accounts", color: otherSeriesColor });
  const attributed = report.byDayAccount.reduce((sum, entry) => sum + entry.costUsd, 0);
  const total = report.byDay.reduce((sum, entry) => sum + entry.costUsd, 0);
  if (total - attributed > 0.000001) series.push({ key: "unattributed", label: "No account recorded", color: "var(--muted-foreground)" });
  return series;
}

// Daily bars split by account; each bar's segments add up to that day's spend.
export function stackedDailyBars(report: Pick<ModelCostReport, "from" | "to" | "byDay" | "byAccount" | "byDayAccount">): StackedDayBar[] {
  const series = accountSeries(report);
  const shown = new Set(series.map((entry) => entry.key));
  const color = new Map(series.map((entry) => [entry.key, entry.color]));
  const perDay = new Map<string, Map<string, number>>();
  for (const entry of report.byDayAccount) {
    const day = entry.day.slice(0, 10);
    const key = shown.has(accountKey(entry.accountId)) ? accountKey(entry.accountId) : "other";
    const segments = perDay.get(day) ?? new Map<string, number>();
    segments.set(key, (segments.get(key) ?? 0) + entry.costUsd);
    perDay.set(day, segments);
  }
  return dailyBars(report).map((bar) => {
    const segments = perDay.get(bar.day) ?? new Map<string, number>();
    const attributed = [...segments.values()].reduce((sum, value) => sum + value, 0);
    if (bar.costUsd - attributed > 0.000001) segments.set("unattributed", bar.costUsd - attributed);
    return {
      ...bar,
      segments: series
        .filter((entry) => (segments.get(entry.key) ?? 0) > 0)
        .map((entry) => ({ key: entry.key, costUsd: segments.get(entry.key) ?? 0, color: color.get(entry.key) ?? otherSeriesColor }))
    };
  });
}
