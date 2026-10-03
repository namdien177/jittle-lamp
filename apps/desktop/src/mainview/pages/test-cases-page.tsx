import React, { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { ExternalLink, FlaskConical, Play, Search } from "lucide-react";

import {
  builtinStepTags,
  parseTestCaseTranscript,
  type CreateTestRunResponse,
  type TestCaseDetail,
  type TestCaseStatus,
  type TestCaseSummary,
  type TestRunSummary,
  type TranscriptStep
} from "@jittle-lamp/shared";

import { isExternalHttpUrl } from "../../deep-link";
import { describeRunState } from "../test-runs/live-run";
import { webPaths } from "../test-runs/web-links";
import { formatCostUsd, formatPercent, formatStepDuration } from "../test-runs/run-format";
import {
  testQueryKeys,
  useCaseRuns,
  useTestApi,
  useTestCase,
  useTestCases,
  useOpenInWeb,
  useTestEnvironments
} from "../test-runs/test-api-context";
import { useToast } from "../ui/toast";
import { formatRelativeTime } from "../utils";

const statusFilters: Array<{ label: string; value: TestCaseStatus[] | null }> = [
  { label: "All", value: null },
  { label: "Active", value: ["active"] },
  { label: "Review", value: ["review"] },
  { label: "Draft", value: ["draft"] }
];

const statusTone: Record<TestCaseStatus, string> = {
  active: "success",
  review: "warning",
  draft: "neutral",
  archived: "neutral"
};

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function TestCasesPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { caseId } = useParams<{ caseId: string }>();
  const [search, setSearch] = useState("");
  const [statusIndex, setStatusIndex] = useState(0);
  const q = useDebounced(search, 250);
  const status = statusFilters[statusIndex]?.value ?? null;
  const filter = useMemo(() => ({ q, ...(status ? { status } : {}), limit: 200 }), [q, status]);
  const casesQuery = useTestCases(filter);
  const web = useOpenInWeb();
  const items = casesQuery.data?.items ?? [];
  const selectedId = caseId ?? null;
  const error = casesQuery.error instanceof Error ? casesQuery.error.message : null;

  return (
    <div className="page test-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Test cases</h1>
          <p className="page-subtitle">
            Runs execute on your organisation&apos;s runner pool. Queue a run from here, follow its steps live and review the
            recording when it finishes.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="button ghost sm button-label-with-icon" type="button" onClick={() => web.openPath(webPaths.reviewQueue())}>
            <ExternalLink aria-hidden size={13} strokeWidth={2} />
            Review queue
          </button>
          <button className="button ghost sm button-label-with-icon" type="button" onClick={() => web.openPath(webPaths.importCases())}>
            <ExternalLink aria-hidden size={13} strokeWidth={2} />
            Import
          </button>
          <button className="button ghost sm" type="button" onClick={() => void casesQuery.refetch()} disabled={casesQuery.isFetching}>
            {casesQuery.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="tc-layout">
        <section className="card tc-list" aria-label="Test case list">
          <div className="tc-list-toolbar">
            <div className="search-input-wrap">
              <Search className="search-input-icon" aria-hidden size={14} strokeWidth={2} />
              <input
                type="search"
                className="input search-input"
                placeholder="Search key, title or steps…"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div className="segmented" role="group" aria-label="Status">
                {statusFilters.map((option, index) => (
                  <button key={option.label} type="button" data-active={index === statusIndex} onClick={() => setStatusIndex(index)}>
                    {option.label}
                  </button>
                ))}
              </div>
              <span className="muted" style={{ fontSize: 11 }}>
                {casesQuery.data ? `${casesQuery.data.total} case${casesQuery.data.total === 1 ? "" : "s"}` : ""}
              </span>
            </div>
          </div>
          {error ? <div className="auth-error tc-list-message">{error}</div> : null}
          {items.length === 0 && !error ? (
            <div className="tc-list-message muted">{casesQuery.isLoading ? "Loading test cases…" : "No test cases match."}</div>
          ) : null}
          <ul className="tc-rows">
            {items.map((item) => (
              <li key={item.id}>
                <TestCaseRow item={item} selected={item.id === selectedId} onSelect={() => navigate(`/test-cases/${encodeURIComponent(item.id)}`)} />
              </li>
            ))}
          </ul>
        </section>

        <section className="tc-detail">
          {selectedId ? (
            <TestCaseDetailPanel testCaseId={selectedId} />
          ) : (
            <div className="empty-state">
              <FlaskConical aria-hidden size={22} strokeWidth={1.6} />
              <h3>Select a test case</h3>
              <p>Its steps, the configuration it needs and its recent runs appear here.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function TestCaseRow(props: { item: TestCaseSummary; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const { item } = props;
  const outcome = item.stats.lastOutcome;
  return (
    <button type="button" className="tc-row" data-selected={props.selected} aria-current={props.selected ? "true" : undefined} onClick={props.onSelect}>
      <span className="tc-row-top">
        <span className="mono tc-key">{item.key}</span>
        {item.status !== "active" ? <span className={`chip ${statusTone[item.status]}`}>{item.status}</span> : null}
        <span className="spacer" />
        {outcome ? (
          <span className="tc-outcome" data-outcome={outcome} title={`Last run ${outcome}`}>
            {outcome}
          </span>
        ) : (
          <span className="soft" style={{ fontSize: 11 }}>
            never run
          </span>
        )}
      </span>
      <span className="tc-row-title">{item.title}</span>
      <span className="tc-row-meta">
        {item.tags.slice(0, 3).map((tag) => (
          <span key={tag} className="tc-tag">
            {tag}
          </span>
        ))}
        <span className="spacer" />
        <span className="soft">{item.stats.runs > 0 ? `${formatPercent(item.stats.passRate)} pass · ${item.stats.runs} runs` : `${item.stepCount} steps`}</span>
      </span>
    </button>
  );
}

const stepTypeLabel = (step: TranscriptStep): string =>
  step.type === "macro" ? (step.macro ?? step.tag ?? "Macro") : builtinStepTags[step.type];

function stepText(step: TranscriptStep): string {
  if (step.text) return step.text;
  return step.args.map((arg) => (arg.name ? `${arg.name}=${arg.value}` : arg.value)).join(", ");
}

export function TestCaseDetailPanel(props: { testCaseId: string }): React.JSX.Element {
  const caseQuery = useTestCase(props.testCaseId);
  const web = useOpenInWeb();
  const [view, setView] = useState<"steps" | "transcript">("steps");

  if (caseQuery.error) {
    return <div className="auth-error">{caseQuery.error instanceof Error ? caseQuery.error.message : "Unable to load the test case."}</div>;
  }
  const detail = caseQuery.data;
  if (!detail) return <div className="skeleton-row" style={{ height: 160 }} />;

  return (
    <div className="column tc-detail-stack">
      <header className="tc-detail-header">
        <div className="row" style={{ gap: 8 }}>
          <span className="mono tc-key">{detail.key}</span>
          <span className={`chip ${statusTone[detail.status]}`}>{detail.status}</span>
          <span className="chip neutral">v{detail.transcriptVersion}</span>
          {detail.lintErrors > 0 ? <span className="chip danger">{detail.lintErrors} lint errors</span> : null}
          <span className="spacer" />
          {detail.status === "review" ? (
            <button className="button secondary xs button-label-with-icon" type="button" onClick={() => web.openPath(webPaths.reviewQueue())}>
              <ExternalLink aria-hidden size={12} strokeWidth={2} />
              Review in web
            </button>
          ) : null}
          <button className="button secondary xs button-label-with-icon" type="button" onClick={() => web.openPath(webPaths.caseEditor(detail.id))}>
            <ExternalLink aria-hidden size={12} strokeWidth={2} />
            Edit in web
          </button>
        </div>
        <h2 className="tc-detail-title">{detail.title}</h2>
        {detail.description ? <p className="muted tc-detail-description">{detail.description}</p> : null}
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {detail.tags.map((tag) => (
            <span key={tag} className="tc-tag">
              {tag}
            </span>
          ))}
          {detail.links.map((link) =>
            isExternalHttpUrl(link.url) ? (
              <button key={link.url} type="button" className="tc-link" onClick={() => web.openUrl(link.url)} title={link.url}>
                {link.label ?? link.url}
              </button>
            ) : (
              <span key={link.url} className="tc-link" title={link.url}>
                {link.label ?? link.url}
              </span>
            )
          )}
        </div>
      </header>

      <RunLauncher detail={detail} />

      <section className="card">
        <div className="card-header">
          <h3 className="card-title">Required configuration</h3>
        </div>
        <div className="card-section tc-config">
          <ConfigList label="Variables" names={detail.requiredConfig.variables} unresolved={detail.requiredConfig.unresolved} />
          <ConfigList label="Credential profiles" names={detail.requiredConfig.credentials} unresolved={detail.requiredConfig.unresolved} />
          {detail.requiredConfig.unresolved.length > 0 ? (
            <p className="field-error">
              Not configured for the case environment: {detail.requiredConfig.unresolved.join(", ")}. A run would be blocked.
            </p>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <h3 className="card-title">
            {detail.stepCount} steps · {detail.stats.cachedSteps} cached
            {detail.stats.staleSteps > 0 ? ` · ${detail.stats.staleSteps} stale` : ""}
          </h3>
          <div className="segmented" role="group" aria-label="Case view">
            <button type="button" data-active={view === "steps"} onClick={() => setView("steps")}>
              Steps
            </button>
            <button type="button" data-active={view === "transcript"} onClick={() => setView("transcript")}>
              Transcript
            </button>
          </div>
        </div>
        <div className="card-section">
          {view === "steps" ? <StepOutline detail={detail} /> : <pre className="tc-transcript">{detail.transcript}</pre>}
          {detail.lint.length > 0 ? (
            <ul className="tc-lint">
              {detail.lint.map((finding, index) => (
                <li key={`${finding.ruleId}-${index}`} data-severity={finding.severity}>
                  <span className="mono">{finding.line !== null ? `L${finding.line}` : "—"}</span> {finding.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      <RecentRuns testCaseId={detail.id} />
    </div>
  );
}

function ConfigList(props: { label: string; names: string[]; unresolved: string[] }): React.JSX.Element {
  return (
    <div className="tc-config-row">
      <span className="detail-label">{props.label}</span>
      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
        {props.names.length === 0 ? <span className="soft">None</span> : null}
        {props.names.map((name) => (
          <span key={name} className={`chip mono ${props.unresolved.includes(name) ? "warning" : "neutral"}`}>
            {name}
          </span>
        ))}
      </span>
    </div>
  );
}

function StepOutline(props: { detail: TestCaseDetail }): React.JSX.Element {
  const checkpoints = useMemo(() => {
    try {
      return new Map(
        parseTestCaseTranscript(props.detail.transcript).testCase.checkpoints.map((checkpoint) => [checkpoint.checkpointId, checkpoint.title])
      );
    } catch {
      return new Map<string, string>();
    }
  }, [props.detail.transcript]);
  let lastCheckpoint: string | null = null;
  return (
    <ol className="tc-steps">
      {props.detail.steps.map((step) => {
        const heading =
          step.checkpointId !== lastCheckpoint && step.checkpointId ? (checkpoints.get(step.checkpointId) ?? step.checkpointId) : null;
        lastCheckpoint = step.checkpointId;
        return (
          <React.Fragment key={step.stepId}>
            {heading ? <li className="tc-checkpoint">Checkpoint · {heading}</li> : null}
            <li className="tc-step" data-disabled={step.disabled}>
              <span className="tc-step-ordinal mono">{step.ordinal}</span>
              <span className="tc-step-type" data-type={step.type}>
                {stepTypeLabel(step)}
              </span>
              <span className="tc-step-text">{stepText(step)}</span>
            </li>
          </React.Fragment>
        );
      })}
    </ol>
  );
}

function RunLauncher(props: { detail: TestCaseDetail }): React.JSX.Element {
  const { detail } = props;
  const api = useTestApi();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const environmentsQuery = useTestEnvironments();
  const environments = environmentsQuery.data ?? [];
  const [environmentId, setEnvironmentId] = useState<string>(detail.environmentId ?? "");
  const [params, setParams] = useState<Record<string, string>>({});
  const [force, setForce] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateTestRunResponse | null>(null);

  useEffect(() => {
    setEnvironmentId(detail.environmentId ?? "");
    setParams({});
    setResult(null);
  }, [detail.id, detail.environmentId]);

  const missingParams = detail.params.filter((param) => param.required && !param.default && !params[param.name]?.trim());
  const runnable = detail.status === "active" && missingParams.length === 0;
  const selectedEnvironment = environments.find((environment) => environment.id === environmentId) ?? null;

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const filled = Object.fromEntries(Object.entries(params).filter(([, value]) => value.trim() !== ""));
      const response = await api.createRun(detail.id, {
        environmentId: environmentId || null,
        params: filled,
        force,
        trigger: "manual"
      });
      setResult(response);
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.caseRuns(detail.id) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs() });
      toast.success(response.attached ? "Attached to a run that is already queued or just finished." : "Run queued.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to queue the run.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="card tc-run-card">
      <div className="card-header">
        <h3 className="card-title">Run on the backend queue</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          {selectedEnvironment ? `pool · ${selectedEnvironment.runnerPool}` : "pool · from the environment"}
        </span>
      </div>
      <div className="card-section column" style={{ gap: 12 }}>
        <div className="tc-run-fields">
          <label className="field">
            <span>Environment</span>
            <select className="select field-input" value={environmentId} onChange={(event) => setEnvironmentId(event.currentTarget.value)}>
              <option value="">Case default</option>
              {environments.map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
          </label>
          {detail.params.map((param) => (
            <label key={param.name} className="field">
              <span>
                {param.name}
                {param.required ? " *" : ""}
              </span>
              <input
                className="input field-input"
                value={params[param.name] ?? ""}
                placeholder={param.default ?? ""}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setParams((previous) => ({ ...previous, [param.name]: value }));
                }}
              />
            </label>
          ))}
        </div>
        <div className="row" style={{ gap: 12, justifyContent: "space-between" }}>
          <label className="tc-checkbox">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.currentTarget.checked)} />
            <span>Force a new run instead of attaching to an identical recent one</span>
          </label>
          <button className="button primary sm button-label-with-icon" type="button" disabled={!runnable || submitting} onClick={() => void submit()}>
            <Play aria-hidden size={13} strokeWidth={2.2} />
            {submitting ? "Queuing…" : "Run"}
          </button>
        </div>
        {detail.status !== "active" ? <p className="field-error">Only active cases can run. Approve this case in the web app first.</p> : null}
        {missingParams.length > 0 ? <p className="field-error">Fill required parameters: {missingParams.map((param) => param.name).join(", ")}.</p> : null}
        {result ? (
          <div className="tc-run-result" role="status" data-attached={result.attached}>
            <span className={`chip ${result.attached ? "accent" : "neutral"}`}>{result.attached ? "Attached" : "Queued"}</span>
            <span>
              {result.attached
                ? `Joined an identical run${
                    result.requestedBy.length > 0 ? ` requested by ${result.requestedBy.map((person) => person.name ?? "a teammate").join(", ")}` : ""
                  }.`
                : result.queuePosition !== null && result.queuePosition > 0
                  ? `${result.queuePosition} run${result.queuePosition === 1 ? "" : "s"} ahead in the queue.`
                  : "Next in the queue."}
            </span>
            <span className="spacer" />
            <button className="button secondary xs" type="button" onClick={() => navigate(`/test-runs/${encodeURIComponent(result.runId)}`)}>
              Open run
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RecentRuns(props: { testCaseId: string }): React.JSX.Element {
  const navigate = useNavigate();
  const runsQuery = useCaseRuns(props.testCaseId);
  const runs = runsQuery.data?.items ?? [];
  return (
    <section className="card">
      <div className="card-header">
        <h3 className="card-title">Recent runs</h3>
        <button className="button ghost xs" type="button" onClick={() => void runsQuery.refetch()} disabled={runsQuery.isFetching}>
          Refresh
        </button>
      </div>
      {runsQuery.error ? (
        <div className="card-section auth-error">{runsQuery.error instanceof Error ? runsQuery.error.message : "Unable to load runs."}</div>
      ) : runs.length === 0 ? (
        <div className="card-section muted">{runsQuery.isLoading ? "Loading runs…" : "No runs yet."}</div>
      ) : (
        <RunTable runs={runs} onOpen={(runId) => navigate(`/test-runs/${encodeURIComponent(runId)}`)} showCase={false} />
      )}
    </section>
  );
}

export function RunTable(props: {
  runs: ReadonlyArray<TestRunSummary>;
  onOpen: (runId: string) => void;
  showCase: boolean;
}): React.JSX.Element {
  return (
    <table className="table tc-table">
      <thead>
        <tr>
          <th>Status</th>
          {props.showCase ? <th>Test case</th> : null}
          <th>Environment</th>
          <th>Trigger</th>
          <th>Duration</th>
          <th>Cost</th>
          <th>Queued</th>
        </tr>
      </thead>
      <tbody>
        {props.runs.map((run) => {
          const label = describeRunState(run);
          return (
            <tr
              key={run.id}
              className="tc-table-link"
              tabIndex={0}
              onClick={() => props.onOpen(run.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter") props.onOpen(run.id);
              }}
            >
              <td>
                <span className={`chip ${label.tone}`}>{label.text}</span>
                {run.subscribers.length > 1 ? <span className="chip neutral" style={{ marginLeft: 6 }}>attached · {run.subscribers.length}</span> : null}
              </td>
              {props.showCase ? (
                <td>
                  <span className="mono tc-key">{run.testCaseKey}</span> <span>{run.testCaseTitle}</span>
                </td>
              ) : null}
              <td className="muted">{run.environmentName ?? "—"}</td>
              <td className="muted">{run.trigger}</td>
              <td className="muted">{run.metrics.durationMs === null ? "—" : formatStepDuration(run.metrics.durationMs)}</td>
              <td className="muted">{run.metrics.costUsd === null ? "—" : formatCostUsd(run.metrics.costUsd)}</td>
              <td className="muted">{formatRelativeTime(run.queuedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
