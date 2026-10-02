import React, { useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Download, ExternalLink } from "lucide-react";
import type { ImportItem } from "@jittle-lamp/shared";

import { PageBody, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Skeleton } from "../../components/ui/misc";
import { Select } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../utils";
import { testAdminApi } from "../admin-api";
import { testAdminKeys, useActiveOrgId, useImportBatch, useTestAdminMutation, useTestPermissions } from "../admin-queries";
import { AdminCard, ErrorNote, LintBadge, LintFindingList, ReadOnlyNotice, StatTile, TranscriptView, downloadText, pressable } from "../admin-ui";
import { caseEditorHref } from "../review/review-queue-state";
import {
  applyDecisionToSimilar,
  batchOverview,
  bestMatch,
  decisionOptions,
  importErrorRows,
  importErrorsCsv,
  itemIsEditable,
  lintCounts,
  similarityClass,
  type ImportDecision
} from "./batch-state";
// Batch page (design.md §7): progress, counts, per-row lint and duplicates, decisions, commit.

const statusLabel: Record<string, string> = {
  parsing: "Parsing",
  ready: "Ready to commit",
  committing: "Committing",
  done: "Done",
  error: "Failed"
};

const stateBadge: Record<ImportItem["state"], { label: string; variant: "outline" | "success" | "muted" | "danger" | "default" }> = {
  pending: { label: "normalising", variant: "outline" },
  ready: { label: "ready", variant: "default" },
  committed: { label: "committed", variant: "success" },
  skipped: { label: "skipped", variant: "muted" },
  error: { label: "error", variant: "danger" }
};

export function TestCaseImportBatchPage(): React.JSX.Element {
  const { batchId = "" } = useParams();
  const orgId = useActiveOrgId();
  const queryClient = useQueryClient();
  const batchQuery = useImportBatch(batchId);
  const permissions = useTestPermissions();
  const canEdit = permissions.can("test_case.create");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmCommit, setConfirmCommit] = useState(false);

  const patch = useTestAdminMutation(
    (getToken, body: { decisions?: Array<{ itemId: string; decision: ImportDecision }>; commit?: boolean }) => testAdminApi.patchImportBatch(getToken, batchId, body),
    [testAdminKeys.reviewQueue]
  );

  const applyPatch = async (body: { decisions?: Array<{ itemId: string; decision: ImportDecision }>; commit?: boolean }) => {
    const key = testAdminKeys.importBatch(orgId, batchId);
    const previous = queryClient.getQueryData(key);
    if (body.decisions?.length) {
      // Optimistic: decisions show at once; the PATCH response replaces them.
      const byId = new Map(body.decisions.map((decision) => [decision.itemId, decision.decision]));
      queryClient.setQueryData(key, (current: typeof batchQuery.data) =>
        current ? { ...current, items: current.items.map((item) => (byId.has(item.id) ? { ...item, decision: byId.get(item.id) as ImportDecision } : item)) } : current
      );
    }
    try {
      const next = await patch.mutateAsync(body);
      queryClient.setQueryData(key, next);
    } catch {
      queryClient.setQueryData(key, previous);
    }
  };

  if (batchQuery.isPending) {
    return (
      <PageBody className="max-w-6xl">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </PageBody>
    );
  }
  if (batchQuery.isError || !batchQuery.data) {
    return (
      <PageBody className="max-w-6xl">
        <ErrorNote error={batchQuery.error ?? new Error("Import batch not found.")} />
      </PageBody>
    );
  }

  const batch = batchQuery.data;
  const overview = batchOverview(batch);
  const errorRows = importErrorRows(batch.items);
  const editable = canEdit && batch.status === "ready";
  const exactPending = batch.items.filter((item) => itemIsEditable(item) && similarityClass(item) === "exact" && item.decision !== "skip");
  const committable = overview.toCreate + overview.toUpdate + overview.toMerge;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/test-cases/import" className="hover:text-foreground">
            Import
          </Link>
        }
        title={`Import batch · ${batch.sourceKind}`}
        description={`Started ${formatRelativeTime(batch.createdAt)} · ${batch.counts.total.toLocaleString()} rows`}
        actions={
          <>
            <Badge variant={batch.status === "error" ? "danger" : batch.status === "done" ? "success" : "outline"}>{statusLabel[batch.status] ?? batch.status}</Badge>
            <Button
              variant="outline"
              size="sm"
              className={pressable}
              disabled={errorRows.length === 0}
              onClick={() => downloadText(`import-${batch.id}-errors.csv`, importErrorsCsv(batch.items), "text/csv")}
            >
              <Download aria-hidden />
              Error CSV ({errorRows.length})
            </Button>
          </>
        }
      />
      <PageBody className="max-w-6xl">
        {!canEdit && !permissions.loading ? <ReadOnlyNotice permission="test_case.create" /> : null}

        <div
          role="progressbar"
          aria-label="Import progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={overview.percent}
          className="h-1.5 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn("h-full rounded-full bg-primary transition-[width] duration-200 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none", batch.status === "error" && "bg-destructive")}
            style={{ width: `${overview.percent}%` }}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Created" value={batch.counts.created} tone="success" />
          <StatTile label="Updated" value={batch.counts.updated} />
          <StatTile label="Skipped" value={batch.counts.skipped} />
          <StatTile label="Errors" value={batch.counts.errors} tone={batch.counts.errors > 0 ? "danger" : "default"} />
          <StatTile label="Similar" value={overview.exact + overview.near} detail={`${overview.exact} exact · ${overview.near} near`} tone={overview.exact + overview.near > 0 ? "warning" : "default"} />
        </div>

        <AdminCard
          title="Rows"
          description={
            batch.status === "ready"
              ? `${overview.toCreate} create · ${overview.toUpdate} update · ${overview.toMerge} merge · ${overview.toSkip} skip${overview.normalising ? ` · ${overview.normalising} normalising` : ""}`
              : overview.lintErrors > 0
                ? `${overview.lintErrors} rows with lint errors`
                : undefined
          }
          actions={
            editable ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={exactPending.length === 0 || patch.isPending}
                  onClick={() => void applyPatch({ decisions: exactPending.map((item) => ({ itemId: item.id, decision: "skip" })) })}
                >
                  Skip all exact duplicates ({exactPending.length})
                </Button>
                <Button size="sm" className={pressable} disabled={committable === 0 || patch.isPending || overview.normalising > 0} onClick={() => setConfirmCommit(true)}>
                  Commit {committable} as review
                </Button>
              </>
            ) : null
          }
          bodyClassName="p-0 pt-0"
        >
          <ErrorNote error={patch.error} className="mx-5 mt-4" />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 pl-5">#</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-28">Lint</TableHead>
                <TableHead className="w-56">Similar</TableHead>
                <TableHead className="w-60 pr-5">Decision</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batch.items.map((item) => (
                <BatchRow
                  key={item.id}
                  item={item}
                  expanded={expanded === item.id}
                  onToggle={() => setExpanded((current) => (current === item.id ? null : item.id))}
                  editable={editable && itemIsEditable(item)}
                  busy={patch.isPending}
                  onDecision={(decision) => void applyPatch({ decisions: [{ itemId: item.id, decision }] })}
                  onApplyToSimilar={() => {
                    const decisions = applyDecisionToSimilar(batch.items, item, item.decision);
                    if (decisions.length > 0) void applyPatch({ decisions });
                  }}
                  similarCount={applyDecisionToSimilar(batch.items, item, item.decision).length}
                />
              ))}
            </TableBody>
          </Table>
        </AdminCard>
      </PageBody>
      <ConfirmDialog
        open={confirmCommit}
        title={`Commit ${committable} cases?`}
        description={`Creates ${overview.toCreate}, updates ${overview.toUpdate} and merges ${overview.toMerge} cases as "review". ${overview.toSkip} rows are skipped. Approve them in the review queue to make them runnable.`}
        confirmLabel="Commit"
        busy={patch.isPending}
        onCancel={() => setConfirmCommit(false)}
        onConfirm={() => {
          setConfirmCommit(false);
          void applyPatch({ commit: true });
        }}
      />
    </>
  );
}

function BatchRow(props: {
  item: ImportItem;
  expanded: boolean;
  onToggle: () => void;
  editable: boolean;
  busy: boolean;
  onDecision: (decision: ImportDecision) => void;
  onApplyToSimilar: () => void;
  similarCount: number;
}): React.JSX.Element {
  const { item } = props;
  const counts = lintCounts(item.lint);
  const match = bestMatch(item);
  const kind = similarityClass(item);
  const badge = stateBadge[item.state];
  const ExpandIcon = props.expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow className={cn(item.state === "error" && "bg-destructive/5")}>
        <TableCell className="pl-5 font-mono text-xs">{item.ordinal + 1}</TableCell>
        <TableCell>
          <button
            type="button"
            className="flex items-start gap-1.5 text-left"
            aria-expanded={props.expanded}
            aria-label={`${props.expanded ? "Hide" : "Show"} transcript and lint for row ${item.ordinal + 1}`}
            onClick={props.onToggle}
          >
            <ExpandIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <span className="font-medium text-foreground">{item.title || <em className="text-muted-foreground">untitled</em>}</span>
              {item.externalId ? <span className="ml-2 font-mono text-xs text-muted-foreground">{item.externalId}</span> : null}
            </span>
          </button>
          {item.error ? <p className="ml-5 text-sm text-destructive">{item.error}</p> : null}
          {!props.expanded && item.lint.length > 0 ? (
            <LintFindingList findings={item.lint.filter((finding) => finding.severity !== "info").slice(0, 2)} className="ml-5 mt-1" />
          ) : null}
        </TableCell>
        <TableCell>
          <LintBadge errors={counts.errors} warnings={counts.warnings} pending={item.state === "pending"} />
        </TableCell>
        <TableCell>
          {item.similar.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <ul className="grid gap-1">
              {[...item.similar]
                .sort((left, right) => right.score - left.score)
                .slice(0, 3)
                .map((similar) => (
                  <li key={similar.id} className="flex items-center gap-1.5 text-sm">
                    <Link
                      to={caseEditorHref(similar.id)}
                      target="_blank"
                      className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
                      aria-label={`Open ${similar.key} ${similar.title} in a new tab`}
                      title={similar.title}
                    >
                      {similar.key}
                      <ExternalLink className="size-3" aria-hidden />
                    </Link>
                    <span className="tabular-nums text-muted-foreground">{Math.round(similar.score * 100)}%</span>
                    {similar.exact ? <Badge variant="warning" className="px-1.5 py-0 text-[11px]">exact</Badge> : null}
                  </li>
                ))}
            </ul>
          )}
        </TableCell>
        <TableCell className="pr-5">
          {item.state === "committed" || item.state === "skipped" || item.state === "error" ? (
            <div className="flex items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {item.resultTestCaseId ? (
                <Link to={caseEditorHref(item.resultTestCaseId)} className="text-sm text-primary hover:underline">
                  Open case
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="grid gap-1">
              <Select
                size="sm"
                ariaLabel={`Decision for row ${item.ordinal + 1}`}
                value={item.decision}
                disabled={!props.editable || props.busy}
                onValueChange={(value) => props.onDecision(value)}
                options={decisionOptions(item)}
              />
              {props.editable && kind !== "none" && props.similarCount > 0 ? (
                <button type="button" className="text-left text-xs font-semibold text-primary hover:underline" onClick={props.onApplyToSimilar} disabled={props.busy}>
                  Apply “{item.decision}” to {props.similarCount} other {kind} match{props.similarCount === 1 ? "" : "es"}
                </button>
              ) : null}
              {match && item.decision !== "create" && item.decision !== "skip" ? <span className="text-xs text-muted-foreground">target: {match.title}</span> : null}
            </div>
          )}
        </TableCell>
      </TableRow>
      {props.expanded ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="px-5 pb-4">
            <TranscriptView transcript={item.transcript} findings={item.lint} label={`Transcript of row ${item.ordinal + 1}`} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
