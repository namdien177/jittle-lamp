import React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Ban, Info, Users } from "lucide-react";
import type { TestRunDetail, TestRunStep } from "@jittle-lamp/shared";
import { RunStepList, formatCostUsd } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { StatusScreen } from "../components/status-screen";
import { useAccountProfile } from "../queries";
import { useToast } from "../toast";
import { EmbeddedEvidenceViewer } from "./evidence-viewer";
import { Hint } from "../components/ui/tooltip";
import { RunStatusBadge } from "../test-cases/bits";
import { formatDuration, formatRelative } from "../test-cases/list-model";
import { useTestPermissions } from "../test-cases/admin-queries";
import { useCancelTestRun, useTestRun } from "../test-cases/queries";
import { LiveViewPanel } from "../test-runs/live-panel";
import {
  canCancelRun,
  explainBlockedReason,
  failedAsserts,
  formatModelId,
  formatQueuePill,
  formatTokens,
  isRunActive,
  liveScreenshot,
  normalizeRunSteps,
  runProgress,
  toRunStepListSteps
} from "../test-cases/run-model";

// Run detail (design.md §7 "Run detail", §10.4): step list on the left, the shared viewer on the
// run's evidence on the right. While the run is queued or executing the page polls every 2 s and
// shows live step progress with the per-step screenshots. The header stays two short lines so
// the recording keeps most of the screen.
export function TestRunPage(): React.JSX.Element {
  const { runId } = useParams();
  const query = useTestRun(runId ?? null);
  if (!runId) return <StatusScreen tone="error" title="Missing run id" />;
  if (query.isPending) return <StatusScreen loading title="Loading run" />;
  if (query.isError) return <StatusScreen tone="error" title="Unable to load the run" detail={query.error instanceof Error ? query.error.message : "Unknown error"} />;
  return <RunDetailView run={query.data} refreshing={query.isFetching} />;
}

function RunDetailView(props: { run: TestRunDetail; refreshing: boolean }): React.JSX.Element {
  const { run } = props;
  const navigate = useNavigate();
  const toast = useToast();
  const account = useAccountProfile();
  const cancel = useCancelTestRun();
  const [activeStepId, setActiveStepId] = React.useState<string | null>(null);
  const [expandMacros, setExpandMacros] = React.useState(false);
  const [playingStepId, setPlayingStepId] = React.useState<string | null>(null);
  const [actionsContainer, setActionsContainer] = React.useState<HTMLSpanElement | null>(null);
  const active = isRunActive(run.status);
  const listSteps = React.useMemo(() => toRunStepListSteps(run.steps, run.transcript), [run.steps, run.transcript]);
  const stepOffsetsMs = React.useMemo(() => {
    const offsets: Record<string, number> = {};
    for (const step of run.steps) if (step.videoOffsetMs !== null) offsets[step.stepId] = step.videoOffsetMs;
    return offsets;
  }, [run.steps]);
  const failures = failedAsserts(run.steps);
  const stepsById = React.useMemo(() => new Map(normalizeRunSteps(run.steps, run.transcript).map((step) => [step.stepId, step])), [run.steps, run.transcript]);
  const progress = runProgress(run.steps, run.transcript);
  const currentUserIds = [account.data?.localUserId, account.data?.userId].filter((value): value is string => typeof value === "string");
  const permissions = useTestPermissions();
  const canCancelAny = permissions.can("test_run.cancel_any");
  const mayCancel = currentUserIds.some((id) => canCancelRun(run, id, canCancelAny));
  const blockedExplanation = explainBlockedReason(run.blockedReason);
  const queuePill = formatQueuePill(run);
  const caseLink = `/test-cases?case=${encodeURIComponent(run.testCaseId)}`;
  const metrics = run.metrics;
  const runBy = run.createdByName ?? (run.createdBy !== null && currentUserIds.includes(run.createdBy) ? "you" : "unknown");

  // A failed run opens on its first failure: the list expands it and the video seeks there.
  const firstFailureId = failures[0]?.stepId ?? null;
  const openedOnFailure = React.useRef(false);
  React.useEffect(() => {
    if (openedOnFailure.current || !run.evidenceId || !firstFailureId) return;
    openedOnFailure.current = true;
    setActiveStepId((current) => current ?? firstFailureId);
  }, [run.evidenceId, firstFailureId]);

  const requestCancel = () =>
    cancel.mutate(
      { runId: run.id, testCaseId: run.testCaseId },
      {
        onSuccess: () => toast.success("Cancel requested", "The runner stops after the current step."),
        onError: (error) => toast.error("Cancel failed", error instanceof Error ? error.message : undefined)
      }
    );

  return (
    <div className="jl-tc-scope grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-2">
        <Link to={caseLink} className="jl-tc-press inline-flex shrink-0 items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden /> {run.testCaseKey}
        </Link>
        <h1 className="min-w-0 truncate text-base font-semibold tracking-[-0.01em]" title={run.testCaseTitle}>
          {run.testCaseTitle}
        </h1>
        <RunStatusBadge run={run} />
        {run.status === "cancelled" ? <Badge variant="muted" className="px-1.5 py-0 text-xs">cancelled</Badge> : null}
        {run.flaky ? <Badge variant="warning" className="px-1.5 py-0 text-xs">flaky</Badge> : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {formatRelative(run.queuedAt)} · {formatDuration(metrics.durationMs)} · {metrics.costUsd === null ? "—" : formatCostUsd(metrics.costUsd)}
        </span>
        <Hint label={<RunDetails run={run} who={runBy} />} side="bottom" align="start">
          <button type="button" className="jl-tc-press grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Run details">
            <Info className="size-3.5" aria-hidden />
          </button>
        </Hint>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {props.refreshing && active ? <span className="text-xs text-muted-foreground">updating…</span> : null}
          <span ref={setActionsContainer} className="flex items-center" />
          {mayCancel ? (
            <Button size="xs" variant="destructive" className="jl-tc-press" onClick={requestCancel} disabled={cancel.isPending}>
              <Ban aria-hidden /> {cancel.isPending ? "Cancelling…" : "Cancel run"}
            </Button>
          ) : null}
        </span>
      </header>

      <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[380px_minmax(0,1fr)]">
        <aside className="jl-scroll flex min-h-0 flex-col gap-2 overflow-y-auto border-r border-border px-2 py-2" aria-label="Run steps">
          {run.outcome === "blocked" || run.blockedReason ? (
            <section role="alert" className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2">
              <p className="font-mono text-sm font-semibold text-foreground">{run.blockedReason ?? "BLOCKED"}</p>
              <p className="mt-1 text-sm leading-relaxed text-foreground/85">{blockedExplanation ?? "The run could not judge the app."}</p>
              {run.error ? <p className="mt-1 font-mono text-xs text-muted-foreground">{run.error}</p> : null}
            </section>
          ) : run.error ? (
            <section role="alert" className="rounded-md border border-destructive/45 bg-destructive/10 px-3 py-2 font-mono text-sm">
              {run.error}
            </section>
          ) : null}

          {active ? (
            <section className="rounded-md border border-border bg-card/40 px-3 py-2 text-sm" aria-live="polite">
              {run.status === "queued" ? (
                <p className="font-mono text-sm">{queuePill ?? "queued"}</p>
              ) : (
                <p>
                  <span className="jl-tc-pulse mr-1.5 inline-block size-2 rounded-full bg-primary align-middle" aria-hidden />
                  {run.status === "paused" ? "Paused" : "Running"} · step {Math.min(progress.done + 1, progress.total)} of {progress.total}
                </p>
              )}
              {run.subscribers.length > 1 ? (
                <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                  <Users className="size-3.5" aria-hidden /> attached: {run.subscribers.map((subscriber) => subscriber.name ?? subscriber.userId).join(", ")}
                </p>
              ) : null}
            </section>
          ) : null}

          {failures.length > 0 && !run.evidenceId ? (
            <section className="flex flex-col gap-2" aria-label="Failed asserts">
              {failures.map((failure) => (
                <button
                  key={failure.stepId}
                  type="button"
                  className={cn("jl-tc-press rounded-md border px-2.5 py-2 text-left", activeStepId === failure.stepId ? "border-destructive/60 bg-destructive/12" : "border-destructive/35 bg-destructive/6 hover:bg-destructive/10")}
                  onClick={() => setActiveStepId(failure.stepId)}
                >
                  <ExpectedObserved expected={failure.expected} observed={failure.observed} error={failure.error} screenshotUrl={failure.screenshotUrl} />
                </button>
              ))}
            </section>
          ) : null}

          <div className="flex items-center justify-between px-2 pt-1 text-xs text-muted-foreground">
            <span>{progress.done === progress.total ? `${progress.total} steps` : `${progress.done} of ${progress.total} steps`}</span>
            {run.steps.some((step) => step.parentStepId !== null) ? (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--primary)]" checked={expandMacros} onChange={(event) => setExpandMacros(event.currentTarget.checked)} />
                Macro steps
              </label>
            ) : null}
          </div>
          <RunStepList
            steps={listSteps}
            activeStepId={activeStepId}
            playingStepId={playingStepId}
            meta="duration"
            expandMacros={expandMacros}
            screenshots={run.evidenceId ? "active" : "all"}
            onSelect={(step) => setActiveStepId((current) => (current === step.stepId ? null : step.stepId))}
            renderDetail={(step) => {
              const detail = stepsById.get(step.stepId);
              return detail ? <SelectedStep step={detail} /> : null;
            }}
          />
        </aside>

        <section className="jl-tc-run-pane flex min-h-0 min-w-0 flex-col" aria-label="Run evidence">
          {run.evidenceId ? (
            <EmbeddedEvidenceViewer
              evidenceId={run.evidenceId}
              activeStepId={activeStepId}
              onActiveStepIdChange={setActiveStepId}
              stepOffsetsMs={stepOffsetsMs}
              onPlayingStepIdChange={setPlayingStepId}
              actionsContainer={actionsContainer}
              onClose={() => navigate(caseLink)}
            />
          ) : active && run.status !== "queued" ? (
            <LiveViewPanel run={run} currentUserIds={currentUserIds} canCancelAny={canCancelAny} fallback={<LivePanel run={run} />} />
          ) : active ? (
            <LivePanel run={run} />
          ) : (
            <div className="grid flex-1 place-items-center p-8 text-center text-base text-muted-foreground">
              No evidence was uploaded for this run{run.status === "cancelled" ? " (cancelled)" : ""}.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ExpectedObserved(props: { expected: string; observed: string | null; error: string | null; screenshotUrl: string | null }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-1 text-sm">
      <span className="text-muted-foreground">Expected</span>
      <span className="text-foreground">{props.expected}</span>
      <span className="text-muted-foreground">Observed</span>
      <span className="text-destructive">{props.observed ?? props.error ?? "No observation recorded."}</span>
      {props.screenshotUrl ? <img src={props.screenshotUrl} alt="Screen when the assert failed" className="col-span-2 mt-1 max-h-32 rounded border border-border object-contain object-left" loading="lazy" /> : null}
    </div>
  );
}

// Under the selected step in the list: how it ran. The row above already shows label and result.
function SelectedStep(props: { step: TestRunStep }): React.JSX.Element {
  const { step } = props;
  return (
    <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground" aria-label={`Step ${step.ordinal} details`}>
      <dt>Mode</dt>
      <dd className="text-foreground">{step.mode ?? "—"}{step.cacheReason && step.cacheReason !== "hit" ? ` · cache: ${step.cacheReason}` : ""}</dd>
      <dt>Model</dt>
      <dd className="text-foreground">
        {step.usage.modelCalls} call{step.usage.modelCalls === 1 ? "" : "s"} · {formatTokens(step.usage.inputTokens + step.usage.outputTokens)} tokens · {step.usage.costUsd === null ? "—" : formatCostUsd(step.usage.costUsd)}
      </dd>
      {step.observed && step.status !== "failed" ? (
        <>
          <dt>Observed</dt>
          <dd className="text-foreground/85">{step.observed}</dd>
        </>
      ) : null}
    </dl>
  );
}

// Everything about the run that is not needed to review it, behind the header's info button.
function RunDetails(props: { run: TestRunDetail; who: string }): React.JSX.Element {
  const { run } = props;
  const metrics = run.metrics;
  const rows: Array<[string, string]> = [
    ["Version", `v${run.transcriptVersion}`],
    ["Trigger", `${run.trigger} by ${props.who}`],
    ["Environment", run.environmentName ?? "none"],
    ["Runner", `pool ${run.runnerPool} · cache ${run.cacheMode}`],
    ...(metrics.modelId === metrics.judgeModelId
      ? ([["Model", metrics.modelId ?? "—"]] as Array<[string, string]>)
      : ([
          ["Act model", metrics.modelId ?? "—"],
          ["Judge model", metrics.judgeModelId ?? "—"]
        ] as Array<[string, string]>)),
    ["Tokens", `${formatTokens(metrics.inputTokens)} in · ${formatTokens(metrics.outputTokens)} out · ${metrics.modelCalls} calls`],
    ["Steps", `${metrics.stepsReplayed}/${metrics.stepsTotal} replayed · ${metrics.stepsAgent} agent · ${metrics.stepsHandoff} hand-off`]
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="whitespace-nowrap tabular-nums">{value}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function LivePanel(props: { run: TestRunDetail }): React.JSX.Element {
  const shot = liveScreenshot(props.run);
  const current = normalizeRunSteps(props.run.steps, props.run.transcript).find((step) => step.stepId === props.run.currentStepId) ?? null;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-[#0d0e10] p-6 text-white/85">
      {shot ? (
        <img src={shot.url} alt={`Screen after: ${shot.label}`} className="max-h-[70vh] max-w-full rounded-md border border-white/10 object-contain shadow-2xl" />
      ) : (
        <p className="text-base text-white/60">{props.run.status === "queued" ? formatQueuePill(props.run) ?? "Waiting for a runner…" : "Waiting for the first screenshot…"}</p>
      )}
      <p className="text-sm text-white/70" aria-live="polite">
        {current ? `Now: ${current.label}` : shot ? shot.label : ""}
      </p>
    </div>
  );
}
