import React, { useMemo, useRef, useState } from "react";
import {
  buildVisibleActionRows,
  buildSectionTimeline,
  findActiveIndex,
  formatOffset,
  type SessionArchive,
  type TimelineItem,
  type TimelineSection,
  type NetworkSubtype
} from "@jittle-lamp/shared";
import {
  createMergeGroup,
  getContiguousMergeableSelection,
  selectActionRange,
  selectSingleAction,
  toggleActionSelection,
  type ViewerCoreState
} from "@jittle-lamp/viewer-core";
import {
  ViewerModal,
  buildCurl,
  getResponseBodyString,
  type ViewerContextMenuState,
  type ViewerDiscussionComment,
  type ViewerModalRow,
  type ViewerSource
} from "@jittle-lamp/viewer-react";
import type { ActionMergeGroup } from "@jittle-lamp/shared";

import { buildReviewedArchive } from "./archive-export";
import { buildReviewedZipBlob } from "./adapters";

export type FeedbackTone = "neutral" | "success" | "error";

type Feedback = { tone: FeedbackTone; text: string } | null;

export type EvidenceViewerContentProps = {
  loadedArchive: SessionArchive;
  loadedTimeline: TimelineItem[];
  loadedMergeGroups: ActionMergeGroup[];
  videoSrc: string | null;
  recordingBytesInitial: Uint8Array | null;
  source: ViewerSource;
  isOwner: boolean;
  shareLinkUrl: string | null;
  fetchVideoBytes: () => Promise<Uint8Array | null>;
  onVideoError: (videoEl: HTMLVideoElement) => void;
  onClose: () => void;
  viewerMode?: "modal" | "page";
  discussionComments?: ViewerDiscussionComment[];
  discussionValue?: string;
  discussionSaving?: boolean;
  discussionNotice?: string | null;
  onDiscussionChange?: (value: string) => void;
  onSubmitDiscussion?: () => void;
  onRenameEvidence?: () => void;
  onCopyEvidence?: () => void;
  onCopyLlmPrompt?: () => void;
  onTransferEvidence?: () => void;
  renamingEvidence?: boolean;
  copyingLlmPrompt?: boolean;
};

type SectionItem = ReturnType<typeof buildSectionTimeline>[number] & {
  mergedRangeText?: string;
  rangeStartMs?: number;
  rangeEndMs?: number;
};

type MergeDialogState = Pick<ViewerCoreState, "mergeDialogOpen" | "mergeDialogValue" | "mergeDialogError" | "pendingMergeActionIds">;

const initialContextMenu: ViewerContextMenuState = {
  open: false,
  x: 0,
  y: 0,
  rowId: null,
  kind: "actions",
  canMerge: false,
  canUnmerge: false
};

const initialMergeDialog: MergeDialogState = {
  mergeDialogOpen: false,
  mergeDialogValue: "",
  mergeDialogError: null,
  pendingMergeActionIds: []
};

export function EvidenceViewerContent(props: EvidenceViewerContentProps): React.JSX.Element {
  const {
    loadedArchive,
    loadedTimeline,
    loadedMergeGroups,
    videoSrc,
    recordingBytesInitial,
    source,
    isOwner,
    shareLinkUrl,
    fetchVideoBytes,
    onVideoError,
    onClose,
    viewerMode = "modal",
    discussionComments,
    discussionValue,
    discussionSaving = false,
    discussionNotice,
    onDiscussionChange,
    onSubmitDiscussion,
    onRenameEvidence,
    onCopyEvidence,
    onCopyLlmPrompt,
    onTransferEvidence,
    renamingEvidence = false,
    copyingLlmPrompt = false
  } = props;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const autoScrollingRef = useRef(false);

  const [mergeGroups, setMergeGroups] = useState<ActionMergeGroup[]>(loadedMergeGroups);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [networkDetailIndex, setNetworkDetailIndex] = useState<number | null>(null);
  const [networkSearchQuery, setNetworkSearchQuery] = useState("");
  const [activeSection, setActiveSection] = useState<TimelineSection>("actions");
  const [networkSubtypeFilter, setNetworkSubtypeFilter] = useState<NetworkSubtype | "all">("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [selectedActionIds, setSelectedActionIds] = useState<Set<string>>(new Set());
  const [anchorActionId, setAnchorActionId] = useState<string | null>(null);
  const [mergeDialog, setMergeDialog] = useState<MergeDialogState>(initialMergeDialog);
  const [contextMenu, setContextMenu] = useState<ViewerContextMenuState>(initialContextMenu);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [recordingBytes, setRecordingBytes] = useState<Uint8Array | null>(recordingBytesInitial);

  const archive = useMemo(
    () => buildReviewedArchive({ archive: loadedArchive, mergeGroups }),
    [loadedArchive, mergeGroups]
  );

  const recordingMeta = useMemo(() => formatRecordingMeta(loadedArchive), [loadedArchive]);
  const videoDurationHintMs = useMemo(
    () => getVideoDurationHintMs(loadedArchive, loadedTimeline),
    [loadedArchive, loadedTimeline]
  );

  const sectionItems = useMemo<SectionItem[]>(() => {
    const baseItems = buildSectionTimeline(archive, activeSection, networkSubtypeFilter, networkSearchQuery);
    if (activeSection !== "actions") return baseItems;

    const itemsById = new Map(baseItems.map((item) => [item.id, item]));
    const rows = buildVisibleActionRows(archive, mergeGroups);

    return rows
      .map((row) => {
        if (row.memberActionIds.length === 1) {
          const item = itemsById.get(row.id);
          return item ? { ...item, rangeStartMs: item.offsetMs, rangeEndMs: item.offsetMs } : undefined;
        }

        const memberItems = row.memberActionIds
          .map((memberId) => itemsById.get(memberId))
          .filter((item): item is NonNullable<typeof item> => item !== undefined);
        const firstItem = memberItems[0];
        const group = mergeGroups.find((candidate) => candidate.id === row.id);
        if (!firstItem || !group) return undefined;

        const firstMs = Math.min(...memberItems.map((item) => item.offsetMs));
        const lastMs = Math.max(...memberItems.map((item) => item.offsetMs));

        return {
          ...firstItem,
          id: group.id,
          offsetMs: firstMs,
          label: group.label,
          tags: group.tags,
          mergedRangeText: `${formatOffset(firstMs)}–${formatOffset(lastMs)}`,
          rangeStartMs: firstMs,
          rangeEndMs: lastMs
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
  }, [archive, activeSection, networkSubtypeFilter, networkSearchQuery, mergeGroups]);

  const showFeedback = (text: string, tone: FeedbackTone): void => setFeedback({ text, tone });
  const dismissFeedback = (): void => setFeedback(null);

  const closeContextMenu = (): void => {
    setContextMenu((prev) => (prev.open ? { ...prev, open: false } : prev));
  };

  const handleTimelineItemClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    itemId: string,
    itemOffsetMs: number
  ): void => {
    if (activeSection === "actions") {
      if (event.metaKey || event.ctrlKey) {
        const selection = toggleActionSelection({ selectedActionIds, anchorActionId }, itemId);
        setSelectedActionIds(selection.selectedActionIds);
        setAnchorActionId(selection.anchorActionId);
      } else if (event.shiftKey && anchorActionId) {
        const selection = selectActionRange(
          archive,
          mergeGroups,
          { selectedActionIds, anchorActionId },
          itemId
        );
        setSelectedActionIds(selection.selectedActionIds);
      } else {
        const selection = selectSingleAction(itemId);
        setSelectedActionIds(selection.selectedActionIds);
        setAnchorActionId(selection.anchorActionId);
      }
    } else if (activeSection === "network") {
      const fullTimelineIndex = loadedTimeline.findIndex((item) => item.id === itemId);
      if (fullTimelineIndex !== -1) {
        const item = loadedTimeline[fullTimelineIndex];
        if (item && item.kind === "network") {
          setNetworkDetailIndex((prev) => (prev === fullTimelineIndex ? null : fullTimelineIndex));
        }
      }
    }

    if (videoRef.current) videoRef.current.currentTime = itemOffsetMs / 1000;
  };

  const handleTimelineItemContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    itemId: string
  ): void => {
    if (activeSection !== "actions") return;
    event.preventDefault();
    const selectedIds = selectedActionIds.has(itemId) ? selectedActionIds : new Set([itemId]);
    const mergeable = getContiguousMergeableSelection(archive, mergeGroups, selectedIds);
    const group = mergeGroups.find((candidate) => candidate.id === itemId);

    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      rowId: itemId,
      kind: "actions",
      canMerge: mergeable.length >= 2,
      canUnmerge: Boolean(group)
    });
  };

  const handleContextMenuMerge = (): void => {
    if (!contextMenu.rowId) return;
    const selectedIds = selectedActionIds.has(contextMenu.rowId) ? selectedActionIds : new Set([contextMenu.rowId]);
    const mergeable = getContiguousMergeableSelection(archive, mergeGroups, selectedIds);
    if (mergeable.length < 2) return;
    setMergeDialog({
      mergeDialogOpen: true,
      mergeDialogValue: "",
      mergeDialogError: null,
      pendingMergeActionIds: mergeable
    });
    closeContextMenu();
  };

  const handleContextMenuUnmerge = (): void => {
    const groupId = contextMenu.rowId;
    if (!groupId) return;
    setMergeGroups((prev) => prev.filter((group) => group.id !== groupId));
    setSelectedActionIds((prev) => {
      if (!prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
    setAnchorActionId((prev) => (prev === groupId ? null : prev));
    closeContextMenu();
  };

  const submitMergeDialog = (): void => {
    const label = mergeDialog.mergeDialogValue.trim();
    if (!label) {
      setMergeDialog((prev) => ({ ...prev, mergeDialogError: "Enter a label for the merged action." }));
      return;
    }
    if (mergeDialog.pendingMergeActionIds.length < 2) {
      setMergeDialog((prev) => ({ ...prev, mergeDialogError: "Select at least two actions to merge." }));
      return;
    }
    const newGroup = createMergeGroup({
      id: `merge-${Date.now()}`,
      createdAt: new Date().toISOString(),
      label,
      selectedActionIds: mergeDialog.pendingMergeActionIds
    });
    setMergeGroups((prev) => [...prev, newGroup]);
    setSelectedActionIds(new Set());
    setAnchorActionId(null);
    setMergeDialog(initialMergeDialog);
  };

  const cancelMergeDialog = (): void => {
    setMergeDialog(initialMergeDialog);
  };

  const updateHighlight = (): void => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const currentMs = videoEl.currentTime * 1000;
    const items =
      activeSection === "actions"
        ? sectionItems
        : buildSectionTimeline(archive, activeSection, networkSubtypeFilter, networkSearchQuery);
    setActiveIndex(findActiveIndex(items, currentMs));

    if (autoFollow) {
      const tl = timelineRef.current;
      const activeBtn = tl?.querySelector<HTMLElement>("[data-active='true']") ?? null;
      if (activeBtn) {
        autoScrollingRef.current = true;
        activeBtn.scrollIntoView({ block: "nearest", behavior: "smooth" });
        window.setTimeout(() => {
          autoScrollingRef.current = false;
        }, 300);
      }
    }
  };

  const onCopy = (value: string, label: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => showFeedback(`Copied ${label}.`, "success"),
      () => showFeedback(`Failed to copy ${label}.`, "error")
    );
  };

  const findNetworkItem = (rowId: string): TimelineItem | null =>
    loadedTimeline.find((item) => item.id === rowId) ?? null;

  const closeViewer = (): void => {
    onClose();
  };

  const ensureRecordingBytes = async (): Promise<Uint8Array | null> => {
    if (recordingBytes && recordingBytes.length > 0) return recordingBytes;
    const bytes = await fetchVideoBytes();
    if (bytes) setRecordingBytes(bytes);
    return bytes;
  };

  const handleDownloadZip = async (): Promise<void> => {
    setDownloadingZip(true);
    try {
      const bytes = await ensureRecordingBytes();
      if (!bytes) {
        showFeedback("Nothing loaded to export.", "error");
        return;
      }
      const blob = buildReviewedZipBlob({ archive, mergeGroups, recordingBytes: bytes });
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadUrl;
      anchor.download = `${archive.sessionId}-reviewed.zip`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);
      showFeedback("Updated ZIP exported.", "success");
    } finally {
      setDownloadingZip(false);
    }
  };

  const drawerItem: TimelineItem | null =
    networkDetailIndex !== null ? loadedTimeline[networkDetailIndex] ?? null : null;

  const activeItem = activeIndex >= 0 ? sectionItems[activeIndex] : null;
  const activeItemId = activeItem ? activeItem.id : null;

  const rows: ViewerModalRow[] = sectionItems.map((item) => {
    const isMerged = "mergedRangeText" in item && item.mergedRangeText !== undefined;
    const status = item.payload.kind === "network" ? item.payload.status ?? null : null;
    const subtype = item.kind === "network" ? item.subtype ?? null : null;
    const method = item.payload.kind === "network" ? item.payload.method : null;
    const url = item.payload.kind === "network" ? item.payload.url : null;
    const durationMs = item.payload.kind === "network" ? item.payload.durationMs ?? null : null;
    const base: ViewerModalRow = {
      id: item.id,
      offsetMs: item.offsetMs,
      section: activeSection,
      label: item.label,
      kind: item.kind,
      selected: selectedActionIds.has(item.id),
      merged: Boolean(isMerged),
      tags: item.tags ?? [],
      statusCode: status,
      subtype,
      method,
      url,
      durationMs
    };
    return isMerged && item.mergedRangeText !== undefined
      ? { ...base, mergedRange: item.mergedRangeText }
      : base;
  });

  return (
    <ViewerModal
      open
      onClose={closeViewer}
      mode={viewerMode}
      {...(viewerMode === "page" ? { closeLabel: "Back to evidence" } : {})}
      title={archive.name}
      titleMeta={recordingMeta}
      tags={[]}
      source={source}
      isOwner={isOwner}
      shareLinkUrl={shareLinkUrl}
      {...(shareLinkUrl ? { onCopyShareLink: () => onCopy(shareLinkUrl, "share link") } : {})}
      {...(onRenameEvidence ? { onRename: onRenameEvidence } : {})}
      {...(onRenameEvidence ? { renaming: renamingEvidence } : {})}
      {...(onCopyEvidence ? { onCopyEvidence } : {})}
      {...(onCopyLlmPrompt ? { onCopyLlmPrompt } : {})}
      {...(onCopyLlmPrompt ? { copyingLlmPrompt } : {})}
      {...(onTransferEvidence ? { onTransferEvidence } : {})}
      onDownloadZip={() => void handleDownloadZip()}
      downloadingZip={downloadingZip}
      videoRef={videoRef}
      videoSrc={videoSrc}
      videoDurationHintMs={videoDurationHintMs}
      notesValue=""
      notesReadOnly
      notesSaving={false}
      notesDirty={false}
      notesNotice={null}
      onNotesChange={() => undefined}
      onSaveNotes={() => undefined}
      discussionComments={discussionComments ?? []}
      discussionValue={discussionValue ?? ""}
      discussionReadOnly={false}
      discussionSaving={discussionSaving}
      discussionNotice={discussionNotice ?? null}
      onDiscussionChange={onDiscussionChange ?? (() => undefined)}
      onSubmitDiscussion={onSubmitDiscussion ?? (() => undefined)}
      onVideoTimeUpdate={updateHighlight}
      onVideoError={() => {
        if (videoRef.current) onVideoError(videoRef.current);
      }}
      activeSection={activeSection}
      onSectionChange={(section) => {
        setActiveSection(section);
        setActiveIndex(-1);
        setNetworkDetailIndex(null);
      }}
      searchQuery={networkSearchQuery}
      onSearchChange={(query) => {
        setNetworkSearchQuery(query);
        setNetworkDetailIndex(null);
      }}
      subtypeFilter={networkSubtypeFilter}
      onSubtypeFilterChange={(subtype) => {
        setNetworkSubtypeFilter(subtype);
        setNetworkDetailIndex(null);
      }}
      rows={rows}
      activeItemId={activeItemId}
      autoFollow={autoFollow}
      onItemClick={(row, event) => {
        handleTimelineItemClick(event, row.id, row.offsetMs);
        if (activeSection === "console") {
          const idx = loadedTimeline.findIndex((item) => item.id === row.id);
          if (idx !== -1) {
            setNetworkDetailIndex((prev) => (prev === idx ? null : idx));
          }
        }
      }}
      onItemContextMenu={(row, event) => {
        if (activeSection === "actions") {
          handleTimelineItemContextMenu(event, row.id);
          return;
        }
        if (activeSection === "network") {
          setContextMenu({
            open: true,
            x: event.clientX,
            y: event.clientY,
            rowId: row.id,
            kind: "network",
            canMerge: false,
            canUnmerge: false
          });
        }
      }}
      onAutoFollowToggle={() => setAutoFollow(true)}
      timelineRef={timelineRef}
      drawerItem={drawerItem}
      onDrawerClose={() => setNetworkDetailIndex(null)}
      onCopy={onCopy}
      contextMenu={contextMenu}
      onContextMenuClose={closeContextMenu}
      onContextMenuMerge={handleContextMenuMerge}
      onContextMenuUnmerge={handleContextMenuUnmerge}
      onCopyCurl={(rowId) => {
        const item = findNetworkItem(rowId);
        if (item && item.payload.kind === "network") onCopy(buildCurl(item.payload), "cURL command");
      }}
      onCopyResponse={(rowId) => {
        const item = findNetworkItem(rowId);
        if (item && item.payload.kind === "network") onCopy(getResponseBodyString(item.payload), "response body");
      }}
      mergeDialog={{
        open: mergeDialog.mergeDialogOpen,
        value: mergeDialog.mergeDialogValue,
        error: mergeDialog.mergeDialogError
      }}
      onMergeValueChange={(value) =>
        setMergeDialog((prev) => ({ ...prev, mergeDialogValue: value, mergeDialogError: null }))
      }
      onMergeConfirm={submitMergeDialog}
      onMergeCancel={cancelMergeDialog}
      feedback={feedback}
      onFeedbackDismiss={dismissFeedback}
    />
  );
}

function formatRecordingMeta(archive: SessionArchive): string {
  const started = new Date(archive.createdAt);
  const ended = new Date(archive.updatedAt);
  if (!Number.isFinite(started.getTime())) return "";
  const startText = formatDateTime(started);
  if (!Number.isFinite(ended.getTime()) || archive.updatedAt === archive.createdAt) {
    return `Recorded ${startText}`;
  }
  const endText = formatDateTime(ended);
  return `Recorded ${startText} to ${endText}`;
}

function formatDateTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(value);
}

function getVideoDurationHintMs(archive: SessionArchive, timeline: TimelineItem[]): number {
  const start = Date.parse(archive.createdAt);
  const end = Date.parse(archive.updatedAt);
  const archiveDuration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
  const timelineDuration = Math.max(0, ...timeline.map((item) => item.offsetMs));
  return Math.max(archiveDuration, timelineDuration);
}
