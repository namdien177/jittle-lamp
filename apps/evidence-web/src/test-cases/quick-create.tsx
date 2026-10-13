import React from "react";
import { useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Pencil, Sparkles, X } from "lucide-react";
import type { DraftTestCaseResponse, LintFinding } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { ConfirmDialog, Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { SimpleSelect } from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { Hint } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { useToast } from "../toast";
import {
  defaultEnvironmentId,
  describeDraftError,
  draftRows,
  filterStartFromCases,
  lintSummary,
  loadLastEnvironment,
  manualTranscript,
  storeLastEnvironment,
  withTitle,
  type StartFromCase
} from "./draft-model";
import { useTestOrgId } from "./org";
import { useCreateTestCase, useCreateTestRun, useDraftTestCase, useLinkableCases, useTestEnvironments } from "./queries";
import { describeRunRequestError } from "./run-errors";

// "What do you want to test?" (roadmap §3.2): one screen from the New button, `c` and the empty
// state. Plain text in; either a placeholder case opens in the editor ("Write steps myself"), or
// the act model drafts the steps, the draft is shown in place, and "Save and run" creates the
// case and queues its first run (decision 3: a watched authoring run saves the case as active).

export type QuickCreatePhase = "compose" | "drafting" | "drafted" | "saving" | "queueing";

export type QuickCreateDraft = Pick<DraftTestCaseResponse, "transcript" | "lint" | "similar"> & { title: string };

export type QuickCreateViewProps = {
  text: string;
  onTextChange: (text: string) => void;
  environments: ReadonlyArray<{ id: string; name: string }>;
  environmentId: string;
  onEnvironmentChange: (id: string) => void;
  startFromCases: readonly StartFromCase[];
  startFrom: StartFromCase | null;
  onStartFromChange: (testCase: StartFromCase | null) => void;
  phase: QuickCreatePhase;
  draft: QuickCreateDraft | null;
  onDraftTitleChange: (title: string) => void;
  error: string | null;
  onWriteMyself: () => void;
  onDraft: () => void;
  onBackToText: () => void;
  onSaveAndRun: () => void;
  onClose: () => void;
};

const placeholder = ["Login as PCF HQ admin, open the registration list,", "open the first pending application and approve it.", "The status should change to Approved."].join("\n");

export function QuickCreateDialog(props: { onClose: () => void }): React.JSX.Element {
  const toast = useToast();
  const navigate = useNavigate();
  const orgId = useTestOrgId();
  const environmentsQuery = useTestEnvironments();
  const casesQuery = useLinkableCases();
  const draftMutation = useDraftTestCase();
  const create = useCreateTestCase();
  const createRun = useCreateTestRun();
  const storage = typeof window === "undefined" ? null : window.localStorage;

  const [text, setText] = React.useState("");
  const [environmentId, setEnvironmentId] = React.useState("");
  const [startFrom, setStartFrom] = React.useState<StartFromCase | null>(null);
  const [phase, setPhase] = React.useState<QuickCreatePhase>("compose");
  const [draft, setDraft] = React.useState<QuickCreateDraft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const environments = React.useMemo(() => (environmentsQuery.data ?? []).map((environment) => ({ id: environment.id, name: environment.name })), [environmentsQuery.data]);
  const startFromCases = casesQuery.data?.cases ?? [];

  // Opens on the last used environment of this organisation.
  React.useEffect(() => {
    if (environmentId || environments.length === 0) return;
    setEnvironmentId(defaultEnvironmentId(environments, loadLastEnvironment(storage, orgId)));
  }, [environments, environmentId, orgId, storage]);

  const chooseEnvironment = (id: string) => {
    setEnvironmentId(id);
    storeLastEnvironment(storage, orgId, id);
  };

  const busy = phase === "drafting" || phase === "saving" || phase === "queueing";
  const hasText = text.trim().length > 0;

  const requestClose = () => {
    if (busy) return;
    if (hasText && phase === "compose") {
      setConfirmDiscard(true);
      return;
    }
    props.onClose();
  };

  const writeMyself = async () => {
    if (!hasText || busy) return;
    setError(null);
    setPhase("saving");
    try {
      const created = await create.mutateAsync({ transcript: manualTranscript(text), status: "active", source: "manual", ...(environmentId ? { environmentId } : {}) });
      toast.success("Case saved", created.key);
      props.onClose();
      navigate(`/test-cases/${encodeURIComponent(created.id)}?edit=1`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the case.");
      setPhase("compose");
    }
  };

  const draftWithAi = async () => {
    if (!hasText || busy || !environmentId) return;
    setError(null);
    setPhase("drafting");
    try {
      const result = await draftMutation.mutateAsync({ text, environmentId, ...(startFrom ? { startFromCaseId: startFrom.key } : {}) });
      setDraft({ title: result.title, transcript: result.transcript, lint: result.lint, similar: result.similar });
      setPhase("drafted");
    } catch (failure) {
      setError(describeDraftError(failure));
      setPhase("compose");
    }
  };

  const saveAndRun = async () => {
    if (!draft || busy) return;
    setError(null);
    setPhase("saving");
    let caseId: string;
    try {
      const created = await create.mutateAsync({ transcript: withTitle(draft.transcript, draft.title), status: "active", source: "ai", environmentId });
      caseId = created.id;
      toast.success("Case saved", created.key);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save the case.");
      setPhase("drafted");
      return;
    }
    setPhase("queueing");
    try {
      const run = await createRun.mutateAsync({ testCaseId: caseId, environmentId, cacheMode: "read-write", trigger: "manual" });
      toast.success(run.attached ? "Attached to a queued run" : `Run queued${run.queuePosition === null ? "" : ` (position ${run.queuePosition + 1})`}`);
    } catch (failure) {
      // The case exists; the page offers Run again.
      toast.error("Run request failed", describeRunRequestError(failure).message);
    }
    props.onClose();
    navigate(`/test-cases/${encodeURIComponent(caseId)}`);
  };

  return (
    <>
      <Dialog
        open
        disablePointerDismissal
        onOpenChange={(open) => {
          if (!open) requestClose();
        }}
      >
        <DialogContent size={phase === "drafted" || phase === "queueing" ? "xl" : "lg"} showCloseButton={false} className="jl-tc-scope jl-tc-dialog">
          <QuickCreateView
            text={text}
            onTextChange={setText}
            environments={environments}
            environmentId={environmentId}
            onEnvironmentChange={chooseEnvironment}
            startFromCases={startFromCases}
            startFrom={startFrom}
            onStartFromChange={setStartFrom}
            phase={phase}
            draft={draft}
            onDraftTitleChange={(title) => setDraft((current) => (current ? { ...current, title } : current))}
            error={error}
            onWriteMyself={() => void writeMyself()}
            onDraft={() => void draftWithAi()}
            onBackToText={() => {
              setPhase("compose");
              setError(null);
            }}
            onSaveAndRun={() => void saveAndRun()}
            onClose={requestClose}
          />
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard what you typed?"
        confirmLabel="Discard"
        destructive
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          props.onClose();
        }}
      />
    </>
  );
}

// The dialog's content without the Dialog root, so it renders in tests and in any host.
export function QuickCreateView(props: QuickCreateViewProps): React.JSX.Element {
  const { phase, draft } = props;
  const busy = phase === "drafting" || phase === "saving" || phase === "queueing";
  const hasText = props.text.trim().length > 0;
  const showDraft = draft !== null && phase !== "compose" && phase !== "drafting";

  return (
    <>
      <DialogHeader className="pr-5">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{showDraft ? "Review the draft" : "What do you want to test?"}</DialogTitle>
          <Hint label="Close">
            <Button variant="ghost" size="icon-sm" className="jl-tc-press -mr-1" aria-label="Close" onClick={props.onClose} disabled={busy}>
              <X aria-hidden />
            </Button>
          </Hint>
        </div>
      </DialogHeader>

      <DialogBody className="gap-4 pt-2">
        {showDraft && draft ? (
          <DraftView draft={draft} onTitleChange={props.onDraftTitleChange} disabled={busy} />
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <Textarea
                autoFocus
                value={props.text}
                disabled={busy}
                maxLength={8000}
                rows={6}
                placeholder={placeholder}
                aria-label="Describe the test"
                aria-invalid={props.error ? true : undefined}
                className="min-h-[9.5rem] resize-y text-base leading-relaxed"
                onChange={(event) => props.onTextChange(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    props.onDraft();
                  }
                }}
              />
              {props.error ? (
                <p role="alert" className="jl-tc-enter text-sm text-destructive">
                  {props.error}
                </p>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Environment
                <SimpleSelect
                  ariaLabel="Environment"
                  value={props.environmentId}
                  disabled={busy || props.environments.length === 0}
                  onValueChange={props.onEnvironmentChange}
                  options={props.environments.length > 0 ? props.environments.map((environment) => ({ value: environment.id, label: environment.name })) : [{ value: "", label: "No environment yet" }]}
                />
              </label>
              <StartFromPicker cases={props.startFromCases} value={props.startFrom} onChange={props.onStartFromChange} disabled={busy} />
            </div>
          </>
        )}
      </DialogBody>

      <DialogFooter className="items-center sm:justify-between">
        {showDraft ? (
          <>
            <Button variant="ghost" size="sm" className="jl-tc-press" onClick={props.onBackToText} disabled={busy}>
              <ArrowLeft aria-hidden /> Back
            </Button>
            <Button size="sm" className="jl-tc-press" onClick={props.onSaveAndRun} disabled={busy} aria-busy={busy}>
              {phase === "saving" ? <PendingLabel>Saving…</PendingLabel> : phase === "queueing" ? <PendingLabel>Queueing…</PendingLabel> : "Save and run"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" className="jl-tc-press" onClick={props.onWriteMyself} disabled={busy || !hasText} aria-busy={phase === "saving"}>
              {phase === "saving" ? <PendingLabel>Saving…</PendingLabel> : (
                <>
                  <Pencil aria-hidden /> Write steps myself
                </>
              )}
            </Button>
            <Button size="sm" className="jl-tc-press" onClick={props.onDraft} disabled={busy || !hasText || !props.environmentId} aria-busy={phase === "drafting"} aria-keyshortcuts="Meta+Enter">
              {phase === "drafting" ? <PendingLabel>Drafting…</PendingLabel> : (
                <>
                  <Sparkles aria-hidden /> Run it with AI <ArrowRight aria-hidden />
                </>
              )}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
}

function PendingLabel(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <Spinner className="jl-tc-spin size-3.5" /> {props.children}
    </>
  );
}

// Search by key or title; the chosen case shows as a chip the draft starts from.
function StartFromPicker(props: { cases: readonly StartFromCase[]; value: StartFromCase | null; onChange: (value: StartFromCase | null) => void; disabled: boolean }): React.JSX.Element {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const matches = filterStartFromCases(props.cases, query);
  const listId = React.useId();
  return (
    <div className="relative flex flex-col gap-1.5 text-xs text-muted-foreground">
      <span>Start from</span>
      {props.value ? (
        <span className="flex h-8 items-center gap-2 rounded-md border border-border bg-secondary/60 px-2 text-sm text-foreground">
          <span className="font-mono text-xs text-muted-foreground">{props.value.key}</span>
          <span className="min-w-0 flex-1 truncate">{props.value.title}</span>
          <button type="button" className="jl-tc-press rounded text-muted-foreground hover:text-foreground" aria-label="Clear start from" onClick={() => props.onChange(null)} disabled={props.disabled}>
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      ) : (
        <Input
          value={query}
          disabled={props.disabled || props.cases.length === 0}
          placeholder={props.cases.length === 0 ? "No cases yet" : "Optional"}
          aria-label="Start from an existing case"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              props.onChange(matches[0]);
              setOpen(false);
            }
          }}
        />
      )}
      {open && !props.value && matches.length > 0 ? (
        <ul id={listId} role="listbox" className="jl-tc-enter absolute left-0 right-0 top-[calc(100%+4px)] z-50 flex flex-col gap-0.5 rounded-md border border-border-strong bg-popover p-1 shadow-pop">
          {matches.map((testCase) => (
            <li key={testCase.key} role="option" aria-selected={false}>
              <button
                type="button"
                className="jl-tc-press jl-tc-hover flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onChange(testCase);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-xs text-muted-foreground">{testCase.key}</span>
                <span className="min-w-0 flex-1 truncate">{testCase.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The draft as a read-only step list: a colour rail per type, the instruction as the only text,
// checkpoints as section headers, rows staggered in (§3.7).
function DraftView(props: { draft: QuickCreateDraft; onTitleChange: (title: string) => void; disabled: boolean }): React.JSX.Element {
  const rows = React.useMemo(() => draftRows(props.draft.transcript), [props.draft.transcript]);
  const summary = lintSummary(props.draft.lint);
  const errors = props.draft.lint.filter((finding) => finding.severity === "error").length;
  return (
    <div className="flex flex-col gap-3">
      <Input
        value={props.draft.title}
        disabled={props.disabled}
        aria-label="Title"
        className="h-9 text-base font-medium"
        onChange={(event) => props.onTitleChange(event.currentTarget.value)}
      />
      <ol className="jl-tc-stagger flex flex-col gap-0.5" aria-label="Draft steps">
        {rows.map((row, index) =>
          row.kind === "checkpoint" ? (
            <li key={row.id} className="mt-2 px-1 pb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground" style={{ "--i": index } as React.CSSProperties}>
              {row.title}
            </li>
          ) : (
            <li key={row.id} className={cn("flex min-h-10 items-center gap-3 rounded-md px-1 py-1.5", row.disabled && "opacity-50")} style={{ "--i": index } as React.CSSProperties}>
              <Hint label={row.tag}>
                <span className="jl-tc-rail h-7 w-1.5 shrink-0 rounded-full" data-type={row.type} aria-label={row.tag} role="img" />
              </Hint>
              <span className="min-w-0 flex-1 text-base leading-snug text-foreground">{row.text}</span>
            </li>
          )
        )}
      </ol>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>{rows.filter((row) => row.kind === "step").length} steps</span>
        {summary ? (
          <Hint label={<LintList lint={props.draft.lint} />}>
            <span className={cn("cursor-default", errors > 0 ? "text-destructive" : "text-warning")}>{summary}</span>
          </Hint>
        ) : null}
        {props.draft.similar.length > 0 ? <span>{props.draft.similar.length} similar: {props.draft.similar.map((item) => item.key).join(", ")}</span> : null}
      </div>
    </div>
  );
}

function LintList(props: { lint: readonly LintFinding[] }): React.JSX.Element {
  return (
    <ul className="flex max-w-xs flex-col gap-1">
      {props.lint.slice(0, 8).map((finding, index) => (
        <li key={`${finding.ruleId}-${index}`} className={finding.severity === "error" ? "text-destructive" : ""}>
          {finding.message}
        </li>
      ))}
    </ul>
  );
}
