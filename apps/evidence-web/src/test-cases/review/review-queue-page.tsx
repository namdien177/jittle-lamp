import React, { useEffect, useReducer, useRef, useState } from "react";
import { safeExternalHref } from "@jittle-lamp/ui";
import { Link, useNavigate } from "react-router";
import { Check, ExternalLink, Inbox, Pencil, X } from "lucide-react";
import type { TestCaseDetail } from "@jittle-lamp/shared";

import { PageBody, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/input";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { cn } from "../../lib/cn";
import { useToast } from "../../toast";
import { formatRelativeTime } from "../../utils";
import { testAdminApi } from "../admin-api";
import { testAdminKeys, useAdminTestCase, useReviewQueue, useSimilarForCase, useTestAdminMutation, useTestPermissions } from "../admin-queries";
import { importBatchHref } from "../../notifications/notification-links";
import { AdminCard, ErrorNote, Kbd, LintBadge, ReadOnlyNotice, TranscriptView, pressable } from "../admin-ui";
import { approveCleanPrompt, caseEditorHref, cleanCaseIds, initialReviewQueueState, reviewKeyCommand, reviewQueueReducer, type ReviewCommand } from "./review-queue-state";

// Review queue (design.md §7): imported and AI-generated cases wait in `review` until approved.

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.getAttribute("role") === "combobox";
}

const sourceLabel: Record<TestCaseDetail["source"], string> = {
  manual: "Manual",
  import: "Import",
  ai: "AI generation",
  duplicate: "Duplicate",
  recording: "Recording"
};

export function TestCaseReviewQueuePage(): React.JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const permissions = useTestPermissions();
  const canApprove = permissions.can("test_case.approve");
  const queue = useReviewQueue();
  const items = queue.data?.items ?? [];
  const [state, dispatch] = useReducer(reviewQueueReducer, undefined, () => initialReviewQueueState());
  const [reason, setReason] = useState("");
  const [confirmClean, setConfirmClean] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const detail = useAdminTestCase(state.selectedId);
  const selected = items.find((item) => item.id === state.selectedId) ?? null;
  const similar = useSimilarForCase(state.selectedId, selected?.title ?? null);
  const clean = cleanCaseIds(items);
  const cleanPrompt = approveCleanPrompt(items);

  const itemIds = items.map((item) => item.id).join(",");
  useEffect(() => {
    dispatch({ type: "sync", ids: itemIds ? itemIds.split(",") : [] });
  }, [itemIds]);

  useEffect(() => {
    if (state.rejecting) reasonRef.current?.focus();
  }, [state.rejecting]);

  useEffect(() => {
    if (!state.selectedId) return;
    listRef.current?.querySelector(`[data-case-id="${CSS.escape(state.selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [state.selectedId]);

  const bulk = useTestAdminMutation(
    (getToken, input: { action: "approve" | "reject"; ids: string[]; reason?: string }) =>
      testAdminApi.bulkTestCases(getToken, { action: input.action, ids: input.ids, ...(input.reason ? { reason: input.reason } : {}) }),
    [testAdminKeys.cases]
  );

  const run = async (action: "approve" | "reject", ids: string[], rejectReason?: string) => {
    if (ids.length === 0) return;
    try {
      const result = await bulk.mutateAsync({ action, ids, ...(rejectReason ? { reason: rejectReason } : {}) });
      const failed = new Set(result.errors.map((error) => error.id));
      dispatch({ type: "removed", ids: ids.filter((id) => !failed.has(id)) });
      if (result.errors.length > 0) toast.error(`${result.errors.length} could not be ${action === "approve" ? "approved" : "rejected"}: ${result.errors[0]?.message ?? ""}`);
      else if (ids.length > 1) toast.success(`Approved ${result.updated} cases`);
      setReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Request failed.");
    }
  };

  const execute = (command: ReviewCommand) => {
    switch (command) {
      case "next":
        dispatch({ type: "move", delta: 1 });
        return;
      case "previous":
        dispatch({ type: "move", delta: -1 });
        return;
      case "edit":
        if (state.selectedId) navigate(caseEditorHref(state.selectedId));
        return;
      case "approve":
        if (state.selectedId) void run("approve", [state.selectedId]);
        return;
      case "approve-clean":
        // A bulk approval always asks first, with the count.
        if (cleanPrompt) setConfirmClean(true);
        return;
      case "reject":
        dispatch({ type: "start-reject" });
        return;
      case "cancel":
        dispatch({ type: "cancel-reject" });
        setReason("");
        return;
    }
  };

  const executeRef = useRef(execute);
  executeRef.current = execute;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || bulk.isPending || confirmClean) return;
      const command = reviewKeyCommand(
        { key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, editableTarget: isEditableTarget(event.target) },
        { canApprove, rejecting: state.rejecting }
      );
      if (!command) return;
      // Ignore keys while a dialog or menu owns focus.
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox][data-open]") && command !== "cancel") return;
      event.preventDefault();
      executeRef.current(command);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canApprove, state.rejecting, bulk.isPending, confirmClean]);

  const submitReject = () => {
    if (!state.selectedId || reason.trim().length === 0) return;
    void run("reject", [state.selectedId], reason.trim());
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/test-cases" className="hover:text-foreground">
            Test cases
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            Review queue
            {queue.data ? <Badge variant="outline" className="text-sm">{items.length}</Badge> : null}
          </span>
        }
        description="Imported and AI-generated cases stay in review until someone approves them. Approved cases become active; rejected ones are archived with your reason."
        actions={
          <>
            <Link to="/test-cases/import" className="text-sm font-semibold text-primary hover:underline">
              Import
            </Link>
            {canApprove ? (
              <Button variant="outline" size="sm" className={pressable} disabled={clean.length === 0 || bulk.isPending} onClick={() => execute("approve-clean")}>
                Approve all without warnings ({clean.length})
                <Kbd>⇧A</Kbd>
              </Button>
            ) : null}
          </>
        }
      />
      <PageBody className="max-w-[90rem]">
        {!canApprove && !permissions.loading ? <ReadOnlyNotice permission="test_case.approve" /> : null}
        <ErrorNote error={queue.error} />
        {queue.isPending ? (
          <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <Skeleton className="h-96" />
            <Skeleton className="h-96" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={<Inbox aria-hidden />} title="Nothing to review" description="Imports and AI generations land here before they become runnable." action={<Link to="/test-cases/import" className="font-semibold text-primary hover:underline">Import test cases</Link>} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
            <div
              ref={listRef}
              role="listbox"
              aria-label="Cases waiting for review"
              aria-activedescendant={state.selectedId ? `review-${state.selectedId}` : undefined}
              tabIndex={0}
              className="jl-scroll grid max-h-[calc(100vh-14rem)] grid-cols-[minmax(0,1fr)] content-start gap-1 overflow-y-auto rounded-md border border-border bg-card p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/55"
            >
              {items.map((item) => {
                const active = item.id === state.selectedId;
                return (
                  <div
                    key={item.id}
                    id={`review-${item.id}`}
                    data-case-id={item.id}
                    role="option"
                    aria-selected={active}
                    onClick={() => dispatch({ type: "select", id: item.id })}
                    className={cn("flex cursor-pointer items-start justify-between gap-2 rounded-md px-3 py-2", active ? "bg-secondary shadow-soft" : "hover:bg-muted")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground" title={item.title}>{item.title || "Untitled"}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {item.key} · {item.source} · {item.stepCount} steps
                      </span>
                    </span>
                    <span className="shrink-0">
                      <LintBadge errors={item.lintErrors} warnings={item.lintWarnings} />
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="grid min-w-0 content-start gap-4">
              {detail.isPending || !detail.data ? (
                detail.isError ? <ErrorNote error={detail.error} /> : <Skeleton className="h-96" />
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-4 py-3">
                    <div className="mr-auto min-w-0">
                      <p className="font-mono text-xs text-muted-foreground">{detail.data.key}</p>
                      <h2 className="truncate font-display text-lg font-bold">{detail.data.title}</h2>
                    </div>
                    <Button size="sm" className={pressable} disabled={!canApprove || bulk.isPending} onClick={() => execute("approve")}>
                      <Check aria-hidden />
                      Approve <Kbd>a</Kbd>
                    </Button>
                    <Button variant="secondary" size="sm" className={pressable} onClick={() => execute("edit")}>
                      <Pencil aria-hidden />
                      Edit <Kbd>e</Kbd>
                    </Button>
                    <Button variant="ghost" size="sm" className={pressable} disabled={!canApprove || bulk.isPending} onClick={() => execute("reject")}>
                      <X aria-hidden />
                      Reject <Kbd>x</Kbd>
                    </Button>
                  </div>

                  {state.rejecting ? (
                    <form
                      className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4"
                      onSubmit={(event) => {
                        event.preventDefault();
                        submitReject();
                      }}
                    >
                      <label htmlFor="reject-reason" className="text-sm font-semibold text-foreground">
                        Why reject this case? The reason feeds back into the next generation.
                      </label>
                      <Textarea
                        id="reject-reason"
                        ref={reasonRef}
                        value={reason}
                        maxLength={500}
                        onChange={(event) => setReason(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            execute("cancel");
                          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            submitReject();
                          }
                        }}
                        placeholder="Duplicates TC-0412; asserts the wrong role"
                      />
                      <div className="flex items-center justify-end gap-2">
                        <span className="mr-auto text-xs text-muted-foreground">
                          <Kbd>⌘⏎</Kbd> reject · <Kbd>Esc</Kbd> cancel
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => execute("cancel")}>
                          Cancel
                        </Button>
                        <Button type="submit" variant="destructive" size="sm" disabled={reason.trim().length === 0 || bulk.isPending}>
                          Reject case
                        </Button>
                      </div>
                    </form>
                  ) : null}

                  <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                    <AdminCard title="Transcript" description={`${detail.data.lint.length} lint finding${detail.data.lint.length === 1 ? "" : "s"} · version ${detail.data.transcriptVersion}`}>
                      <TranscriptView transcript={detail.data.transcript} findings={detail.data.lint} label={`Transcript of ${detail.data.key}`} />
                    </AdminCard>
                    <AdminCard title="Source" description={`${sourceLabel[detail.data.source]} · created ${formatRelativeTime(detail.data.createdAt)}`}>
                      <dl className="grid gap-3 text-sm">
                        {detail.data.sourceRef ? (
                          <div>
                            <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">{detail.data.source === "import" ? "Import batch" : "Reference"}</dt>
                            <dd className="break-all font-mono text-foreground">
                              {detail.data.source === "import" ? (
                                <Link to={importBatchHref(detail.data.sourceRef)} className="text-primary hover:underline">
                                  {detail.data.sourceRef}
                                </Link>
                              ) : (
                                detail.data.sourceRef
                              )}
                            </dd>
                          </div>
                        ) : null}
                        {detail.data.externalId ? (
                          <div>
                            <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">External id</dt>
                            <dd className="font-mono text-foreground">{detail.data.externalId}</dd>
                          </div>
                        ) : null}
                        {detail.data.description ? (
                          <div>
                            <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Description</dt>
                            <dd className="whitespace-pre-wrap rounded-md border border-border bg-muted px-3 py-2 text-foreground">{detail.data.description}</dd>
                          </div>
                        ) : null}
                        {detail.data.links.length > 0 ? (
                          <div>
                            <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Links</dt>
                            <dd className="grid gap-1">
                              {detail.data.links.map((link) => {
                                const href = safeExternalHref(link.url);
                                return href ? (
                                  <a key={link.url} href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-primary hover:underline">
                                    {link.label ?? link.url}
                                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                                  </a>
                                ) : (
                                  <span key={link.url} className="break-all text-muted-foreground">
                                    {link.label ?? link.url}
                                  </span>
                                );
                              })}
                            </dd>
                          </div>
                        ) : null}
                        {detail.data.tags.length > 0 ? (
                          <div>
                            <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Tags</dt>
                            <dd className="flex flex-wrap gap-1">
                              {detail.data.tags.map((tag) => (
                                <Badge key={tag} variant="outline">
                                  {tag}
                                </Badge>
                              ))}
                            </dd>
                          </div>
                        ) : null}
                        <div>
                          <dt className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Similar cases</dt>
                          <dd>
                            {similar.data && similar.data.items.length > 0 ? (
                              <ul className="grid gap-1">
                                {similar.data.items.slice(0, 5).map((match) => (
                                  <li key={match.id} className="flex items-center gap-2">
                                    <Link to={caseEditorHref(match.id)} className="font-mono text-xs text-primary hover:underline" aria-label={`Open ${match.key} ${match.title}`}>
                                      {match.key}
                                    </Link>
                                    <span className="min-w-0 flex-1 truncate text-foreground">{match.title}</span>
                                    <span className="tabular-nums text-muted-foreground">{Math.round(match.score * 100)}%</span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-muted-foreground">{similar.isPending ? "Checking…" : "None found"}</span>
                            )}
                          </dd>
                        </div>
                      </dl>
                    </AdminCard>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>x</Kbd> reject · <Kbd>e</Kbd> edit · <Kbd>⇧A</Kbd> approve all without warnings
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </PageBody>
      <ConfirmDialog
        open={confirmClean && cleanPrompt !== null}
        title={cleanPrompt?.title ?? ""}
        description={cleanPrompt?.description}
        confirmLabel={cleanPrompt?.confirmLabel ?? "Approve"}
        busy={bulk.isPending}
        onCancel={() => setConfirmClean(false)}
        onConfirm={() => {
          setConfirmClean(false);
          if (cleanPrompt) void run("approve", cleanPrompt.ids);
        }}
      />
    </>
  );
}
