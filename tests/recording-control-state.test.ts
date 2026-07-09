import { describe, expect, test } from "bun:test";

import type { CapturePhase, PopupState, RecordingOperation } from "@jittle-lamp/shared";

import { deriveRecordingControlState } from "../apps/extension/src/recording-control-state";

describe("deriveRecordingControlState", () => {
  test("fails closed while the initial state is loading", () => {
    expect(deriveRecordingControlState(null, null)).toEqual({
      busy: true,
      start: {
        visible: true,
        disabled: true,
        loading: true,
        label: "Checking…"
      },
      finish: {
        visible: false,
        disabled: true,
        loading: false,
        label: "Finish recording"
      },
      pause: {
        visible: false,
        disabled: true,
        loading: false,
        label: "Pause recording",
        mode: "pause"
      },
      abort: {
        visible: false,
        disabled: true,
        loading: false,
        label: "Abort recording"
      }
    });
  });

  test("enables only Start while idle", () => {
    const controls = deriveRecordingControlState(createPopupState(), null);

    expect(controls.busy).toBeFalse();
    expect(controls.start).toEqual({
      visible: true,
      disabled: false,
      loading: false,
      label: "Start capture"
    });
    expect(controls.finish.visible).toBeFalse();
    expect(controls.finish.disabled).toBeTrue();
    expect(controls.pause.visible).toBeFalse();
    expect(controls.abort.visible).toBeFalse();
  });

  test("shows a disabled Start loader as soon as starting is requested", () => {
    const controls = deriveRecordingControlState(createPopupState(), "starting");

    expect(controls.busy).toBeTrue();
    expect(controls.start).toEqual({
      visible: true,
      disabled: true,
      loading: true,
      label: "Starting…"
    });
  });

  test("keeps Finish visible and loading while the recording is stopping", () => {
    const controls = deriveRecordingControlState(createPopupState("recording"), "stopping");

    expect(controls.busy).toBeTrue();
    expect(controls.finish).toEqual({
      visible: true,
      disabled: true,
      loading: true,
      label: "Saving…"
    });
    expect(controls.pause.disabled).toBeTrue();
    expect(controls.abort.disabled).toBeTrue();
  });

  test("offers Finish, Resume, and Abort while paused", () => {
    const controls = deriveRecordingControlState(createPopupState("paused"), null);

    expect(controls.busy).toBeFalse();
    expect(controls.start.visible).toBeFalse();
    expect(controls.finish).toMatchObject({ visible: true, disabled: false, loading: false });
    expect(controls.pause).toEqual({
      visible: true,
      disabled: false,
      loading: false,
      label: "Resume recording",
      mode: "resume"
    });
    expect(controls.abort).toMatchObject({ visible: true, disabled: false, loading: false });
  });

  test("keeps global operations visible after a polling refresh", () => {
    expect(globalOperationControls("pausing", "recording").pause).toMatchObject({
      visible: true,
      disabled: true,
      loading: true,
      label: "Pausing…",
      mode: "pause"
    });
    expect(globalOperationControls("resuming", "paused").pause).toMatchObject({
      visible: true,
      disabled: true,
      loading: true,
      label: "Resuming…",
      mode: "resume"
    });
    expect(globalOperationControls("aborting", "recording").abort).toMatchObject({
      visible: true,
      disabled: true,
      loading: true,
      label: "Discarding…"
    });

    const retrying = globalOperationControls("retrying-upload", "failed");
    expect(retrying.busy).toBeTrue();
    expect(retrying.start).toMatchObject({ visible: true, disabled: true, loading: false });
  });

  test("uses persisted transitional phases when no operation field is available", () => {
    const starting = deriveRecordingControlState(createPopupState("armed"), null);
    const stopping = deriveRecordingControlState(createPopupState("processing"), null);

    expect(starting.start).toMatchObject({ visible: true, disabled: true, loading: true, label: "Starting…" });
    expect(stopping.finish).toMatchObject({ visible: true, disabled: true, loading: true, label: "Saving…" });
  });
});

function globalOperationControls(operation: RecordingOperation, phase: CapturePhase) {
  return deriveRecordingControlState(
    {
      ...createPopupState(phase),
      recordingOperation: operation
    },
    null
  );
}

function createPopupState(phase?: CapturePhase): PopupState {
  return {
    activeSession: phase
      ? {
          sessionId: "jl_test1234",
          name: "Example recording",
          phase,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          page: {
            title: "Example",
            url: "https://example.com"
          },
          artifacts: [],
          eventCount: 0
        }
      : null,
    companion: {
      status: "offline",
      origin: "http://127.0.0.1:48115",
      checkedAt: "2026-01-01T00:00:00.000Z"
    },
    cloud: {
      status: "signed-out",
      checkedAt: "2026-01-01T00:00:00.000Z"
    },
    recordingOperation: null,
    canStart: phase === undefined || phase === "ready" || phase === "failed",
    canStop: phase === "armed" || phase === "recording" || phase === "paused"
  };
}
