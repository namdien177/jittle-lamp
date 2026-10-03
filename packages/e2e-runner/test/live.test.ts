import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "playwright-core";

import {
  FRAMES_HIDDEN_MARKER,
  belongsToTakeover,
  markSecretUsed,
  startLiveFrames,
  stopLiveFrames,
  takeoverSteps,
  waitWhileTakenOver
} from "../src/runtime/live";

const saved = { liveDir: process.env.JL_LIVE_DIR, stepLog: process.env.JL_STEP_LOG };

afterEach(() => {
  for (const [key, value] of [["JL_LIVE_DIR", saved.liveDir], ["JL_STEP_LOG", saved.stepLog]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__jlCurrentStepId = null;
});

describe("waitWhileTakenOver", () => {
  test("input relayed together with the release is replayed and logged as take-over input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-live-unit-"));
    const stepLog = join(dir, "steps.jsonl");
    process.env.JL_LIVE_DIR = dir;
    process.env.JL_STEP_LOG = stepLog;
    globalThis.__jlCurrentStepId = "step-act";
    writeFileSync(join(dir, "control.json"), JSON.stringify({ live: true, takeover: true }));

    const dispatched: string[] = [];
    const page = {
      mouse: { move: async (x: number, y: number) => void dispatched.push(`move ${x},${y}`) },
      keyboard: { press: async (key: string) => void dispatched.push(`press ${key}`) }
    } as unknown as Page;

    const waiting = waitWhileTakenOver(() => page, 20);
    await Bun.sleep(60);
    // The daemon's relay writes the input and the released state in the same cycle.
    appendFileSync(join(dir, "inputs.jsonl"), `${JSON.stringify({ seq: 0, kind: "move", x: 5, y: 6 })}\n${JSON.stringify({ seq: 1, kind: "press", key: "Shift" })}\n`);
    writeFileSync(join(dir, "control.json"), JSON.stringify({ live: true, takeover: false }));
    await waiting;

    expect(dispatched).toEqual(["move 5,6", "press Shift"]);
    const events = readFileSync(stepLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.map((event) => [event.type, event.action ?? event.kind])).toEqual([
      ["takeover", "start"],
      ["takeover-input", "move"],
      ["takeover-input", "press"],
      ["takeover", "end"]
    ]);
    expect(events.every((event) => event.stepId === "step-act")).toBe(true);
    expect(takeoverSteps().has("step-act")).toBe(true);
  });
});

describe("take-over epochs", () => {
  test("input left over from an earlier take-over is not replayed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-live-epoch-"));
    process.env.JL_LIVE_DIR = dir;
    process.env.JL_STEP_LOG = join(dir, "steps.jsonl");
    globalThis.__jlCurrentStepId = "step-2";
    // Take-over 1 ended; a late line of it is still in the file when take-over 2 starts.
    appendFileSync(join(dir, "inputs.jsonl"), `${JSON.stringify({ seq: 7, kind: "press", key: "Delete", takeover: 1 })}\n`);
    writeFileSync(join(dir, "control.json"), JSON.stringify({ live: true, takeover: true, epoch: 2 }));
    const dispatched: string[] = [];
    const page = { keyboard: { press: async (key: string) => void dispatched.push(key) } } as unknown as Page;
    const waiting = waitWhileTakenOver(() => page, 20);
    await Bun.sleep(40);
    appendFileSync(join(dir, "inputs.jsonl"), `${JSON.stringify({ seq: 8, kind: "press", key: "Enter", takeover: 2 })}\n`);
    writeFileSync(join(dir, "control.json"), JSON.stringify({ live: true, takeover: false, epoch: 2 }));
    await waiting;
    expect(dispatched).toEqual(["Enter"]);
    expect(belongsToTakeover({ takeover: 2 }, 2)).toBe(true);
    expect(belongsToTakeover({ takeover: 1 }, 2)).toBe(false);
    // Relays without epochs (older daemons) still match.
    expect(belongsToTakeover({}, undefined)).toBe(true);
  });
});

describe("live frames after a secret", () => {
  test("no frame of the page leaves the runner once a secret was used", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-live-secret-"));
    process.env.JL_LIVE_DIR = dir;
    writeFileSync(join(dir, "control.json"), JSON.stringify({ live: true, takeover: false }));
    let screenshots = 0;
    const page = {
      isClosed: () => false,
      screenshot: async () => {
        screenshots += 1;
        return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      }
    } as unknown as Page;
    try {
      startLiveFrames(() => page, 10);
      await Bun.sleep(60);
      expect(screenshots).toBeGreaterThan(0);
      expect(existsSync(join(dir, "frame.jpg"))).toBe(true);
      markSecretUsed();
      await Bun.sleep(60);
      const taken = screenshots;
      await Bun.sleep(60);
      expect(screenshots).toBe(taken);
      expect(existsSync(join(dir, "frame.jpg"))).toBe(false);
      expect(readFileSync(join(dir, FRAMES_HIDDEN_MARKER), "utf8")).toBe("secret-entered");
    } finally {
      stopLiveFrames();
      globalThis.__jlSecretUsed = undefined;
    }
  });
});
