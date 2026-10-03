import type { LiveInputRequest, TestRunDetail } from "@jittle-lamp/shared";

// Pure logic of the live view panel (design.md §5.4, phase 2 unit 2.3): polling cadence, where
// the frame sits on screen, how a click maps to the run's viewport and how keys become input
// events. Kept free of React so root tests cover it.

// POST /live/watch keeps frames flowing for 30 s; refresh well before that.
export const LIVE_WATCH_INTERVAL_MS = 10_000;
// GET /live/frame while the panel is open.
export const LIVE_FRAME_INTERVAL_MS = 1_000;
// Input is batched briefly so typing a word is one event, not one request per key.
export const LIVE_INPUT_FLUSH_MS = 80;
export const DEFAULT_VIEWPORT = { width: 1440, height: 900 } as const;

export type LiveInput = LiveInputRequest["events"][number];
export type Size = { width: number; height: number };
export type Rect = { left: number; top: number; width: number; height: number };

// The rectangle an object-contain image of `content`'s aspect ratio occupies inside `box`.
export function containedRect(box: Rect, content: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { left: box.left, top: box.top, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / content.width, box.height / content.height);
  const width = content.width * scale;
  const height = content.height * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

// A point on the displayed frame in the run's viewport CSS pixels; null on the letterbox.
export function toViewportPoint(point: { clientX: number; clientY: number }, box: Rect, viewport: Size): { x: number; y: number } | null {
  const shown = containedRect(box, viewport);
  if (shown.width === 0 || shown.height === 0) return null;
  const dx = point.clientX - shown.left;
  const dy = point.clientY - shown.top;
  if (dx < 0 || dy < 0 || dx > shown.width || dy > shown.height) return null;
  return {
    x: round1(Math.min(viewport.width - 1, Math.max(0, (dx / shown.width) * viewport.width))),
    y: round1(Math.min(viewport.height - 1, Math.max(0, (dy / shown.height) * viewport.height)))
  };
}

// Keys sent as presses; everything printable is typed.
export const PRESS_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

export type KeyLike = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

// Reserved chord that leaves the remote browser (moves focus to Release) instead of being sent:
// while holding, Tab and Escape go to the run, so the panel needs a way out for keyboard users.
export const LEAVE_CHORD_LABEL = "Ctrl+Alt+Esc";
export function isLeaveChord(event: KeyLike): boolean {
  return event.key === "Escape" && event.ctrlKey && event.altKey;
}

// Playwright key names: "Enter", "Shift+Tab", "Control+A". Modifier-only keys and function keys
// are not sent, nor is the leave chord.
export function keyToLiveInput(event: KeyLike): LiveInput | null {
  if (event.isComposing || isLeaveChord(event)) return null;
  const { key } = event;
  if (PRESS_KEYS.has(key)) {
    const modifiers = [event.ctrlKey && "Control", event.metaKey && "Meta", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
    return { kind: "press", key: [...modifiers, key].join("+") };
  }
  if (key.length !== 1) return null;
  if (event.ctrlKey || event.metaKey) {
    const modifier = event.ctrlKey ? "Control" : "Meta";
    return { kind: "press", key: `${modifier}+${key.toUpperCase()}` };
  }
  return { kind: "type", text: key };
}

// Consecutive typed characters become one `type` event (at most 2 000 characters each).
export function coalesceInputs(events: readonly LiveInput[]): LiveInput[] {
  const out: LiveInput[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (event.kind === "type" && last?.kind === "type" && last.text.length + event.text.length <= 2000) {
      out[out.length - 1] = { kind: "type", text: last.text + event.text };
      continue;
    }
    out.push(event);
  }
  return out;
}

// WheelEvent.deltaMode: 0 pixels, 1 lines, 2 pages.
export function wheelDeltaPixels(deltaY: number, deltaMode: number): number {
  const factor = deltaMode === 1 ? 40 : deltaMode === 2 ? 800 : 1;
  return Math.max(-5_000, Math.min(5_000, Math.round(deltaY * factor)));
}

export type TakeoverRole = "none" | "mine" | "other";

export function takeoverRole(live: TestRunDetail["live"], currentUserIds: readonly string[]): TakeoverRole {
  if (!live?.takeoverBy) return "none";
  return currentUserIds.includes(live.takeoverBy) ? "mine" : "other";
}

// The requester of the run, or anyone with test_run.cancel_any, may take over a live run.
export function canTakeOver(
  run: Pick<TestRunDetail, "status" | "createdBy" | "live">,
  currentUserIds: readonly string[],
  canCancelAny: boolean
): boolean {
  if (!run.live?.available) return false;
  if (run.status !== "claimed" && run.status !== "running" && run.status !== "paused") return false;
  if (run.live.takeoverBy && !currentUserIds.includes(run.live.takeoverBy)) return false;
  return canCancelAny || (run.createdBy !== null && currentUserIds.includes(run.createdBy));
}

export function liveViewport(live: TestRunDetail["live"], frame: Size | null): Size {
  return frame ?? live?.viewport ?? DEFAULT_VIEWPORT;
}

// "frame 0.4 s ago" next to the live dot; frames older than 5 s read as stalled.
export function frameAge(frameAt: number | null, now: number): { label: string; stale: boolean } {
  if (frameAt === null) return { label: "waiting for the first frame", stale: false };
  const seconds = Math.max(0, (now - frameAt) / 1000);
  return { label: seconds < 1 ? "just now" : `${seconds.toFixed(seconds < 10 ? 1 : 0)} s ago`, stale: seconds > 5 };
}
