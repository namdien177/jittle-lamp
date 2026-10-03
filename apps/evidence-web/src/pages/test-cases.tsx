import React from "react";
import { useSearchParams } from "react-router";
import type { TestCaseDetail, TestCaseSummary } from "@jittle-lamp/shared";
import { isMacPlatform } from "@jittle-lamp/ui";

import { Button } from "../components/ui/button";
import { SimpleDialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { SimpleSelect } from "../components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "../components/ui/sheet";
import { useAccountProfile } from "../queries";
import { useToast } from "../toast";
import { CaseDetailPane, type DetailTab } from "../test-cases/case-detail";
import { CaseListPane, type BulkAction } from "../test-cases/case-list";
import { CaseSidebar } from "../test-cases/case-sidebar";
import { useDebounced } from "../test-cases/editor-support";
import {
  buildTagGroups,
  defaultColumns,
  defaultSort,
  emptyFilters,
  emptySelection,
  leavingDetailNeedsConfirm,
  listKeyCommand,
  listKeyEventIgnored,
  listSelectionReducer,
  loadSavedViews,
  storeSavedViews,
  upsertSavedView,
  type ListColumnId,
  type ListFilters,
  type ListSort,
  type SavedView
} from "../test-cases/list-model";
import { QuickCreateDialog } from "../test-cases/quick-create";
import { useBulkTestCases, useTestCaseList, useTestEnvironments, useTestTags } from "../test-cases/queries";
import { describeRunRequestError } from "../test-cases/run-errors";
import { DuplicateTestCaseDialog } from "../test-cases/duplicate-dialog";
import { RunDialog } from "../test-cases/run-dialog";

export type TestCasesPageProps = {
  // Duplicate dialog slot (unit 1c.4). Without it, `d` navigates to `?duplicate=<ids>`.
  onDuplicate?: (ids: string[]) => void;
  renderDuplicateDialog?: (input: { ids: string[]; onClose: () => void }) => React.ReactNode;
};


type BulkDialog = { action: "tag" | "untag" | "set-environment" | "archive"; ids: string[] } | null;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.closest("[role='dialog'],[role='menu'],[role='listbox']") !== null;
}

// A field the user types into (not just any element inside a dialog).
function isTextEntry(target: Element | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes((target as HTMLInputElement).type));
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("button, a[href], [role='button'], [role='menuitem'], [role='tab'], summary") !== null;
}

export function TestCasesPage(props: TestCasesPageProps = {}): React.JSX.Element {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const openId = searchParams.get("case");
  const tab = (["steps", "sessions", "scripts"] as const).find((candidate) => candidate === searchParams.get("tab")) ?? "steps";
  const duplicateIds = searchParams.get("duplicate")?.split(",").filter(Boolean) ?? [];

  const account = useAccountProfile();
  const orgId = account.data?.activeOrgId ?? null;
  const [filters, setFilters] = React.useState<ListFilters>(emptyFilters);
  const [searchDraft, setSearchDraft] = React.useState("");
  const debouncedSearch = useDebounced(searchDraft, 250);
  const [sort, setSort] = React.useState<ListSort>(defaultSort);
  const [columns, setColumns] = React.useState<ListColumnId[]>(defaultColumns);
  const [savedViews, setSavedViews] = React.useState<SavedView[]>([]);
  const [selection, dispatch] = React.useReducer(listSelectionReducer, undefined, emptySelection);
  const [scrollToken, setScrollToken] = React.useState(0);
  const [quickCreate, setQuickCreate] = React.useState(false);
  const [runTarget, setRunTarget] = React.useState<{ testCase: Pick<TestCaseSummary, "id" | "key" | "title" | "environmentId">; hasDataset: boolean } | null>(null);
  const [bulkDialog, setBulkDialog] = React.useState<BulkDialog>(null);
  const searchRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    setFilters((current) => (current.q === debouncedSearch ? current : { ...current, q: debouncedSearch }));
  }, [debouncedSearch]);

  React.useEffect(() => {
    if (orgId) setSavedViews(loadSavedViews(typeof window === "undefined" ? null : window.localStorage, orgId));
  }, [orgId]);

  const list = useTestCaseList(filters, sort);
  const environmentsQuery = useTestEnvironments();
  const tagsQuery = useTestTags();
  const bulk = useBulkTestCases();
  const environments = environmentsQuery.data ?? [];
  const tagDefinitions = tagsQuery.data ?? [];
  const items = list.items;
  const ids = React.useMemo(() => items.map((item) => item.id), [items]);
  const tagGroups = React.useMemo(() => buildTagGroups(list.tagCounts, tagDefinitions), [list.tagCounts, tagDefinitions]);

  React.useEffect(() => {
    dispatch({ type: "move", delta: 0, count: ids.length });
  }, [ids.length]);

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: false });
  };

  // Unsaved Steps-tab edits: leaving the case or the tab asks first (and so does closing the page).
  const [detailDirty, setDetailDirty] = React.useState(false);
  const [pendingLeave, setPendingLeave] = React.useState<(() => void) | null>(null);
  const guardDetail = (next: { caseId: string | null; tab: DetailTab }, go: () => void) => {
    if (leavingDetailNeedsConfirm({ dirty: detailDirty, current: { caseId: openId, tab }, next })) setPendingLeave(() => go);
    else go();
  };
  React.useEffect(() => {
    if (!detailDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [detailDirty]);
  React.useEffect(() => setDetailDirty(false), [openId]);

  const openCase = (id: string) => {
    if (id === openId) return;
    guardDetail({ caseId: id, tab: "steps" }, () => setParams({ case: id, tab: null }));
  };
  const closeCase = () => guardDetail({ caseId: null, tab: "steps" }, () => setParams({ case: null, tab: null }));

  // Keyboard-driven changes render without motion; a pointer press turns motion back on.
  const [keyboardDriven, setKeyboardDriven] = React.useState(false);
  React.useEffect(() => {
    const onPointerDown = () => setKeyboardDriven(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const onDuplicate = (targetIds: string[]) => {
    if (targetIds.length === 0) return;
    if (props.onDuplicate) props.onDuplicate(targetIds);
    else setParams({ duplicate: targetIds.join(",") });
  };

  const persistViews = (views: SavedView[]) => {
    setSavedViews(views);
    if (orgId) storeSavedViews(window.localStorage, orgId, views);
  };

  const applyView = (input: { filters: ListFilters; sort?: ListSort; columns?: ListColumnId[] }) => {
    setFilters(input.filters);
    setSearchDraft(input.filters.q);
    if (input.sort) setSort(input.sort);
    if (input.columns) setColumns(input.columns);
    dispatch({ type: "clear" });
  };

  const cursorCase = items[selection.cursor];
  const selectedIds = [...selection.selected];
  const actionIds = selectedIds.length > 0 ? selectedIds : cursorCase ? [cursorCase.id] : [];

  const runCase = (testCase: Pick<TestCaseSummary, "id" | "key" | "title" | "environmentId">, hasDataset = false) => setRunTarget({ testCase, hasDataset });

  const runBulk = (action: BulkAction, targetIds = actionIds) => {
    if (targetIds.length === 0) return;
    if (action === "duplicate") return onDuplicate(targetIds);
    if (action === "tag" || action === "untag" || action === "set-environment" || action === "archive") return setBulkDialog({ action, ids: targetIds });
    bulk.mutate(
      { action, ids: targetIds },
      {
        onSuccess: (result) => {
          if (action === "export" && result.document) {
            const blob = new Blob([result.document], { type: "text/markdown" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `test-cases-${new Date().toISOString().slice(0, 10)}.transcript.md`;
            anchor.click();
            URL.revokeObjectURL(url);
            toast.success(`Exported ${targetIds.length} case${targetIds.length === 1 ? "" : "s"}`);
          } else if (action === "run") {
            const attached = result.runs.filter((run) => run.attached).length;
            toast.success(`${result.runs.length - attached} queued, ${attached} attached`, result.errors.length > 0 ? `${result.errors.length} failed` : undefined);
          } else {
            toast.success(`${action === "approve" ? "Approved" : "Updated"} ${result.updated}`);
          }
          if (result.errors.length > 0 && action !== "run") toast.error(`${result.errors.length} failed`, result.errors[0]?.message);
        },
        onError: (error) =>
          action === "run"
            ? toast.error("Run request failed", describeRunRequestError(error).message)
            : toast.error("Bulk action failed", error instanceof Error ? error.message : undefined)
      }
    );
  };

  // Keyboard map (design.md §7): j/k move, enter open, / search, x select, shift+x range,
  // c quick create, d duplicate, r run. No animation on these: the row simply moves.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (quickCreate || runTarget || bulkDialog || pendingLeave || duplicateIds.length > 0) return;
      if (listKeyEventIgnored(event)) return;
      const command = listKeyCommand({
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        inEditable: isEditableTarget(event.target),
        inInteractive: isInteractiveTarget(event.target)
      });
      if (!command) return;
      // Focus inside the detail pane keeps every key there except Escape.
      const inDetail = event.target instanceof HTMLElement && event.target.closest("[data-pane='detail']") !== null;
      if (inDetail && command !== "escape") return;
      setKeyboardDriven(true);
      switch (command) {
        case "next":
        case "prev":
          dispatch({ type: "move", delta: command === "next" ? 1 : -1, count: ids.length });
          setScrollToken((token) => token + 1);
          break;
        case "open":
          if (cursorCase) openCase(cursorCase.id);
          break;
        case "focus-search":
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case "toggle-select":
          dispatch({ type: "toggle", ids });
          break;
        case "range-select":
          dispatch({ type: "range", ids });
          break;
        case "select-all":
          dispatch({ type: "select-all", ids });
          break;
        case "quick-create":
          setQuickCreate(true);
          break;
        case "duplicate":
          onDuplicate(actionIds);
          break;
        case "run":
          if (selectedIds.length > 1) runBulk("run");
          else if (cursorCase) runCase(cursorCase);
          break;
        case "escape":
          if (event.target instanceof HTMLElement && isEditableTarget(event.target)) event.target.blur();
          else if (selection.selected.size > 0) dispatch({ type: "clear" });
          else if (openId) closeCase();
          break;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const detailOpen = openId !== null;
  // Keeps the case on screen while the sheet animates closed.
  const lastOpenId = React.useRef<string | null>(null);
  if (openId) lastOpenId.current = openId;
  const shownId = openId ?? lastOpenId.current;
  const sheetRef = React.useRef<HTMLDivElement | null>(null);

  return (
    <div className="jl-tc-scope grid h-full min-h-0 grid-cols-1 lg:grid-cols-[208px_minmax(0,1fr)]">
      <div className="hidden min-h-0 lg:flex">
        <CaseSidebar
          filters={filters}
          sort={sort}
          columns={columns}
          onApply={applyView}
          tagGroups={tagGroups}
          savedViews={savedViews}
          onSaveView={(name) => persistViews(upsertSavedView(savedViews, { id: `view_${Date.now().toString(36)}`, name, filters, sort, columns }))}
          onDeleteView={(id) => persistViews(savedViews.filter((view) => view.id !== id))}
        />
      </div>
      <div className="flex min-h-0 min-w-0">
        <CaseListPane
          items={items}
          total={list.total}
          loading={list.isPending}
          error={list.isError ? (list.error instanceof Error ? list.error.message : "Unable to load test cases.") : null}
          hasMore={Boolean(list.hasNextPage)}
          onNeedMore={() => {
            if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
          }}
          filters={filters}
          onFiltersChange={(next) => {
            setFilters(next);
            dispatch({ type: "clear" });
          }}
          searchDraft={searchDraft}
          onSearchDraftChange={setSearchDraft}
          searchRef={searchRef}
          sort={sort}
          onSortChange={setSort}
          columns={columns}
          onColumnsChange={setColumns}
          environments={environments}
          tagDefinitions={tagDefinitions}
          cursor={selection.cursor}
          openId={openId}
          selected={selection.selected}
          onRowClick={(index, event) => {
            dispatch({ type: "set-cursor", index });
            const item = items[index];
            if (!item) return;
            if (event.metaKey || event.ctrlKey) dispatch({ type: "toggle", ids });
            else if (event.shiftKey) dispatch({ type: "range", ids });
            else openCase(item.id);
          }}
          onToggleRow={(index, shift) => {
            dispatch({ type: "set-cursor", index });
            dispatch({ type: shift ? "range" : "toggle", ids });
          }}
          onSelectAll={() => dispatch({ type: "select-all", ids })}
          onClearSelection={() => dispatch({ type: "clear" })}
          onBulk={(action) => runBulk(action, selectedIds)}
          bulkBusy={bulk.isPending}
          onQuickCreate={() => setQuickCreate(true)}
          scrollToCursorToken={scrollToken}
          instant={keyboardDriven}
        />
      </div>
      {/* The open case slides in from the right over the list, like a dialog. */}
      <Sheet
        open={detailOpen}
        onOpenChange={(open, details) => {
          if (open) return;
          // Escape while typing leaves the field first; a second Escape closes the case.
          if (details.reason === "escape-key" && isTextEntry(document.activeElement)) {
            document.activeElement.blur();
            sheetRef.current?.focus();
            return;
          }
          closeCase();
        }}
      >
        <SheetContent
          ref={sheetRef}
          // Focus the sheet itself, not its first button; Tab moves into the case from there.
          initialFocus={sheetRef}
          side="right"
          showCloseButton={false}
          data-pane="detail"
          className="jl-tc-scope w-full p-0 sm:w-[70vw] sm:min-w-[560px] sm:max-w-[1000px]"
        >
          <SheetTitle className="sr-only">Test case</SheetTitle>
          {shownId ? (
          <CaseDetailPane
            key={shownId}
            caseId={shownId}
            tab={tab}
            onTabChange={(next: DetailTab) => guardDetail({ caseId: openId, tab: next }, () => setParams({ tab: next === "steps" ? null : next }))}
            onDirtyChange={setDetailDirty}
            environments={environments}
            tagDefinitions={tagDefinitions}
            onRun={(detail: TestCaseDetail) => runCase(detail, detail.dataset !== null && detail.dataset.rows.length > 0)}
            onDuplicate={onDuplicate}
            onClose={closeCase}
            onTagClick={(tag) => {
              setFilters((current) => ({ ...current, tags: current.tags.includes(tag) ? current.tags : [...current.tags, tag] }));
              closeCase();
            }}
          />
          ) : null}
        </SheetContent>
      </Sheet>

      {pendingLeave ? (
        <SimpleDialog
          open
          onClose={() => setPendingLeave(null)}
          size="sm"
          title="Discard unsaved changes?"
          description="The Steps tab has edits that are not saved yet."
          footer={
            <>
              <Button size="sm" variant="ghost" onClick={() => setPendingLeave(null)} autoFocus>
                Keep editing
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  const go = pendingLeave;
                  setPendingLeave(null);
                  setDetailDirty(false);
                  go();
                }}
              >
                Discard changes
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-muted-foreground">Save with {isMacPlatform() ? "⌘S" : "Ctrl+S"} first to keep them.</p>
        </SimpleDialog>
      ) : null}
      {quickCreate ? (
        <QuickCreateDialog
          onClose={() => setQuickCreate(false)}
          onCreated={(createdIds) => {
            setQuickCreate(false);
            const first = createdIds[0];
            if (first) openCase(first);
          }}
        />
      ) : null}
      {runTarget ? <RunDialog testCase={runTarget.testCase} hasDataset={runTarget.hasDataset} environments={environments} onClose={() => setRunTarget(null)} /> : null}
      {bulkDialog ? (
        <BulkDialogView
          dialog={bulkDialog}
          environments={environments.map((environment) => ({ value: environment.id, label: environment.name }))}
          tagSuggestions={tagDefinitions.map((tag) => (tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name))}
          busy={bulk.isPending}
          onClose={() => setBulkDialog(null)}
          onSubmit={(input) =>
            bulk.mutate(
              { action: bulkDialog.action, ids: bulkDialog.ids, ...input },
              {
                onSuccess: (result) => {
                  toast.success(`Updated ${result.updated} case${result.updated === 1 ? "" : "s"}`);
                  setBulkDialog(null);
                  if (bulkDialog.action === "archive") dispatch({ type: "clear" });
                },
                onError: (error) => toast.error("Bulk action failed", error instanceof Error ? error.message : undefined)
              }
            )
          }
        />
      ) : null}
      {duplicateIds.length > 0
        ? props.renderDuplicateDialog?.({ ids: duplicateIds, onClose: () => setParams({ duplicate: null }) }) ?? (
            <DuplicateTestCaseDialog key={duplicateIds.join(",")} caseIds={duplicateIds} onClose={() => setParams({ duplicate: null })} />
          )
        : null}
    </div>
  );

}

function BulkDialogView(props: {
  dialog: NonNullable<BulkDialog>;
  environments: { value: string; label: string }[];
  tagSuggestions: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: { tags?: string[]; environmentId?: string | null }) => void;
}): React.JSX.Element {
  const { dialog } = props;
  const [tags, setTags] = React.useState("");
  const [environmentId, setEnvironmentId] = React.useState(props.environments[0]?.value ?? "");
  const count = `${dialog.ids.length} case${dialog.ids.length === 1 ? "" : "s"}`;
  const title =
    dialog.action === "tag" ? `Tag ${count}` : dialog.action === "untag" ? `Remove tags from ${count}` : dialog.action === "set-environment" ? `Set environment of ${count}` : `Archive ${count}?`;
  const submit = () => {
    if (dialog.action === "tag" || dialog.action === "untag") {
      const list = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean);
      if (list.length > 0) props.onSubmit({ tags: list });
      return;
    }
    if (dialog.action === "set-environment") return props.onSubmit({ environmentId: environmentId || null });
    props.onSubmit({});
  };
  return (
    <SimpleDialog
      open
      onClose={props.onClose}
      size="sm"
      title={title}
      {...(dialog.action === "archive" ? { description: "Archived cases leave the default views and stop running in suites. Their runs and evidence stay." } : {})}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={props.busy}>
            Cancel
          </Button>
          <Button size="sm" variant={dialog.action === "archive" ? "destructive" : "default"} className="jl-tc-press" onClick={submit} disabled={props.busy}>
            {props.busy ? "Working…" : dialog.action === "archive" ? "Archive" : "Apply"}
          </Button>
        </>
      }
    >
      {dialog.action === "tag" || dialog.action === "untag" ? (
        <Field label="Tags" hint="Comma separated, e.g. team:qa-pcf, regression">
          <Input
            autoFocus
            list="jl-bulk-tag-suggestions"
            value={tags}
            onChange={(event) => setTags(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <datalist id="jl-bulk-tag-suggestions">
            {props.tagSuggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </Field>
      ) : null}
      {dialog.action === "set-environment" ? (
        <Field label="Environment">
          <SimpleSelect ariaLabel="Environment" value={environmentId} onValueChange={setEnvironmentId} options={props.environments} />
        </Field>
      ) : null}
    </SimpleDialog>
  );
}
