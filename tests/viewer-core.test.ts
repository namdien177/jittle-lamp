import { describe, expect, test } from "bun:test";

import { createSessionArchive, createSessionDraft, sessionArchiveSchema, type SessionArchive, type SessionEvent } from "@jittle-lamp/shared";
import { CANONICAL_NOW, canonicalArchiveBundles } from "./fixtures/canonical-fixtures";
import { makeRunnerArchive, runnerSteps } from "./fixtures/e2e/runner-archive";
import {
  applyArchiveToViewerCore,
  closeMergeDialog,
  createMergeGroup,
  createViewerCoreState,
  deriveSectionTimeline,
  deriveTimeline,
  filterTimelineByStep,
  getContiguousMergeableSelection,
  getStepSeekSeconds,
  setStepFilter,
  openMergeDialog,
  resetViewerCoreState,
  selectActionRange,
  selectSingleAction,
  toggleActionSelection,
  validateMergeDialog,
  type ViewerCoreState
} from "@jittle-lamp/viewer-core";

const NOW = CANONICAL_NOW;

function makeArchive(events: SessionEvent[]) {
  const draft = createSessionDraft({
    page: { title: "Example", url: "https://example.com" },
    now: new Date(NOW)
  });

  return createSessionArchive({
    ...draft,
    createdAt: NOW,
    updatedAt: events.at(-1)?.at ?? NOW,
    phase: "ready",
    events
  });
}

function makeAnnotatedArchive(events: SessionEvent[]) {
  const archive = makeArchive(events);

  return sessionArchiveSchema.parse({
    ...archive,
    annotations: [
      {
        id: "merge-1",
        kind: "merge-group",
        memberIds: [archive.sessionId + ":actions:000001", archive.sessionId + ":actions:000002"],
        tags: [],
        label: "Merged",
        createdAt: NOW
      }
    ]
  });
}

function makeMergeArchive(): SessionArchive {
  return canonicalArchiveBundles.medium;
}

function mutateCoreState(state: ViewerCoreState): void {
  state.activeIndex = 10;
  state.networkDetailIndex = 4;
  state.networkSearchQuery = "hello";
  state.mergeDialogOpen = true;
  state.mergeDialogValue = "Merged stuff";
  state.mergeDialogError = "Oops";
  state.pendingMergeActionIds = ["a", "b"];
  state.activeSection = "network";
  state.networkSubtypeFilter = "xhr";
  state.autoFollow = false;
  state.selectedActionIds = new Set(["a"]);
  state.anchorActionId = "a";
  state.mergeGroups = [
    {
      id: "merge-x",
      kind: "merge-group",
      memberIds: ["a", "b"],
      tags: [],
      label: "X",
      createdAt: NOW
    }
  ];
}

describe("viewer core state helpers", () => {
  test("createViewerCoreState returns default viewer state", () => {
    const state = createViewerCoreState();

    expect(state.activeIndex).toBe(-1);
    expect(state.networkDetailIndex).toBeNull();
    expect(state.networkSearchQuery).toBe("");
    expect(state.activeSection).toBe("actions");
    expect(state.networkSubtypeFilter).toBe("all");
    expect(state.autoFollow).toBe(true);
    expect(state.selectedActionIds.size).toBe(0);
    expect(state.mergeGroups).toEqual([]);
  });

  test("resetViewerCoreState clears viewer interaction state", () => {
    const state = createViewerCoreState();
    mutateCoreState(state);

    resetViewerCoreState(state);

    expect(state.activeIndex).toBe(-1);
    expect(state.networkDetailIndex).toBeNull();
    expect(state.networkSearchQuery).toBe("");
    expect(state.mergeDialogOpen).toBe(false);
    expect(state.mergeDialogValue).toBe("");
    expect(state.mergeDialogError).toBeNull();
    expect(state.pendingMergeActionIds).toEqual([]);
    expect(state.activeSection).toBe("actions");
    expect(state.networkSubtypeFilter).toBe("all");
    expect(state.autoFollow).toBe(true);
    expect(state.selectedActionIds.size).toBe(0);
    expect(state.anchorActionId).toBeNull();
    expect(state.mergeGroups).toEqual([]);
  });

  test("applyArchiveToViewerCore hydrates timeline and merge groups", () => {
    const state = createViewerCoreState();
    mutateCoreState(state);
    const archive = makeAnnotatedArchive([
      { at: NOW, payload: { kind: "lifecycle", phase: "recording", detail: "Started" } },
      { at: "2024-06-01T12:00:01.000Z", payload: { kind: "interaction", type: "click", selector: "#a" } },
      { at: "2024-06-01T12:00:02.000Z", payload: { kind: "interaction", type: "click", selector: "#b" } }
    ]);

    applyArchiveToViewerCore(state, archive);

    expect(state.timeline.length).toBeGreaterThan(0);
    expect(state.activeIndex).toBe(-1);
    expect(state.networkDetailIndex).toBeNull();
    expect(state.networkSearchQuery).toBe("");
    expect(state.mergeDialogOpen).toBe(false);
    expect(state.pendingMergeActionIds).toEqual([]);
    expect(state.activeSection).toBe("actions");
    expect(state.networkSubtypeFilter).toBe("all");
    expect(state.autoFollow).toBe(true);
    expect(state.selectedActionIds.size).toBe(0);
    expect(state.anchorActionId).toBeNull();
    expect(state.mergeGroups).toHaveLength(1);
    expect(state.mergeGroups[0]?.id).toBe("merge-1");
  });
});

describe("viewer core command helpers", () => {
  test("merge/unmerge commands are deterministic across dialog and group helpers", () => {
    const state = createViewerCoreState();
    const selection = ["action-1", "action-2", "action-3"];

    openMergeDialog(state, selection);
    expect(state.mergeDialogOpen).toBeTrue();
    expect(state.pendingMergeActionIds).toEqual(selection);

    state.mergeDialogValue = "  Grouped actions  ";
    const validation = validateMergeDialog(state);
    expect(validation).toEqual({
      ok: true,
      label: "Grouped actions",
      selectedActionIds: selection
    });

    if (!validation.ok) {
      throw new Error("expected merge validation to succeed");
    }

    const created = createMergeGroup({
      id: "merge-fixed",
      createdAt: NOW,
      label: validation.label,
      selectedActionIds: validation.selectedActionIds
    });
    const mergeGroups = [created, createMergeGroup({ id: "merge-keep", createdAt: NOW, label: "Keep", selectedActionIds: ["x", "y"] })];

    expect(created).toEqual({
      id: "merge-fixed",
      kind: "merge-group",
      memberIds: selection,
      tags: [],
      label: "Grouped actions",
      createdAt: NOW
    });

    const unmerged = mergeGroups.filter((group) => group.id !== "merge-fixed");
    expect(unmerged.map((group) => group.id)).toEqual(["merge-keep"]);

    closeMergeDialog(state);
    expect(state.mergeDialogOpen).toBeFalse();
    expect(state.pendingMergeActionIds).toEqual([]);
  });

  test("range and toggle selection commands mirror shift/cmd/ctrl variants", () => {
    const archive = makeMergeArchive();
    const actionIds = archive.sections.actions
      .filter((entry) => entry.payload.kind === "interaction")
      .map((entry) => entry.id);

    const cmdSelection = toggleActionSelection(selectSingleAction(actionIds[0]!), actionIds[2]!);
    expect([...cmdSelection.selectedActionIds]).toEqual([actionIds[0]!, actionIds[2]!]);
    expect(cmdSelection.anchorActionId).toBe(actionIds[2]!);

    const rangeFromCmdAnchor = selectActionRange(archive, [], cmdSelection, actionIds[3]!);
    expect([...rangeFromCmdAnchor.selectedActionIds]).toEqual([actionIds[2]!, actionIds[3]!]);
    expect(rangeFromCmdAnchor.anchorActionId).toBe(actionIds[2]!);

    const ctrlToggleOff = toggleActionSelection(rangeFromCmdAnchor, actionIds[3]!);
    expect([...ctrlToggleOff.selectedActionIds]).toEqual([actionIds[2]!]);
    expect(ctrlToggleOff.anchorActionId).toBe(actionIds[2]!);

    const shiftFromSingle = selectActionRange(archive, [], selectSingleAction(actionIds[1]!), actionIds[3]!);
    expect([...shiftFromSingle.selectedActionIds]).toEqual([actionIds[1]!, actionIds[2]!, actionIds[3]!]);
  });

  test("filter/search results remain consistent across repeated and equivalent queries", () => {
    const archive = makeMergeArchive();

    const first = deriveSectionTimeline(archive, "network", "all", "req-timeout").map((item) => item.id);
    const second = deriveSectionTimeline(archive, "network", "all", "REQ-TIMEOUT").map((item) => item.id);
    const regex = deriveSectionTimeline(archive, "network", "all", "/req-timeout/i").map((item) => item.id);
    const subtypeFiltered = deriveSectionTimeline(archive, "network", "xhr", "req-timeout").map((item) => item.id);

    expect(first).toEqual(second);
    expect(first).toEqual(regex);
    expect(first).toEqual(subtypeFiltered);
    expect(deriveSectionTimeline(archive, "network", "all", "/(/invalid/").length).toBe(0);
  });

  test("mergeable selection contract matches parity constraints for merged and non-contiguous rows", () => {
    const archive = makeMergeArchive();
    const actionIds = archive.sections.actions
      .filter((entry) => entry.payload.kind === "interaction")
      .map((entry) => entry.id);

    const merged = createMergeGroup({
      id: "merge-middle",
      createdAt: NOW,
      label: "Middle",
      selectedActionIds: [actionIds[1]!, actionIds[2]!]
    });

    expect(getContiguousMergeableSelection(archive, [], [actionIds[0]!, actionIds[1]!, actionIds[2]!, actionIds[3]!])).toEqual(actionIds.slice(0, 4));
    expect(getContiguousMergeableSelection(archive, [], [actionIds[0]!, actionIds[3]!])).toEqual([]);
    expect(getContiguousMergeableSelection(archive, [merged], [actionIds[0]!, actionIds[3]!])).toEqual([]);
    expect(getContiguousMergeableSelection(archive, [merged], ["merge-middle", actionIds[3]!])).toEqual([]);
  });
});

describe("viewer-core step filter (archive v4)", () => {
  test("hydrates steps and filters each section by step tag", () => {
    const archive = makeRunnerArchive();
    const state = createViewerCoreState();
    applyArchiveToViewerCore(state, archive);
    expect(state.steps.map((step) => step.stepId)).toEqual([runnerSteps.open, runnerSteps.logout]);

    const actionIds = deriveSectionTimeline(archive, "actions", "all", "", runnerSteps.logout).map((item) => item.id);
    expect(actionIds).toEqual([`${archive.sessionId}:actions:000002`]);
    const networkLabels = deriveSectionTimeline(archive, "network", "all", "", runnerSteps.open).map((item) => item.label);
    expect(networkLabels).toEqual(["GET https://uat.example.test/login"]);
    // Untagged console output inside the step's time window belongs to the step.
    expect(deriveSectionTimeline(archive, "console", "all", "", runnerSteps.logout)).toHaveLength(1);
    expect(deriveSectionTimeline(archive, "console", "all", "", runnerSteps.open)).toHaveLength(0);
    expect(deriveSectionTimeline(archive, "actions", "all", "", null)).toHaveLength(2);
  });

  test("setStepFilter ignores unknown steps and resets selection; seek offsets come from the annotation", () => {
    const archive = makeRunnerArchive();
    const state = createViewerCoreState();
    applyArchiveToViewerCore(state, archive);
    state.selectedActionIds = new Set(["x"]);
    setStepFilter(state, runnerSteps.logout);
    expect(state.stepFilter).toBe(runnerSteps.logout);
    expect(state.selectedActionIds.size).toBe(0);
    setStepFilter(state, "st_missing");
    expect(state.stepFilter).toBeNull();
    expect(getStepSeekSeconds(state.steps, runnerSteps.logout)).toBe(3);
    expect(filterTimelineByStep(deriveTimeline(archive), state.steps, "st_missing")).toEqual([]);
  });

  test("extension archives without steps keep the unfiltered timeline", () => {
    const archive = makeMergeArchive();
    const state = createViewerCoreState();
    applyArchiveToViewerCore(state, archive);
    expect(state.steps).toEqual([]);
    expect(deriveSectionTimeline(archive, "actions")).toEqual(deriveSectionTimeline(archive, "actions", "all", "", null));
  });
});
