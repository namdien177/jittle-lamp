import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import type { TestCaseDetail } from "@jittle-lamp/shared";
import { TestCaseEditor, isMacPlatform, serializeEditorDoc, setTitle, type EditorDoc, type StepEditorRowStatus, type TestCaseEditorMode } from "@jittle-lamp/ui";

import { Button } from "../components/ui/button";
import { useToast } from "../toast";
import { useTestPermissions } from "./admin-queries";
import { ReadOnlyNotice } from "./admin-ui";
import { isConflictError } from "./api";
import { Kbd } from "./bits";
import { editorDocFromDetail, normalizedTranscript, useEditorCatalog, type EditorCatalog } from "./editor-support";
import { useTestOrgId } from "./org";
import { scriptElementNames, testQueryKeys, useRunElementNames, useStepScripts, useTestCaseRuns, useTestCaseVersions, useTestRun, useUpdateTestCase } from "./queries";

// The case's editable document: one state shared by the Steps pane and the Details drawer, with
// Save = PATCH with expectedVersion. A 409 means someone saved in between, and the user chooses
// whose version wins (the conflict banner).

export type CaseEditor = {
  doc: EditorDoc;
  setDoc: (doc: EditorDoc) => void;
  dirty: boolean;
  saving: boolean;
  // No test_case.update: the editor never leaves read-only.
  locked: boolean;
  conflict: { mine: string } | null;
  save: (options?: { force?: boolean; doc?: EditorDoc }) => void;
  discard: () => void;
  // Set the `# Title`; saved at once when nothing else is pending.
  rename: (title: string) => void;
  catalog: EditorCatalog;
  environment: ReturnType<EditorCatalog["environmentFor"]>;
  stepStatus: Readonly<Record<string, StepEditorRowStatus>>;
  elementNames: string[];
  versions: readonly { version: number; createdAt: number; changeNote: string | null }[];
  // Called once the user interacts; lazy queries (versions, element names) start then.
  engage: () => void;
};

export function useCaseEditor(detail: TestCaseDetail): CaseEditor {
  const toast = useToast();
  const catalog = useEditorCatalog();
  const update = useUpdateTestCase();
  const queryClient = useQueryClient();
  const orgId = useTestOrgId();
  const [doc, setDoc] = React.useState<EditorDoc>(() => editorDocFromDetail(detail));
  const permissions = useTestPermissions();
  const locked = !permissions.loading && !permissions.can("test_case.update");
  const [conflict, setConflict] = React.useState<{ mine: string } | null>(null);
  const [engaged, setEngaged] = React.useState(false);
  const loadedVersion = React.useRef({ id: detail.id, version: detail.transcriptVersion });

  const saved = React.useMemo(() => normalizedTranscript(detail.transcript), [detail.transcript]);
  const current = serializeEditorDoc(doc);
  const dirty = current !== saved;

  // A new server version replaces the editor content unless the user has unsaved edits.
  React.useEffect(() => {
    const changedCase = loadedVersion.current.id !== detail.id;
    const changedVersion = loadedVersion.current.version !== detail.transcriptVersion;
    if (!changedCase && !changedVersion) return;
    if (changedCase || !dirty) {
      setDoc(editorDocFromDetail(detail));
      setConflict(null);
    }
    loadedVersion.current = { id: detail.id, version: detail.transcriptVersion };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id, detail.transcriptVersion]);

  const scriptsQuery = useStepScripts(detail.id);
  const runsQuery = useTestCaseRuns(detail.id);
  const lastRun = runsQuery.data?.items.find((run) => run.status === "completed" || run.status === "failed") ?? null;
  const lastRunQuery = useTestRun(lastRun?.id ?? null);
  const archiveNames = useRunElementNames(lastRun?.evidenceId ?? null, engaged);
  const versionsQuery = useTestCaseVersions(detail.id, engaged);

  const stepStatus = React.useMemo(() => {
    const status: Record<string, StepEditorRowStatus> = {};
    for (const script of scriptsQuery.data ?? []) {
      const existing = status[script.stepId];
      if (existing?.cache === "active") continue;
      status[script.stepId] = {
        cache: script.status,
        cacheDetail: script.status === "active" ? `v${script.version} · replayed ${script.verifiedCount}×` : script.staleReason,
        lastOutcome: existing?.lastOutcome ?? null
      };
    }
    for (const step of lastRunQuery.data?.steps ?? []) {
      if (step.status === "pending" || step.status === "running") continue;
      status[step.stepId] = { cache: status[step.stepId]?.cache ?? null, cacheDetail: status[step.stepId]?.cacheDetail ?? null, lastOutcome: step.status, lastMode: step.mode };
    }
    return status;
  }, [scriptsQuery.data, lastRunQuery.data]);

  const elementNames = React.useMemo(
    () => [...new Set([...scriptElementNames(scriptsQuery.data ?? []), ...(archiveNames.data ?? [])])],
    [scriptsQuery.data, archiveNames.data]
  );

  const environment = catalog.environmentFor(doc, detail.environmentId);

  const save = (options: { force?: boolean; doc?: EditorDoc } = {}) => {
    const target = options.doc ?? doc;
    const transcript = serializeEditorDoc(target);
    // Nothing to save: the document equals the stored version.
    if (!options.doc && !dirty) return;
    // Read-only or already saving: the toolbar is disabled, a shortcut still lands here.
    if (locked || update.isPending) return;
    const targetEnvironment = catalog.environmentFor(target, detail.environmentId);
    update.mutate(
      {
        id: detail.id,
        transcript,
        ...(options.force ? {} : { expectedVersion: detail.transcriptVersion }),
        ...(targetEnvironment && targetEnvironment.id !== detail.environmentId ? { environmentId: targetEnvironment.id } : {})
      },
      {
        onSuccess: (updated) => {
          setConflict(null);
          loadedVersion.current = { id: updated.id, version: updated.transcriptVersion };
          setDoc(editorDocFromDetail(updated));
          toast.success("Case saved", `${updated.key} · v${updated.transcriptVersion}`);
        },
        onError: (error) => {
          if (isConflictError(error)) {
            setConflict({ mine: transcript });
            void queryClient.invalidateQueries({ queryKey: testQueryKeys.detail(orgId, detail.id) });
            return;
          }
          toast.error("Save failed", error instanceof Error ? error.message : undefined);
        }
      }
    );
  };

  return {
    doc,
    setDoc,
    dirty,
    saving: update.isPending,
    locked,
    conflict,
    save,
    discard: () => {
      setDoc(editorDocFromDetail(detail));
      setConflict(null);
    },
    rename: (title) => {
      const next = setTitle(doc, title);
      setDoc(next);
      if (!dirty) save({ doc: next });
    },
    catalog,
    environment,
    stepStatus,
    elementNames,
    versions: versionsQuery.data ?? [],
    engage: () => setEngaged(true)
  };
}

// Left pane of the case page: the structured editor. Read-only while a run is being watched;
// "Edit steps" switches to editing, Save writes the new version.
export function StepsPane(props: {
  detail: TestCaseDetail;
  editor: CaseEditor;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onRun: () => void;
  // Step picked in the Flow view or the run; the editor scrolls to it and reports focus back.
  activeStepId?: string | null;
  onActiveStepChange?: (stepId: string | null) => void;
  // The case page owns the Steps | Text switch and draws the toolbar in its own header; on its
  // own the pane keeps the editor's switch and toolbar.
  mode?: TestCaseEditorMode;
  onModeChange?: (mode: TestCaseEditorMode) => void;
}): React.JSX.Element {
  const { detail, editor } = props;
  const toast = useToast();
  const [ownMode, setOwnMode] = React.useState<TestCaseEditorMode>("steps");
  const hostOwnsMode = props.mode !== undefined;
  const mode = props.mode ?? ownMode;
  const setMode = props.onModeChange ?? setOwnMode;
  const multiCaseWarned = React.useRef(0);
  const readOnly = editor.locked || !props.editing;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3"
      onFocusCapture={editor.engage}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          editor.save();
        }
      }}
    >
      {editor.locked ? <ReadOnlyNotice permission="test_case.update" /> : null}
      {editor.conflict ? (
        <ConflictBanner
          detailVersion={detail.transcriptVersion}
          onReload={editor.discard}
          onOverwrite={() => editor.save({ force: true })}
          onCopy={() => void navigator.clipboard?.writeText(editor.conflict?.mine ?? "").then(() => toast.success("Your transcript is on the clipboard"))}
          busy={editor.saving}
        />
      ) : null}
      <TestCaseEditor
        doc={editor.doc}
        onChange={editor.setDoc}
        readOnly={readOnly}
        mode={mode}
        onModeChange={setMode}
        macros={editor.catalog.macros}
        macrosLoaded={editor.catalog.macrosLoaded}
        cases={editor.catalog.cases}
        casesLoaded={editor.catalog.casesLoaded}
        caseKey={detail.key}
        credentials={editor.catalog.credentials}
        environmentVariables={editor.environment ? Object.keys(editor.environment.variables) : []}
        environmentName={editor.environment?.name ?? null}
        elementNames={editor.elementNames}
        stepStatus={editor.stepStatus}
        activeStepId={props.activeStepId ?? null}
        {...(props.onActiveStepChange ? { onActiveStepChange: props.onActiveStepChange } : {})}
        onRun={() => {
          if (editor.dirty) editor.save();
          props.onRun();
        }}
        onMultiCasePaste={(_document, cases) => {
          if (multiCaseWarned.current === cases) return;
          multiCaseWarned.current = cases;
          toast.error(`${cases} cases in one document`, "Only the first is kept here. Use New (c) to split a multi-case document.");
        }}
        modesHidden={hostOwnsMode}
        toolbar={hostOwnsMode ? undefined : <EditorToolbar editor={editor} editing={props.editing} onEditingChange={props.onEditingChange} />}
      />
    </div>
  );
}

export function EditorToolbar(props: { editor: CaseEditor; editing: boolean; onEditingChange: (editing: boolean) => void }): React.JSX.Element {
  const { editor } = props;
  if (editor.locked) return <></>;
  if (!props.editing) {
    return (
      <Button size="sm" variant="outline" className="jl-tc-press" onClick={() => props.onEditingChange(true)}>
        <Pencil aria-hidden /> Edit steps
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {editor.dirty ? (
        <Button size="sm" variant="ghost" className="jl-tc-press" onClick={editor.discard} disabled={editor.saving}>
          Discard
        </Button>
      ) : (
        <Button size="sm" variant="ghost" className="jl-tc-press" onClick={() => props.onEditingChange(false)}>
          Done
        </Button>
      )}
      <Button size="sm" className="jl-tc-press" onClick={() => editor.save()} disabled={!editor.dirty || editor.saving} aria-keyshortcuts="Meta+S" aria-busy={editor.saving}>
        {editor.saving ? "Saving…" : "Save"} <Kbd>{isMacPlatform() ? "⌘S" : "Ctrl+S"}</Kbd>
      </Button>
    </div>
  );
}

export function ConflictBanner(props: { detailVersion: number; busy: boolean; onReload: () => void; onOverwrite: () => void; onCopy: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/45 bg-warning/10 px-3 py-2 text-sm">
      <span className="mr-auto">Someone saved this case while you were editing; the latest version is v{props.detailVersion} or newer.</span>
      <Button size="xs" variant="ghost" onClick={props.onCopy}>
        Copy mine
      </Button>
      <Button size="xs" variant="secondary" onClick={props.onReload} disabled={props.busy}>
        Load theirs
      </Button>
      <Button size="xs" variant="destructive" onClick={props.onOverwrite} disabled={props.busy}>
        Overwrite with mine
      </Button>
    </div>
  );
}
