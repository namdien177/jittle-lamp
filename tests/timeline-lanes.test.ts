import { describe, expect, test } from "bun:test";
import type { TimelineItem } from "@jittle-lamp/shared";
import { deriveTimelineLaneMarks } from "@jittle-lamp/viewer-core";

// The web lane timeline classifies items the way the desktop viewer does (jl-core::timeline
// classify_action / network_severity, and jl-app events_of), so both show the same lanes.

let seq = 0;
function item(partial: Pick<TimelineItem, "kind" | "section" | "offsetMs" | "payload"> & { tags?: string[] }): TimelineItem {
  seq += 1;
  return { id: `item-${seq}`, seq, at: "2026-10-30T00:00:00.000Z", label: `label ${seq}`, ...partial } as TimelineItem;
}

function network(offsetMs: number, payload: Record<string, unknown>): TimelineItem {
  return item({ kind: "network", section: "network", offsetMs, payload: { kind: "network", method: "GET", url: "https://x.test/a", ...payload } as TimelineItem["payload"] });
}

describe("deriveTimelineLaneMarks", () => {
  test("puts interactions and integrations on the actions lane", () => {
    const marks = deriveTimelineLaneMarks([
      item({ kind: "interaction", section: "actions", offsetMs: 900, payload: { kind: "interaction", type: "click" } as TimelineItem["payload"] }),
      item({ kind: "integration", section: "actions", offsetMs: 1200, payload: { kind: "integration", durationMs: 300 } as TimelineItem["payload"] })
    ]);
    expect(marks.map((mark) => [mark.lane, mark.severity, mark.durationMs])).toEqual([
      ["actions", "info", null],
      ["actions", "info", 300]
    ]);
  });

  test("sends page errors to the console lane as errors", () => {
    const [mark] = deriveTimelineLaneMarks([item({ kind: "error", section: "actions", offsetMs: 500, payload: { kind: "error", message: "boom" } as TimelineItem["payload"] })]);
    expect(mark).toMatchObject({ lane: "console", severity: "error" });
  });

  test("draws lifecycle events as markers, a failed capture as an error", () => {
    const marks = deriveTimelineLaneMarks([
      item({ kind: "lifecycle", section: "actions", offsetMs: 0, payload: { kind: "lifecycle", phase: "recording" } as TimelineItem["payload"] }),
      item({ kind: "lifecycle", section: "actions", offsetMs: 4000, payload: { kind: "lifecycle", phase: "failed" } as TimelineItem["payload"] })
    ]);
    expect(marks.map((mark) => [mark.lane, mark.severity])).toEqual([
      ["markers", "info"],
      ["markers", "error"]
    ]);
  });

  test("keeps the console level as the severity", () => {
    const levels = ["debug", "info", "warn", "error"] as const;
    const marks = deriveTimelineLaneMarks(levels.map((level, index) => item({ kind: "console", section: "console", offsetMs: index * 100, payload: { kind: "console", level, message: level } as TimelineItem["payload"] })));
    expect(marks.map((mark) => mark.severity)).toEqual([...levels]);
  });

  test("rates requests by failure and status, with their duration as the bar width", () => {
    const marks = deriveTimelineLaneMarks([
      network(100, { status: 200, durationMs: 120.4 }),
      network(200, { status: 404 }),
      network(300, { status: 503 }),
      network(400, { failureText: "net::ERR_FAILED" }),
      network(500, {})
    ]);
    expect(marks.map((mark) => [mark.severity, mark.durationMs])).toEqual([
      ["info", 120.4],
      ["warn", null],
      ["error", null],
      ["error", null],
      ["info", null]
    ]);
  });

  test("drops requests from before the recording started and clamps other early items to 0", () => {
    const marks = deriveTimelineLaneMarks([
      network(-800, { status: 200 }),
      item({ kind: "console", section: "console", offsetMs: -50, payload: { kind: "console", level: "info", message: "early" } as TimelineItem["payload"] })
    ]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ lane: "console", offsetMs: 0 });
  });

  test("returns nothing for an empty timeline", () => {
    expect(deriveTimelineLaneMarks([])).toEqual([]);
  });
});
