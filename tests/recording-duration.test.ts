import { describe, expect, test } from "bun:test";

import {
  RecordingDurationClock,
  resolveRecordingDurationMs
} from "../apps/extension/src/recording-duration";

describe("recording duration clock", () => {
  test("reports real elapsed recording time when WebM metadata has no duration", () => {
    let nowMs = 1_000;
    const clock = new RecordingDurationClock(() => nowMs);

    nowMs = 13_500;

    expect(clock.elapsedMs()).toBe(12_500);
  });

  test("excludes time spent paused", () => {
    let nowMs = 1_000;
    const clock = new RecordingDurationClock(() => nowMs);

    nowMs = 6_000;
    clock.pause();
    nowMs = 16_000;
    clock.resume();
    nowMs = 20_000;

    expect(clock.elapsedMs()).toBe(9_000);
  });

  test("uses the recorder clock when Chrome WebM metadata has no duration", () => {
    expect(resolveRecordingDurationMs(null, 12_500)).toBe(12_500);
    expect(resolveRecordingDurationMs(12_300, 12_500)).toBe(12_300);
  });
});
