import React from "react";
import { Link } from "react-router";
import { ChevronDown, ExternalLink, MoreHorizontal, Play } from "lucide-react";
import type { TestCaseDetail, TestRunSummary } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Hint } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { CaseStatusBadge, RunStatusBadge } from "./bits";
import { formatRelative } from "./list-model";
import { caseMenuItems, defaultView, runHref, runPickerLabel, shownRun, viewSegments, type CaseMenuAction, type CaseView } from "./case-page-model";

// The case page's layout without data hooks (roadmap §3.4): header line, the case on the left as
// Flow | Steps | Text, one run on the right behind a run picker, the Details drawer over it.
// pages/test-case.tsx wires the queries; tests render this with stubs.

// ---------------------------------------------------------------------------------------------

export type TestCasePageViewProps = {
  detail: TestCaseDetail;
  environmentName: string | null;
  runs: readonly TestRunSummary[];
  runsLoaded: boolean;
  // null = the default for the case's state (defaultView).
  view: CaseView | null;
  onViewChange: (view: CaseView) => void;
  // null = the newest run.
  selectedRunId: string | null;
  onSelectRun: (runId: string) => void;
  onShowAllRuns: () => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
  onRename: (title: string) => void;
  drawerOpen: boolean;
  onRun: () => void;
  onMenu: (action: CaseMenuAction) => void;
  // The editor body for Steps and Text; its toolbar (Edit steps, Save) sits in the pane header.
  renderSteps: (input: { editing: boolean; view: "steps" | "text" }) => React.ReactNode;
  renderStepsToolbar: (input: { editing: boolean }) => React.ReactNode;
  renderRun: (runId: string) => React.ReactNode;
  // FLOW SLOT (roadmap §3.4, decision 4): when set, the "Flow" segment appears and is the default.
  renderFlow?: () => React.ReactNode;
  renderDrawer: () => React.ReactNode;
};

export function TestCasePageView(props: TestCasePageViewProps): React.JSX.Element {
  const { detail, runs } = props;
  const flowAvailable = props.renderFlow !== undefined;
  const steps = detail.steps.filter((step) => !step.disabled).length;
  const view = props.view ?? defaultView({ editing: props.editing, steps, flowAvailable });
  const segments = viewSegments.filter((segment) => segment.id !== "flow" || flowAvailable);
  const run = shownRun(runs, props.selectedRunId);
  const neverRan = props.runsLoaded && runs.length === 0;

  return (
    <div className="jl-tc-scope grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex min-w-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{detail.key}</span>
        <CaseStatusBadge status={detail.status} />
        <CaseTitle title={detail.title} renaming={props.renaming} onRenamingChange={props.onRenamingChange} onRename={props.onRename} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button size="sm" className="jl-tc-press" onClick={props.onRun} aria-keyshortcuts="r">
            <Play aria-hidden /> Run
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" className="jl-tc-press" aria-label="More actions">
                  <MoreHorizontal aria-hidden />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              {caseMenuItems.map((item, index) => (
                <React.Fragment key={item.id}>
                  {item.destructive && !caseMenuItems[index - 1]?.destructive ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem variant={item.destructive ? "destructive" : "default"} onClick={() => props.onMenu(item.id)}>
                    {item.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </header>

      <div className="relative grid min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(380px,5fr)_minmax(0,7fr)]">
        <section className="flex min-h-0 flex-col border-r border-border" aria-label="Case" data-editing={props.editing ? "true" : "false"}>
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <div role="tablist" aria-label="Case view" className="jl-tc-seg flex h-7 items-center rounded-md bg-muted p-0.5">
              {segments.map((segment) => (
                <button
                  key={segment.id}
                  type="button"
                  role="tab"
                  aria-selected={view === segment.id}
                  className={cn("jl-tc-press h-6 rounded-[5px] px-2.5 text-xs font-medium", view === segment.id ? "bg-background text-foreground shadow-soft" : "text-muted-foreground")}
                  onClick={() => props.onViewChange(segment.id)}
                >
                  {segment.label}
                </button>
              ))}
            </div>
            <span className="ml-auto flex items-center gap-1.5">{props.renderStepsToolbar({ editing: props.editing })}</span>
          </div>
          <div className={cn("flex min-h-0 flex-1 flex-col", view === "flow" ? "" : "jl-scroll overflow-y-auto px-4 py-3")} role="tabpanel">
            {view === "flow" ? props.renderFlow?.() : props.renderSteps({ editing: props.editing, view })}
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col" aria-label="Run">
          {neverRan ? (
            <div className="grid flex-1 place-items-center p-8">
              <EmptyState
                title="Never run"
                description={props.environmentName ?? "No environment"}
                className="border-0"
                action={
                  <Button size="lg" className="jl-tc-press" onClick={props.onRun}>
                    <Play aria-hidden /> Run
                  </Button>
                }
              />
            </div>
          ) : (
            <>
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
                {run ? <RunPicker runs={runs} run={run} onSelectRun={props.onSelectRun} onShowAllRuns={props.onShowAllRuns} /> : null}
                {run ? (
                  <Hint label="Open the run page">
                    <Link to={runHref(run.id)} className="jl-tc-press ml-auto inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground">
                      <ExternalLink className="size-3.5" aria-hidden /> Open
                    </Link>
                  </Hint>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                {run ? props.renderRun(run.id) : <p className="p-6 text-sm text-muted-foreground">Loading runs…</p>}
              </div>
            </>
          )}
        </section>

        {props.renderDrawer()}
      </div>
    </div>
  );
}

// Which run the right pane shows: a menu of the case's runs, newest first, and the full table.
function RunPicker(props: { runs: readonly TestRunSummary[]; run: TestRunSummary; onSelectRun: (runId: string) => void; onShowAllRuns: () => void }): React.JSX.Element {
  const now = Date.now();
  const sorted = [...props.runs].sort((a, b) => b.queuedAt - a.queuedAt);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button type="button" className="jl-tc-press jl-tc-hover inline-flex h-7 min-w-0 items-center gap-1.5 rounded px-1.5 text-xs" aria-label="Choose a run">
            <RunStatusBadge run={props.run} />
            <span className="truncate text-muted-foreground">
              {formatRelative(props.run.queuedAt, now)} · v{props.run.transcriptVersion}
            </span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent align="start" className="min-w-56">
        {sorted.map((run) => (
          <DropdownMenuItem key={run.id} onClick={() => props.onSelectRun(run.id)} aria-current={run.id === props.run.id ? "true" : undefined} className={cn(run.id === props.run.id && "bg-accent/60")}>
            <span className="flex min-w-0 items-center gap-2">
              <RunStatusBadge run={run} />
              <span className="truncate text-xs text-muted-foreground">{runPickerLabel(run, (at) => formatRelative(at, now)).split(" · ").slice(1).join(" · ")}</span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={props.onShowAllRuns}>All runs</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The title: click to rename, Enter saves, Escape cancels.
function CaseTitle(props: { title: string; renaming: boolean; onRenamingChange: (renaming: boolean) => void; onRename: (title: string) => void }): React.JSX.Element {
  const [draft, setDraft] = React.useState(props.title);
  React.useEffect(() => {
    if (props.renaming) setDraft(props.title);
  }, [props.renaming, props.title]);
  if (props.renaming) {
    return (
      <Input
        autoFocus
        value={draft}
        aria-label="Title"
        className="h-7 min-w-0 flex-1 text-base font-semibold"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => props.onRenamingChange(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onRenamingChange(false);
          if (event.key === "Enter") {
            event.preventDefault();
            if (draft.trim().length > 0 && draft.trim() !== props.title) props.onRename(draft.trim());
            props.onRenamingChange(false);
          }
        }}
      />
    );
  }
  return (
    <Hint label="Rename">
      <button type="button" className="jl-tc-press jl-tc-hover min-w-0 flex-1 truncate rounded px-1 text-left text-base font-semibold tracking-[-0.01em]" title={props.title} onClick={() => props.onRenamingChange(true)}>
        {props.title || "Untitled case"}
      </button>
    </Hint>
  );
}
