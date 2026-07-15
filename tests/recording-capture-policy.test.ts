import { describe, expect, test } from "bun:test";

import {
  RecordingByteBudget,
  captureWithTimeout,
  getRecordingCapturePolicy
} from "../apps/extension/src/recording-capture-policy";

describe("recording capture policy", () => {
  test("uses a bounded desktop capture profile", () => {
    const policy = getRecordingCapturePolicy("desktop", true);

    expect(policy.maxDurationMs).toBe(2 * 60 * 1000);
    expect(policy.pickerTimeoutMs).toBe(60 * 1000);
    expect(policy.warningRecordingBytes).toBe(40 * 1024 * 1024);
    expect(policy.maxRecordingBytes).toBe(45 * 1024 * 1024);
    expect(policy.videoConstraints).toEqual({
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { max: 15 }
    });
    expect(policy.recorderOptions).toEqual({
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 64_000
    });
  });

  test("stops before accepting a chunk that would exceed the video budget", () => {
    const budget = new RecordingByteBudget({
      warningBytes: 40,
      maxBytes: 45
    });

    expect(budget.observeChunk(40)).toEqual({
      accept: true,
      totalBytes: 40,
      warningReached: true,
      limitReached: false
    });
    expect(budget.observeChunk(6)).toEqual({
      accept: false,
      totalBytes: 40,
      warningReached: false,
      limitReached: true
    });
  });

  test("fails a capture request when the desktop picker does not resolve", async () => {
    const pendingCapture = new Promise<MediaStream>(() => undefined);

    await expect(captureWithTimeout(pendingCapture, 5)).rejects.toThrow(
      "Screen selection timed out after 5 ms."
    );
  });

  test("stops a desktop stream that arrives after picker timeout", async () => {
    let resolveCapture: ((stream: MediaStream) => void) | undefined;
    const pendingCapture = new Promise<MediaStream>((resolve) => {
      resolveCapture = resolve;
    });
    let stopped = false;
    const lateStream = {
      getTracks: () => [{ stop: () => { stopped = true; } }]
    } as unknown as MediaStream;

    await captureWithTimeout(pendingCapture, 1).catch(() => undefined);
    resolveCapture?.(lateStream);
    await Promise.resolve();

    expect(stopped).toBeTrue();
  });
});
