export type { StorageAdapter, PlaybackAdapter, ShareAdapter, NotesAdapter, ViewerAdapters } from "./adapters";

import {
  getStepAnnotations,
  stepTag,
  buildSectionTimeline,
  buildTimeline,
  buildVisibleActionRangeSelection,
  getContiguousMergeableActionIds,
  type TimelineItem,
  type TimelineSection
} from "@jittle-lamp/shared";
import type { ActionMergeGroup, NetworkSubtype, SessionArchive, StepAnnotation } from "@jittle-lamp/shared";

export type FeedbackTone = "neutral" | "success" | "error";
export type AppPhase = "idle" | "loading" | "error" | "viewing";

export type ViewerCoreState = {
  timeline: TimelineItem[];
  activeIndex: number;
  networkDetailIndex: number | null;
  networkSearchQuery: string;
  mergeDialogOpen: boolean;
  mergeDialogValue: string;
  mergeDialogError: string | null;
  pendingMergeActionIds: string[];
  activeSection: TimelineSection;
  networkSubtypeFilter: NetworkSubtype | "all";
  autoFollow: boolean;
  selectedActionIds: Set<string>;
  anchorActionId: string | null;
  mergeGroups: ActionMergeGroup[];
  // Test-run step annotations (archive v4) and the step the timeline is filtered to.
  steps: StepAnnotation[];
  stepFilter: string | null;
};

export type SelectionCommand = {
  selectedActionIds: Set<string>;
  anchorActionId: string | null;
};

export type MergeDialogCommandResult =
  | { ok: true; label: string; selectedActionIds: string[] }
  | { ok: false; error: string };

export type ViewerPhaseState = {
  phase: AppPhase;
  error: string | null;
};

export function createViewerCoreState(): ViewerCoreState {
  return {
    timeline: [],
    activeIndex: -1,
    networkDetailIndex: null,
    networkSearchQuery: "",
    mergeDialogOpen: false,
    mergeDialogValue: "",
    mergeDialogError: null,
    pendingMergeActionIds: [],
    activeSection: "actions",
    networkSubtypeFilter: "all",
    autoFollow: true,
    selectedActionIds: new Set(),
    anchorActionId: null,
    mergeGroups: [],
    steps: [],
    stepFilter: null
  };
}

export function reduceViewerPhase(
  _state: ViewerPhaseState,
  action: { type: "load:start" } | { type: "load:success" } | { type: "load:error"; error: string } | { type: "reset" }
): ViewerPhaseState {
  switch (action.type) {
    case "load:start":
      return { phase: "loading", error: null };
    case "load:success":
      return { phase: "viewing", error: null };
    case "load:error":
      return { phase: "error", error: action.error };
    case "reset":
      return { phase: "idle", error: null };
  }
}

export function resetViewerCoreState(state: ViewerCoreState): void {
  Object.assign(state, createViewerCoreState());
}

export function applyArchiveToViewerCore(state: ViewerCoreState, archive: SessionArchive): void {
  resetViewerCoreState(state);
  state.timeline = deriveTimeline(archive);
  state.mergeGroups = getArchiveMergeGroups(archive);
  state.steps = getStepAnnotations(archive);
}

export function deriveTimeline(archive: SessionArchive): TimelineItem[] {
  return buildTimeline(archive);
}

export function deriveSectionTimeline(
  archive: SessionArchive,
  section: TimelineSection,
  subtypeFilter: NetworkSubtype | "all" = "all",
  networkSearchQuery = "",
  stepFilter: string | null = null
): TimelineItem[] {
  const items = buildSectionTimeline(archive, section, subtypeFilter, networkSearchQuery);
  if (stepFilter === null) return items;
  const steps = getStepAnnotations(archive);
  // A filter left over from another archive does not empty the list.
  return steps.some((step) => step.stepId === stepFilter) ? filterTimelineByStep(items, steps, stepFilter) : items;
}

const hasStepTag = (item: TimelineItem): boolean => (item.tags ?? []).some((tag) => tag.startsWith("step:"));

// Entries tagged `step:<id>` belong to the step. Entries that carry no step tag at all (for example
// network traffic captured without a step scope) belong to it when they fall inside its time window.
export function filterTimelineByStep(
  items: ReadonlyArray<TimelineItem>,
  steps: ReadonlyArray<StepAnnotation>,
  stepId: string
): TimelineItem[] {
  // A macro step owns the entries of the steps it expanded into.
  const owned = new Set([stepId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const candidate of steps) {
      if (candidate.parentStepId !== null && owned.has(candidate.parentStepId) && !owned.has(candidate.stepId)) {
        owned.add(candidate.stepId);
        grew = true;
      }
    }
  }
  const tags = new Set([...owned].map(stepTag));
  const step = steps.find((candidate) => candidate.stepId === stepId);
  const startMs = step ? Date.parse(step.startedAt) : Number.NaN;
  const endMs = step?.endedAt ? Date.parse(step.endedAt) : Number.POSITIVE_INFINITY;

  return items.filter((item) => {
    if (item.tags?.some((itemTag) => tags.has(itemTag))) return true;
    if (hasStepTag(item) || Number.isNaN(startMs)) return false;
    const at = Date.parse(item.at);
    return at >= startMs && at <= endMs;
  });
}

export function setStepFilter(state: ViewerCoreState, stepId: string | null): void {
  state.stepFilter = stepId !== null && state.steps.some((step) => step.stepId === stepId) ? stepId : null;
  state.activeIndex = -1;
  state.networkDetailIndex = null;
  state.selectedActionIds = new Set();
  state.anchorActionId = null;
}

// Video position of a step, in seconds, for seeking the shared player.
export function getStepSeekSeconds(steps: ReadonlyArray<StepAnnotation>, stepId: string): number | null {
  const step = steps.find((candidate) => candidate.stepId === stepId);
  return step ? step.videoOffsetMs / 1000 : null;
}

export function deriveVisibleActionRange(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>,
  anchorId: string,
  targetId: string
): string[] {
  return buildVisibleActionRangeSelection(archive, mergeGroups, anchorId, targetId);
}

export function getContiguousMergeableSelection(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>,
  selectedIds: Iterable<string>
): string[] {
  return getContiguousMergeableActionIds(archive, mergeGroups, selectedIds);
}

export function selectSingleAction(itemId: string): SelectionCommand {
  return { selectedActionIds: new Set([itemId]), anchorActionId: itemId };
}

export function toggleActionSelection(current: SelectionCommand, itemId: string): SelectionCommand {
  const next = new Set(current.selectedActionIds);
  let anchorActionId = current.anchorActionId;
  if (next.has(itemId)) {
    next.delete(itemId);
  } else {
    next.add(itemId);
    anchorActionId = itemId;
  }
  return { selectedActionIds: next, anchorActionId };
}

export function selectActionRange(
  archive: SessionArchive,
  mergeGroups: ReadonlyArray<ActionMergeGroup>,
  current: SelectionCommand,
  targetId: string
): SelectionCommand {
  if (!current.anchorActionId) {
    return current;
  }

  const rangeIds = deriveVisibleActionRange(archive, mergeGroups, current.anchorActionId, targetId);
  if (rangeIds.length === 0) {
    return current;
  }

  return { selectedActionIds: new Set(rangeIds), anchorActionId: current.anchorActionId };
}

export function openMergeDialog(state: ViewerCoreState, selectedActionIds: string[]): void {
  state.pendingMergeActionIds = [...selectedActionIds];
  state.mergeDialogValue = `Merged ${selectedActionIds.length} actions`;
  state.mergeDialogError = null;
  state.mergeDialogOpen = true;
}

export function closeMergeDialog(state: ViewerCoreState): void {
  state.mergeDialogOpen = false;
  state.mergeDialogValue = "";
  state.mergeDialogError = null;
  state.pendingMergeActionIds = [];
}

export function validateMergeDialog(state: ViewerCoreState): MergeDialogCommandResult {
  if (state.pendingMergeActionIds.length < 2) {
    return { ok: false, error: "Select at least two actions before merging." };
  }

  const label = state.mergeDialogValue.trim();
  if (!label) {
    return { ok: false, error: "Enter a name for the merged action." };
  }

  return {
    ok: true,
    label,
    selectedActionIds: [...state.pendingMergeActionIds]
  };
}

export function createMergeGroup(args: {
  id: string;
  createdAt: string;
  label: string;
  selectedActionIds: string[];
}): ActionMergeGroup {
  return {
    id: args.id,
    kind: "merge-group",
    memberIds: [...args.selectedActionIds],
    tags: [],
    label: args.label,
    createdAt: args.createdAt
  };
}

export function getArchiveMergeGroups(archive: SessionArchive): ActionMergeGroup[] {
  return (archive.annotations ?? []).filter((annotation): annotation is ActionMergeGroup => annotation.kind === "merge-group");
}

// ---------------------------------------------------------------------------------------------
// Skip gaps: during review, playback jumps over idle stretches to just before the next step.
// ---------------------------------------------------------------------------------------------

export type GapSkipOptions = {
  // Land this long before the next step.
  leadMs: number;
  // Let a step play out for this long before skipping on.
  settleMs: number;
  // Skip only when it saves at least this much.
  minSkipMs: number;
};

export const defaultGapSkipOptions: GapSkipOptions = { leadMs: 1500, settleMs: 1500, minSkipMs: 1000 };

/**
 * Video offsets (ms, ascending) that count as steps for skipping: the run's step offsets when the
 * host has them, else the archive's step annotations, else its interactions and errors (an
 * extension recording has no steps).
 */
export function deriveGapMarkers(archive: SessionArchive, stepOffsetsMs?: Readonly<Record<string, number>> | null): number[] {
  const fromRun = stepOffsetsMs ? Object.values(stepOffsetsMs) : [];
  const fromSteps = fromRun.length > 0 ? fromRun : getStepAnnotations(archive).map((step) => step.videoOffsetMs);
  const offsets =
    fromSteps.length > 0
      ? fromSteps
      : buildTimeline(archive)
          .filter((item) => item.kind === "interaction" || item.kind === "error")
          .map((item) => item.offsetMs);
  return [...new Set(offsets.filter((offset) => Number.isFinite(offset) && offset >= 0))].sort((a, b) => a - b);
}

/**
 * Where to jump from `currentMs`, or null to keep playing. The start of the video counts as a
 * step, so a long idle intro is skipped too; after the last step playback runs to the end.
 */
export function gapSkipTarget(markersMs: readonly number[], currentMs: number, options: GapSkipOptions = defaultGapSkipOptions): number | null {
  let previous = 0;
  let next: number | null = null;
  for (const marker of markersMs) {
    if (marker <= currentMs) previous = marker;
    else {
      next = marker;
      break;
    }
  }
  if (next === null) return null;
  if (currentMs < previous + options.settleMs) return null;
  const target = next - options.leadMs;
  return target - currentMs >= options.minSkipMs ? target : null;
}

/** The first marker after `currentMs`, used to stop skipping inside a gap the user sought into. */
export function nextGapMarker(markersMs: readonly number[], currentMs: number): number | null {
  return markersMs.find((marker) => marker > currentMs) ?? null;
}
