import React, { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import {
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  LayoutGrid,
  Link2,
  List,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Search,
  Share2,
  Tag,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";

import { PageBody, PageHeader } from "../components/page";
import { UploadEvidenceButton } from "../components/upload-evidence-button";
import { Button, buttonVariants } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { SimpleSelect } from "../components/ui/select";
import { EmptyState } from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "../components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { ConfirmDialog, SimpleDialog } from "../components/ui/dialog";
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
import { Hint } from "../components/ui/tooltip";

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
  const selectedTagIds = useMemo(
    () =>
      (params.get("tags") ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    [params],
  );
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const evidencesQuery = useEvidences({
    createdBy: selectedCreatorIds,
    tagIds: selectedTagIds,
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

  const setTagFilter = (tagId: string, selected: boolean): void => {
    const next = new Set(selectedTagIds);
    if (selected) next.add(tagId);
    else next.delete(tagId);
    setParam("tags", Array.from(next).join(","), "");
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
    <DropdownMenu>
      <Hint label="More actions">
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="More actions"
              disabled={downloading || deleting}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {downloading || deleting ? <Spinner /> : <MoreHorizontal className="size-4" aria-hidden />}
            </button>
          }
        />
      </Hint>
      <DropdownMenuContent>
        <DropdownMenuItem onClick={() => navigateToEvidence(evidence)}>
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
        <DropdownMenuItem onClick={() => setWorkspaceActionTarget({ evidence, action: "copy" })}>
          <Copy aria-hidden />
          Copy to workspace
        </DropdownMenuItem>
        {isOwnEvidence(evidence) ? (
          <DropdownMenuItem onClick={() => setWorkspaceActionTarget({ evidence, action: "transfer" })}>
            <ArrowRightLeft aria-hidden />
            Transfer
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => void handleDownload(evidence)}>
          <Download aria-hidden />
          Download ZIP
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" disabled={!canDelete(evidence)} onClick={() => setPendingDelete(evidence)}>
          <Trash2 aria-hidden />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const hasFilters = search !== "" || selectedCreatorIds.length > 0 || selectedTagIds.length > 0;
  const filterButtonClass = (active: boolean): string =>
    cn(buttonVariants({ variant: "outline", size: "sm" }), active && "border-primary/40 bg-primary/10 text-foreground");

  return (
    <>
      <PageHeader
        title={<>Recordings <span className="ml-1 font-normal text-muted-foreground tabular-nums">{total}</span></>}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void evidencesQuery.refetch()} disabled={loading}>
            <RefreshCw aria-hidden className={cn(loading && "animate-spin")} />
            Refresh
          </Button>
        }
      />
      <PageBody className="gap-3">
        {/* Toolbar: search, filters, view. */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative w-full sm:w-72">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setParam("q", e.currentTarget.value, "")}
              placeholder="Search by title, user, or id"
              className="h-7 pl-8"
              aria-label="Search evidence"
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className={filterButtonClass(selectedCreatorIds.length > 0)} />}>
              <Users aria-hidden />
              {selectedCreatorIds.length === 0 ? "Recorded by" : `${selectedCreatorIds.length} ${selectedCreatorIds.length === 1 ? "person" : "people"}`}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Recorded by</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={selectedCreatorIds.length === 0} onCheckedChange={() => setParam("people", "", "")}>
                Everyone
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {members.length === 0 ? (
                <DropdownMenuItem disabled>{membersQuery.isPending ? "Loading people…" : "No people found"}</DropdownMenuItem>
              ) : (
                members.map((member) => {
                  const selected = selectedCreatorIds.includes(member.userId);
                  return (
                    <DropdownMenuCheckboxItem key={member.userId} checked={selected} onCheckedChange={() => setCreatorFilter(member.userId, !selected)}>
                      <span className="min-w-0 flex-1 truncate">{memberNameById.get(member.userId) ?? personName(member)}</span>
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<button type="button" className={filterButtonClass(selectedTagIds.length > 0)} />}>
              <Tag aria-hidden />
              {selectedTagIds.length === 0 ? "Tags" : `${selectedTagIds.length} tag${selectedTagIds.length === 1 ? "" : "s"}`}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>Tags</DropdownMenuLabel>
              <DropdownMenuCheckboxItem checked={selectedTagIds.length === 0} onCheckedChange={() => setParam("tags", "", "")}>
                All tags
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {tags.length === 0 ? (
                <DropdownMenuItem disabled>{tagsQuery.isPending ? "Loading tags…" : "No tags found"}</DropdownMenuItem>
              ) : (
                tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <DropdownMenuCheckboxItem key={tag.id} checked={selected} onCheckedChange={() => setTagFilter(tag.id, !selected)}>
                      <EvidenceTagBadge tag={tag} />
                    </DropdownMenuCheckboxItem>
                  );
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {hasFilters ? (
            <Button variant="ghost" size="sm" onClick={() => setParams({ ...(view === "grid" ? { view: "grid" } : {}) }, { replace: true })}>
              <X aria-hidden />
              Clear
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
              {loading ? "Loading…" : hasFilters ? `${filtered.length} of ${total}` : `${total} recording${total === 1 ? "" : "s"}`}
            </span>
            {view === "grid" && filtered.length > 0 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  aria-label="Select visible evidence"
                  checked={allFilteredSelected}
                  indeterminate={filteredSelectedCount > 0 && !allFilteredSelected}
                  onCheckedChange={toggleFilteredSelection}
                />
                Select all
              </label>
            ) : null}
            <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label="Layout">
              {([
                { id: "table", label: "List view", icon: List },
                { id: "grid", label: "Grid view", icon: LayoutGrid },
              ] as const).map((option) => {
                const Icon = option.icon;
                return (
                  <Hint key={option.id} label={option.label} side="bottom">
                    <button
                      type="button"
                      aria-label={option.label}
                      aria-pressed={view === option.id}
                      onClick={() => setParam("view", option.id, "table")}
                      className={cn(
                        "inline-flex size-6 items-center justify-center rounded-[5px] transition-colors",
                        view === option.id ? "bg-background text-foreground shadow-soft dark:bg-accent" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="size-3.5" aria-hidden />
                    </button>
                  </Hint>
                );
              })}
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        ) : null}

        {hasSelection ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/60 py-1.5 pl-3 pr-1.5">
            <span className="text-[13px] font-medium text-foreground">{selectedEvidences.length} selected</span>
            {selectedUndeletableCount > 0 ? (
              <span className="text-xs text-muted-foreground">{selectedUndeletableCount} recorded by someone else cannot be deleted</span>
            ) : null}
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => void handleBulkDownload()} disabled={bulkDownloading || bulkDeleting}>
                <Download aria-hidden />
                {bulkDownloading ? "Downloading…" : "Download ZIPs"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setPendingBulkDelete(true)}
                disabled={bulkDownloading || bulkDeleting || selectedUndeletableCount > 0}
              >
                <Trash2 aria-hidden />
                Delete
              </Button>
              <Hint label="Clear selection">
                <Button size="icon-sm" variant="ghost" aria-label="Clear selection" onClick={() => setSelectedIds(new Set())} disabled={bulkDownloading || bulkDeleting}>
                  <X aria-hidden />
                </Button>
              </Hint>
            </div>
          </div>
        ) : null}

        {loading ? (
          view === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <Skeleton key={i} className="aspect-[4/3] w-full rounded-lg" />
              ))}
            </div>
          ) : (
            <div className="grid gap-1">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          )
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Video aria-hidden />}
            title={evidences.length === 0 ? "No evidence in this workspace yet" : "No matches"}
            description={
              evidences.length === 0 ? "Upload a ZIP, MP4, WebM, or WebP. Video-only files get an empty log." : "Try a different search term or filter."
            }
            action={
              evidences.length === 0 ? (
                <UploadEvidenceButton label="Upload evidence" />
              ) : (
                <Button variant="outline" size="sm" onClick={() => setParams({}, { replace: true })}>
                  Clear filters
                </Button>
              )
            }
          />
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {filtered.map((evidence) => {
              const selected = selectedIds.has(evidence.id);
              return (
                <div
                  key={evidence.id}
                  className={cn(
                    "group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-[border-color,box-shadow] hover:border-border-strong",
                    selected && "border-primary/50 ring-1 ring-primary/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => navigateToEvidence(evidence)}
                    className="relative block aspect-video w-full overflow-hidden bg-muted"
                    aria-label={`Review ${evidence.title}`}
                  >
                    <EvidenceThumbnail evidence={evidence} className="size-full rounded-none border-0 bg-muted" />
                    {evidence.status === "pending" ? (
                      <Badge variant="secondary" className="absolute bottom-2 left-2">Pending</Badge>
                    ) : null}
                    {evidence.durationMs !== null ? (
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
                        {formatDuration(evidence.durationMs)}
                      </span>
                    ) : null}
                  </button>
                  <span
                    className={cn(
                      "absolute left-2 top-2 z-10 grid size-6 place-items-center rounded-md bg-background/90 shadow-soft transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                      selected && "[@media(hover:hover)]:opacity-100",
                    )}
                  >
                    <Checkbox
                      aria-label={`Select ${evidence.title}`}
                      checked={selected}
                      onCheckedChange={(checked) => setEvidenceSelected(evidence.id, checked)}
                    />
                  </span>
                  <div className="flex items-start gap-1 p-3 pr-1.5">
                    <button type="button" onClick={() => navigateToEvidence(evidence)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[13px] font-medium text-foreground">{evidence.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {memberNameById.get(evidence.createdBy) ?? evidence.createdBy} · {formatRelativeTime(evidence.createdAt)}
                      </span>
                      <EvidenceStats evidence={evidence} hideDuration />
                    </button>
                    {/* Centred on the title line, not on the three-line text block. */}
                    <div className="-mt-[5px] flex shrink-0 items-center">
                      <Hint label="Share">
                        <Button size="icon-sm" variant="ghost" aria-label={`Share ${evidence.title}`} onClick={() => setShareTarget(evidence)}>
                          <Share2 aria-hidden />
                        </Button>
                      </Hint>
                      {actions(evidence, downloadingId === evidence.id, deletingId === evidence.id)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead className="w-9 pl-3 pr-0">
                    <Checkbox
                      aria-label="Select visible evidence"
                      checked={allFilteredSelected}
                      indeterminate={filteredSelectedCount > 0 && !allFilteredSelected}
                      onCheckedChange={toggleFilteredSelection}
                    />
                  </TableHead>
                  <TableHead>Recording</TableHead>
                  <TableHead className="hidden sm:table-cell">Recorded by</TableHead>
                  <TableHead className="hidden md:table-cell">Tags</TableHead>
                  <TableHead className="hidden lg:table-cell">Recorded</TableHead>
                  <TableHead className="w-24 pr-3">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((evidence) => (
                  <TableRow
                    key={evidence.id}
                    data-state={selectedIds.has(evidence.id) ? "selected" : undefined}
                    onClick={() => navigateToEvidence(evidence)}
                    className="group cursor-pointer"
                  >
                    <TableCell className="w-9 py-1.5 pl-3 pr-0" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        aria-label={`Select ${evidence.title}`}
                        checked={selectedIds.has(evidence.id)}
                        onCheckedChange={(checked) => setEvidenceSelected(evidence.id, checked)}
                      />
                    </TableCell>
                    <TableCell className="py-1.5">
                      <div className="flex min-w-0 items-center gap-3">
                        <EvidenceThumbnail evidence={evidence} className="h-8 w-14" />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-foreground">{evidence.title}</span>
                          <EvidenceStats evidence={evidence} />
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden py-1.5 sm:table-cell">
                      <RecordedByCell
                        member={memberById.get(evidence.createdBy)}
                        fallbackName={memberNameById.get(evidence.createdBy) ?? evidence.createdBy}
                        onClick={() => setCreatorFilter(evidence.createdBy, true)}
                      />
                    </TableCell>
                    <TableCell className="hidden py-1.5 md:table-cell">
                      <EvidenceTagStack tags={evidence.tags} />
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap py-1.5 text-[13px] text-muted-foreground lg:table-cell">
                      {formatRelativeTime(evidence.createdAt)}
                    </TableCell>
                    <TableCell className="py-1.5 pr-3" onClick={(event) => event.stopPropagation()}>
                      <div className="flex items-center justify-end gap-0.5">
                        <Hint label="Copy share link">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Copy share link for ${evidence.title}`}
                            className="transition-opacity [@media(hover:hover)]:opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={(event) => {
                              event.preventDefault();
                              void handleShareCopy(evidence);
                            }}
                          >
                            <Link2 aria-hidden />
                          </Button>
                        </Hint>
                        {actions(evidence, downloadingId === evidence.id, deletingId === evidence.id)}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {!loading && totalPages > 1 ? (
          <FloatingEvidencePager
            page={page}
            totalPages={totalPages}
            onPrevious={() => setParam("page", String(page - 1), "1")}
            onNext={() => setParam("page", String(page + 1), "1")}
          />
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

function formatRequestCount(value: number | null): string {
  if (value === null) return "No requests";
  return `${value} request${value === 1 ? "" : "s"}`;
}

function EvidenceStats(props: { evidence: ApiEvidenceSummary; hideDuration?: boolean }): React.JSX.Element {
  const { evidence } = props;
  // Only the counts the recording has; missing values are left out rather than spelled "No …".
  const parts = [
    props.hideDuration || evidence.durationMs === null ? null : formatDuration(evidence.durationMs),
    evidence.actionCount === null ? null : formatActionCount(evidence.actionCount),
    evidence.requestCount === null ? null : formatRequestCount(evidence.requestCount),
  ].filter((part): part is string => part !== null);

  return (
    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
      {parts.length > 0 ? parts.join(" · ") : "No log"}
    </span>
  );
}

function FloatingEvidencePager(props: {
  page: number;
  totalPages: number;
  onPrevious: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const currentPage = Math.min(props.page, props.totalPages);

  return (
    <>
      <div className="h-20 shrink-0" aria-hidden />
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        <div className="pointer-events-auto flex items-center gap-1.5 rounded-md border border-border-strong/80 bg-popover/90 p-1.5 text-sm shadow-[0_18px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur-xl">
          <Button
            size="sm"
            variant="ghost"
            className="w-[98px] gap-1.5 rounded-[6px] px-2 text-muted-foreground hover:text-foreground"
            disabled={props.page <= 1}
            onClick={props.onPrevious}
          >
            <ChevronLeft aria-hidden className="size-4" />
            Previous
          </Button>
          <span className="flex min-w-[88px] items-center justify-center rounded-[6px] border border-border bg-secondary/70 px-3 py-2 font-mono text-xs font-semibold tabular-nums text-foreground">
            {currentPage} / {props.totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="w-[98px] gap-1.5 rounded-[6px] px-2 text-muted-foreground hover:text-foreground"
            disabled={props.page >= props.totalPages}
            onClick={props.onNext}
          >
            Next
            <ChevronRight aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
    </>
  );
}

function getInitials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("");
  return initials || "?";
}

function EvidenceTagStack({ tags }: { tags: ApiEvidenceTag[] }): React.JSX.Element {
  if (tags.length === 0) {
    return <span className="text-xs text-muted-foreground/70">—</span>;
  }

  const visibleTags = tags.slice(0, 2);
  const hiddenCount = tags.length - visibleTags.length;

  return (
    <div className="flex max-w-[220px] flex-wrap items-center gap-1.5">
      {visibleTags.map((tag) => (
        <EvidenceTagBadge key={tag.id} tag={tag} />
      ))}
      {hiddenCount > 0 ? (
        <span className="inline-flex items-center rounded-sm bg-secondary px-1.5 py-px text-[11px] font-medium text-muted-foreground">
          +{hiddenCount}
        </span>
      ) : null}
    </div>
  );
}

function EvidenceTagBadge({ tag }: { tag: ApiEvidenceTag }): React.JSX.Element {
  return (
    <span
      className="inline-flex max-w-28 items-center gap-1 rounded-sm border px-1.5 py-px text-[11px] font-medium"
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
  return (
    <Hint
      side="bottom"
      align="start"
      label={
        <span className="grid gap-0.5">
          <span>{name}</span>
          {props.member?.email ? <span className="font-normal text-muted-foreground">{props.member.email}</span> : null}
          <span className="font-normal text-muted-foreground">Click to show only their recordings</span>
        </span>
      }
    >
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onClick();
        }}
        className="flex max-w-[200px] items-center gap-2 rounded-md text-left text-[13px] text-foreground hover:text-foreground/80"
      >
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-brand-300">
          {getInitials(name)}
        </span>
        <span className="min-w-0 truncate">{name}</span>
      </button>
    </Hint>
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
    <SimpleDialog
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
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2 hover:bg-muted/50"
            >
              <Checkbox checked={selected.has(tag.id)} onCheckedChange={() => toggle(tag.id)} />
              <EvidenceTagBadge tag={tag} />
            </label>
          ))
        )}
      </div>
    </SimpleDialog>
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
    <SimpleDialog
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
    </SimpleDialog>
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
    <SimpleDialog
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
          <SimpleSelect
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
    </SimpleDialog>
  );
}
