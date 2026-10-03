import { describe, expect, it } from "bun:test";
import type { TestRunDetail } from "@jittle-lamp/shared";

import {
  canTakeOver,
  coalesceInputs,
  containedRect,
  frameAge,
  keyToLiveInput,
  liveViewport,
  takeoverRole,
  toViewportPoint,
  wheelDeltaPixels,
  type KeyLike
} from "../apps/evidence-web/src/test-runs/live-model";

const key = (value: string, modifiers: Partial<KeyLike> = {}): KeyLike => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers
});

const live = (overrides: Partial<NonNullable<TestRunDetail["live"]>> = {}): NonNullable<TestRunDetail["live"]> => ({
  available: true,
  takeoverBy: null,
  paused: false,
  frameUrl: null,
  frameAt: null,
  viewport: { width: 1440, height: 900 },
  ...overrides
});

describe("live view coordinate scaling", () => {
  it("places the frame with object-contain letterboxing", () => {
    // 1600×600 stage, 16:10 frame → limited by height: 960×600, centred.
    expect(containedRect({ left: 0, top: 0, width: 1600, height: 600 }, { width: 1440, height: 900 })).toEqual({
      left: 320,
      top: 0,
      width: 960,
      height: 600
    });
    // Tall stage → limited by width.
    expect(containedRect({ left: 10, top: 20, width: 720, height: 1000 }, { width: 1440, height: 900 })).toEqual({
      left: 10,
      top: 295,
      width: 720,
      height: 450
    });
    expect(containedRect({ left: 0, top: 0, width: 0, height: 400 }, { width: 1440, height: 900 }).width).toBe(0);
  });

  it("maps clicks on the shown frame to the run's viewport pixels", () => {
    const stage = { left: 100, top: 50, width: 1600, height: 600 };
    const viewport = { width: 1440, height: 900 };
    // Frame occupies x 420..1380, y 50..650 on screen (scale 1.5 down).
    expect(toViewportPoint({ clientX: 420, clientY: 50 }, stage, viewport)).toEqual({ x: 0, y: 0 });
    expect(toViewportPoint({ clientX: 900, clientY: 350 }, stage, viewport)).toEqual({ x: 720, y: 450 });
    expect(toViewportPoint({ clientX: 1380, clientY: 650 }, stage, viewport)).toEqual({ x: 1439, y: 899 });
    expect(toViewportPoint({ clientX: 421, clientY: 51 }, stage, viewport)).toEqual({ x: 1.5, y: 1.5 });
    // On the letterbox: nothing is sent.
    expect(toViewportPoint({ clientX: 300, clientY: 350 }, stage, viewport)).toBeNull();
    expect(toViewportPoint({ clientX: 1500, clientY: 350 }, stage, viewport)).toBeNull();
  });

  it("prefers the frame's own size, then the run's viewport, then a default", () => {
    expect(liveViewport(live(), { width: 1280, height: 720 })).toEqual({ width: 1280, height: 720 });
    expect(liveViewport(live(), null)).toEqual({ width: 1440, height: 900 });
    expect(liveViewport(live({ viewport: null }), null)).toEqual({ width: 1440, height: 900 });
  });
});

describe("live view keyboard and scroll mapping", () => {
  it("types printable keys and presses control keys", () => {
    expect(keyToLiveInput(key("a"))).toEqual({ kind: "type", text: "a" });
    expect(keyToLiveInput(key("A", { shiftKey: true }))).toEqual({ kind: "type", text: "A" });
    expect(keyToLiveInput(key(" "))).toEqual({ kind: "type", text: " " });
    expect(keyToLiveInput(key("é"))).toEqual({ kind: "type", text: "é" });
    for (const name of ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(keyToLiveInput(key(name))).toEqual({ kind: "press", key: name });
    }
    expect(keyToLiveInput(key("Tab", { shiftKey: true }))).toEqual({ kind: "press", key: "Shift+Tab" });
    expect(keyToLiveInput(key("a", { ctrlKey: true }))).toEqual({ kind: "press", key: "Control+A" });
    expect(keyToLiveInput(key("v", { metaKey: true }))).toEqual({ kind: "press", key: "Meta+V" });
  });

  it("ignores modifier-only keys, function keys and IME composition", () => {
    expect(keyToLiveInput(key("Shift", { shiftKey: true }))).toBeNull();
    expect(keyToLiveInput(key("Control", { ctrlKey: true }))).toBeNull();
    expect(keyToLiveInput(key("F5"))).toBeNull();
    expect(keyToLiveInput(key("a", { isComposing: true }))).toBeNull();
  });

  it("merges consecutive typing into one event and keeps the order", () => {
    expect(
      coalesceInputs([
        { kind: "type", text: "he" },
        { kind: "type", text: "llo" },
        { kind: "press", key: "Enter" },
        { kind: "type", text: "x" },
        { kind: "click", x: 1, y: 2, button: "left", double: false }
      ])
    ).toEqual([
      { kind: "type", text: "hello" },
      { kind: "press", key: "Enter" },
      { kind: "type", text: "x" },
      { kind: "click", x: 1, y: 2, button: "left", double: false }
    ]);
    const long = coalesceInputs([
      { kind: "type", text: "a".repeat(1999) },
      { kind: "type", text: "bc" }
    ]);
    expect(long).toHaveLength(2);
  });

  it("turns wheel deltas into pixels", () => {
    expect(wheelDeltaPixels(120, 0)).toBe(120);
    expect(wheelDeltaPixels(3, 1)).toBe(120);
    expect(wheelDeltaPixels(-1, 2)).toBe(-800);
    expect(wheelDeltaPixels(100_000, 0)).toBe(5_000);
  });
});

describe("live view take-over rules", () => {
  const run = (overrides: Partial<Pick<TestRunDetail, "status" | "createdBy" | "live">> = {}) => ({
    status: "running" as TestRunDetail["status"],
    createdBy: "u-requester",
    live: live(),
    ...overrides
  });

  it("lets the requester or test_run.cancel_any take over a live run", () => {
    expect(canTakeOver(run(), ["u-requester"], false)).toBe(true);
    expect(canTakeOver(run(), ["u-other"], false)).toBe(false);
    expect(canTakeOver(run(), ["u-other"], true)).toBe(true);
    expect(canTakeOver(run({ status: "completed" }), ["u-requester"], true)).toBe(false);
    expect(canTakeOver(run({ live: null }), ["u-requester"], true)).toBe(false);
    expect(canTakeOver(run({ live: live({ available: false }) }), ["u-requester"], true)).toBe(false);
    // Someone else already holds it.
    expect(canTakeOver(run({ live: live({ takeoverBy: "u-qa" }) }), ["u-requester"], true)).toBe(false);
  });

  it("tells whose take-over it is", () => {
    expect(takeoverRole(live(), ["u-1"])).toBe("none");
    expect(takeoverRole(live({ takeoverBy: "u-1" }), ["u-1"])).toBe("mine");
    expect(takeoverRole(live({ takeoverBy: "u-2" }), ["u-1"])).toBe("other");
    expect(takeoverRole(null, ["u-1"])).toBe("none");
  });

  it("describes the frame age", () => {
    expect(frameAge(null, 1_000)).toEqual({ label: "waiting for the first frame", stale: false });
    expect(frameAge(10_000, 10_400)).toEqual({ label: "just now", stale: false });
    expect(frameAge(10_000, 12_500)).toEqual({ label: "2.5 s ago", stale: false });
    expect(frameAge(10_000, 22_000)).toEqual({ label: "12 s ago", stale: true });
  });
});
