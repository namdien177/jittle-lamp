import { describe, expect, test } from "bun:test";

import { RecordingLifecycle } from "../apps/extension/src/recording-lifecycle";

describe("recording lifecycle single flight", () => {
  test("claims synchronously and joins the active operation", async () => {
    const lifecycle = new RecordingLifecycle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runCount = 0;
    const task = async (): Promise<string> => {
      runCount += 1;
      await gate;
      return "finished";
    };

    const first = lifecycle.run("stopping", task);
    const second = lifecycle.run("stopping", task);

    expect(lifecycle.current()).toBe("stopping");
    expect(lifecycle.blocksCaptureIntake()).toBeTrue();
    expect(second).toBe(first);
    expect(runCount).toBe(0);

    release();

    expect(await first).toBe("finished");
    expect(runCount).toBe(1);
    expect(lifecycle.current()).toBeNull();
    expect(lifecycle.blocksCaptureIntake()).toBeFalse();
  });

  test("rejects a conflicting operation without running its task", async () => {
    const lifecycle = new RecordingLifecycle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = lifecycle.run("stopping", () => gate);
    let conflictingRunCount = 0;

    const conflicting = lifecycle.run("aborting", () => {
      conflictingRunCount += 1;
    });

    expect(lifecycle.current()).toBe("stopping");
    await expect(conflicting).rejects.toThrow(
      'Cannot start recording operation "aborting" while "stopping" is active.'
    );
    expect(conflictingRunCount).toBe(0);

    release();
    await active;
  });

  test("releases the operation after its task rejects", async () => {
    const lifecycle = new RecordingLifecycle();
    const taskError = new Error("stop failed");

    await expect(
      lifecycle.run("stopping", () => {
        throw taskError;
      })
    ).rejects.toBe(taskError);

    expect(lifecycle.current()).toBeNull();
    expect(lifecycle.blocksCaptureIntake()).toBeFalse();
    expect(await lifecycle.run("aborting", () => "aborted")).toBe("aborted");
  });

  test("does not let a reset task release a newer operation", async () => {
    const lifecycle = new RecordingLifecycle();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldTask = lifecycle.run("stopping", () => oldGate);

    lifecycle.resetForTests();

    let releaseNew!: () => void;
    const newGate = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    const newTask = lifecycle.run("starting", () => newGate);

    releaseOld();
    await oldTask;

    expect(lifecycle.current()).toBe("starting");
    expect(lifecycle.blocksCaptureIntake()).toBeTrue();

    releaseNew();
    await newTask;

    expect(lifecycle.current()).toBeNull();
  });
});
