import type * as React from "react";

import type { NetworkSubtype, TimelineItem, TimelineSection } from "@jittle-lamp/shared";

export type ViewerModalRow = {
  id: string;
  offsetMs: number;
  section: TimelineSection;
  label: string;
  kind: string;
  selected: boolean;
  merged: boolean;
  mergedRange?: string;
  tags: string[];
  statusCode?: number | null;
  subtype?: NetworkSubtype | null;
};

export type ViewerSource = "local" | "zip" | "cloud" | "share";

export type ViewerModalFeedback = {
  tone: "neutral" | "success" | "error";
  text: string;
};

export type ViewerDiscussionComment = {
  id: string;
  body: string;
  authorLabel: string;
  createdAt: number;
};

export type ViewerContextMenuState = {
  open: boolean;
  x: number;
  y: number;
  rowId: string | null;
  kind: "actions" | "network";
  canMerge: boolean;
  canUnmerge: boolean;
};

export type ViewerModalProps = {
  open: boolean;
  onClose: () => void;
  mode?: "modal" | "page";
  closeLabel?: string;

  title: string;
  titleMeta?: string | null;
  tags: string[];
  source: ViewerSource;
  isOwner: boolean;
  shareLinkUrl: string | null;
  onCopyShareLink?: () => void;
  onCreateShareLink?: () => void;
  onRename?: () => void;
  onCopyEvidence?: () => void;
  onTransferEvidence?: () => void;
  onDownloadZip?: () => void;
  renaming?: boolean;
  downloadingZip?: boolean;
  creatingShareLink?: boolean;

  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  videoDurationHintMs?: number;
  notesValue: string;
  notesReadOnly: boolean;
  notesSaving: boolean;
  notesDirty: boolean;
  notesNotice?: string | null;
  onNotesChange: (v: string) => void;
  onSaveNotes: () => void;
  discussionComments?: ViewerDiscussionComment[];
  discussionValue?: string;
  discussionReadOnly?: boolean;
  discussionSaving?: boolean;
  discussionNotice?: string | null;
  onDiscussionChange?: (v: string) => void;
  onSubmitDiscussion?: () => void;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;

  activeSection: TimelineSection;
  onSectionChange: (s: TimelineSection) => void;
  searchQuery: string;
  onSearchChange: (v: string) => void;
  subtypeFilter: NetworkSubtype | "all";
  onSubtypeFilterChange: (v: NetworkSubtype | "all") => void;
  rows: ViewerModalRow[];
  activeItemId: string | null;
  autoFollow: boolean;
  onItemClick: (row: ViewerModalRow, event: React.MouseEvent<HTMLButtonElement>) => void;
  onItemContextMenu: (row: ViewerModalRow, event: React.MouseEvent<HTMLButtonElement>) => void;
  onAutoFollowToggle: () => void;
  timelineRef?: React.RefObject<HTMLDivElement | null>;

  drawerItem: TimelineItem | null;
  onDrawerClose: () => void;
  onCopy: (value: string, label: string) => void;

  contextMenu: ViewerContextMenuState;
  onContextMenuClose: () => void;
  onContextMenuMerge?: () => void;
  onContextMenuUnmerge?: () => void;
  onCopyCurl?: (rowId: string) => void;
  onCopyResponse?: (rowId: string) => void;

  mergeDialog: { open: boolean; value: string; error: string | null };
  onMergeValueChange: (v: string) => void;
  onMergeConfirm: () => void;
  onMergeCancel: () => void;

  feedback?: ViewerModalFeedback | null;
  onFeedbackDismiss?: () => void;
};
