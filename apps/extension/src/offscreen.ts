import { z } from "zod/v4";
import { storePendingRecording, readPendingRecording, deletePendingRecording } from "./pending-recording";
import {
  offscreenRequestSchema,
  type OffscreenRequest,
  type OffscreenResponse,
  type SessionArchive
} from "@jittle-lamp/shared";

import {
  RecordingDurationClock,
  resolveRecordingDurationMs
} from "./recording-duration";
import {
  RecordingByteBudget,
  captureWithTimeout,
  getRecordingCapturePolicy
} from "./recording-capture-policy";

declare const __JITTLE_LAMP_API_ORIGIN__: string | undefined;
declare const __JITTLE_LAMP_WEB_ORIGIN__: string | undefined;

const companionServerOrigin = "http://127.0.0.1:48115";
const cloudApiOrigin = (
  typeof __JITTLE_LAMP_API_ORIGIN__ === "string"
    ? __JITTLE_LAMP_API_ORIGIN__.trim()
    : "https://jl-api.monthlyparty.com"
).replace(/\/+$/, "");
const cloudWebOrigin = (
  typeof __JITTLE_LAMP_WEB_ORIGIN__ === "string"
    ? __JITTLE_LAMP_WEB_ORIGIN__.trim()
    : "https://jittlelamp.dev"
).replace(/\/+$/, "");
const healthRequestTimeoutMs = 2_000;
const cloudControlRequestTimeoutMs = 15_000;
const artifactUploadTimeoutMs = 2 * 60 * 1_000;

type ChromeTabCaptureTrackConstraints = MediaTrackConstraints & {
  mandatory: {
    chromeMediaSource: "tab";
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
};

type ChromeDesktopCaptureTrackConstraints = MediaTrackConstraints & {
  mandatory: {
    chromeMediaSource: "desktop";
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
};

type CaptureTarget = "tab" | "desktop";

type ActiveRecorderState = {
  sessionId: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  stopPromise: Promise<Blob>;
  audioContext: AudioContext | null;
  durationClock: RecordingDurationClock;
  byteBudget: RecordingByteBudget;
};

type CompanionWriteResult =
  | {
      saved: true;
      destination: "companion";
      outputDir: string;
    }
  | {
      saved: false;
    };

type CloudWriteResult =
  | {
      saved: true;
      destination: "cloud";
      evidenceId: string;
      cloudUrl: string;
    }
  | {
      saved: false;
      error: string;
      evidenceId?: string;
    };

type CompanionHealthPayload = {
  ok?: boolean;
  origin?: string;
  outputDir?: string;
};

const cloudUploadStartSchema = z.object({
  evidenceId: z.string().min(1),
  uploadSessions: z.array(z.object({
    key: z.enum(["recording", "archive"]),
    uploadId: z.string().min(1),
    uploadUrl: z.url(),
    headers: z.object({ "content-type": z.string().min(1) })
  })).length(2).refine((sessions) => new Set(sessions.map((session) => session.key)).size === 2)
});
type CloudUploadStartPayload = z.infer<typeof cloudUploadStartSchema>;

type PendingCloudRetry = {
  sessionId: string;
  archive: SessionArchive;
  recordingBlob: Blob;
  jsonBlob: Blob;
  evidenceId?: string;
};

type VideoThumbnail = {
  base64: string;
  mimeType: string;
  durationMs: number | null;
};

type StopAndExportRequest = Extract<OffscreenRequest, { type: "jl/offscreen-stop-and-export" }>;

type RecorderStartOperation = {
  sessionId: string;
  promise: Promise<void>;
};

type RecorderStopOperation = {
  sessionId: string;
  promise: Promise<Blob>;
};

type StopAndExportOperation = {
  sessionId: string;
  promise: Promise<OffscreenResponse>;
  status: "pending" | "settled";
};

type StartRecorderInput = {
  sessionId: string;
  streamId?: string;
  captureTarget: CaptureTarget;
  captureAudio: boolean;
  playCapturedAudio: boolean;
};

const thumbnailMimeType = "image/jpeg";
const thumbnailWidth = 240;
const thumbnailHeight = 135;
const thumbnailCandidateSeconds = [2.5, 3, 4, 1, 0] as const;

let activeRecorderState: ActiveRecorderState | null = null;
let pendingCloudRetry: PendingCloudRetry | null = null;
let recoveryStorageWarning = "";
let recorderStartOperation: RecorderStartOperation | null = null;
let recorderStopOperation: RecorderStopOperation | null = null;
let completedRecording: { sessionId: string; blob: Blob; durationMs: number } | null = null;
let stopAndExportOperation: StopAndExportOperation | null = null;

chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse) => {
  const parsed = offscreenRequestSchema.safeParse(rawMessage);

  if (!parsed.success) {
    return false;
  }

  void handleRequest(parsed.data)
    .then((response) => sendResponse(response))
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: errorMessage(error) + recoveryStorageWarning
      });
    });

  return true;
});

async function handleRequest(
  request: OffscreenRequest
): Promise<OffscreenResponse> {
  switch (request.type) {
    case "jl/offscreen-start-recording":
      await startRecorder({
        sessionId: request.sessionId,
        captureTarget: request.captureTarget,
        captureAudio: request.captureAudio ?? (request.captureTarget === "tab"),
        playCapturedAudio: request.playTabAudio ?? false,
        ...(request.streamId ? { streamId: request.streamId } : {})
      });
      return { ok: true };

    case "jl/offscreen-stop-recording": {
      const recordingBlob = await stopRecorder(request.sessionId);
      return {
        ok: true,
        recordingBytes: recordingBlob.size
      };
    }

    case "jl/offscreen-stop-and-export":
      return stopAndExport(request);

    case "jl/offscreen-pause-recording":
      await pauseRecorder(request.sessionId);
      return { ok: true };

    case "jl/offscreen-resume-recording":
      await resumeRecorder(request.sessionId);
      return { ok: true };

    case "jl/offscreen-abort-recording":
      await stopRecorder(request.sessionId).catch(() => undefined);
      await deletePendingRecording(request.sessionId);
      pendingCloudRetry = null;
      return { ok: true };

    case "jl/offscreen-save-local": {
      const retry = pendingCloudRetry ?? await readPendingRecording(request.sessionId);
      if (!retry || retry.sessionId !== request.sessionId) {
        throw new Error("No saved recording is available for this session.");
      }
      await saveArtifactsLocally(retry);
      await deletePendingRecording(request.sessionId);
      pendingCloudRetry = null;
      return { ok: true, destination: "downloads", recordingBytes: retry.recordingBlob.size, eventBytes: retry.jsonBlob.size };
    }

    case "jl/offscreen-retry-cloud-upload": {
      const retry = pendingCloudRetry ?? await readPendingRecording(request.sessionId);

      if (!retry || retry.sessionId !== request.sessionId) {
        throw new Error("No retryable cloud upload is available for this session.");
      }

      const cloudUploadResult = await tryWriteArtifactsToCloud(
        retry.archive,
        retry.recordingBlob,
        retry.jsonBlob,
        request.cloudAuthToken,
        retry.evidenceId
      );

      if (!cloudUploadResult.saved) {
        pendingCloudRetry = {
          ...retry,
          ...(cloudUploadResult.evidenceId || retry.evidenceId
            ? { evidenceId: cloudUploadResult.evidenceId ?? retry.evidenceId }
            : {})
        };
        await retainPendingRecording(pendingCloudRetry);
        throw new Error(cloudUploadResult.error);
      }

      await deletePendingRecording(request.sessionId);
      pendingCloudRetry = null;
      return {
        ok: true,
        recordingBytes: retry.recordingBlob.size,
        eventBytes: retry.jsonBlob.size,
        destination: "cloud",
        cloudUrl: cloudUploadResult.cloudUrl
      };
    }
  }
}

function stopAndExport(request: StopAndExportRequest): Promise<OffscreenResponse> {
  const existingOperation = stopAndExportOperation;

  if (existingOperation) {
    if (existingOperation.sessionId === request.sessionId) {
      return existingOperation.promise;
    }

    return Promise.reject(new Error("Another recording session is already being finalized."));
  }

  const promise = performStopAndExport(request);
  const operation: StopAndExportOperation = {
    sessionId: request.sessionId,
    promise,
    status: "pending"
  };
  stopAndExportOperation = operation;
  void promise.then(
    () => {
      if (stopAndExportOperation === operation) {
        operation.status = "settled";
      }
    },
    () => {
      if (stopAndExportOperation === operation) {
        operation.status = "settled";
      }
    }
  );

  return promise;
}

async function performStopAndExport(request: StopAndExportRequest): Promise<OffscreenResponse> {
  const recordingBlob = await stopRecorder(request.sessionId);
  const metadataDurationMs = await readVideoDurationMs(recordingBlob);
  const elapsedDurationMs = completedRecording?.sessionId === request.sessionId
    ? completedRecording.durationMs
    : null;
  const videoDurationMs = resolveRecordingDurationMs(metadataDurationMs, elapsedDurationMs);
  const finalized = finalizeArchiveForExport(
    request.archive,
    recordingBlob.size,
    recordingBlob.type || "video/webm",
    videoDurationMs
  );

  await retainPendingRecording({
    sessionId: request.sessionId,
    archive: finalized.archive,
    recordingBlob,
    jsonBlob: finalized.jsonBlob
  });

  const cloudUploadResult = await tryWriteArtifactsToCloud(
    finalized.archive,
    recordingBlob,
    finalized.jsonBlob,
    request.cloudAuthToken
  );

  if (request.cloudRequired && !request.cloudAuthToken) {
    throw new Error("Sign in to retry the upload, or save the recording locally.");
  }

  if (!cloudUploadResult.saved && (request.cloudAuthToken || request.cloudRequired)) {
    pendingCloudRetry = {
      sessionId: request.sessionId,
      archive: finalized.archive,
      recordingBlob,
      jsonBlob: finalized.jsonBlob,
      ...(cloudUploadResult.evidenceId ? { evidenceId: cloudUploadResult.evidenceId } : {})
    };
    await retainPendingRecording(pendingCloudRetry);
    throw new Error(cloudUploadResult.error + " Retry upload or save locally.");
  }

  const companionResult = cloudUploadResult.saved
    ? cloudUploadResult
    : await tryWriteArtifactsToCompanion(
        finalized.archive,
        recordingBlob,
        finalized.jsonBlob
      );

  if (!companionResult.saved) {
    await saveArtifactsLocally(pendingCloudRetry!);
  }

  await deletePendingRecording(request.sessionId);
  pendingCloudRetry = null;

  return {
    ok: true,
    recordingBytes: recordingBlob.size,
    eventBytes: finalized.jsonBlob.size,
    destination: companionResult.saved ? companionResult.destination : "downloads",
    ...(companionResult.saved && companionResult.destination === "cloud" ? { cloudUrl: companionResult.cloudUrl } : {}),
    ...(companionResult.saved && companionResult.destination === "companion" ? { outputDir: companionResult.outputDir } : {})
  };
}

async function tryWriteArtifactsToCloud(
  archive: SessionArchive,
  recordingBlob: Blob,
  jsonBlob: Blob,
  authToken?: string,
  replaceEvidenceId?: string
): Promise<CloudWriteResult> {
  if (!authToken) {
    return { saved: false, error: "Cloud upload skipped because no extension auth token was available." };
  }

  if (recordingBlob.size > 60 * 1024 * 1024 || jsonBlob.size > 100 * 1024 * 1024) {
    return { saved: false, error: "This recording is too large for cloud upload. Save it locally to keep the video and session archive." };
  }

  let startedEvidenceId: string | undefined;

  try {
    const [recordingChecksum, archiveChecksum, thumbnail] = await Promise.all([
      sha256Blob(recordingBlob),
      sha256Blob(jsonBlob),
      createVideoThumbnail(recordingBlob)
    ]);

    const startResponse = await fetchCloud("Cloud upload start", `${cloudApiOrigin}/evidences/desktop-sessions/sync/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: archive.sessionId,
        title: archive.name,
        sourceMetadata: JSON.stringify({
          source: "extension",
          sessionId: archive.sessionId,
          durationMs: archive.summary.videoDurationMs,
          actionCount: archive.summary.actionCount,
          requestCount: archive.summary.requestCount
        }),
        ...(replaceEvidenceId ? { replaceEvidenceId } : {}),
        ...(thumbnail
          ? {
              thumbnailBase64: thumbnail.base64,
              thumbnailMimeType: thumbnail.mimeType
            }
          : {}),
        artifacts: [
          { key: "recording", kind: "recording", mimeType: "video/webm", bytes: recordingBlob.size, checksum: recordingChecksum },
          { key: "archive", kind: "network-log", mimeType: "application/json", bytes: jsonBlob.size, checksum: archiveChecksum }
        ]
      })
    });

    if (!startResponse.ok) {
      return { saved: false, error: await responseErrorSummary(startResponse, "Cloud upload start failed") };
    }

    const payload = cloudUploadStartSchema.parse(await startResponse.json());
    startedEvidenceId = payload.evidenceId;

    const uploadErrors = await Promise.all(
      payload.uploadSessions.map((session) => uploadCloudArtifactSession({
        session,
        authToken,
        recordingBlob,
        jsonBlob,
        recordingChecksum,
        archiveChecksum
      }))
    );
    const uploadError = uploadErrors.find((error): error is string => typeof error === "string");

    if (uploadError) {
      return {
        saved: false,
        error: uploadError,
        evidenceId: payload.evidenceId
      };
    }

    return {
      saved: true,
      destination: "cloud",
      evidenceId: payload.evidenceId,
      cloudUrl: `${cloudWebOrigin}/evidence/${encodeURIComponent(payload.evidenceId)}`
    };
  } catch (error: unknown) {
    return {
      saved: false,
      error: errorMessage(error),
      ...(startedEvidenceId ? { evidenceId: startedEvidenceId } : {})
    };
  }
}

async function uploadCloudArtifactSession(input: {
  session: CloudUploadStartPayload["uploadSessions"][number];
  authToken: string;
  recordingBlob: Blob;
  jsonBlob: Blob;
  recordingChecksum: string;
  archiveChecksum: string;
}): Promise<string | null> {
  const { session, authToken, recordingBlob, jsonBlob, recordingChecksum, archiveChecksum } = input;
  const blob = session.key === "recording" ? recordingBlob : jsonBlob;
  const checksum = session.key === "recording" ? recordingChecksum : archiveChecksum;

  try {
    const putResponse = await fetchCloud(
      `Cloud artifact upload (${session.key})`,
      normalizeCloudUploadUrl(session.uploadUrl),
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": session.headers["content-type"]
        },
        body: blob
      },
      artifactUploadTimeoutMs
    );

    if (!putResponse.ok) {
      return await responseErrorSummary(putResponse, "Cloud artifact upload failed");
    }

    const completeResponse = await fetchCloud(
      `Cloud artifact completion (${session.key})`,
      `${cloudApiOrigin}/evidences/uploads/${encodeURIComponent(session.uploadId)}/complete`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          bytes: blob.size,
          checksum,
          mimeType: session.headers["content-type"]
        })
      }
    );

    if (!completeResponse.ok) {
      return await responseErrorSummary(completeResponse, "Cloud artifact completion failed");
    }

    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

async function fetchCloud(
  label: string,
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = cloudControlRequestTimeoutMs
): Promise<Response> {
  return fetchWithTimeout(label, input, init, timeoutMs);
}

function normalizeCloudUploadUrl(uploadUrl: string): string {
  try {
    const url = new URL(uploadUrl);
    const cloudOrigin = new URL(cloudApiOrigin);

    if (url.protocol === "http:" && url.host === cloudOrigin.host && cloudOrigin.protocol === "https:") {
      url.protocol = "https:";
      return url.toString();
    }
  } catch {
    return uploadUrl;
  }

  return uploadUrl;
}

async function responseErrorSummary(response: Response, label: string): Promise<string> {
  const status = `HTTP ${response.status}`;

  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      const text = (await response.text()).trim();
      return text ? `${label} with ${status}: ${text.slice(0, 240)}` : `${label} with ${status}.`;
    }

    const payload = (await response.json()) as {
      error?: {
        code?: unknown;
        message?: unknown;
      };
      message?: unknown;
    };
    const code = typeof payload.error?.code === "string" ? payload.error.code : undefined;
    const message =
      typeof payload.error?.message === "string"
        ? payload.error.message
        : typeof payload.message === "string"
          ? payload.message
          : undefined;

    if (code && message) {
      return `${label} with ${status} (${code}): ${message}`;
    }

    if (message) {
      return `${label} with ${status}: ${message}`;
    }

    return `${label} with ${status}.`;
  } catch {
    return `${label} with ${status}.`;
  }
}

async function fetchWithTimeout(
  label: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init?.signal;
  let timedOut = false;
  const abortFromExternalSignal = (): void => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal?.aborted) {
    abortFromExternalSignal();
  } else {
    externalSignal?.addEventListener("abort", abortFromExternalSignal, { once: true });
  }

  const timeoutId = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error: unknown) {
    if (timedOut) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1_000)} seconds.`);
    }

    throw new Error(`${label} failed: ${errorMessage(error)}`);
  } finally {
    globalThis.clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternalSignal);
  }
}

async function sha256Blob(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function createVideoThumbnail(recording: Blob): Promise<VideoThumbnail | null> {
  const url = URL.createObjectURL(recording);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
      };
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Video metadata could not be loaded."));
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
    });

    const canvas = document.createElement("canvas");
    canvas.width = thumbnailWidth;
    canvas.height = thumbnailHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;

    const duration = mediaDuration(video);
    let drewFrame = false;

    for (const candidate of thumbnailCandidateSeconds) {
      const targetTime = clampThumbnailTime(candidate, duration);
      await seekVideoFrame(video, targetTime);
      drawVideoThumbnailFrame(video, context);
      drewFrame = true;

      if (!isMostlyBlackFrame(context)) {
        break;
      }
    }

    if (!drewFrame) return null;

    const dataUrl = canvas.toDataURL(thumbnailMimeType, 0.72);
    return {
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mimeType: thumbnailMimeType,
      durationMs: duration > 0 ? Math.round(duration * 1000) : null
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function readVideoDurationMs(recording: Blob): Promise<number | null> {
  const url = URL.createObjectURL(recording);
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
        video.removeEventListener("error", onError);
      };
      const onLoadedMetadata = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error("Video metadata could not be loaded."));
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata, { once: true });
      video.addEventListener("error", onError, { once: true });
      video.src = url;
    });

    const duration = mediaDuration(video);
    return duration > 0 ? Math.round(duration * 1000) : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function seekVideoFrame(video: HTMLVideoElement, targetTime: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve();
    }, 2500);
    const cleanup = (): void => {
      window.clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = (): void => {
      cleanup();
      waitForDecodedVideoFrame(video).then(resolve, reject);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Video thumbnail seek failed."));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });

    if (Math.abs(video.currentTime - targetTime) < 0.05) {
      onSeeked();
      return;
    }

    video.currentTime = targetTime;
  });
}

async function waitForDecodedVideoFrame(video: HTMLVideoElement): Promise<void> {
  const requestVideoFrameCallback = video.requestVideoFrameCallback?.bind(video);

  if (!requestVideoFrameCallback) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(resolve, 300);
    requestVideoFrameCallback(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

function mediaDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  if (video.seekable.length > 0) {
    const seekableEnd = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(seekableEnd) && seekableEnd > 0) {
      return seekableEnd;
    }
  }

  return 0;
}

function clampThumbnailTime(seconds: number, duration: number): number {
  if (duration <= 0) {
    return seconds;
  }

  return Math.max(0, Math.min(seconds, Math.max(0, duration - 0.25)));
}

function drawVideoThumbnailFrame(video: HTMLVideoElement, context: CanvasRenderingContext2D): void {
  const sourceWidth = video.videoWidth || thumbnailWidth;
  const sourceHeight = video.videoHeight || thumbnailHeight;
  const scale = Math.max(thumbnailWidth / sourceWidth, thumbnailHeight / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(
    video,
    (thumbnailWidth - drawWidth) / 2,
    (thumbnailHeight - drawHeight) / 2,
    drawWidth,
    drawHeight
  );
}

function isMostlyBlackFrame(context: CanvasRenderingContext2D): boolean {
  const sample = context.getImageData(0, 0, thumbnailWidth, thumbnailHeight).data;
  let brightPixels = 0;
  const pixelCount = sample.length / 4;

  for (let index = 0; index < sample.length; index += 16) {
    const brightness = sample[index]! + sample[index + 1]! + sample[index + 2]!;
    if (brightness > 48) {
      brightPixels += 1;
    }
  }

  return brightPixels / Math.max(1, pixelCount / 4) < 0.015;
}

async function tryWriteArtifactsToCompanion(
  archive: SessionArchive,
  recordingBlob: Blob,
  jsonBlob: Blob
): Promise<CompanionWriteResult> {
  try {
    const healthResponse = await fetchWithTimeout(
      "Companion health check",
      `${companionServerOrigin}/health`,
      undefined,
      healthRequestTimeoutMs
    );

    if (!healthResponse.ok) {
      return { saved: false };
    }

    const companionHealth = await readCompanionHealth(healthResponse);

    await Promise.all([
      uploadArtifactToCompanion(archive.sessionId, "recording.webm", recordingBlob, "video/webm"),
      uploadArtifactToCompanion(archive.sessionId, "session.archive.json", jsonBlob, "application/json")
    ]);

    return {
      saved: true,
      destination: "companion",
      outputDir: companionHealth.outputDir
    };
  } catch {
    return { saved: false };
  }
}

async function readCompanionHealth(response: Response): Promise<{ outputDir: string }> {
  const payload = (await response.json()) as CompanionHealthPayload;

  if (typeof payload.outputDir !== "string" || payload.outputDir.trim().length === 0) {
    throw new Error("Companion health response did not include a writable output directory.");
  }

  return {
    outputDir: payload.outputDir
  };
}

async function uploadArtifactToCompanion(
  sessionId: string,
  artifactName: "recording.webm" | "session.archive.json",
  blob: Blob,
  contentType: string
): Promise<void> {
  const response = await fetchWithTimeout(
    `Companion artifact upload (${artifactName})`,
    `${companionServerOrigin}/api/sessions/${encodeURIComponent(sessionId)}/${artifactName}`,
    {
      method: "PUT",
      headers: {
        "content-type": contentType
      },
      body: blob
    },
    artifactUploadTimeoutMs
  );

  if (!response.ok) {
    throw new Error(`Companion server rejected ${artifactName} with ${response.status}.`);
  }
}

function startRecorder(input: StartRecorderInput): Promise<void> {
  const { sessionId } = input;

  if (recorderStopOperation) {
    return Promise.reject(new Error("The offscreen recording is already stopping."));
  }

  if (recorderStartOperation) {
    return recorderStartOperation.sessionId === sessionId
      ? recorderStartOperation.promise
      : Promise.reject(new Error("Another offscreen recording is already starting."));
  }

  if (activeRecorderState) {
    return activeRecorderState.sessionId === sessionId
      ? Promise.resolve()
      : Promise.reject(new Error("An offscreen recording is already active."));
  }

  try {
    prepareForRecorderStart(sessionId);
  } catch (error: unknown) {
    return Promise.reject(error);
  }

  const promise = performStartRecorder(input);
  const operation: RecorderStartOperation = { sessionId, promise };
  recorderStartOperation = operation;
  void promise.then(
    () => {
      if (recorderStartOperation === operation) {
        recorderStartOperation = null;
      }
    },
    () => {
      if (recorderStartOperation === operation) {
        recorderStartOperation = null;
      }
    }
  );

  return promise;
}

function prepareForRecorderStart(sessionId: string): void {
  const exportOperation = stopAndExportOperation;

  if (exportOperation?.status === "pending") {
    throw new Error("The previous offscreen recording is still being finalized.");
  }

  if (exportOperation?.sessionId === sessionId || completedRecording?.sessionId === sessionId) {
    throw new Error("This offscreen recording session has already stopped.");
  }

  if (exportOperation) {
    stopAndExportOperation = null;
  }

  if (completedRecording) {
    completedRecording = null;
  }

  if (pendingCloudRetry?.sessionId !== sessionId) {
    pendingCloudRetry = null;
  }
}

async function performStartRecorder(input: StartRecorderInput): Promise<void> {
  const { sessionId, streamId, captureTarget, captureAudio, playCapturedAudio } = input;
  const capturePolicy = getRecordingCapturePolicy(captureTarget, captureAudio);
  const stream = await getRecorderMediaStream({
    captureTarget,
    captureAudio,
    ...(streamId ? { streamId } : {})
  });
  let audioContext: AudioContext | null = null;

  try {
    audioContext = playCapturedAudio ? keepCapturedAudioAudible(stream) : null;
    const mimeType = preferredMimeType();
    const chunks: Blob[] = [];
    let resolveStop: ((blob: Blob) => void) | null = null;
    let rejectStop: ((error: Error) => void) | null = null;
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      ...capturePolicy.recorderOptions
    });
    const byteBudget = new RecordingByteBudget({
      warningBytes: capturePolicy.warningRecordingBytes,
      maxBytes: capturePolicy.maxRecordingBytes
    });
    const stopPromise = new Promise<Blob>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size <= 0) {
        return;
      }

      const budgetResult = byteBudget.observeChunk(event.data.size);
      if (budgetResult.accept) {
        chunks.push(event.data);
      }

      if (budgetResult.warningReached) {
        console.warn("[jittle-lamp] Recording is approaching the safe upload size.", {
          sessionId,
          recordingBytes: budgetResult.totalBytes,
          maxRecordingBytes: capturePolicy.maxRecordingBytes
        });
      }

      if (budgetResult.limitReached) {
        void notifyRecordingLimitReached(sessionId, budgetResult.totalBytes);
      }
    });

    recorder.addEventListener("stop", () => {
      resolveStop?.(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
    });

    recorder.addEventListener("error", (event) => {
      const message = event.error?.message || "MediaRecorder failed in the offscreen document.";
      rejectStop?.(new Error(message));
    });

    recorder.start(1000);
    activeRecorderState = {
      sessionId,
      stream,
      recorder,
      chunks,
      stopPromise,
      audioContext,
      durationClock: new RecordingDurationClock(),
      byteBudget
    };
  } catch (error: unknown) {
    stream.getTracks().forEach((track) => track.stop());
    void audioContext?.close().catch(() => undefined);
    throw error;
  }
}

function stopRecorder(sessionId: string): Promise<Blob> {
  if (recorderStopOperation) {
    return recorderStopOperation.sessionId === sessionId
      ? recorderStopOperation.promise
      : Promise.reject(new Error("Another offscreen recording is already stopping."));
  }

  if (completedRecording?.sessionId === sessionId) {
    return Promise.resolve(completedRecording.blob);
  }

  const startOperation = recorderStartOperation;
  if (startOperation && startOperation.sessionId !== sessionId) {
    return Promise.reject(new Error("Another offscreen recording is already starting."));
  }

  if (activeRecorderState && activeRecorderState.sessionId !== sessionId) {
    return Promise.reject(new Error("Another offscreen recording is active."));
  }

  const promise = performStopRecorder(sessionId, startOperation);
  const operation: RecorderStopOperation = { sessionId, promise };
  recorderStopOperation = operation;
  void promise.then(
    () => {
      if (recorderStopOperation === operation) {
        recorderStopOperation = null;
      }
    },
    () => {
      if (recorderStopOperation === operation) {
        recorderStopOperation = null;
      }
    }
  );

  return promise;
}

async function performStopRecorder(
  sessionId: string,
  startOperation: RecorderStartOperation | null
): Promise<Blob> {
  if (startOperation) {
    await startOperation.promise;
  }

  const recorderState = activeRecorderState;
  if (!recorderState || recorderState.sessionId !== sessionId) {
    throw new Error("No matching offscreen recording session is active.");
  }

  activeRecorderState = null;

  try {
    const durationMs = recorderState.durationClock.elapsedMs();
    if (recorderState.recorder.state !== "inactive") {
      recorderState.recorder.stop();
    }

    const blob = await recorderState.stopPromise;
    completedRecording = { sessionId, blob, durationMs };
    return blob;
  } finally {
    recorderState.stream.getTracks().forEach((track) => track.stop());
    void recorderState.audioContext?.close().catch(() => undefined);
  }
}

async function pauseRecorder(sessionId: string): Promise<void> {
  const recorderState = activeRecorderState;

  if (!recorderState || recorderState.sessionId !== sessionId) {
    throw new Error("No matching offscreen recording session is active.");
  }

  if (recorderState.recorder.state === "recording") {
    recorderState.recorder.pause();
    recorderState.durationClock.pause();
  }

  await recorderState.audioContext?.suspend().catch(() => undefined);
}

async function resumeRecorder(sessionId: string): Promise<void> {
  const recorderState = activeRecorderState;

  if (!recorderState || recorderState.sessionId !== sessionId) {
    throw new Error("No matching offscreen recording session is active.");
  }

  if (recorderState.recorder.state === "paused") {
    recorderState.recorder.resume();
    recorderState.durationClock.resume();
  }

  await recorderState.audioContext?.resume().catch(() => undefined);
}

function preferredMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8",
    "video/webm"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

async function getRecorderMediaStream(input: {
  captureTarget: CaptureTarget;
  streamId?: string;
  captureAudio: boolean;
}): Promise<MediaStream> {
  if (input.captureTarget === "desktop") {
    try {
      const policy = getRecordingCapturePolicy(input.captureTarget, input.captureAudio);
      const capturePromise = navigator.mediaDevices.getDisplayMedia({
        video: policy.videoConstraints ?? true,
        audio: input.captureAudio
      });

      return await captureWithTimeout(capturePromise, policy.pickerTimeoutMs ?? 60_000);
    } catch (error: unknown) {
      throw new Error(desktopCaptureErrorMessage(error));
    }
  }

  if (!input.streamId) {
    throw new Error("Tab capture stream identifier is required.");
  }

  return navigator.mediaDevices.getUserMedia(buildCaptureConstraints({
    captureTarget: input.captureTarget,
    streamId: input.streamId,
    captureAudio: input.captureAudio
  }));
}

async function notifyRecordingLimitReached(sessionId: string, recordingBytes: number): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: "jl/offscreen-recording-limit-reached",
      sessionId,
      reason: "size",
      recordingBytes
    });
  } catch (error: unknown) {
    console.error("[jittle-lamp] Could not stop the recording at the safe upload size.", {
      sessionId,
      error: errorMessage(error)
    });
  }
}

function desktopCaptureErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "Desktop capture was not allowed. Choose a screen or window in the browser sharing prompt to start recording.";
    }

    if (error.name === "NotReadableError") {
      return "Desktop capture could not start. On macOS, remove and re-add this browser in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the browser.";
    }
  }

  return errorMessage(error);
}

function buildCaptureConstraints(input: {
  captureTarget: CaptureTarget;
  streamId: string;
  captureAudio: boolean;
}): MediaStreamConstraints {
  const chromeMediaSource = input.captureTarget;
  const videoConstraints = {
    mandatory: {
      chromeMediaSource,
      chromeMediaSourceId: input.streamId,
      maxFrameRate: 30
    }
  } as ChromeTabCaptureTrackConstraints | ChromeDesktopCaptureTrackConstraints;

  if (!input.captureAudio) {
    return {
      video: videoConstraints,
      audio: false
    };
  }

  return {
    video: videoConstraints,
    audio: {
      mandatory: {
        chromeMediaSource,
        chromeMediaSourceId: input.streamId
      }
    } as ChromeTabCaptureTrackConstraints | ChromeDesktopCaptureTrackConstraints
  };
}

function keepCapturedAudioAudible(stream: MediaStream): AudioContext | null {
  if (stream.getAudioTracks().length === 0) {
    return null;
  }

  try {
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);
    void audioContext.resume().catch(() => undefined);
    return audioContext;
  } catch {
    return null;
  }
}

function finalizeArchiveForExport(
  archive: SessionArchive,
  recordingBytes: number,
  recordingMimeType: string,
  videoDurationMs: number | null
): { archive: SessionArchive; jsonBlob: Blob } {
  let nextArchive = withRecordingArtifact(archive, {
    bytes: recordingBytes,
    mimeType: recordingMimeType || "video/webm"
  });
  nextArchive = withArchiveSummary(nextArchive, videoDurationMs);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    const jsonText = stringifyArchive(nextArchive);
    const jsonBlob = new Blob([jsonText], { type: "application/json" });
    const updatedArchive = withArtifactBytes(nextArchive, "session.archive.json", jsonBlob.size);

    if (artifactBytes(updatedArchive, "session.archive.json") === artifactBytes(nextArchive, "session.archive.json")) {
      return {
        archive: updatedArchive,
        jsonBlob: new Blob([stringifyArchive(updatedArchive)], { type: "application/json" })
      };
    }

    nextArchive = updatedArchive;
  }

  return {
    archive: nextArchive,
    jsonBlob: new Blob([stringifyArchive(nextArchive)], { type: "application/json" })
  };
}

function withArchiveSummary(archive: SessionArchive, videoDurationMs: number | null): SessionArchive {
  const actionCount = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction").length;
  return {
    ...archive,
    summary: {
      videoDurationMs: videoDurationMs ?? archive.summary.videoDurationMs,
      actionCount,
      requestCount: archive.sections.network.length
    }
  };
}

function withArtifactBytes(
  archive: SessionArchive,
  kind: "recording.webm" | "session.archive.json",
  bytes: number
): SessionArchive {
  return {
    ...archive,
    artifacts: archive.artifacts.map((artifact) => {
      if (artifact.kind !== kind) {
        return artifact;
      }

      return {
        ...artifact,
        bytes
      };
    })
  };
}

function withRecordingArtifact(
  archive: SessionArchive,
  input: { bytes: number; mimeType: string }
): SessionArchive {
  return {
    ...archive,
    artifacts: archive.artifacts.map((artifact) => {
      if (artifact.kind !== "recording.webm") {
        return artifact;
      }

      return {
        ...artifact,
        bytes: input.bytes,
        mimeType: input.mimeType
      };
    })
  };
}

function artifactBytes(
  archive: SessionArchive,
  kind: "recording.webm" | "session.archive.json"
): number | undefined {
  return archive.artifacts.find((artifact) => artifact.kind === kind)?.bytes;
}

function artifactPath(
  archive: SessionArchive,
  kind: "recording.webm" | "session.archive.json"
): string {
  const artifact = archive.artifacts.find((entry) => entry.kind === kind);

  if (artifact) {
    return artifact.relativePath;
  }

  return `${archive.sessionId}/${kind}`;
}

function stringifyArchive(archive: SessionArchive): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

async function retainPendingRecording(recording: PendingCloudRetry): Promise<void> {
  pendingCloudRetry = recording;
  try {
    await storePendingRecording(recording);
    recoveryStorageWarning = "";
  } catch (error) {
    recoveryStorageWarning = " Keep this browser open and save locally now; there was not enough storage to retain a recovery copy.";
    // Keep the in-memory copy usable even if disk quota is exhausted.
    console.warn("Could not persist recording recovery data. Keep the browser open until saved.", error);
  }
}

async function saveArtifactsLocally(recording: PendingCloudRetry): Promise<void> {
  // Sequential prompts avoid competing Save As dialogs. Retain both blobs on cancellation.
  await downloadBlob(recording.recordingBlob, artifactPath(recording.archive, "recording.webm"), "video/webm");
  await downloadBlob(recording.jsonBlob, artifactPath(recording.archive, "session.archive.json"), "application/json");
}

async function downloadBlob(blob: Blob, filename: string, mimeType: string): Promise<void> {
  const url = URL.createObjectURL(blob.type === mimeType ? blob : new Blob([blob], { type: mimeType }));
  try {
    const response = await chrome.runtime.sendMessage({ type: "jl/download-artifact", url, filename });
    if (!response?.ok) throw new Error(response?.error ?? "Local save was not confirmed. Try Save locally again.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
