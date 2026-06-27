import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ArrowRightLeft,
  Check,
  Copy,
  Download,
  LayoutGrid,
  List,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Tag,
  Trash2,
  Users,
  Video,
} from "lucide-react";

import { PageBody, PageHeader } from "../components/page";
import { Button, buttonVariants } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Select } from "../components/ui/select";
import { EmptyState, Skeleton, Spinner } from "../components/ui/misc";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "../components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { ConfirmDialog, Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { cn } from "../lib/cn";
import type { ApiEvidenceSummary, ApiEvidenceTag, ApiOrganization, FetchToken } from "../api";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  useAccountProfile,
  useBulkDeleteEvidences,
  useCopyEvidence,
  useDeleteEvidence,
  useEvidenceTags,
  useEvidences,
  useMoveEvidence,
  useOrganizationMembers,
  useRenameEvidence,
  useUpdateEvidenceTags,
} from "../queries";
import { downloadEvidenceAsZip } from "../download-evidence";
import { ShareDialog } from "../share-dialog";
import { useToast } from "../toast";
import { copyToClipboard, formatRelativeTime } from "../utils";

const PAGE_SIZE = 50;

const personName = (person: {
  displayName?: string | null;
  email?: string | null;
  userId: string;
}): string =>
  person.displayName?.trim() || person.email?.trim() || person.userId;

const canManageOthers = (role: string | undefined): boolean =>
  role === "owner" || role === "admin" || role === "moderator";

export function EvidenceLibraryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const auth = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const accountQuery = useAccountProfile();
  const activeOrg = accountQuery.data?.organizations.find(
    (org) => org.isActive,
  );
  const currentUserId =
    accountQuery.data?.localUserId ?? accountQuery.data?.userId ?? null;
  const selectedCreatorIds = useMemo(
    () =>
      (params.get("people") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    [params],
  );
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const evidencesQuery = useEvidences({
    createdBy: selectedCreatorIds,
    search: params.get("q") ?? "",
    page,
    limit: PAGE_SIZE,
  });
  const membersQuery = useOrganizationMembers(activeOrg?.id ?? null, {
    limit: 100,
  });
  const tagsQuery = useEvidenceTags(activeOrg?.id);
  const deleteEvidence = useDeleteEvidence();
  const bulkDeleteEvidences = useBulkDeleteEvidences();

  const [shareTarget, setShareTarget] = useState<ApiEvidenceSummary | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<ApiEvidenceSummary | null>(
    null,
  );
  const [tagTarget, setTagTarget] = useState<ApiEvidenceSummary | null>(null);
  const [workspaceActionTarget, setWorkspaceActionTarget] = useState<{
    evidence: ApiEvidenceSummary;
    action: "copy" | "transfer";
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ApiEvidenceSummary | null>(
    null,
  );
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [bulkDownloading, setBulkDownloading] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const getToken: FetchToken = () => auth.getToken();

  const search = params.get("q") ?? "";
  const view = params.get("view") === "grid" ? "grid" : "table";

  const setParam = (key: string, value: string, fallback: string): void => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === fallback) next.delete(key);
        else next.set(key, value);
        if (key !== "page") next.delete("page");
        return next;
      },
      { replace: true },
    );
  };

  const evidences = evidencesQuery.data?.evidences ?? [];
  const total = evidencesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const members = membersQuery.data?.members ?? [];
  const tags = tagsQuery.data?.tags ?? [];
  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) {
      map.set(
        member.userId,
        member.userId === currentUserId ? "You" : personName(member),
      );
    }
    return map;
  }, [currentUserId, members]);
  const memberById = useMemo(() => {
    const map = new Map<string, (typeof members)[number]>();
    for (const member of members) map.set(member.userId, member);
    return map;
  }, [members]);
  const activeOrgRole = activeOrg?.role;
  const canDelete = (evidence: ApiEvidenceSummary): boolean =>
    evidence.createdBy === currentUserId || canManageOthers(activeOrgRole);
  const isOwnEvidence = (evidence: ApiEvidenceSummary): boolean =>
    currentUserId !== null && evidence.createdBy === currentUserId;
  const isDeletingSomeoneElse = (evidence: ApiEvidenceSummary): boolean =>
    Boolean(currentUserId && evidence.createdBy !== currentUserId);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = evidences.filter((e) => {
      const matchesQuery =
        !q ||
        [
          e.title,
          e.id,
          memberNameById.get(e.createdBy) ?? e.createdBy,
        ].some((f) => f.toLowerCase().includes(q));
      return matchesQuery;
    });
    return list;
  }, [evidences, memberNameById, search]);

  // `selectedIds` is the raw user selection; everywhere it is consumed it is
  // intersected with the current `evidences` (see `selectedEvidences` below and
  // the bulk handlers), so stale ids are filtered at read time — no syncing
  // effect needed. Bulk-delete prunes the set on success.
  const selectedEvidences = useMemo(
    () => evidences.filter((evidence) => selectedIds.has(evidence.id)),
    [evidences, selectedIds],
  );
  const filteredSelectedCount = filtered.filter((evidence) =>
    selectedIds.has(evidence.id),
  ).length;
  const allFilteredSelected =
    filtered.length > 0 && filteredSelectedCount === filtered.length;
  const hasSelection = selectedEvidences.length > 0;
  const selectedOtherCount = selectedEvidences.filter(
    isDeletingSomeoneElse,
  ).length;
  const selectedUndeletableCount = selectedEvidences.filter(
    (evidence) => !canDelete(evidence),
  ).length;

  const loading = evidencesQuery.isPending;
  const deletingId = deleteEvidence.variables ?? null;
  const error =
    evidencesQuery.error instanceof Error
      ? evidencesQuery.error.message
      : deleteEvidence.error instanceof Error
        ? deleteEvidence.error.message
        : null;

  const handleDownload = async (
    evidence: ApiEvidenceSummary,
  ): Promise<void> => {
    setDownloadingId(evidence.id);
    try {
      await downloadEvidenceAsZip({
        getToken,
        evidenceId: evidence.id,
        orgId: evidence.orgId,
        title: evidence.title,
      });
      toast.success("Download started", "ZIP saved to your downloads folder.");
    } catch (downloadError) {
      toast.error(
        "Download failed",
        downloadError instanceof Error ? downloadError.message : undefined,
      );
    } finally {
      setDownloadingId(null);
    }
  };

  const setEvidenceSelected = (evidenceId: string, selected: boolean): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (selected) next.add(evidenceId);
      else next.delete(evidenceId);
      return next;
    });
  };

  const toggleFilteredSelection = (): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (allFilteredSelected) {
        for (const evidence of filtered) next.delete(evidence.id);
      } else {
        for (const evidence of filtered) next.add(evidence.id);
      }
      return next;
    });
  };

  const handleBulkDownload = async (): Promise<void> => {
    if (selectedEvidences.length === 0) return;
    setBulkDownloading(true);
    try {
      for (const evidence of selectedEvidences) {
        await downloadEvidenceAsZip({
          getToken,
          evidenceId: evidence.id,
          orgId: evidence.orgId,
          title: evidence.title,
        });
      }
      toast.success(
        "Downloads started",
        `${selectedEvidences.length} ZIP files saved to your downloads folder.`,
      );
    } catch (downloadError) {
      toast.error(
        "Bulk download failed",
        downloadError instanceof Error ? downloadError.message : undefined,
      );
    } finally {
      setBulkDownloading(false);
    }
  };

  const confirmDelete = (): void => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    deleteEvidence.mutate(target.id, {
      onSuccess: () => {
        toast.success(
          "Evidence moved to bin",
          "It will auto-purge after 30 days.",
        );
        setPendingDelete(null);
      },
      onError: (mutationError) =>
        toast.error(
          "Delete failed",
          mutationError instanceof Error ? mutationError.message : undefined,
        ),
    });
  };

  const confirmBulkDelete = async (): Promise<void> => {
    if (selectedEvidences.length === 0) return;
    const targets = selectedEvidences;
    setBulkDeleting(true);
    try {
      await bulkDeleteEvidences.mutateAsync(
        targets.map((evidence) => evidence.id),
      );
      toast.success(
        "Evidence moved to bin",
        `${targets.length} record${targets.length === 1 ? "" : "s"} will purge after 30 days.`,
      );
      setSelectedIds((previous) => {
        const next = new Set(previous);
        for (const evidence of targets) next.delete(evidence.id);
        return next;
      });
      setPendingBulkDelete(false);
    } catch (mutationError) {
      toast.error(
        "Bulk delete failed",
        mutationError instanceof Error ? mutationError.message : undefined,
      );
    } finally {
      setBulkDeleting(false);
    }
  };

  const setCreatorFilter = (personId: string, selected: boolean): void => {
    const next = new Set(selectedCreatorIds);
    if (selected) next.add(personId);
    else next.delete(personId);
    setParam("people", Array.from(next).join(","), "");
  };

  const navigateToEvidence = (evidence: ApiEvidenceSummary): void => {
    navigate(`/evidence/${encodeURIComponent(evidence.id)}`);
  };

  const handleShareCopy = async (evidence: ApiEvidenceSummary): Promise<void> => {
    try {
      const result = await api.createShareLink(getToken, evidence.id);
      const url = `${window.location.origin}/share/${encodeURIComponent(result.shareLink.slug)}`;
      await copyToClipboard(url);
      toast.success("Share URL copied", evidence.title);
    } catch (error) {
      toast.error(
        "Unable to copy share URL",
        error instanceof Error ? error.message : undefined,
      );
    }
  };

  const actions = (
    evidence: ApiEvidenceSummary,
    downloading: boolean,
    deleting: boolean,
  ): React.JSX.Element => (
    <DropdownMenu
      trigger={
        <button
          type="button"
          aria-label="More actions"
          disabled={downloading || deleting}
          className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          {downloading || deleting ? (
            <Spinner />
          ) : (
            <MoreVertical className="size-4" aria-hidden />
          )}
        </button>
      }
    >
      <DropdownMenuItem
        onClick={() => navigateToEvidence(evidence)}
      >
        <Play aria-hidden />
        Review
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setTagTarget(evidence)}>
        <Tag aria-hidden />
        Tags
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setRenameTarget(evidence)}>
        <Pencil aria-hidden />
        Rename
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => setShareTarget(evidence)}>
        <Share2 aria-hidden />
        Share link
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => setWorkspaceActionTarget({ evidence, action: "copy" })}
      >
        <Copy aria-hidden />
        Copy to workspace
      </DropdownMenuItem>
      {isOwnEvidence(evidence) ? (
        <DropdownMenuItem
          onClick={() =>
            setWorkspaceActionTarget({ evidence, action: "transfer" })
          }
        >
          <ArrowRightLeft aria-hidden />
          Transfer
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onClick={() => void handleDownload(evidence)}>
        <Download aria-hidden />
        Download ZIP
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        destructive
        disabled={!canDelete(evidence)}
        onClick={() => setPendingDelete(evidence)}
      >
        <Trash2 aria-hidden />
        Delete
      </DropdownMenuItem>
    </DropdownMenu>
  );

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Evidence library"
        description={`${total} records in this workspace.`}
        actions={
          <Button
            variant="outline"
            onClick={() => void evidencesQuery.refetch()}
            disabled={loading}
          >
            <RefreshCw aria-hidden className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <PageBody>
        {/* Toolbar */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative max-w-md flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={search}
              onChange={(e) => setParam("q", e.currentTarget.value, "")}
              placeholder="Search by title, user, or id"
              className="pl-9"
              aria-label="Search evidence"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu
              align="end"
              className="w-64"
              trigger={
                <button
                  type="button"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "sm" }),
                    "justify-start",
                  )}
                >
                  <Users aria-hidden />
                  {selectedCreatorIds.length === 0
                    ? "All people"
                    : `${selectedCreatorIds.length} selected`}
                </button>
              }
            >
              <DropdownMenuLabel>Recorded by</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setParam("people", "", "")}>
                <span className="inline-flex size-4 items-center justify-center">
                  {selectedCreatorIds.length === 0 ? (
                    <Check aria-hidden />
                  ) : null}
                </span>
                Everyone
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {members.length === 0 ? (
                <DropdownMenuItem disabled>
                  {membersQuery.isPending
                    ? "Loading people…"
                    : "No people found"}
                </DropdownMenuItem>
              ) : (
                members.map((member) => {
                  const selected = selectedCreatorIds.includes(member.userId);
                  return (
                    <DropdownMenuItem
                      key={member.userId}
                      onClick={() => setCreatorFilter(member.userId, !selected)}
                    >
                      <span className="inline-flex size-4 items-center justify-center">
                        {selected ? <Check aria-hidden /> : null}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {memberNameById.get(member.userId) ??
                          personName(member)}
                      </span>
                    </DropdownMenuItem>
                  );
                })
              )}
            </DropdownMenu>
            <div className="flex items-center rounded-md bg-secondary p-0.5">
              <button
                type="button"
                aria-label="Grid view"
                aria-pressed={view === "grid"}
                onClick={() => setParam("view", "grid", "table")}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-[3px] transition-colors",
                  view === "grid"
                    ? "bg-background text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LayoutGrid className="size-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Table view"
                aria-pressed={view === "table"}
                onClick={() => setParam("view", "table", "table")}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-[3px] transition-colors",
                  view === "table"
                    ? "bg-background text-foreground shadow-soft"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <List className="size-4" aria-hidden />
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/12 px-3 py-2 text-base text-destructive">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className=" text-muted-foreground">
            {loading
              ? "Loading…"
              : `${filtered.length} shown · ${total} total · latest first`}
          </p>
          {filtered.length > 0 ? (
            <label className="inline-flex w-fit items-center gap-2 text-muted-foreground">
              <input
                type="checkbox"
                checked={allFilteredSelected}
                ref={(element) => {
                  if (element)
                    element.indeterminate =
                      filteredSelectedCount > 0 && !allFilteredSelected;
                }}
                onChange={toggleFilteredSelection}
                className="size-4 accent-[var(--brand-500)]"
              />
              Select visible
            </label>
          ) : null}
        </div>

        {hasSelection ? (
          <div className="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/[0.08] px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-base font-medium text-foreground">
              {selectedEvidences.length} selected
              {selectedUndeletableCount > 0 ? (
                <span className="ml-2 font-normal text-destructive">
                  {selectedUndeletableCount} cannot be deleted because they belong to someone else
                </span>
              ) : null}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleBulkDownload()}
                disabled={bulkDownloading || bulkDeleting}
              >
                <Download aria-hidden />
                {bulkDownloading ? "Downloading…" : "Download ZIPs"}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setPendingBulkDelete(true)}
                disabled={
                  bulkDownloading ||
                  bulkDeleting ||
                  selectedUndeletableCount > 0
                }
              >
                <Trash2 aria-hidden />
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkDownloading || bulkDeleting}
              >
                Clear
              </Button>
            </div>
          </div>
        ) : null}

        {loading ? (
          view === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                <Skeleton key={i} className="aspect-[4/3] w-full" />
              ))}
            </div>
          ) : (
            <Skeleton className="h-64 w-full" />
          )
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Video aria-hidden />}
            title={
              evidences.length === 0
                ? "No evidence in this workspace yet"
                : "No matches"
            }
            description={
              evidences.length === 0
                ? "Upload from the desktop app or open a local archive in Quick view. Uploads land in the active organisation automatically."
                : "Try a different search term or filter."
            }
            action={
              evidences.length === 0 ? (
                <Button onClick={() => navigate("/quick-view")}>
                  <Plus aria-hidden />
                  Open a local archive
                </Button>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setParams({}, { replace: true })}
                >
                  Clear filters
                </Button>
              )
            }
          />
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {filtered.map((evidence) => (
              <Card
                key={evidence.id}
                className={cn(
                  "group relative flex flex-col overflow-hidden p-0 transition-[border-color,box-shadow]",
                  selectedIds.has(evidence.id) &&
                    "border-primary ring-2 ring-primary/30",
                )}
              >
                <div className="relative">
                  <label
                    className="absolute left-1.5 top-1.5 z-10 inline-flex shrink-0 items-center rounded-md bg-foreground/55 p-1 text-background opacity-0 transition-opacity group-hover:opacity-100 has-[:checked]:opacity-100"
                    aria-label={`Select ${evidence.title}`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(evidence.id)}
                      onChange={(event) =>
                        setEvidenceSelected(
                          evidence.id,
                          event.currentTarget.checked,
                        )
                      }
                      className="size-4 accent-[var(--brand-500)]"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/evidence/${encodeURIComponent(evidence.id)}`)
                    }
                    className="block w-full"
                    aria-label={`Review ${evidence.title}`}
                  >
                    <EvidenceThumbnail
                      evidence={evidence}
                      className="aspect-video w-full rounded-none border-0"
                    />
                  </button>
                  {evidence.status === "pending" ? (
                    <Badge variant="muted" className="absolute bottom-1.5 left-1.5">
                      Pending
                    </Badge>
                  ) : null}
                  <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-foreground/70 px-1.5 py-0.5 font-mono text-[10px] text-background">
                    {formatRelativeTime(evidence.createdAt)}
                  </span>
                  <div className="absolute right-1.5 top-1.5">
                    {actions(
                      evidence,
                      downloadingId === evidence.id,
                      deletingId === evidence.id,
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/evidence/${encodeURIComponent(evidence.id)}`)
                  }
                  className="min-w-0 px-3 pt-2.5 text-left"
                >
                  <span className="block truncate text-sm font-semibold text-foreground group-hover:text-primary">
                    {evidence.title}
                  </span>
                  <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Badge
                      variant="muted"
                      className="shrink-0 px-1.5 py-0 text-[10px] capitalize"
                    >
                      {evidence.sourceType}
                    </Badge>
                    <span className="truncate">
                      {memberNameById.get(evidence.createdBy) ??
                        evidence.createdBy}
                    </span>
                  </span>
                </button>
                <div className="mt-auto flex items-center gap-2 px-3 pb-3 pt-2.5">
                  <Button
                    size="sm"
                    className="h-8 flex-1"
                    onClick={() =>
                      navigate(`/evidence/${encodeURIComponent(evidence.id)}`)
                    }
                  >
                    <Play aria-hidden />
                    Review
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-2.5"
                    aria-label={`Share ${evidence.title}`}
                    onClick={() => setShareTarget(evidence)}
                  >
                    <Share2 aria-hidden />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="overflow-hidden p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      aria-label="Select visible evidence"
                      checked={allFilteredSelected}
                      ref={(element) => {
                        if (element)
                          element.indeterminate =
                            filteredSelectedCount > 0 && !allFilteredSelected;
                      }}
                      onChange={toggleFilteredSelection}
                      className="size-4 accent-[var(--brand-500)]"
                    />
                  </TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Recorded by
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Recorded
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((evidence) => (
                  <TableRow
                    key={evidence.id}
                    data-active={selectedIds.has(evidence.id)}
                    onClick={() => navigateToEvidence(evidence)}
                    className="cursor-pointer"
                  >
                    <TableCell className="w-10 pr-0" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${evidence.title}`}
                        checked={selectedIds.has(evidence.id)}
                        onChange={(event) =>
                          setEvidenceSelected(
                            evidence.id,
                            event.currentTarget.checked,
                          )
                        }
                        className="size-4 accent-[var(--brand-500)]"
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-3 text-left">
                        <EvidenceThumbnail
                          evidence={evidence}
                          className="h-10 w-16"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-base font-semibold text-foreground group-hover:text-primary">
                            {evidence.title}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span>{formatDuration(evidence.durationMs)}</span>
                            <span aria-hidden>·</span>
                            <span>{formatActionCount(evidence.actionCount)}</span>
                            {evidence.tags.map((tag) => (
                              <EvidenceTagBadge key={tag.id} tag={tag} />
                            ))}
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <RecordedByCell
                        member={memberById.get(evidence.createdBy)}
                        fallbackName={memberNameById.get(evidence.createdBy) ?? evidence.createdBy}
                        onClick={() => setCreatorFilter(evidence.createdBy, true)}
                      />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-base text-muted-foreground lg:table-cell">
                      {formatRelativeTime(evidence.createdAt)}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void handleShareCopy(evidence);
                          }}
                          className={cn(
                            buttonVariants({ variant: "ghost", size: "sm" }),
                          )}
                        >
                          <Share2 aria-hidden />
                          Share
                        </button>
                        {actions(
                          evidence,
                          downloadingId === evidence.id,
                          deletingId === evidence.id,
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
        {!loading && totalPages > 1 ? (
          <div className="sticky bottom-0 z-20 flex justify-center">
            <div className="flex items-center gap-4 rounded-md border border-border-strong bg-popover/95 px-3 py-2 shadow-pop backdrop-blur">
              <Button
                size="sm"
                variant="ghost"
                className="w-[98px]"
                disabled={page <= 1}
                onClick={() => setParam("page", String(page - 1), "1")}
              >
                Previous
              </Button>
              <span className="min-w-16 text-center font-mono text-sm text-muted-foreground">
                {Math.min(page, totalPages)} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="w-[98px]"
                disabled={page >= totalPages}
                onClick={() => setParam("page", String(page + 1), "1")}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </PageBody>

      {shareTarget ? (
        <ShareDialog
          evidence={shareTarget}
          onClose={() => setShareTarget(null)}
        />
      ) : null}

      {renameTarget ? (
        <RenameEvidenceDialog
          evidence={renameTarget}
          onClose={() => setRenameTarget(null)}
        />
      ) : null}

      {workspaceActionTarget ? (
        <WorkspaceEvidenceActionDialog
          evidence={workspaceActionTarget.evidence}
          action={workspaceActionTarget.action}
          organizations={accountQuery.data?.organizations ?? []}
          onClose={() => setWorkspaceActionTarget(null)}
        />
      ) : null}

      {tagTarget ? (
        <EvidenceTagsDialog
          evidence={tagTarget}
          tags={tags}
          loading={tagsQuery.isPending}
          onClose={() => setTagTarget(null)}
        />
      ) : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this evidence?"
        description={
          pendingDelete
            ? isDeletingSomeoneElse(pendingDelete)
              ? `You are deleting evidence recorded by ${memberNameById.get(pendingDelete.createdBy) ?? pendingDelete.createdBy}. It will move to the bin and auto-purge after 30 days.`
              : `“${pendingDelete.title}” will move to the bin and auto-purge after 30 days.`
            : ""
        }
        confirmLabel="Move to bin"
        destructive
        busy={deleteEvidence.isPending}
        onConfirm={confirmDelete}
        onCancel={() =>
          deleteEvidence.isPending ? null : setPendingDelete(null)
        }
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        title="Delete selected evidence?"
        description={`${selectedEvidences.length} selected record${
          selectedEvidences.length === 1 ? "" : "s"
        } will move to the bin and auto-purge after 30 days.${
          selectedOtherCount > 0
            ? ` ${selectedOtherCount} were recorded by other people.`
            : ""
        }`}
        confirmLabel="Move to bin"
        destructive
        busy={bulkDeleting}
        onConfirm={() => void confirmBulkDelete()}
        onCancel={() => (bulkDeleting ? null : setPendingBulkDelete(false))}
      />
    </>
  );
}

function formatDuration(value: number | null): string {
  if (value === null) return "No duration";
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatActionCount(value: number | null): string {
  if (value === null) return "No actions";
  return `${value} action${value === 1 ? "" : "s"}`;
}

function getInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return initials || "?";
}

function EvidenceTagBadge({ tag }: { tag: ApiEvidenceTag }): React.JSX.Element {
  return (
    <span
      className="inline-flex max-w-24 items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold"
      style={{
        borderColor: `${tag.color}55`,
        backgroundColor: `${tag.color}18`,
        color: tag.color,
      }}
    >
      <span className="truncate">{tag.name}</span>
    </span>
  );
}

function RecordedByCell(props: {
  member: { displayName: string; email: string | null } | undefined;
  fallbackName: string;
  onClick: () => void;
}): React.JSX.Element {
  const name = props.member?.displayName ?? props.fallbackName;
  const email = props.member?.email ?? "No email";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onClick();
      }}
      className="group/author relative flex w-[200px] items-center gap-2 text-left"
      title={name}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-xs font-semibold text-primary">
        {getInitials(name)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-base font-medium text-foreground">
          {name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {email}
        </span>
      </span>
      <span className="pointer-events-none absolute left-10 top-9 z-30 hidden w-56 rounded-md border border-border bg-popover px-3 py-2 text-left shadow-pop group-hover/author:block">
        <span className="block truncate text-sm font-semibold text-foreground">
          {name}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {email}
        </span>
      </span>
    </button>
  );
}

function EvidenceTagsDialog(props: {
  evidence: ApiEvidenceSummary;
  tags: ApiEvidenceTag[];
  loading: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const updateTags = useUpdateEvidenceTags();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(props.evidence.tags.map((tag) => tag.id)),
  );

  const toggle = (tagId: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  };

  const submit = (): void => {
    updateTags.mutate(
      { evidenceId: props.evidence.id, tagIds: Array.from(selected) },
      {
        onSuccess: () => {
          toast.success("Tags updated", props.evidence.title);
          props.onClose();
        },
        onError: (error) =>
          toast.error(
            "Unable to update tags",
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      size="sm"
      title="Evidence tags"
      description={props.evidence.title}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={updateTags.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={props.loading || updateTags.isPending}
          >
            {updateTags.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {props.loading ? (
          <Skeleton className="h-24 w-full" />
        ) : props.tags.length === 0 ? (
          <p className="text-base text-muted-foreground">No tags available.</p>
        ) : (
          props.tags.map((tag) => (
            <label
              key={tag.id}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-secondary px-3 py-2"
            >
              <input
                type="checkbox"
                checked={selected.has(tag.id)}
                onChange={() => toggle(tag.id)}
                className="size-4 accent-[var(--brand-500)]"
              />
              <EvidenceTagBadge tag={tag} />
            </label>
          ))
        )}
      </div>
    </Dialog>
  );
}

function EvidenceThumbnail(props: {
  evidence: ApiEvidenceSummary;
  className?: string;
}): React.JSX.Element {
  const { evidence, className } = props;
  const thumbnailSrc =
    evidence.thumbnailBase64 && evidence.thumbnailMimeType
      ? `data:${evidence.thumbnailMimeType};base64,${evidence.thumbnailBase64}`
      : null;

  return (
    <span
      className={cn(
        "relative isolate flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-secondary text-primary",
        className,
      )}
    >
      {thumbnailSrc ? (
        <>
          <img
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            aria-hidden
            className="absolute inset-0 size-full scale-110 object-cover opacity-70 blur-lg"
          />
          <img
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            className="relative z-10 size-full object-cover"
          />
        </>
      ) : (
        <Video className="size-4" aria-hidden />
      )}
    </span>
  );
}

function RenameEvidenceDialog(props: {
  evidence: ApiEvidenceSummary;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const renameEvidence = useRenameEvidence();
  const [value, setValue] = useState(props.evidence.title);
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== props.evidence.title;

  const submit = (): void => {
    if (!canSave) {
      props.onClose();
      return;
    }
    renameEvidence.mutate(
      { evidenceId: props.evidence.id, title: trimmed },
      {
        onSuccess: () => {
          toast.success("Evidence renamed", trimmed);
          props.onClose();
        },
        onError: (error) =>
          toast.error(
            "Rename failed",
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      size="sm"
      title="Rename evidence"
      description="Keep it searchable."
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={renameEvidence.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={renameEvidence.isPending || !canSave}
          >
            {renameEvidence.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Session name">
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            maxLength={200}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function WorkspaceEvidenceActionDialog(props: {
  evidence: ApiEvidenceSummary;
  action: "copy" | "transfer";
  organizations: ApiOrganization[];
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const copyEvidence = useCopyEvidence();
  const moveEvidence = useMoveEvidence();
  const targetOrganizations = props.organizations.filter(
    (org) => org.id !== props.evidence.orgId,
  );
  const [targetOrgId, setTargetOrgId] = useState(
    targetOrganizations[0]?.id ?? "",
  );
  const targetOrg = targetOrganizations.find((org) => org.id === targetOrgId);
  const mutation =
    props.action === "copy" ? copyEvidence : moveEvidence;
  const busy = mutation.isPending;
  const verb = props.action === "copy" ? "Copy" : "Transfer";

  const submit = (): void => {
    if (!targetOrgId || busy) return;
    mutation.mutate(
      { evidenceId: props.evidence.id, targetOrgId },
      {
        onSuccess: () => {
          toast.success(
            props.action === "copy" ? "Evidence copied" : "Evidence transferred",
            targetOrg ? `${props.evidence.title} -> ${targetOrg.name}` : undefined,
          );
          props.onClose();
        },
        onError: (error) =>
          toast.error(
            `${verb} failed`,
            error instanceof Error ? error.message : undefined,
          ),
      },
    );
  };

  return (
    <Dialog
      open
      onClose={props.onClose}
      size="sm"
      title={`${verb} evidence`}
      description={
        props.action === "copy"
          ? "Create a separate evidence entry in another workspace."
          : "Move this evidence to another workspace and invalidate existing share links."
      }
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || targetOrganizations.length === 0 || !targetOrgId}
          >
            {busy ? `${verb}ing…` : verb}
          </Button>
        </>
      }
    >
      {targetOrganizations.length === 0 ? (
        <p className="text-base text-muted-foreground">
          Join or create another workspace before using this action.
        </p>
      ) : (
        <Field label="Destination workspace">
          <Select
            ariaLabel="Destination workspace"
            value={targetOrgId}
            onValueChange={setTargetOrgId}
            options={targetOrganizations.map((org) => ({
              label: org.name,
              value: org.id,
            }))}
          />
        </Field>
      )}
    </Dialog>
  );
}
