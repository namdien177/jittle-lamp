import { offscreenRequestSchema, type SessionArchive } from "@jittle-lamp/shared";

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

type ChromeTabCaptureTrackConstraints = MediaTrackConstraints & {
  mandatory: {
    chromeMediaSource: "tab";
    chromeMediaSourceId: string;
    maxFrameRate?: number;
  };
};

type ActiveRecorderState = {
  sessionId: string;
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  stopPromise: Promise<Blob>;
  audioContext: AudioContext | null;
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

type CloudUploadStartPayload = {
  evidenceId: string;
  uploadSessions: Array<{
    key: "recording" | "archive";
    uploadId: string;
    uploadUrl: string;
    headers: { "content-type": string };
  }>;
};

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
};

const thumbnailMimeType = "image/jpeg";
const thumbnailWidth = 240;
const thumbnailHeight = 135;
const thumbnailSeekSeconds = 2.5;

let activeRecorderState: ActiveRecorderState | null = null;
let pendingCloudRetry: PendingCloudRetry | null = null;

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
        error: errorMessage(error)
      });
    });

  return true;
});

async function handleRequest(
  request: ReturnType<typeof offscreenRequestSchema.parse>
): Promise<{
  ok: boolean;
  recordingBytes?: number;
  eventBytes?: number;
  destination?: "cloud" | "companion" | "downloads";
  outputDir?: string;
  cloudUrl?: string;
  error?: string;
}> {
  switch (request.type) {
    case "jl/offscreen-start-recording":
      await startRecorder(request.sessionId, request.streamId);
      return { ok: true };

    case "jl/offscreen-stop-and-export": {
      const recordingBlob = await stopRecorder(request.sessionId);
      const finalized = finalizeArchiveForExport(request.archive, recordingBlob.size, recordingBlob.type || "video/webm");

      const cloudUploadResult = await tryWriteArtifactsToCloud(
        finalized.archive,
        recordingBlob,
        finalized.jsonBlob,
        request.cloudAuthToken
      );

      if (request.cloudRequired && !request.cloudAuthToken) {
        throw new Error("Cloud upload was required, but no extension auth token was available.");
      }

      if (!cloudUploadResult.saved && (request.cloudAuthToken || request.cloudRequired)) {
        pendingCloudRetry = {
          sessionId: request.sessionId,
          archive: finalized.archive,
          recordingBlob,
          jsonBlob: finalized.jsonBlob,
          ...(cloudUploadResult.evidenceId ? { evidenceId: cloudUploadResult.evidenceId } : {})
        };
        throw new Error(cloudUploadResult.error);
      }

      const companionResult = cloudUploadResult.saved
        ? cloudUploadResult
        : await tryWriteArtifactsToCompanion(
        finalized.archive,
        recordingBlob,
        finalized.jsonBlob
      );

      if (!companionResult.saved) {
        await Promise.all([
          downloadBlob(
            recordingBlob,
            artifactPath(finalized.archive, "recording.webm"),
            "video/webm"
          ),
          downloadBlob(
            finalized.jsonBlob,
            artifactPath(finalized.archive, "session.archive.json"),
            "application/json"
          )
        ]);
      }

      return {
        ok: true,
        recordingBytes: recordingBlob.size,
        eventBytes: finalized.jsonBlob.size,
        destination: companionResult.saved ? companionResult.destination : "downloads",
        ...(companionResult.saved && companionResult.destination === "cloud" ? { cloudUrl: companionResult.cloudUrl } : {}),
        ...(companionResult.saved && companionResult.destination === "companion" ? { outputDir: companionResult.outputDir } : {})
      };
    }

    case "jl/offscreen-retry-cloud-upload": {
      const retry = pendingCloudRetry;

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
        throw new Error(cloudUploadResult.error);
      }

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

  let startedEvidenceId: string | undefined;

  try {
    const meResponse = await fetchCloud("Cloud auth check", `${cloudApiOrigin}/protected/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${authToken}` }
    });

    if (!meResponse.ok) {
      return { saved: false, error: await responseErrorSummary(meResponse, "Cloud auth check failed") };
    }

    const recordingChecksum = await sha256Hex(await recordingBlob.arrayBuffer());
    const archiveChecksum = await sha256Hex(await jsonBlob.arrayBuffer());
    const thumbnail = await createVideoThumbnail(recordingBlob);

    const startResponse = await fetchCloud("Cloud upload start", `${cloudApiOrigin}/evidences/desktop-sessions/sync/start`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: archive.sessionId,
        title: archive.name,
        sourceMetadata: JSON.stringify({ source: "extension" }),
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

    const payload = (await startResponse.json()) as CloudUploadStartPayload;
    startedEvidenceId = payload.evidenceId;

    for (const session of payload.uploadSessions) {
      const blob = session.key === "recording" ? recordingBlob : jsonBlob;
      const putResponse = await fetchCloud(`Cloud artifact upload (${session.key})`, normalizeCloudUploadUrl(session.uploadUrl), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": session.headers["content-type"]
        },
        body: blob
      });
      if (!putResponse.ok) {
        return {
          saved: false,
          error: await responseErrorSummary(putResponse, "Cloud artifact upload failed"),
          evidenceId: payload.evidenceId
        };
      }

      const checksum = session.key === "recording" ? recordingChecksum : archiveChecksum;
      const completeResponse = await fetchCloud(`Cloud artifact completion (${session.key})`, `${cloudApiOrigin}/evidences/uploads/${encodeURIComponent(session.uploadId)}/complete`, {
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
      });

      if (!completeResponse.ok) {
        return {
          saved: false,
          error: await responseErrorSummary(completeResponse, "Cloud artifact completion failed"),
          evidenceId: payload.evidenceId
        };
      }
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

async function fetchCloud(label: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error: unknown) {
    throw new Error(`${label} failed: ${errorMessage(error)}`);
  }
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

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : thumbnailSeekSeconds;
    const targetTime = Math.max(0, Math.min(thumbnailSeekSeconds, Math.max(0, duration - 0.25)));
    await seekVideoFrame(video, targetTime);

    const canvas = document.createElement("canvas");
    canvas.width = thumbnailWidth;
    canvas.height = thumbnailHeight;
    const context = canvas.getContext("2d");
    if (!context) return null;

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

    const dataUrl = canvas.toDataURL(thumbnailMimeType, 0.72);
    return {
      base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
      mimeType: thumbnailMimeType
    };
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
      video.removeEventListener("loadeddata", onSeeked);
      video.removeEventListener("error", onError);
    };
    const onSeeked = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Video thumbnail seek failed."));
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.addEventListener("loadeddata", onSeeked, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.currentTime = targetTime;
  });
}

async function tryWriteArtifactsToCompanion(
  archive: SessionArchive,
  recordingBlob: Blob,
  jsonBlob: Blob
): Promise<CompanionWriteResult> {
  try {
    const healthResponse = await fetch(`${companionServerOrigin}/health`);

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
  const response = await fetch(
    `${companionServerOrigin}/api/sessions/${encodeURIComponent(sessionId)}/${artifactName}`,
    {
      method: "PUT",
      headers: {
        "content-type": contentType
      },
      body: blob
    }
  );

  if (!response.ok) {
    throw new Error(`Companion server rejected ${artifactName} with ${response.status}.`);
  }
}

async function startRecorder(sessionId: string, streamId: string): Promise<void> {
  if (activeRecorderState?.sessionId === sessionId) {
    return;
  }

  if (activeRecorderState) {
    throw new Error("An offscreen recording is already active.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: 30
      }
    } as ChromeTabCaptureTrackConstraints,
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    } as MediaTrackConstraints
  });
  const audioContext = keepCapturedTabAudioAudible(stream);

  const mimeType = preferredMimeType();
  const chunks: Blob[] = [];
  let resolveStop: ((blob: Blob) => void) | null = null;
  let rejectStop: ((error: Error) => void) | null = null;

  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);

  const stopPromise = new Promise<Blob>((resolve, reject) => {
    resolveStop = resolve;
    rejectStop = reject;
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
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
    audioContext
  };
}

async function stopRecorder(sessionId: string): Promise<Blob> {
  const recorderState = activeRecorderState;

  if (!recorderState || recorderState.sessionId !== sessionId) {
    throw new Error("No matching offscreen recording session is active.");
  }

  activeRecorderState = null;

  try {
    if (recorderState.recorder.state !== "inactive") {
      recorderState.recorder.stop();
    }

    return await recorderState.stopPromise;
  } finally {
    recorderState.stream.getTracks().forEach((track) => {
      track.stop();
    });
    void recorderState.audioContext?.close().catch(() => undefined);
  }
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

function keepCapturedTabAudioAudible(stream: MediaStream): AudioContext | null {
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
  recordingMimeType: string
): { archive: SessionArchive; jsonBlob: Blob } {
  let nextArchive = withRecordingArtifact(archive, {
    bytes: recordingBytes,
    mimeType: recordingMimeType || "video/webm"
  });

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

async function downloadBlob(blob: Blob, filename: string, mimeType: string): Promise<void> {
  const typedBlob = blob.type === mimeType ? blob : new Blob([blob], { type: mimeType });
  const objectUrl = URL.createObjectURL(typedBlob);

  try {
    if (!canUseChromeDownloadsApi()) {
      await triggerAnchorDownload(objectUrl, filename);
      return;
    }

    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      saveAs: true,
      conflictAction: "uniquify"
    });

    if (typeof downloadId !== "number") {
      throw new Error(`Failed to create a browser download for ${filename}.`);
    }

    await waitForDownload(downloadId);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function canUseChromeDownloadsApi(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.downloads?.download === "function" &&
    typeof chrome.downloads?.onChanged?.addListener === "function" &&
    typeof chrome.downloads?.onChanged?.removeListener === "function"
  );
}

async function triggerAnchorDownload(url: string, filename: string): Promise<void> {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function waitForDownload(downloadId: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const listener = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId || !delta.state?.current) {
        return;
      }

      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(listener);
        resolve();
        return;
      }

      if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(listener);
        reject(new Error("A local recorder download was interrupted."));
      }
    };

    chrome.downloads.onChanged.addListener(listener);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
