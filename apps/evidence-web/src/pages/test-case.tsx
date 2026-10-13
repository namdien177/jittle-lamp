import React from "react";
import { useBlocker, useLocation, useNavigate, useParams } from "react-router";
import type { TestCaseDetail } from "@jittle-lamp/shared";

import { StatusScreen } from "../components/status-screen";
import { Button } from "../components/ui/button";
import { ConfirmDialog, SimpleDialog } from "../components/ui/dialog";
import { useToast } from "../toast";
import { HoldToConfirmButton } from "../test-cases/bits";
import { EditorToolbar, StepsPane, useCaseEditor } from "../test-cases/case-editor";
import { CaseDetailsDrawer, type DrawerSection } from "../test-cases/case-details-drawer";
import { editingFromSearch, exportFileName, shownRun, type CaseMenuAction, type CaseView } from "../test-cases/case-page-model";
import { TestCasePageView } from "../test-cases/case-page-view";
import { FlowView, useFlowLinkedCases } from "../test-cases/flow-view";
import { useBulkTestCases, useClearStepScripts, useTestCase, useTestCaseRuns, useTestEnvironments, useTestRun } from "../test-cases/queries";
import { RunDialog } from "../test-cases/run-dialog";
import { RunView } from "../test-runs/run-view";

// Case page (roadmap §3.4): one header line, the case on the left as Flow | Steps | Text, one run
// on the right behind a run picker. Everything else lives in the Details drawer behind the ⋯ menu.

export function TestCasePage(): React.JSX.Element {
  const { id } = useParams();
  const query = useTestCase(id ?? null);
  if (!id) return <StatusScreen tone="error" title="Missing case id" />;
  if (query.isPending) return <StatusScreen loading title="Loading case" />;
  if (query.isError) return <StatusScreen tone="error" title="Unable to load the case" detail={query.error instanceof Error ? query.error.message : "Unknown error"} />;
  return <TestCaseScreen key={query.data.id} detail={query.data} />;
}

function TestCaseScreen(props: { detail: TestCaseDetail }): React.JSX.Element {
  const { detail } = props;
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const editor = useCaseEditor(detail);
  const runsQuery = useTestCaseRuns(detail.id);
  const environmentsQuery = useTestEnvironments();
  const bulk = useBulkTestCases();
  const clearScripts = useClearStepScripts();
  const runs = runsQuery.data?.items ?? [];
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null);
  // The Flow pane colours its nodes from the shown run's steps.
  const run = shownRun(runs, selectedRunId);
  const shownRunQuery = useTestRun(run?.id ?? null);
  const linkedCases = useFlowLinkedCases();
  const environments = environmentsQuery.data ?? [];
  const environment = environments.find((candidate) => candidate.id === detail.environmentId) ?? null;

  const [editing, setEditingState] = React.useState(() => editingFromSearch(location.search));
  const [view, setView] = React.useState<CaseView | null>(null);
  // Editing happens in Steps: entering edit mode from Flow switches the view.
  const setEditing = React.useCallback((next: boolean) => {
    setEditingState(next);
    if (next) setView((current) => (current === "flow" || current === null ? "steps" : current));
  }, []);
  const [drawer, setDrawer] = React.useState<{ open: boolean; section: DrawerSection }>({ open: false, section: "details" });
  const [runDialog, setRunDialog] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"archive" | "clear-scripts" | null>(null);
  const [renaming, setRenaming] = React.useState(false);
  // Step picked in the Flow view or by focusing an editor row: both panes follow it.
  const [selectedStepId, setSelectedStepId] = React.useState<string | null>(null);

  // A case that never ran opens in edit mode: there is nothing to watch yet.
  React.useEffect(() => {
    if (runsQuery.isSuccess && runs.length === 0) setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsQuery.isSuccess]);

  // `r` runs the case (the list page's map), outside fields and open dialogs.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.key !== "r") return;
      if (runDialog || confirm !== null || renaming) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[role='dialog'],[role='menu']") !== null)) return;
      event.preventDefault();
      setRunDialog(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runDialog, confirm, renaming]);

  // Unsaved edits: leaving the page asks first, closing the tab too.
  const blocker = useBlocker(editor.dirty);
  React.useEffect(() => {
    if (!editor.dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [editor.dirty]);

  const download = (document: string) => {
    const blob = new Blob([document], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = exportFileName(detail.key);
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const onMenu = (action: CaseMenuAction) => {
    switch (action) {
      case "rename":
        setRenaming(true);
        return;
      case "tags":
      case "links":
        setDrawer({ open: true, section: "details" });
        return;
      case "versions":
        editor.engage();
        setDrawer({ open: true, section: "versions" });
        return;
      case "duplicate":
        navigate(`/test-cases?duplicate=${encodeURIComponent(detail.id)}`);
        return;
      case "export":
        bulk.mutate(
          { action: "export", ids: [detail.id] },
          {
            onSuccess: (result) => {
              if (result.document) download(result.document);
              toast.success("Exported", exportFileName(detail.key));
            },
            onError: (error) => toast.error("Export failed", error instanceof Error ? error.message : undefined)
          }
        );
        return;
      case "archive":
      case "clear-scripts":
        setConfirm(action);
        return;
    }
  };

  const archive = () =>
    bulk.mutate(
      { action: "archive", ids: [detail.id] },
      {
        onSuccess: () => {
          setConfirm(null);
          toast.success("Archived", detail.key);
          navigate("/test-cases");
        },
        onError: (error) => toast.error("Archive failed", error instanceof Error ? error.message : undefined)
      }
    );

  const clearAllScripts = () =>
    clearScripts.mutate(
      { testCaseId: detail.id },
      {
        onSuccess: () => {
          setConfirm(null);
          toast.success("Cached scripts cleared", "The next run records them again with the agent.");
        },
        onError: (error) => toast.error("Clear failed", error instanceof Error ? error.message : undefined)
      }
    );

  return (
    <>
      <TestCasePageView
        detail={detail}
        environmentName={environment?.name ?? null}
        runs={runs}
        runsLoaded={runsQuery.isSuccess}
        view={view}
        onViewChange={setView}
        selectedRunId={selectedRunId}
        onSelectRun={setSelectedRunId}
        onShowAllRuns={() => setDrawer({ open: true, section: "runs" })}
        editing={editing}
        onEditingChange={setEditing}
        renaming={renaming}
        onRenamingChange={(value) => setRenaming(value && !editor.locked)}
        onRename={editor.rename}
        drawerOpen={drawer.open}
        onRun={() => setRunDialog(true)}
        onMenu={onMenu}
        renderSteps={(input) => (
          <StepsPane
            detail={detail}
            editor={editor}
            editing={input.editing}
            onEditingChange={setEditing}
            onRun={() => setRunDialog(true)}
            activeStepId={selectedStepId}
            onActiveStepChange={setSelectedStepId}
            mode={input.view}
            onModeChange={setView}
          />
        )}
        renderStepsToolbar={(input) => <EditorToolbar editor={editor} editing={input.editing} onEditingChange={setEditing} />}
        renderRun={(runId) => <RunView runId={runId} embedded selectedStepId={selectedStepId} onSelectedStepChange={setSelectedStepId} />}
        renderFlow={() => (
          <FlowView detail={detail} latestRun={shownRunQuery.data ?? null} selectedStepId={selectedStepId} onSelectStep={setSelectedStepId} environmentName={environment?.name ?? null} linkedCases={linkedCases} />
        )}
        renderDrawer={() => (
          <CaseDetailsDrawer
            open={drawer.open}
            onClose={() => setDrawer((current) => ({ ...current, open: false }))}
            detail={detail}
            editor={editor}
            environmentName={environment?.name ?? null}
            section={drawer.section}
            onSectionChange={(section) => setDrawer({ open: true, section })}
          />
        )}
      />
      {runDialog ? <RunDialog testCase={detail} hasDataset={detail.dataset !== null && detail.dataset.rows.length > 0} environments={environments} onClose={() => setRunDialog(false)} /> : null}
      <ConfirmDialog
        open={confirm === "archive"}
        title={`Archive ${detail.key}?`}
        description="Archived cases leave the default views and stop running in suites. Their runs and evidence stay."
        confirmLabel="Archive"
        destructive
        busy={bulk.isPending}
        onCancel={() => setConfirm(null)}
        onConfirm={archive}
      />
      {confirm === "clear-scripts" ? (
        <SimpleDialog
          open
          size="sm"
          title="Clear all cached scripts?"
          description="Every step runs with the agent again on the next run."
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)} disabled={clearScripts.isPending}>
                Cancel
              </Button>
              <HoldToConfirmButton label="Hold to clear" onConfirm={clearAllScripts} disabled={clearScripts.isPending} />
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            {detail.stats.cachedSteps} cached step{detail.stats.cachedSteps === 1 ? "" : "s"}
            {detail.stats.staleSteps > 0 ? `, ${detail.stats.staleSteps} stale` : ""}.
          </p>
        </SimpleDialog>
      ) : null}
      <ConfirmDialog
        open={blocker.state === "blocked"}
        title="Discard unsaved changes?"
        description="The steps have edits that are not saved yet."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
