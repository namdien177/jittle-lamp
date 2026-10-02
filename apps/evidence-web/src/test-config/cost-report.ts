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

export function userShareRows(report: Pick<ModelCostReport, "byUser" | "totalCostUsd">): ShareRow[] {
  return [...report.byUser]
    .sort((left, right) => right.costUsd - left.costUsd)
    .map((entry, index) => ({
      key: entry.userId ?? `unknown-${index}`,
      label: entry.name ?? (entry.userId ? "Unknown user" : "Automation and deleted users"),
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
