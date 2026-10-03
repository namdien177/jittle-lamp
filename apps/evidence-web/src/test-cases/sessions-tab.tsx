import React from "react";
import { Link } from "react-router";
import type { TestCaseDetail, TestRunSummary } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { RunStatusBadge } from "./bits";
import { formatCost, formatDuration, formatRelative } from "./list-model";
import { useAccountProfile } from "../queries";
import { useTestCaseRuns } from "./queries";
import { cacheHitRatio, formatQueuePill } from "./run-model";
import { Hint, TruncatedText } from "../components/ui/tooltip";

// Test sessions tab: every run of the case with queue state, attachment, flakiness, cost and the
// evidence it produced (design.md §7, §10.4).
export function SessionsTab(props: { detail: TestCaseDetail }): React.JSX.Element {
  const runsQuery = useTestCaseRuns(props.detail.id);
  const runs = runsQuery.data?.items ?? [];
  const account = useAccountProfile();
  const me = [account.data?.localUserId, account.data?.userId].filter((value): value is string => typeof value === "string");

  if (runsQuery.isPending) return <p className="py-6 text-base text-muted-foreground">Loading test sessions…</p>;
  if (runsQuery.isError) return <p className="py-6 text-base text-destructive">{runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load runs."}</p>;
  if (runs.length === 0) return <p className="py-6 text-base text-muted-foreground">No runs yet. Press r or use Run to queue the first one.</p>;

  return (
    <div className="jl-scroll overflow-x-auto">
      <table className="w-full border-collapse text-sm" aria-label="Test sessions">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 font-medium">Run</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Status</th>
            <th scope="col" className="py-1.5 pr-3 font-medium">Trigger · pool</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">Time · cache · cost</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <SessionRow key={run.id} run={run} me={me} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionRow(props: { run: TestRunSummary; me: readonly string[] }): React.JSX.Element {
  const { run } = props;
  const ratio = cacheHitRatio(run.metrics);
  const pill = formatQueuePill(run);
  const others = run.subscribers.filter((subscriber) => subscriber.userId !== run.createdBy);
  const requester = run.createdByName ?? (run.createdBy !== null && props.me.includes(run.createdBy) ? "you" : "unknown");
  const duration = run.metrics.durationMs ?? (run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null);
  return (
    <tr className="jl-tc-row border-b border-border/60 align-top hover:bg-muted/50">
      <td className="max-w-[180px] py-2 pr-3">
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <Link to={`/test-runs/${encodeURIComponent(run.id)}`} className="font-medium text-foreground underline-offset-2 hover:underline">
            {formatRelative(run.queuedAt)} · v{run.transcriptVersion}
          </Link>
          {run.evidenceId ? (
            <Link to={`/evidence/${encodeURIComponent(run.evidenceId)}`} className="text-xs text-primary underline-offset-2 hover:underline" aria-label="Open the run's evidence">
              evidence
            </Link>
          ) : null}
        </div>
        <TruncatedText render={<div />} className="text-xs text-muted-foreground">
          {requester}
          {run.environmentName ? ` · ${run.environmentName}` : ""}
        </TruncatedText>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap items-center gap-1">
          <RunStatusBadge run={run} />
          {run.flaky ? (
            <Hint label="Passed only after a retry">
              <Badge variant="warning" className="px-1.5 py-0 text-xs">flaky</Badge>
            </Hint>
          ) : null}
          {others.length > 0 ? (
            <Hint label={`Also waiting: ${others.map((person) => person.name ?? person.userId).join(", ")}`}>
              <Badge variant="outline" className="px-1.5 py-0 text-xs">attached · {others.length}</Badge>
            </Hint>
          ) : null}
        </div>
        {pill ? <div className="mt-1 whitespace-nowrap font-mono text-xs text-muted-foreground">{pill}</div> : null}
        {run.blockedReason ? <div className="mt-1 font-mono text-xs text-warning">{run.blockedReason}</div> : null}
      </td>
      <td className="py-2 pr-3 text-muted-foreground">
        <div>{run.trigger}</div>
        <TruncatedText render={<div />} className="max-w-[140px] font-mono text-xs">
          {run.runnerPool}
        </TruncatedText>
      </td>
      <td className="whitespace-nowrap py-2 pr-3 text-right font-mono text-sm tabular-nums">
        <div>{formatDuration(duration)}</div>
        <Hint label={`${run.metrics.stepsReplayed} replayed · ${run.metrics.stepsAgent} agent · ${run.metrics.stepsHandoff} hand-off`}>
          <div className="text-muted-foreground">{ratio === null ? "—" : `${Math.round(ratio * 100)}% replayed`}</div>
        </Hint>
        <div className="text-muted-foreground">{formatCost(run.metrics.costUsd)}</div>
      </td>
    </tr>
  );
}
