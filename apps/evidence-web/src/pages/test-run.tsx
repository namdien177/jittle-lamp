import React from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowLeft, Ban, Users } from "lucide-react";
import type { TestRunDetail, TestRunStep } from "@jittle-lamp/shared";
import { RunStepList, formatCostUsd, formatStepDuration } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { StatusScreen } from "../components/status-screen";
import { useAccountProfile } from "../queries";
import { useToast } from "../toast";
import { EmbeddedEvidenceViewer } from "./evidence-viewer";
import { RunStatusBadge, Stat } from "../test-cases/bits";
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
// shows live step progress with the per-step screenshots.
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
  const active = isRunActive(run.status);
  const listSteps = React.useMemo(() => toRunStepListSteps(run.steps, run.transcript), [run.steps, run.transcript]);
  const stepOffsetsMs = React.useMemo(() => {
    const offsets: Record<string, number> = {};
    for (const step of run.steps) if (step.videoOffsetMs !== null) offsets[step.stepId] = step.videoOffsetMs;
    return offsets;
  }, [run.steps]);
  const failures = failedAsserts(run.steps);
  const selected = normalizeRunSteps(run.steps, run.transcript).find((step) => step.stepId === activeStepId) ?? null;
  const progress = runProgress(run.steps, run.transcript);
  const currentUserIds = [account.data?.localUserId, account.data?.userId].filter((value): value is string => typeof value === "string");
  const permissions = useTestPermissions();
  const canCancelAny = permissions.can("test_run.cancel_any");
  const mayCancel = currentUserIds.some((id) => canCancelRun(run, id, canCancelAny));
  const blockedExplanation = explainBlockedReason(run.blockedReason);
  const queuePill = formatQueuePill(run);
  const caseLink = `/test-cases?case=${encodeURIComponent(run.testCaseId)}`;
  const metrics = run.metrics;

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
      <header className="flex flex-col gap-2 border-b border-border px-5 py-3">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Link to={caseLink} className="jl-tc-press inline-flex items-center gap-1 rounded hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden /> {run.testCaseKey}
          </Link>
          <span>/</span>
          <span className="truncate text-foreground">{run.testCaseTitle}</span>
          <span>· v{run.transcriptVersion}</span>
          <span className="ml-auto flex items-center gap-2">
            {props.refreshing && active ? <span className="text-xs">updating…</span> : null}
            {mayCancel ? (
              <Button size="xs" variant="destructive" className="jl-tc-press" onClick={requestCancel} disabled={cancel.isPending}>
                <Ban aria-hidden /> {cancel.isPending ? "Cancelling…" : "Cancel run"}
              </Button>
            ) : null}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Run {formatRelative(run.queuedAt)}</h1>
          <RunStatusBadge run={run} />
          {run.status === "completed" || run.status === "failed" || run.status === "cancelled" ? <Badge variant="muted" className="px-1.5 py-0 text-xs">{run.status}</Badge> : null}
          {run.flaky ? <Badge variant="warning" className="px-1.5 py-0 text-xs">flaky</Badge> : null}
          <span className="text-sm text-muted-foreground">
            {run.trigger} · {run.createdByName ?? (run.createdBy !== null && currentUserIds.includes(run.createdBy) ? "you" : "unknown")} · {run.environmentName ?? "no environment"} · pool {run.runnerPool} · cache {run.cacheMode}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-7 gap-y-2" aria-label="Run metrics">
          <Stat label="Act model" value={formatModelId(metrics.modelId)} {...(metrics.modelId ? { hint: metrics.modelId } : {})} />
          <Stat label="Judge model" value={formatModelId(metrics.judgeModelId)} {...(metrics.judgeModelId ? { hint: metrics.judgeModelId } : {})} />
          <Stat
            label="Tokens"
            value={`${formatTokens(metrics.inputTokens)} in · ${formatTokens(metrics.outputTokens)} out`}
            hint={`${metrics.cachedInputTokens} cached input · ${metrics.reasoningTokens} reasoning · ${metrics.modelCalls} model calls`}
          />
          <Stat label="Cost" value={metrics.costUsd === null ? "—" : formatCostUsd(metrics.costUsd)} {...(metrics.priceTableVersion ? { hint: `price table ${metrics.priceTableVersion}` } : {})} />
          <Stat label="Duration" value={formatDuration(metrics.durationMs)} />
          <Stat label="Replayed" value={`${metrics.stepsReplayed} / ${metrics.stepsTotal}`} hint="Steps replayed from cached scripts with zero model calls" />
          <Stat label="Agent" value={metrics.stepsAgent} />
          <Stat label="Hand-off" value={metrics.stepsHandoff} hint="Cached script failed and the agent took over" />
        </div>
      </header>

      <div className="grid min-h-0 grid-cols-1 lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
        <aside className="jl-scroll flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-border px-4 py-3" aria-label="Run steps">
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

          {failures.length > 0 ? (
            <section className="flex flex-col gap-2" aria-label="Failed asserts">
              {failures.map((failure) => (
                <button
                  key={failure.stepId}
                  type="button"
                  className={cn("jl-tc-press rounded-md border px-3 py-2 text-left", activeStepId === failure.stepId ? "border-destructive/60 bg-destructive/12" : "border-destructive/35 bg-destructive/6 hover:bg-destructive/10")}
                  onClick={() => setActiveStepId(failure.stepId)}
                >
                  <ExpectedObserved expected={failure.expected} observed={failure.observed} error={failure.error} screenshotUrl={failure.screenshotUrl} />
                </button>
              ))}
            </section>
          ) : null}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {progress.done} of {progress.total} steps
            </span>
            {run.steps.some((step) => step.parentStepId !== null) ? (
              <label className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--primary)]" checked={expandMacros} onChange={(event) => setExpandMacros(event.currentTarget.checked)} />
                Show macro steps
              </label>
            ) : null}
          </div>
          <RunStepList steps={listSteps} activeStepId={activeStepId} expandMacros={expandMacros} screenshots={run.evidenceId ? "active" : "all"} onSelect={(step) => setActiveStepId((current) => (current === step.stepId ? null : step.stepId))} />

          {selected ? <SelectedStep step={selected} /> : null}
        </aside>

        <section className="jl-tc-run-pane flex min-h-0 min-w-0 flex-col" aria-label="Run evidence">
          {run.evidenceId ? (
            <EmbeddedEvidenceViewer
              evidenceId={run.evidenceId}
              activeStepId={activeStepId}
              onActiveStepIdChange={setActiveStepId}
              stepOffsetsMs={stepOffsetsMs}
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
      {props.screenshotUrl ? <img src={props.screenshotUrl} alt="Screen when the assert failed" className="col-span-2 mt-1 max-h-48 rounded border border-border object-contain" loading="lazy" /> : null}
    </div>
  );
}

function SelectedStep(props: { step: TestRunStep }): React.JSX.Element {
  const { step } = props;
  return (
    <section className="rounded-md border border-border bg-card/40 px-3 py-2 text-sm" aria-label={`Step ${step.ordinal} details`}>
      <p className="font-semibold text-foreground">
        {step.ordinal}. [{step.type}] {step.label}
      </p>
      <dl className="mt-1 grid grid-cols-[96px_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
        <dt>Mode</dt>
        <dd className="text-foreground">{step.mode ?? "—"}{step.cacheReason && step.cacheReason !== "hit" ? ` · cache: ${step.cacheReason}` : ""}</dd>
        <dt>Duration</dt>
        <dd className="text-foreground">{formatStepDuration(step.durationMs) || "—"}</dd>
        <dt>Video at</dt>
        <dd className="font-mono text-foreground">{step.videoOffsetMs === null ? "—" : formatDuration(step.videoOffsetMs)}</dd>
        <dt>Model</dt>
        <dd className="text-foreground">
          {step.usage.modelCalls} call{step.usage.modelCalls === 1 ? "" : "s"} · {formatTokens(step.usage.inputTokens + step.usage.outputTokens)} tokens · {step.usage.costUsd === null ? "—" : formatCostUsd(step.usage.costUsd)}
        </dd>
      </dl>
      {step.status === "failed" && (step.type === "assert" || step.type === "wait") ? (
        <div className="mt-2">
          <ExpectedObserved expected={step.label} observed={step.observed} error={step.error ? `${step.error.code}: ${step.error.message}` : null} screenshotUrl={step.screenshotUrl} />
        </div>
      ) : step.observed ? (
        <p className="mt-1 text-foreground/85">{step.observed}</p>
      ) : null}
    </section>
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
