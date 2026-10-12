import React, { useMemo, useState } from "react";
import { Link } from "react-router";

import { Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { useAccountProfile } from "../../queries";
import { useModelAccounts, useModelCosts } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, StatTile, pressable } from "../../test-cases/admin-ui";
import { Hint, TruncatedText } from "../../components/ui/tooltip";
import {
  accountSeries,
  accountShareRows,
  averagePerRun,
  costPeriodRange,
  costPeriods,
  formatDayLabel,
  formatShare,
  formatUsd,
  modelShareRows,
  stackedDailyBars,
  userShareRows,
  type CostPeriod,
  type ShareRow
} from "../../test-config/cost-report";
import { groupAccounts } from "../../test-config/model-accounts-ui";
import { AccountStatusBadge, BudgetMeter } from "./model-accounts";

// Model spend per organisation (ops.4) from GET /model-costs: total, by user, by model, by model
// account and by day (stacked by account), plus each account's budget (design.md §9.3).

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
  const accounts = useModelAccounts();
  const profile = useAccountProfile();
  const bars = report.data ? stackedDailyBars(report.data) : [];
  const series = report.data ? accountSeries(report.data) : [];
  const now = Date.now();
  const budgeted = groupAccounts(accounts.data ?? [], [], now).filter((group) => group.accounts.length > 0);
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
                      {bar.costUsd > 0 ? (
                        <div
                          className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm opacity-85 group-hover:opacity-100"
                          style={{ height: `${Math.max(bar.ratio * 100, 2)}%` }}
                        >
                          {bar.segments.map((segment) => (
                            <div key={segment.key} className="w-full shrink-0" style={{ height: `${(segment.costUsd / bar.costUsd) * 100}%`, background: segment.color }} />
                          ))}
                        </div>
                      ) : (
                        <div className="w-full rounded-t-sm bg-muted" style={{ height: "1%" }} />
                      )}
                    </div>
                  </Hint>
                ))}
              </div>
              <div className="flex gap-px" aria-hidden>
                {bars.map((bar, index) => (
                  <span key={bar.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-2xs text-muted-foreground">
                    {index % labelEvery === 0 ? formatDayLabel(bar.day) : ""}
                  </span>
                ))}
              </div>
              {series.length > 0 ? (
                <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground" aria-label="Accounts">
                  {series.map((entry) => (
                    <li key={entry.key} className="flex items-center gap-1.5">
                      <span className="size-2.5 shrink-0 rounded-sm" style={{ background: entry.color }} aria-hidden />
                      {entry.label}
                    </li>
                  ))}
                </ul>
              ) : null}
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
            <AdminCard title="By account" description="The model account that served each call">
              <ShareTable rows={accountShareRows(report.data)} label="Spend by account" empty="No spend recorded per account in this period." />
            </AdminCard>
            <AdminCard
              title="Account budgets"
              description="Today and this month (UTC), against each account's budget"
              actions={
                <Link to="/test-cases/settings/ai-model" className="text-sm font-semibold text-primary hover:underline">
                  Manage accounts
                </Link>
              }
            >
              {budgeted.length === 0 ? (
                <p className="text-sm text-muted-foreground">{accounts.isPending ? "Loading…" : "No model accounts."}</p>
              ) : (
                <div className="grid gap-4">
                  {budgeted.map((group) => (
                    <section key={group.provider} className="grid gap-2" aria-label={`${group.label} accounts`}>
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</h3>
                      <ul className="grid gap-3">
                        {group.accounts.map((account) => (
                          <li key={account.id} className="grid gap-1.5">
                            <div className="flex items-start justify-between gap-3">
                              <span className="min-w-0">
                                <TruncatedText className="text-sm font-medium text-foreground">{account.label}</TruncatedText>
                                <span className="font-mono text-xs text-muted-foreground">{account.keyConfigured ? `••••${account.keyLast4 ?? ""}` : "no key"}</span>
                              </span>
                              <AccountStatusBadge account={account} now={now} />
                            </div>
                            <div className="grid gap-1.5">
                              <BudgetMeter label="Today" spentUsd={account.usage.todayUsd} budgetUsd={account.dailyBudgetUsd} />
                              <BudgetMeter label="This month" spentUsd={account.usage.monthUsd} budgetUsd={account.monthlyBudgetUsd} />
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </AdminCard>
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
