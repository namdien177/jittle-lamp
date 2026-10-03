import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "playwright-core";

import { takeoverSteps, waitWhileTakenOver } from "../src/runtime/live";

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
