import React from "react";
import { Link } from "react-router";
import type { TestCaseDetail, TestRunSummary } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { RunStatusBadge } from "./bits";
import { formatCost, formatDuration, formatRelative } from "./list-model";
import { useTestCaseRuns } from "./queries";
import { cacheHitRatio, formatQueuePill } from "./run-model";

// Test sessions tab: every run of the case with queue state, attachment, flakiness, cost and the
// evidence it produced (design.md §7, §10.4).
export function SessionsTab(props: { detail: TestCaseDetail }): React.JSX.Element {
  const runsQuery = useTestCaseRuns(props.detail.id);
  const runs = runsQuery.data?.items ?? [];

  if (runsQuery.isPending) return <p className="py-6 text-[13.5px] text-muted-foreground">Loading test sessions…</p>;
  if (runsQuery.isError) return <p className="py-6 text-[13.5px] text-destructive">{runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load runs."}</p>;
  if (runs.length === 0) return <p className="py-6 text-[13.5px] text-muted-foreground">No runs yet. Press r or use Run to queue the first one.</p>;

  return (
    <div className="jl-scroll overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" aria-label="Test sessions">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">Run</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Status</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Trigger · pool</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Duration</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium whitespace-nowrap">Cache hit</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Cost</th>
            <th scope="col" className="py-1.5 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <SessionRow key={run.id} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionRow(props: { run: TestRunSummary }): React.JSX.Element {
  const { run } = props;
  const ratio = cacheHitRatio(run.metrics);
  const pill = formatQueuePill(run);
  const others = run.subscribers.filter((subscriber) => subscriber.userId !== run.createdBy);
  const duration = run.metrics.durationMs ?? (run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null);
  return (
    <tr className="jl-tc-row border-b border-border/60 align-top hover:bg-muted/50">
      <td className="max-w-[180px] py-2 pr-3">
        <Link to={`/test-runs/${encodeURIComponent(run.id)}`} className="whitespace-nowrap font-medium text-foreground underline-offset-2 hover:underline">
          {formatRelative(run.queuedAt)} · v{run.transcriptVersion}
        </Link>
        <div className="truncate text-[12px] text-muted-foreground" title={`${run.createdByName ?? "Unknown"}${run.environmentName ? ` · ${run.environmentName}` : ""}`}>
          {run.createdByName ?? "Unknown"}
          {run.environmentName ? ` · ${run.environmentName}` : ""}
        </div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap items-center gap-1">
          <RunStatusBadge run={run} />
          {run.flaky ? (
            <Badge variant="warning" className="px-1.5 py-0 text-[11px]" title="Passed only after a retry">
              flaky
            </Badge>
          ) : null}
          {others.length > 0 ? (
            <Badge variant="outline" className="px-1.5 py-0 text-[11px]" title={`Also waiting: ${others.map((person) => person.name ?? person.userId).join(", ")}`}>
              attached · {others.length}
            </Badge>
          ) : null}
        </div>
        {pill ? <div className="mt-1 whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">{pill}</div> : null}
        {run.blockedReason ? <div className="mt-1 font-mono text-[11.5px] text-warning">{run.blockedReason}</div> : null}
      </td>
      <td className="py-2 pr-3 text-muted-foreground">
        <div>{run.trigger}</div>
        <div className="max-w-[140px] truncate font-mono text-[11.5px]" title={run.runnerPool}>
          {run.runnerPool}
        </div>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono tabular-nums">{formatDuration(duration)}</td>
      <td className="py-2 pr-3 text-right font-mono tabular-nums" title={`${run.metrics.stepsReplayed} replayed · ${run.metrics.stepsAgent} agent · ${run.metrics.stepsHandoff} hand-off`}>
        {ratio === null ? "—" : `${Math.round(ratio * 100)}%`}
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono tabular-nums">{formatCost(run.metrics.costUsd)}</td>
      <td className="py-2">
        {run.evidenceId ? (
          <Link to={`/evidence/${encodeURIComponent(run.evidenceId)}`} className="text-primary underline-offset-2 hover:underline">
            Evidence
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}
