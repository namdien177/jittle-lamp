import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { writeStepLog } from "./step-log";

// Live view and take-over inside the e2e worker (design.md §5.4, phase 2). The daemon relays the
// backend's control state into JL_LIVE_DIR: control.json ({ live, takeover }) and inputs.jsonl
// (one input event per line). This module writes frame.jpg while someone watches and, during a
// take-over, holds the agent before its next action and replays the person's input. Steps touched
// by a take-over are never cached; typed text is never logged.

type Control = { live: boolean; takeover: boolean };
type InputEvent =
  | { seq: number; kind: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { seq: number; kind: "move"; x: number; y: number }
  | { seq: number; kind: "scroll"; x: number; y: number; deltaY: number }
  | { seq: number; kind: "type"; text: string }
  | { seq: number; kind: "press"; key: string };

declare global {
  var __jlTakeoverSteps: Set<string> | undefined;
  var __jlCurrentStepId: string | null | undefined;
}

const liveDir = () => process.env.JL_LIVE_DIR;

export function takeoverSteps(): Set<string> {
  globalThis.__jlTakeoverSteps ??= new Set<string>();
  return globalThis.__jlTakeoverSteps;
}

export function readControl(): Control {
  const dir = liveDir();
  if (!dir) return { live: false, takeover: false };
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "control.json"), "utf8")) as Partial<Control>;
    return { live: parsed.live === true, takeover: parsed.takeover === true };
  } catch {
    return { live: false, takeover: false };
  }
}

let inputOffset = 0;
function readNewInputs(): InputEvent[] {
  const dir = liveDir();
  if (!dir) return [];
  const path = join(dir, "inputs.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const fresh = lines.slice(inputOffset);
  inputOffset = lines.length;
  return fresh.flatMap((line) => {
    try {
      return [JSON.parse(line) as InputEvent];
    } catch {
      return [];
    }
  });
}

async function dispatch(page: Page, event: InputEvent): Promise<string> {
  switch (event.kind) {
    case "click":
      await page.mouse.click(event.x, event.y, { button: event.button ?? "left", clickCount: event.double ? 2 : 1 });
      return `click at ${Math.round(event.x)},${Math.round(event.y)}`;
    case "move":
      await page.mouse.move(event.x, event.y);
      return `move to ${Math.round(event.x)},${Math.round(event.y)}`;
    case "scroll":
      await page.mouse.move(event.x, event.y);
      await page.mouse.wheel(0, event.deltaY);
      return `scroll ${Math.round(event.deltaY)}`;
    case "type":
      await page.keyboard.type(event.text);
      // Only the length: the person may be typing a secret.
      return `typed ${event.text.length} character(s)`;
    case "press":
      await page.keyboard.press(event.key);
      return `pressed ${event.key}`;
  }
}

// Holds the run while a take-over is active, replaying the person's input into the page.
export async function waitWhileTakenOver(getPage: () => Page | null, pollMs = 200): Promise<void> {
  if (!liveDir() || !readControl().takeover) return;
  const stepId = globalThis.__jlCurrentStepId ?? null;
  if (stepId) takeoverSteps().add(stepId);
  writeStepLog({ type: "takeover", at: new Date().toISOString(), action: "start", stepId });
  const replayNewInputs = async () => {
    const page = getPage();
    for (const event of readNewInputs()) {
      if (!page) continue;
      try {
        const detail = await dispatch(page, event);
        writeStepLog({ type: "takeover-input", at: new Date().toISOString(), stepId, kind: event.kind, detail });
      } catch (error) {
        writeStepLog({ type: "takeover-input", at: new Date().toISOString(), stepId, kind: event.kind, detail: `failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  };
  while (readControl().takeover) {
    await replayNewInputs();
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // Input that arrived as the take-over ended still belongs to it, and is logged like the rest.
  await replayNewInputs();
  writeStepLog({ type: "takeover", at: new Date().toISOString(), action: "end", stepId });
}

let frameTimer: ReturnType<typeof setInterval> | null = null;

// Writes frame.jpg (atomically) every intervalMs while someone watches.
export function startLiveFrames(getPage: () => Page | null, intervalMs = Number(process.env.JL_LIVE_FRAME_MS ?? 700)): void {
  const dir = liveDir();
  if (!dir || frameTimer) return;
  let busy = false;
  frameTimer = setInterval(() => {
    if (busy || !readControl().live) return;
    const page = getPage();
    if (!page || page.isClosed()) return;
    busy = true;
    page
      .screenshot({ type: "jpeg", quality: 45, scale: "css", timeout: 2000 })
      .then((bytes) => {
        const tmp = join(dir, "frame.jpg.tmp");
        writeFileSync(tmp, bytes);
        renameSync(tmp, join(dir, "frame.jpg"));
      })
      .catch(() => undefined)
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  frameTimer.unref?.();
}
