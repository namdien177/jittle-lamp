import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { TestCaseDetail } from "@jittle-lamp/shared";
import { TestCaseEditor, serializeEditorDoc, type EditorDoc, type StepEditorRowStatus, type TestCaseEditorMode } from "@jittle-lamp/ui";

import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel } from "../components/ui/dropdown-menu";
import { useToast } from "../toast";
import { useTestPermissions } from "./admin-queries";
import { ReadOnlyNotice } from "./admin-ui";
import { isConflictError } from "./api";
import { Kbd } from "./bits";
import { SimilarHint, editorDocFromDetail, normalizedTranscript, useEditorCatalog, type EditorCatalog } from "./editor-support";
import { formatRelative } from "./list-model";
import { useTestOrgId } from "./org";
import { scriptElementNames, testQueryKeys, useRunElementNames, useStepScripts, useTestCaseRuns, useTestCaseVersions, useTestRun, useUpdateTestCase } from "./queries";

type Conflict = { mine: string };

// Steps tab: the structured editor on a saved case. Save = PATCH with expectedVersion; a 409
// means someone saved in between, and the user chooses whose version wins.
export function StepsTab(props: { detail: TestCaseDetail; onRun: () => void; onDirtyChange?: (dirty: boolean) => void }): React.JSX.Element {
  const { detail } = props;
  const toast = useToast();
  const catalog = useEditorCatalog();
  const update = useUpdateTestCase();
  const queryClient = useQueryClient();
  const orgId = useTestOrgId();
  const [doc, setDoc] = React.useState<EditorDoc>(() => editorDocFromDetail(detail));
  const [mode, setMode] = React.useState<TestCaseEditorMode>("steps");
  // Without test_case.update the editor is read-only: no edits, no save.
  const permissions = useTestPermissions();
  const readOnly = !permissions.loading && !permissions.can("test_case.update");
  const [conflict, setConflict] = React.useState<Conflict | null>(null);
  const [engaged, setEngaged] = React.useState(false);
  const multiCaseWarned = React.useRef(0);
  const loadedVersion = React.useRef({ id: detail.id, version: detail.transcriptVersion });

  const saved = React.useMemo(() => normalizedTranscript(detail.transcript), [detail.transcript]);
  const current = serializeEditorDoc(doc);
  const dirty = current !== saved;

  const onDirtyChange = props.onDirtyChange;
  React.useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

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

  const save = (options: { force?: boolean } = {}) => {
    if (readOnly || !dirty || update.isPending) return;
    const transcript = current;
    update.mutate(
      {
        id: detail.id,
        transcript,
        ...(options.force ? {} : { expectedVersion: detail.transcriptVersion }),
        ...(environment && environment.id !== detail.environmentId ? { environmentId: environment.id } : {})
      },
      {
        onSuccess: (updated) => {
          setConflict(null);
          loadedVersion.current = { id: updated.id, version: updated.transcriptVersion };
          setDoc(editorDocFromDetail(updated));
          toast.success(`Saved v${updated.transcriptVersion}`, updated.key);
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

  return (
    <div
      className="flex flex-col gap-3"
      onFocusCapture={() => setEngaged(true)}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          save();
        }
      }}
    >
      {readOnly ? <ReadOnlyNotice permission="test_case.update" /> : null}
      {conflict ? (
        <ConflictBanner
          detailVersion={detail.transcriptVersion}
          onReload={() => {
            setConflict(null);
            setDoc(editorDocFromDetail(detail));
          }}
          onOverwrite={() => save({ force: true })}
          onCopy={() => void navigator.clipboard?.writeText(conflict.mine).then(() => toast.success("Your transcript is on the clipboard"))}
          busy={update.isPending}
        />
      ) : null}
      <TestCaseEditor
        doc={doc}
        onChange={setDoc}
        readOnly={readOnly}
        mode={mode}
        onModeChange={setMode}
        macros={catalog.macros}
        macrosLoaded={catalog.macrosLoaded}
        credentials={catalog.credentials}
        environments={catalog.environments}
        environmentVariables={environment ? Object.keys(environment.variables) : []}
        environmentName={environment?.name ?? null}
        tagSuggestions={catalog.tagSuggestions}
        elementNames={elementNames}
        stepStatus={stepStatus}
        titleAccessory={<SimilarHint title={doc.title} excludeId={detail.id} />}
        environmentFallback={catalog.environments.find((candidate) => candidate.id === detail.environmentId)?.name ?? null}
        onRun={() => {
          if (dirty) save();
          props.onRun();
        }}
        onMultiCasePaste={(_document, cases) => {
          if (multiCaseWarned.current === cases) return;
          multiCaseWarned.current = cases;
          toast.error(`${cases} cases in one document`, "Only the first is kept here. Use New case (c) to split a multi-case document.");
        }}
        toolbar={
          <EditorToolbar
            readOnly={readOnly}
            dirty={dirty}
            saving={update.isPending}
            version={detail.transcriptVersion}
            versions={versionsQuery.data ?? []}
            onSave={() => save()}
            onDiscard={() => setDoc(editorDocFromDetail(detail))}
          />
        }
      />
    </div>
  );
}

function EditorToolbar(props: {
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  version: number;
  versions: readonly { version: number; createdAt: number; changeNote: string | null }[];
  onSave: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <DropdownMenu
        align="end"
        trigger={
          <Button size="xs" variant="ghost" className="jl-tc-press" aria-label={`Version ${props.version}, show history`}>
            <History aria-hidden /> v{props.version}
          </Button>
        }
      >
        <DropdownMenuLabel>Versions</DropdownMenuLabel>
        {props.versions.length === 0 ? <DropdownMenuItem disabled>Loading…</DropdownMenuItem> : null}
        {props.versions.slice(0, 12).map((version) => (
          <DropdownMenuItem key={version.version} disabled>
            <span className="font-mono">v{version.version}</span>
            <span className="text-muted-foreground">{formatRelative(version.createdAt)}</span>
            {version.changeNote ? <span className="truncate">{version.changeNote}</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenu>
      {props.dirty && !props.readOnly ? (
        <>
          <span className="text-[12px] text-muted-foreground">Unsaved</span>
          <Button size="xs" variant="ghost" className="jl-tc-press" onClick={props.onDiscard} disabled={props.saving}>
            Discard
          </Button>
        </>
      ) : null}
      {props.readOnly ? null : (
        <Button size="xs" className="jl-tc-press" onClick={props.onSave} disabled={!props.dirty || props.saving} aria-keyshortcuts="Meta+S">
          {props.saving ? "Saving…" : "Save"} <Kbd>⌘S</Kbd>
        </Button>
      )}
    </div>
  );
}

function ConflictBanner(props: { detailVersion: number; busy: boolean; onReload: () => void; onOverwrite: () => void; onCopy: () => void }): React.JSX.Element {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-warning/45 bg-warning/10 px-3 py-2 text-[13px]">
      <span className="mr-auto">
        Someone saved this case while you were editing. Your changes are not saved yet; the latest version is v{props.detailVersion} or newer.
      </span>
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

export type { EditorCatalog };
