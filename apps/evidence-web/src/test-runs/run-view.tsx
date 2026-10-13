import React from "react";
import { Link, useNavigate } from "react-router";
import { ArrowLeft, Ban, ChevronLeft, ChevronRight, LoaderCircle, PanelRight, X } from "lucide-react";
import type { TestRunDetail, TestRunStep } from "@jittle-lamp/shared";
import { adjacentPillId, formatCostUsd, formatStepDuration, railKeyCommand, railPills, type RunStepRailPill } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { StatusScreen } from "../components/status-screen";
import { useAccountProfile } from "../queries";
import { useToast } from "../toast";
import { EmbeddedEvidenceViewer } from "../pages/evidence-viewer";
import { RunStatusBadge } from "../test-cases/bits";
import { formatDuration } from "../test-cases/list-model";
import { useTestPermissions } from "../test-cases/admin-queries";
import { useCancelTestRun, useTestRun } from "../test-cases/queries";
import { canCancelRun, explainBlockedReason, formatTokens, isRunActive, liveScreenshot, normalizeRunSteps, runProgress } from "../test-cases/run-model";
import { apiRequestItemsOf, formatRequestStatus, isApiStep } from "../test-cases/api-mode-model";
import { LiveViewPanel } from "./live-panel";
import { cacheDetailOf, mediaHeightFor, queryStepView, queuedStripMeta, readDetailsOpen, runInfoRows, shownStepId, stepRowMeta, stepStripMeta, writeDetailsOpen, type QueryStepView } from "./run-view-model";

// Run view (roadmap 2026-10-13 §3.5): two focal points, the current instruction and the recording
// (or live frame). The media takes the pane's width; the steps fill the rest as a column, the one
// in focus open with what the agent saw. Everything else lives in a Details drawer that slides
// over the pane and stays closed until asked for. Rendered on /test-runs/:id (with its own
// header) and embedded in the case page, where the Flow and Steps views share its selection.

export function RunView(props: { runId: string; embedded?: boolean; selectedStepId?: string | null; onSelectedStepChange?: (stepId: string | null) => void }): React.JSX.Element {
  const query = useTestRun(props.runId);
  if (query.isPending) return <StatusScreen loading title="Loading run" />;
  if (query.isError) return <StatusScreen tone="error" title="Unable to load the run" detail={query.error instanceof Error ? query.error.message : "Unknown error"} />;
  return <RunViewBody run={query.data} embedded={props.embedded === true} selectedStepId={props.selectedStepId ?? null} onSelectedStepChange={props.onSelectedStepChange ?? null} />;
}

type SelectVia = "pointer" | "keyboard";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("[role='application']")) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function RunViewBody(props: { run: TestRunDetail; embedded: boolean; selectedStepId: string | null; onSelectedStepChange: ((stepId: string | null) => void) | null }): React.JSX.Element {
  const { run, embedded, onSelectedStepChange } = props;
  const navigate = useNavigate();
  const toast = useToast();
  const account = useAccountProfile();
  const cancel = useCancelTestRun();
  const permissions = useTestPermissions();
  const [activeStepId, setActiveStepId] = React.useState<string | null>(null);
  const [selectVia, setSelectVia] = React.useState<SelectVia>("pointer");
  const [playingStepId, setPlayingStepId] = React.useState<string | null>(null);
  const [detailsOpen, setDetailsOpenState] = React.useState(() => readDetailsOpen(typeof window === "undefined" ? null : window.localStorage));
  const [paneContainer, setPaneContainer] = React.useState<HTMLDivElement | null>(null);
  const [actionsContainer, setActionsContainer] = React.useState<HTMLSpanElement | null>(null);
  const [bodyNode, setBodyNode] = React.useState<HTMLDivElement | null>(null);
  const [mediaHeight, setMediaHeight] = React.useState<number | null>(null);

  const steps = React.useMemo(() => normalizeRunSteps(run.steps, run.transcript), [run.steps, run.transcript]);
  const pills = React.useMemo(() => railPills(steps), [steps]);
  const stepsById = React.useMemo(() => new Map(steps.map((step) => [step.stepId, step])), [steps]);
  // The column's rows: the top-level steps with their full records and the macro children count.
  const rows = React.useMemo(() => pills.flatMap((pill) => (stepsById.has(pill.step.stepId) ? [{ step: stepsById.get(pill.step.stepId) as TestRunStep, childCount: pill.childCount }] : [])), [pills, stepsById]);
  const stepOffsetsMs = React.useMemo(() => {
    const offsets: Record<string, number> = {};
    for (const step of run.steps) if (step.videoOffsetMs !== null) offsets[step.stepId] = step.videoOffsetMs;
    return offsets;
  }, [run.steps]);
  const active = isRunActive(run.status);
  const progress = runProgress(run.steps, run.transcript);
  const currentUserIds = [account.data?.localUserId, account.data?.userId].filter((value): value is string => typeof value === "string");
  const canCancelAny = permissions.can("test_run.cancel_any");
  const mayCancel = currentUserIds.some((id) => canCancelRun(run, id, canCancelAny));
  const runBy = run.createdByName ?? (run.createdBy !== null && currentUserIds.includes(run.createdBy) ? "you" : "unknown");
  const caseLink = `/test-cases/${encodeURIComponent(run.testCaseId)}`;

  // A failed run opens on its first failure: the rail selects it and the video seeks there.
  const firstFailureId = pills.find((pill) => pill.step.status === "failed")?.step.stepId ?? null;
  const openedOnFailure = React.useRef(false);
  React.useEffect(() => {
    if (openedOnFailure.current || !run.evidenceId || !firstFailureId) return;
    openedOnFailure.current = true;
    setActiveStepId((current) => current ?? firstFailureId);
  }, [run.evidenceId, firstFailureId]);

  const shownId = shownStepId({ steps, activeStepId, playingStepId, currentStepId: run.currentStepId });
  const shown = shownId ? stepsById.get(shownId) ?? null : null;

  const select = React.useCallback(
    (stepId: string | null, via: SelectVia) => {
      setSelectVia(via);
      setActiveStepId(stepId);
      onSelectedStepChange?.(stepId);
    },
    [onSelectedStepChange]
  );
  // The host (case page) picks a step in its Flow or Steps view: this run follows when it has it.
  const hostStepId = props.selectedStepId;
  React.useEffect(() => {
    if (hostStepId === null || !stepsById.has(hostStepId)) return;
    setSelectVia("pointer");
    setActiveStepId(hostStepId);
  }, [hostStepId, stepsById]);

  // The media takes the pane's width at 16:9 and leaves the rest to the step column.
  React.useEffect(() => {
    if (!bodyNode || typeof ResizeObserver === "undefined") return;
    const measure = () => setMediaHeight(mediaHeightFor({ width: bodyNode.clientWidth, height: bodyNode.clientHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bodyNode);
    return () => observer.disconnect();
  }, [bodyNode]);
  const move = React.useCallback(
    (direction: -1 | 1, via: SelectVia) => {
      const next = adjacentPillId(pills, activeStepId ?? shownId, direction);
      if (next) select(next, via);
    },
    [pills, activeStepId, shownId, select]
  );

  const setDetailsOpen = React.useCallback((open: boolean) => {
    setDetailsOpenState(open);
    writeDetailsOpen(typeof window === "undefined" ? null : window.localStorage, open);
  }, []);

  // n/j and p/k move the selection without any transition; Esc closes the drawer.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape" && detailsOpen) {
        setDetailsOpen(false);
        return;
      }
      const command = railKeyCommand(event.key);
      if (!command) return;
      event.preventDefault();
      move(command === "next" ? 1 : -1, "keyboard");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailsOpen, move, setDetailsOpen]);

  const requestCancel = () =>
    cancel.mutate(
      { runId: run.id, testCaseId: run.testCaseId },
      {
        onSuccess: () => toast.success("Cancel requested", "The runner stops after the current step."),
        onError: (error) => toast.error("Cancel failed", error instanceof Error ? error.message : undefined)
      }
    );
  const cancelButton = mayCancel ? (
    <Button size="xs" variant="destructive" className="jl-tc-press" onClick={requestCancel} disabled={cancel.isPending}>
      <Ban aria-hidden /> {cancel.isPending ? "Cancelling…" : "Cancel run"}
    </Button>
  ) : null;

  const infoPanel = (
    <RunInfoPanel run={run} who={runBy} actionsRef={setActionsContainer} cancel={cancelButton} />
  );
  const stripStep = shown ?? null;
  // An API step has no video segment: its request list takes the media area (roadmap §3.5).
  const apiItems = shown && isApiStep(shown) ? apiRequestItemsOf(shown) : [];
  // A [Query] step has no video segment: its statement and the row it picked take the media's place
  // (roadmap §5.4); the viewer keeps its box underneath so moving on never reflows it.
  const queryView = shown && activeStepId === shown.stepId ? queryStepView(shown) : null;
  const hasFrames = active && run.status !== "queued" && Boolean(run.live?.available);
  const screenshot = active && run.status !== "queued" ? liveScreenshot(run) : null;

  return (
    <div className={cn("jl-tc-scope jl-run-view grid h-full min-h-0 flex-1", embedded ? "grid-rows-[minmax(0,1fr)]" : "grid-rows-[auto_minmax(0,1fr)]")}>
      {embedded ? null : (
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
          <span className="ml-auto flex shrink-0 items-center gap-1.5">{cancelButton}</span>
        </header>
      )}

      <div ref={setBodyNode} className="relative grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)]">
        <StepStrip run={run} step={stripStep} total={progress.total} onMove={(direction) => move(direction, "pointer")} pills={pills} />

        <div className="jl-run-media relative min-h-0 overflow-hidden border-b border-border" style={mediaHeight === null ? undefined : { height: mediaHeight }}>
          <section className="jl-tc-run-pane flex h-full min-h-0 min-w-0 flex-col" aria-label="Run evidence">
            {run.evidenceId ? (
              <EmbeddedEvidenceViewer
                evidenceId={run.evidenceId}
                activeStepId={activeStepId}
                onActiveStepIdChange={(stepId) => select(stepId, "pointer")}
                stepOffsetsMs={stepOffsetsMs}
                onPlayingStepIdChange={setPlayingStepId}
                actionsContainer={actionsContainer}
                paneContainer={paneContainer}
                infoPanel={infoPanel}
                discussionEnabled={detailsOpen}
                onClose={() => navigate(caseLink)}
              />
            ) : hasFrames ? (
              <LiveViewPanel run={run} currentUserIds={currentUserIds} canCancelAny={canCancelAny} fallback={<ScreenshotPanel url={screenshot?.url ?? null} label={screenshot?.label ?? null} />} />
            ) : screenshot ? (
              <ScreenshotPanel url={screenshot.url} label={screenshot.label} />
            ) : (
              <p className="grid flex-1 place-items-center px-6 text-center text-sm text-muted-foreground">
                {run.status === "queued" ? "Waiting for a runner…" : active ? "Waiting for the first screenshot…" : run.status === "cancelled" ? "Cancelled before a recording was saved." : "No recording for this run."}
              </p>
            )}
            {shown && apiItems.length > 0 ? <ApiRequestPanel step={shown} items={apiItems} /> : null}
          </section>

          {queryView ? <QueryStepPanel view={queryView} step={shown} /> : null}
        </div>

        <StepColumn
          rows={rows}
          shownStepId={shownId}
          selectedStepId={activeStepId}
          playingStepId={playingStepId}
          instant={selectVia === "keyboard"}
          layoutKey={mediaHeight}
          onSelect={(stepId) => select(stepId, "pointer")}
          details={
            <Button size="xs" variant={detailsOpen ? "secondary" : "ghost"} className="jl-tc-press" aria-expanded={detailsOpen} aria-controls="jl-run-drawer" onClick={() => setDetailsOpen(!detailsOpen)}>
              <PanelRight aria-hidden /> Details
            </Button>
          }
        />

        <aside
          id="jl-run-drawer"
          className="jl-run-drawer absolute inset-y-0 right-0 z-20 flex w-[min(440px,100%)] flex-col border-l border-border bg-background shadow-pop"
          data-open={detailsOpen ? "true" : "false"}
          aria-label="Run details"
          aria-hidden={!detailsOpen}
          inert={!detailsOpen}
        >
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3 pr-1">
            <span className="text-xs font-semibold text-muted-foreground">Details</span>
            <Button size="icon-xs" variant="ghost" className="jl-tc-press" aria-label="Close details" onClick={() => setDetailsOpen(false)}>
              <X aria-hidden />
            </Button>
          </div>
          {run.evidenceId ? (
            <div ref={setPaneContainer} className="min-h-0 flex-1" />
          ) : (
            <div className="jl-scroll min-h-0 flex-1 overflow-y-auto p-3">{infoPanel}</div>
          )}
        </aside>
      </div>
    </div>
  );
}

// The steps under the media, one row each (roadmap §3.5): number, status dot, the instruction, how
// it ran, how long it took. The step in focus opens with what the agent saw and the cache detail;
// clicking a row seeks the recording there. Macro children fold into their parent's count.
function StepColumn(props: {
  rows: ReadonlyArray<{ step: TestRunStep; childCount: number }>;
  shownStepId: string | null;
  selectedStepId: string | null;
  playingStepId: string | null;
  instant: boolean;
  // Changes when the media box above is resized, so the open row is brought back into view.
  layoutKey: number | null;
  onSelect: (stepId: string) => void;
  details: React.ReactNode;
}): React.JSX.Element {
  const listRef = React.useRef<HTMLOListElement | null>(null);
  // The open row stays in view; a keyboard move jumps, a click glides.
  const { layoutKey } = props;
  React.useEffect(() => {
    const list = listRef.current;
    if (!list || !props.shownStepId) return;
    const row = Array.from(list.querySelectorAll<HTMLElement>("[data-step-id]")).find((node) => node.dataset.stepId === props.shownStepId);
    if (!row) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row.scrollIntoView({ block: "nearest", behavior: props.instant || reduce || layoutKey === null ? "auto" : "smooth" });
  }, [props.shownStepId, props.instant, layoutKey]);

  return (
    <div className="jl-run-steps grid min-h-0 grid-rows-[minmax(0,1fr)_auto]" data-instant={props.instant ? "true" : "false"}>
      <ol ref={listRef} className="jl-scroll min-h-0 overflow-y-auto py-1" aria-label="Test run steps">
        {props.rows.map((row) => {
          const { step } = row;
          const open = props.shownStepId === step.stepId;
          const observed = step.observed ?? (step.status === "failed" || step.status === "blocked" ? step.error?.message ?? null : null);
          const cacheDetail = open && step.type !== "query" ? cacheDetailOf(step) : null;
          return (
            <li key={step.stepId} className="jl-run-step" data-step-id={step.stepId} data-status={step.status} data-open={open ? "true" : "false"}>
              <button
                type="button"
                className="jl-tc-press jl-run-step-row grid w-full grid-cols-[2.25rem_auto_minmax(0,1fr)_auto_3.5rem] items-baseline gap-x-2 px-3 py-1.5 text-left text-sm"
                aria-current={props.selectedStepId === step.stepId ? "step" : undefined}
                aria-expanded={open}
                aria-label={`Step ${step.ordinal}, ${step.status}: ${step.label}`}
                onClick={() => props.onSelect(step.stepId)}
              >
                <span className="text-right text-xs tabular-nums text-muted-foreground">{step.ordinal}</span>
                <span className="jl-run-dot" data-status={step.status} data-playing={props.playingStepId === step.stepId ? "true" : "false"} aria-hidden />
                <span className={cn("min-w-0 truncate", open ? "font-semibold text-foreground" : "text-foreground/85")} title={step.label}>
                  {step.label}
                </span>
                <span className="whitespace-nowrap text-[11px] text-muted-foreground">{stepRowMeta(step, row.childCount)}</span>
                <span className="text-right text-xs tabular-nums text-muted-foreground">{formatStepDuration(step.durationMs)}</span>
              </button>
              {open && (observed || cacheDetail) ? (
                <div className="jl-run-step-open px-3 pb-3 pl-[4.25rem] text-sm">
                  {observed ? <p className={cn("whitespace-pre-wrap leading-relaxed", step.status === "failed" || step.status === "blocked" ? "text-foreground" : "text-muted-foreground")}>{observed}</p> : null}
                  {cacheDetail ? <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-xs text-muted-foreground">{cacheDetail}</pre> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="flex h-9 shrink-0 items-center justify-end border-t border-border px-2">{props.details}</div>
    </div>
  );
}

// Top of the page: the instruction in focus and one meta line above it.
function StepStrip(props: { run: TestRunDetail; step: TestRunStep | null; total: number; pills: readonly RunStepRailPill[]; onMove: (direction: -1 | 1) => void }): React.JSX.Element {
  const { run, step } = props;
  const now = useNow(run.status === "queued" ? 1_000 : null);
  const running = run.status === "running" || run.status === "claimed" || run.status === "paused";
  const index = step ? props.pills.findIndex((pill) => pill.step.stepId === step.stepId) : -1;
  // A blocked run says why on the meta line's place; a failed step's reason opens in its row below.
  const blockedLine = run.blockedReason && (!step || step.status !== "failed") ? explainBlockedReason(run.blockedReason) ?? run.error : null;
  const meta =
    run.status === "queued"
      ? queuedStripMeta(run, now)
      : running && step && (step.status === "running" || step.status === "pending")
        ? `${run.status === "paused" ? "Paused at" : "Running"} step ${step.ordinal} of ${props.total}`
        : step
          ? run.blockedReason && step.status !== "failed"
            ? `${stepStripMeta(step, props.total)} · ${run.blockedReason}`
            : stepStripMeta(step, props.total)
          : run.blockedReason ?? "No steps";
  const spinning = run.status === "queued" || (running && step?.status === "running");
  return (
    <div className="jl-run-strip grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border px-4 py-2">
      <div className="min-w-0">
        <p className="flex h-4 items-center gap-1.5 text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {spinning ? <LoaderCircle className="jl-run-spin size-3 shrink-0" aria-hidden /> : null}
          <span className="truncate">{meta}</span>
        </p>
        <p className="jl-run-instruction mt-0.5 line-clamp-2 text-lg font-semibold leading-snug tracking-[-0.01em] text-foreground" title={step?.label ?? undefined}>
          {step?.label ?? (run.status === "queued" ? run.testCaseTitle : "")}
        </p>
        {blockedLine ? (
          <p className="mt-0.5 truncate text-sm text-muted-foreground" title={blockedLine}>
            {blockedLine}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1 self-center">
        <Button size="icon-sm" variant="ghost" className="jl-tc-press" aria-label="Previous step" disabled={index <= 0} onClick={() => props.onMove(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <Button size="icon-sm" variant="ghost" className="jl-tc-press" aria-label="Next step" disabled={index === -1 || index >= props.pills.length - 1} onClick={() => props.onMove(1)}>
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function useNow(intervalMs: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (intervalMs === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

// A query step in focus: the SQL and the row that bound, over the media (roadmap §5.4).
function QueryStepPanel(props: { view: QueryStepView; step: TestRunStep | null }): React.JSX.Element {
  const { view } = props;
  const entries = view.row ? Object.entries(view.row) : [];
  return (
    <section className="jl-run-query absolute inset-0 grid content-start gap-3 overflow-y-auto bg-background/95 p-4 text-sm" aria-label="Query step">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Badge variant="outline" className="px-1.5 py-0 font-mono text-xs">
          SQL
        </Badge>
        <span className="truncate">{view.meta ?? (props.step?.status === "blocked" ? props.step.error?.code ?? "blocked" : "No statement recorded")}</span>
      </div>
      {view.statement ? <pre className="jl-scroll max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">{view.statement}</pre> : null}
      {entries.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-border p-3 text-xs">
          <dt className="col-span-2 font-mono text-muted-foreground">{`{${view.binding ?? "row"}}`}</dt>
          {entries.map(([column, value]) => (
            <React.Fragment key={column}>
              <dt className="font-mono text-muted-foreground">{column}</dt>
              <dd className="truncate font-mono text-foreground" title={String(value)}>
                {value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value)}
              </dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

// Running without frames: the latest step screenshot, nothing else on it.
function ScreenshotPanel(props: { url: string | null; label: string | null }): React.JSX.Element {
  return (
    <div className="grid flex-1 place-items-center bg-[#0d0e10] p-4">
      {props.url ? (
        <img src={props.url} alt={props.label ? `Screen after: ${props.label}` : "Latest screenshot"} className="max-h-full max-w-full rounded-md border border-white/10 object-contain shadow-2xl" />
      ) : (
        <p className="text-sm text-white/60">Waiting for the first screenshot…</p>
      )}
    </div>
  );
}

// The requests an API step sent, over the media: method, path, status, duration and a mutation
// badge per request; the one that stopped the replay carries its reason.
export function ApiRequestPanel(props: { step: Pick<TestRunStep, "mode" | "ordinal">; items: ReturnType<typeof apiRequestItemsOf> }): React.JSX.Element {
  return (
    <div className="jl-run-api jl-scroll absolute inset-0 z-10 overflow-y-auto bg-background p-4" aria-label={`Requests of step ${props.step.ordinal}`}>
      <p className="mb-2 text-xs text-muted-foreground">
        {props.items.length} request{props.items.length === 1 ? "" : "s"} · {props.step.mode === "api-replayed" ? "replayed from the API script" : "API replay handed off to the UI"}
      </p>
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border text-sm">
        {props.items.map((item) => (
          <li key={item.seq} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 px-3 py-1.5 font-mono text-xs">
            <span className="font-semibold">{item.method}</span>
            <span className="truncate" title={item.path}>
              {item.path}
            </span>
            <span className={cn("tabular-nums", item.error ? "text-destructive" : "text-muted-foreground")}>{formatRequestStatus(item)}</span>
            <span className="flex items-center gap-1.5 tabular-nums text-muted-foreground">
              {item.durationMs === null ? "" : `${Math.round(item.durationMs)} ms`}
              {item.mutation ? <Badge variant="warning" className="px-1.5 py-0 text-[10px]">mutation</Badge> : null}
            </span>
            {item.error ? <span className="col-span-4 text-destructive">{item.error}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// The drawer's Info tab: run metadata plus the actions that are not needed to review the run.
function RunInfoPanel(props: { run: TestRunDetail; who: string; actionsRef: (node: HTMLSpanElement | null) => void; cancel: React.ReactNode }): React.JSX.Element {
  const rows = runInfoRows(props.run, props.who, { tokens: formatTokens, cost: formatCostUsd, duration: formatDuration });
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="truncate tabular-nums text-foreground" title={value}>
              {value}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {props.run.error && !props.run.blockedReason ? <p className="font-mono text-xs text-destructive">{props.run.error}</p> : null}
      <div className="flex items-center gap-1.5">
        <span ref={props.actionsRef} className="flex items-center" />
        {props.cancel}
      </div>
    </div>
  );
}
