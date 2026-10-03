import { describe, expect, test } from "bun:test";
import { createSessionArchive, createSessionDraft } from "@jittle-lamp/shared";
import { defaultGapSkipOptions, deriveGapMarkers, gapSkipTarget, nextGapMarker } from "@jittle-lamp/viewer-core";

import { makeRunnerArchive } from "./fixtures/e2e/runner-archive";

// PARITY-SKIP-01: desktop and web both pass deriveGapMarkers to the shared player.

describe("gapSkipTarget", () => {
  const markers = [2000, 20000, 21000, 40000];

  test("skips a long gap to 1.5 s before the next step once the step has played out", () => {
    expect(gapSkipTarget(markers, 2500)).toBeNull(); // still settling after the step at 2 s
    expect(gapSkipTarget(markers, 3600)).toBe(18500);
  });

  test("skips an idle intro before the first step", () => {
    expect(gapSkipTarget([10000], 1600)).toBe(8500);
    expect(gapSkipTarget([10000], 500)).toBeNull();
  });

  test("leaves short gaps and the tail after the last step alone", () => {
    expect(gapSkipTarget(markers, 20000 + defaultGapSkipOptions.settleMs)).toBeNull(); // next step 1 s away
    expect(gapSkipTarget(markers, 18600)).toBeNull(); // already inside the lead window
    expect(gapSkipTarget(markers, 45000)).toBeNull();
    expect(gapSkipTarget([], 1000)).toBeNull();
  });

  test("names the next marker so a manual seek into a gap is respected", () => {
    expect(nextGapMarker(markers, 10000)).toBe(20000);
    expect(nextGapMarker(markers, 40000)).toBeNull();
  });
});

describe("deriveGapMarkers", () => {
  test("uses step annotations of runner evidence", () => {
    const archive = makeRunnerArchive();
    const markers = deriveGapMarkers(archive);
    expect(markers.length).toBeGreaterThan(0);
    expect([...markers].sort((a, b) => a - b)).toEqual(markers);
  });

  test("prefers the run's step offsets when the host passes them", () => {
    expect(deriveGapMarkers(makeRunnerArchive(), { a: 9000, b: 3000, c: 3000 })).toEqual([3000, 9000]);
  });

  test("falls back to interactions for an extension recording", () => {
    const draft = createSessionDraft({ page: { title: "Recording", url: "https://example.test/" }, now: new Date("2026-02-10T10:00:00.000Z") });
    const archive = createSessionArchive({
      ...draft,
      createdAt: "2026-02-10T10:00:00.000Z",
      updatedAt: "2026-02-10T10:00:30.000Z",
      phase: "ready",
      events: [
        { at: "2026-02-10T10:00:00.000Z", payload: { kind: "lifecycle", phase: "recording", detail: "Started" } },
        { at: "2026-02-10T10:00:04.000Z", payload: { kind: "interaction", type: "click", selector: "#a" } },
        { at: "2026-02-10T10:00:30.000Z", payload: { kind: "interaction", type: "click", selector: "#b" } }
      ]
    });
    expect(deriveGapMarkers(archive)).toEqual([4000, 30000]);
  });
});
