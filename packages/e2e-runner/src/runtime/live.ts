import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { writeStepLog } from "./step-log";

// Live view and take-over inside the e2e worker (design.md §5.4, phase 2). The daemon relays the
// backend's control state into JL_LIVE_DIR: control.json ({ live, takeover }) and inputs.jsonl
// (one input event per line). This module writes frame.jpg while someone watches and, during a
// take-over, holds the agent before its next action and replays the person's input. Steps touched
// by a take-over are never cached; typed text is never logged.

// `epoch` counts take-overs (the daemon bumps it when one starts); input lines carry the epoch
// of the take-over they belong to, so input from an earlier take-over is never replayed.
type Control = { live: boolean; takeover: boolean; epoch?: number };
type InputEvent = (
  | { seq: number; kind: "click"; x: number; y: number; button?: "left" | "right"; double?: boolean }
  | { seq: number; kind: "move"; x: number; y: number }
  | { seq: number; kind: "scroll"; x: number; y: number; deltaY: number }
  | { seq: number; kind: "type"; text: string }
  | { seq: number; kind: "press"; key: string }
) & { takeover?: number };

declare global {
  var __jlTakeoverSteps: Set<string> | undefined;
  var __jlCurrentStepId: string | null | undefined;
  var __jlSecretUsed: boolean | undefined;
}

// Called when a step receives a secret (test-helpers params()). From then on no frame of the page
// leaves the runner: a secret typed into a plain text field would be readable in the pixels.
export function markSecretUsed(): void {
  globalThis.__jlSecretUsed = true;
}

export function secretUsed(): boolean {
  return globalThis.__jlSecretUsed === true;
}

export const FRAMES_HIDDEN_MARKER = "frames-hidden";

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
    return {
      live: parsed.live === true,
      takeover: parsed.takeover === true,
      ...(typeof parsed.epoch === "number" ? { epoch: parsed.epoch } : {})
    };
  } catch {
    return { live: false, takeover: false };
  }
}

// Lines already read from inputs.jsonl, per live directory (a new run starts at zero).
const inputOffsets = new Map<string, number>();
function readNewInputs(): InputEvent[] {
  const dir = liveDir();
  if (!dir) return [];
  const path = join(dir, "inputs.jsonl");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  const fresh = lines.slice(inputOffsets.get(dir) ?? 0);
  inputOffsets.set(dir, lines.length);
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

// Input of this take-over only: lines tagged with another epoch are left over from an earlier one.
export function belongsToTakeover(event: { takeover?: number }, epoch: number | undefined): boolean {
  return (event.takeover ?? null) === (epoch ?? null);
}

// Holds the run while a take-over is active, replaying the person's input into the page.
export async function waitWhileTakenOver(getPage: () => Page | null, pollMs = 200): Promise<void> {
  if (!liveDir()) return;
  const control = readControl();
  if (!control.takeover) return;
  const epoch = control.epoch;
  const stepId = globalThis.__jlCurrentStepId ?? null;
  if (stepId) takeoverSteps().add(stepId);
  writeStepLog({ type: "takeover", at: new Date().toISOString(), action: "start", stepId });
  const replayNewInputs = async () => {
    const page = getPage();
        for (const event of readNewInputs()) {
      if (!page || !belongsToTakeover(event, epoch)) continue;
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

export function stopLiveFrames(): void {
  if (frameTimer) clearInterval(frameTimer);
  frameTimer = null;
}

// Writes frame.jpg (atomically) every intervalMs while someone watches, until a secret was used.
export function startLiveFrames(getPage: () => Page | null, intervalMs = Number(process.env.JL_LIVE_FRAME_MS ?? 700)): void {
  const dir = liveDir();
  if (!dir || frameTimer) return;
  let busy = false;
    const hide = () => {
    // Once: the daemon tells the backend, which serves a placeholder from then on.
    if (existsSync(join(dir, FRAMES_HIDDEN_MARKER))) return;
    writeFileSync(join(dir, FRAMES_HIDDEN_MARKER), "secret-entered");
    rmSync(join(dir, "frame.jpg"), { force: true });
  };
  frameTimer = setInterval(() => {
    if (secretUsed()) {
      hide();
      return;
    }
    if (busy || !readControl().live) return;
    const page = getPage();
    if (!page || page.isClosed()) return;
    busy = true;
    page
      .screenshot({ type: "jpeg", quality: 45, scale: "css", timeout: 2000 })
            .then((bytes) => {
        // A capture that overlapped the secret entry is dropped.
        if (secretUsed()) {
          hide();
          return;
        }
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
