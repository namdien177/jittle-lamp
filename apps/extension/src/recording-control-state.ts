import type { CapturePhase, PopupState, RecordingOperation } from "@jittle-lamp/shared";

export type RecordingControlView = Readonly<{
  visible: boolean;
  disabled: boolean;
  loading: boolean;
  label: string;
}>;

export type RecordingControlState = Readonly<{
  busy: boolean;
  start: RecordingControlView;
  finish: RecordingControlView;
  pause: RecordingControlView & Readonly<{ mode: "pause" | "resume" }>;
  abort: RecordingControlView;
}>;

export function deriveRecordingControlState(
  state: PopupState | null,
  localOperation: RecordingOperation | null
): RecordingControlState {
  const phase = state?.activeSession?.phase;
  const operation = localOperation ?? state?.recordingOperation ?? operationFromPhase(phase);
  const busy = state === null || operation !== null;
  const isRecording = phase === "recording";
  const isPaused = phase === "paused";
  const canControlRecording = isRecording || isPaused;
  const isStarting = operation === "starting";
  const isStopping = operation === "stopping";
  const isPausing = operation === "pausing";
  const isResuming = operation === "resuming";
  const isAborting = operation === "aborting";
  const startVisible = state === null || isStarting || Boolean(state.canStart);
  const finishVisible = isStopping || canControlRecording;
  const pauseVisible = isPausing || isResuming || canControlRecording;
  const abortVisible = isAborting || canControlRecording;
  const pauseMode = isResuming || (!isPausing && isPaused) ? "resume" : "pause";

  return {
    busy,
    start: {
      visible: startVisible,
      disabled: !startVisible || busy || !state?.canStart,
      loading: state === null || isStarting,
      label: state === null ? "Checking…" : isStarting ? "Starting…" : "Start capture"
    },
    finish: {
      visible: finishVisible,
      disabled: !finishVisible || busy || !state?.canStop,
      loading: isStopping,
      label: isStopping ? "Saving…" : "Finish recording"
    },
    pause: {
      visible: pauseVisible,
      disabled: !pauseVisible || busy,
      loading: isPausing || isResuming,
      label: isPausing
        ? "Pausing…"
        : isResuming
          ? "Resuming…"
          : pauseMode === "resume"
            ? "Resume recording"
            : "Pause recording",
      mode: pauseMode
    },
    abort: {
      visible: abortVisible,
      disabled: !abortVisible || busy,
      loading: isAborting,
      label: isAborting ? "Discarding…" : "Abort recording"
    }
  };
}

function operationFromPhase(phase: CapturePhase | undefined): RecordingOperation | null {
  if (phase === "armed") {
    return "starting";
  }

  if (phase === "processing") {
    return "stopping";
  }

  return null;
}
