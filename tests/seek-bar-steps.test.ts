import { describe, expect, test } from "bun:test";
import { sessionArchiveSchema } from "@jittle-lamp/shared";
import { buildViewerStepChips, type ViewerStepChip } from "@jittle-lamp/viewer-react";

import { adjacentStepStart, buildStepSegments, stepAtTime } from "../packages/viewer-react/src/viewer-modal/seek-bar";
import { makeRunnerArchive, runnerSteps } from "./fixtures/e2e/runner-archive";

// The player's seek bar draws one segment per test-run step (web and desktop share the player).

const chip = (stepId: string, ordinal: number, startMs: number, endMs: number | null, status: ViewerStepChip["status"] = "passed"): ViewerStepChip => ({
  stepId,
  ordinal,
  type: "act",
  label: `step ${ordinal}`,
  status,
  mode: null,
  startMs,
  endMs
});

describe("buildViewerStepChips", () => {
  const archive = sessionArchiveSchema.parse(makeRunnerArchive());

  test("chips carry where each step sits in the recording", () => {
    expect(buildViewerStepChips(archive).map(({ stepId, type, startMs, endMs }) => ({ stepId, type, startMs, endMs }))).toEqual([
      { stepId: runnerSteps.open, type: "open", startMs: 400, endMs: 1200 },
      { stepId: runnerSteps.logout, type: "act", startMs: 3000, endMs: 4000 }
    ]);
  });

  test("the run's own offsets win and keep each step's length", () => {
    const chips = buildViewerStepChips(archive, { [runnerSteps.logout]: 3500 });
    expect(chips[1]).toMatchObject({ startMs: 3500, endMs: 4500 });
  });
});

describe("buildStepSegments", () => {
  test("a step without an end runs to the next step, the last one to the end of the video", () => {
    const segments = buildStepSegments([chip("b", 2, 5000, null), chip("a", 1, 0, null), chip("c", 3, 8000, null, "failed")], 12);
    expect(segments.map((segment) => [segment.step.stepId, segment.startSeconds, segment.endSeconds])).toEqual([
      ["a", 0, 5],
      ["b", 5, 8],
      ["c", 8, 12]
    ]);
  });

  test("steps past the end of a shorter video are dropped, ends are clamped", () => {
    const segments = buildStepSegments([chip("a", 1, 1000, 9000), chip("b", 2, 15000, null)], 6);
    expect(segments.map((segment) => [segment.step.stepId, segment.startSeconds, segment.endSeconds])).toEqual([["a", 1, 6]]);
  });

  test("no steps or no duration yet: a plain seek bar", () => {
    expect(buildStepSegments(undefined, 10)).toEqual([]);
    expect(buildStepSegments([chip("a", 1, 0, null)], 0)).toEqual([]);
  });
});

describe("step navigation", () => {
  const segments = buildStepSegments([chip("a", 1, 1000, null), chip("b", 2, 4000, null), chip("c", 3, 9000, null)], 20);

  test("the playing step is the last one that has started", () => {
    expect(stepAtTime(segments, 0.5)).toBeNull();
    expect(stepAtTime(segments, 4)?.step.stepId).toBe("b");
    expect(stepAtTime(segments, 8.9)?.step.stepId).toBe("b");
  });

  test("next jumps to the following step start; none after the last", () => {
    expect(adjacentStepStart(segments, 0, 1)).toBe(1);
    expect(adjacentStepStart(segments, 4, 1)).toBe(9);
    expect(adjacentStepStart(segments, 9.5, 1)).toBeNull();
  });

  test("previous restarts the current step, or goes one back right at its start", () => {
    expect(adjacentStepStart(segments, 6, -1)).toBe(4);
    expect(adjacentStepStart(segments, 4.5, -1)).toBe(1);
    expect(adjacentStepStart(segments, 1.2, -1)).toBe(0);
    expect(adjacentStepStart(segments, 0.5, -1)).toBeNull();
  });
});
