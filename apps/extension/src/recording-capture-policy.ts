export type RecordingCaptureTarget = "tab" | "desktop";

export type RecordingCapturePolicy = Readonly<{
  maxDurationMs: number;
  pickerTimeoutMs: number | null;
  warningRecordingBytes: number;
  maxRecordingBytes: number;
  videoConstraints: MediaTrackConstraints | null;
  recorderOptions: Readonly<{
    videoBitsPerSecond?: number;
    audioBitsPerSecond?: number;
  }>;
}>;

export type RecordingByteBudgetResult = Readonly<{
  accept: boolean;
  totalBytes: number;
  warningReached: boolean;
  limitReached: boolean;
}>;

export class RecordingByteBudget {
  private totalBytes = 0;
  private warningReported = false;
  private stopped = false;

  constructor(private readonly limits: Readonly<{ warningBytes: number; maxBytes: number }>) {}

  observeChunk(chunkBytes: number): RecordingByteBudgetResult {
    if (this.stopped) {
      return {
        accept: false,
        totalBytes: this.totalBytes,
        warningReached: false,
        limitReached: false
      };
    }

    if (this.totalBytes + chunkBytes > this.limits.maxBytes) {
      this.stopped = true;
      return {
        accept: false,
        totalBytes: this.totalBytes,
        warningReached: false,
        limitReached: true
      };
    }

    this.totalBytes += chunkBytes;
    const warningReached = !this.warningReported && this.totalBytes >= this.limits.warningBytes;
    this.warningReported ||= warningReached;
    const limitReached = this.totalBytes >= this.limits.maxBytes;
    this.stopped ||= limitReached;

    return {
      accept: true,
      totalBytes: this.totalBytes,
      warningReached,
      limitReached
    };
  }
}

type StoppableCaptureStream = {
  getTracks(): ArrayLike<{ stop(): void }>;
};

export async function captureWithTimeout<Stream extends StoppableCaptureStream>(
  capturePromise: Promise<Stream>,
  timeoutMs: number
): Promise<Stream> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  void capturePromise.then((stream) => {
    if (!timedOut) {
      return;
    }

    for (const track of Array.from(stream.getTracks())) {
      track.stop();
    }
  }, () => undefined);
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Screen selection timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([capturePromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

const tabMaxDurationMs = 5 * 60 * 1000;
const desktopMaxDurationMs = 2 * 60 * 1000;
const desktopPickerTimeoutMs = 60 * 1000;
const warningRecordingBytes = 40 * 1024 * 1024;
const maxRecordingBytes = 45 * 1024 * 1024;

export function getRecordingCapturePolicy(
  target: RecordingCaptureTarget,
  captureAudio: boolean
): RecordingCapturePolicy {
  if (target === "desktop") {
    return {
      maxDurationMs: desktopMaxDurationMs,
      pickerTimeoutMs: desktopPickerTimeoutMs,
      warningRecordingBytes,
      maxRecordingBytes,
      videoConstraints: {
        width: { max: 1280 },
        height: { max: 720 },
        frameRate: { max: 15 }
      },
      recorderOptions: {
        videoBitsPerSecond: 1_000_000,
        ...(captureAudio ? { audioBitsPerSecond: 64_000 } : {})
      }
    };
  }

  return {
    maxDurationMs: tabMaxDurationMs,
    pickerTimeoutMs: null,
    warningRecordingBytes,
    maxRecordingBytes,
    videoConstraints: null,
    recorderOptions: {}
  };
}
