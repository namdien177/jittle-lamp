import React, { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate } from "react-router";
import { ArrowLeft, PlayCircle } from "lucide-react";

import { RunStepList, type RunStepListStep } from "@jittle-lamp/ui";

import { describeRunState, didRunSettle, isRunActive, type LiveRunState } from "../test-runs/live-run";
import { describeBlockedReason, summarizeMetrics } from "../test-runs/run-format";
import { testQueryKeys, useLiveRun, useTestApi, useTestRuns } from "../test-runs/test-api-context";
import { useToast } from "../ui/toast";
import { formatRelativeTime } from "../utils";
import { RunTable } from "./test-cases-page";

export function TestRunsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const runsQuery = useTestRuns();
  const runs = runsQuery.data?.items ?? [];
  return (
    <div className="page test-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Test runs</h1>
          <p className="page-subtitle">Runs queued by you and your organisation, newest first. Open one to follow its steps or review its recording.</p>
        </div>
        <button className="button ghost sm" type="button" onClick={() => void runsQuery.refetch()} disabled={runsQuery.isFetching}>
          {runsQuery.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {runsQuery.error ? <div className="auth-error">{runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load runs."}</div> : null}
      {runs.length === 0 && !runsQuery.error ? (
        <div className="empty-state">
          <PlayCircle aria-hidden size={22} strokeWidth={1.6} />
          <h3>{runsQuery.isLoading ? "Loading runs…" : "No runs yet"}</h3>
          <p>Queue a run from a test case. It runs on the runner pool of its environment.</p>
        </div>
      ) : runs.length > 0 ? (
        <div className="card">
          <RunTable runs={runs} showCase onOpen={(runId) => navigate(`/test-runs/${encodeURIComponent(runId)}`)} />
        </div>
      ) : null}
    </div>
  );
}

export type OpenRunEvidence = (evidenceId: string, options: { stepId: string | null; fallbackOffsetMs: number | null }) => Promise<void>;

export function TestRunPage(props: { runId: string; openEvidence: OpenRunEvidence }): React.JSX.Element {
  const api = useTestApi();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { state, refresh } = useLiveRun(props.runId);
  const [activeStepId, setActiveStepId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [opening, setOpening] = useState(false);
  const previous = useRef<LiveRunState>(state);

  useEffect(() => {
    if (didRunSettle(previous.current, state) && state.run) {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.caseRuns(state.run.testCaseId) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs() });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.notifications() });
    }
    previous.current = state;
  }, [queryClient, state]);

  const run = state.run;
  if (!run) {
    return (
      <div className="page test-page">
        <BackLink />
        {state.phase === "error" ? (
          <div className="column" style={{ gap: 8 }}>
            <div className="auth-error">{state.error}</div>
            <button className="button secondary sm" type="button" onClick={refresh} style={{ alignSelf: "flex-start" }}>
              Retry
            </button>
          </div>
        ) : (
          <div className="skeleton-row" style={{ height: 120 }} />
        )}
      </div>
    );
  }

  const label = describeRunState(run);
  const active = isRunActive(run.status);
  const others = run.subscribers.filter((subscriber) => subscriber.userId !== run.createdBy);

  const openStep = async (step: RunStepListStep | null): Promise<void> => {
    if (!run.evidenceId) return;
    setOpening(true);
    try {
      await props.openEvidence(run.evidenceId, { stepId: step?.stepId ?? null, fallbackOffsetMs: step?.videoOffsetMs ?? null });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to open the recording.");
    } finally {
      setOpening(false);
    }
  };

  const cancel = async (): Promise<void> => {
    setCancelling(true);
    try {
      await api.cancelRun(run.id);
      toast.info("Cancellation requested. The runner stops after the current action.");
      refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to cancel the run.");
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="page test-page">
      <BackLink />
      <header className="run-header">
        <div className="column" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`chip ${label.tone}`} data-live={active}>
              {active ? <span className="run-live-dot" aria-hidden /> : null}
              {label.text}
            </span>
            <NavLink to={`/test-cases/${encodeURIComponent(run.testCaseId)}`} className="mono tc-key">
              {run.testCaseKey}
            </NavLink>
            <span className="chip neutral">v{run.transcriptVersion}</span>
            {run.flaky ? <span className="chip warning">flaky</span> : null}
          </div>
          <h1 className="page-title">{run.testCaseTitle}</h1>
          <span className="muted run-header-meta">
            {run.environmentName ?? "case default"} · pool {run.runnerPool} · {run.trigger} by {run.createdByName ?? "someone"} ·
            queued {formatRelativeTime(run.queuedAt)}
            {active ? " · updates every 2 s" : ""}
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {active ? (
            <button className="button danger sm" type="button" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          ) : null}
          {run.evidenceId ? (
            <button className="button primary sm" type="button" onClick={() => void openStep(null)} disabled={opening}>
              {opening ? "Opening…" : "Open recording"}
            </button>
          ) : null}
        </div>
      </header>

      {run.blockedReason ? (
        <div className="run-banner" data-tone="warning" role="status">
          <strong>{run.status === "queued" ? "Waiting" : "Blocked"} · {run.blockedReason}</strong>
          <span>{describeBlockedReason(run.blockedReason)}</span>
        </div>
      ) : null}
      {run.status === "queued" && !run.blockedReason ? (
        <div className="run-banner" data-tone="neutral" role="status">
          <strong>{label.text}</strong>
          <span>
            {run.estimatedStartAt ? `Estimated start ${formatRelativeTime(run.estimatedStartAt)}.` : "Waiting for a free runner."}
          </span>
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="run-banner" data-tone="accent" role="status">
          <strong>Attached · {run.subscribers.length} waiting</strong>
          <span>Also following this run: {others.map((subscriber) => subscriber.name ?? "a teammate").join(", ")}.</span>
        </div>
      ) : null}
      {run.error ? (
        <div className="run-banner" data-tone="danger" role="alert">
          <strong>Run error</strong>
          <span>{run.error}</span>
        </div>
      ) : null}
      {state.phase === "error" ? (
        <div className="run-banner" data-tone="warning" role="status">
          <strong>Connection problem</strong>
          <span>{state.error} Retrying…</span>
        </div>
      ) : null}

      <div className="run-metrics">
        {summarizeMetrics(run.metrics).map((metric) => (
          <div key={metric.label} className="run-metric">
            <span className="detail-label">{metric.label}</span>
            <span className="run-metric-value">{metric.value}</span>
          </div>
        ))}
      </div>

      <section className="card">
        <div className="card-header">
          <h3 className="card-title">Steps</h3>
          <span className="muted" style={{ fontSize: 11 }}>
            {run.evidenceId
              ? "Select a step to open the recording at that step, filtered to its actions."
              : active
                ? "The recording attaches when the run finishes."
                : "This run has no recording."}
          </span>
        </div>
        <div className="card-section">
          {run.steps.length === 0 ? (
            <p className="muted">Steps appear once a runner claims the run.</p>
          ) : (
            <RunStepList
              steps={run.steps}
              activeStepId={activeStepId ?? run.currentStepId}
              onSelect={(step) => {
                setActiveStepId(step.stepId);
                void openStep(step);
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function BackLink(): React.JSX.Element {
  return (
    <NavLink to="/test-runs" className="run-back">
      <ArrowLeft aria-hidden size={14} strokeWidth={2} />
      <span>Test runs</span>
    </NavLink>
  );
}
