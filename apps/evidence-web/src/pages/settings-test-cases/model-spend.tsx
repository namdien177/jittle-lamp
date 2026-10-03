import React, { useMemo, useState } from "react";

import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { useAccountProfile } from "../../queries";
import { useModelCosts } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, StatTile, pressable } from "../../test-cases/admin-ui";
import { Hint, TruncatedText } from "../../components/ui/tooltip";
import {
  averagePerRun,
  costPeriodRange,
  costPeriods,
  dailyBars,
  formatDayLabel,
  formatShare,
  formatUsd,
  modelShareRows,
  userShareRows,
  type CostPeriod,
  type ShareRow
} from "../../test-config/cost-report";

// Model spend per organisation (ops.4) from GET /model-costs: total, by user, by model, by day.

function ShareTable(props: { rows: ShareRow[]; label: string; empty: string }): React.JSX.Element {
  if (props.rows.length === 0) return <p className="text-sm text-muted-foreground">{props.empty}</p>;
  return (
    <ul className="grid gap-3" aria-label={props.label}>
      {props.rows.map((row) => (
        <li key={row.key} className="grid gap-1">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <TruncatedText className="font-medium text-foreground">{row.label}</TruncatedText>
            <span className="shrink-0 tabular-nums text-foreground">{formatUsd(row.costUsd)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(row.share * 100, row.costUsd > 0 ? 1.5 : 0)}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {formatShare(row.share)} · {row.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SettingsTestModelSpendPage(): React.JSX.Element {
  const [period, setPeriod] = useState<CostPeriod>(30);
  // Rounded to the minute so the query key is stable between renders.
  const range = useMemo(() => costPeriodRange(period, Math.floor(Date.now() / 60_000) * 60_000), [period]);
  const report = useModelCosts(range);
  const profile = useAccountProfile();
  const bars = report.data ? dailyBars(report.data) : [];
  const average = report.data ? averagePerRun(report.data) : null;
  const peak = bars.reduce((max, bar) => Math.max(max, bar.costUsd), 0);
  const labelEvery = bars.length > 31 ? 14 : bars.length > 10 ? 5 : 1;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">Model spend</h2>
          <p className="text-sm text-muted-foreground">Cost of agent and judge calls across this organisation's runs.</p>
        </div>
        <div role="radiogroup" aria-label="Period" className="flex overflow-hidden rounded-md border border-border bg-card">
          {costPeriods.map((days) => (
            <button
              key={days}
              type="button"
              role="radio"
              aria-checked={period === days}
              onClick={() => setPeriod(days)}
              className={cn("px-3.5 py-1.5 text-sm font-semibold", pressable, period === days ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted")}
            >
              {days} days
            </button>
          ))}
        </div>
      </div>

      <ErrorNote error={report.error} />
      {report.isPending ? (
        <Skeleton className="h-80" />
      ) : report.data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatTile label={`Total · ${period} days`} value={formatUsd(report.data.totalCostUsd)} />
            <StatTile label="Runs" value={report.data.runs.toLocaleString()} />
            <StatTile label="Per run" value={average === null ? "—" : formatUsd(average)} detail="average" />
          </div>

          <AdminCard title="By day" description={peak > 0 ? `Busiest day ${formatUsd(peak)}` : "No spend in this period"}>
            <figure className="grid gap-2">
              <div
                role="img"
                aria-label={`Daily model spend over ${period} days. Total ${formatUsd(report.data.totalCostUsd)}${peak > 0 ? `, busiest day ${formatUsd(peak)}` : ""}.`}
                className="flex h-40 items-end gap-px border-b border-border"
              >
                {bars.map((bar) => (
                  <Hint key={bar.day} label={bar.label}>
                    <div className="group relative flex h-full min-w-0 flex-1 items-end">
                      <div
                        className={cn("w-full rounded-t-sm", bar.costUsd > 0 ? "bg-primary/80 group-hover:bg-primary" : "bg-muted")}
                        style={{ height: `${bar.costUsd > 0 ? Math.max(bar.ratio * 100, 2) : 1}%` }}
                      />
                    </div>
                  </Hint>
                ))}
              </div>
              <div className="flex gap-px" aria-hidden>
                {bars.map((bar, index) => (
                  <span key={bar.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-[10px] text-muted-foreground">
                    {index % labelEvery === 0 ? formatDayLabel(bar.day) : ""}
                  </span>
                ))}
              </div>
              <figcaption className="sr-only">
                <table>
                  <caption>Spend per day</caption>
                  <tbody>
                    {bars.map((bar) => (
                      <tr key={bar.day}>
                        <th scope="row">{formatDayLabel(bar.day)}</th>
                        <td>{formatUsd(bar.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </figcaption>
            </figure>
          </AdminCard>

          <div className="grid gap-4 md:grid-cols-2">
            <AdminCard title="By user" description="The requester of each run">
              <ShareTable rows={userShareRows(report.data, { currentUserId: profile.data?.localUserId ?? null })} label="Spend by user" empty="No runs in this period." />
            </AdminCard>
            <AdminCard title="By model" description="Act and judge models">
              <ShareTable rows={modelShareRows(report.data)} label="Spend by model" empty="No model calls in this period." />
            </AdminCard>
          </div>
        </>
      ) : null}
    </div>
  );
}
