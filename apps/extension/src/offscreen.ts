import { offscreenRequestSchema, type SessionArchive } from "@jittle-lamp/shared";

declare const __JITTLE_LAMP_API_ORIGIN__: string | undefined;

const companionServerOrigin = "http://127.0.0.1:48115";
const cloudApiOrigin = (
  typeof __JITTLE_LAMP_API_ORIGIN__ === "string"
    ? __JITTLE_LAMP_API_ORIGIN__.trim()
    : "https://jl-api.monthlyparty.com"
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
};

type CompanionWriteResult =
  | {
      saved: true;
      destination: "cloud" | "companion";
      outputDir: string;
    }
  | {
      saved: false;
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

let activeRecorderState: ActiveRecorderState | null = null;

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
        ...(companionResult.saved ? { outputDir: companionResult.outputDir } : {})
      };
    }
  }
}

async function tryWriteArtifactsToCloud(
  archive: SessionArchive,
  recordingBlob: Blob,
  jsonBlob: Blob,
  authToken?: string
): Promise<CompanionWriteResult> {
  try {
    const meResponse = await fetch(`${cloudApiOrigin}/protected/me`, {
      method: "GET",
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      credentials: "include"
    });

    if (!meResponse.ok) {
      return { saved: false };
    }

    const recordingChecksum = await sha256Hex(await recordingBlob.arrayBuffer());
    const archiveChecksum = await sha256Hex(await jsonBlob.arrayBuffer());

    const startResponse = await fetch(`${cloudApiOrigin}/evidences/desktop-sessions/sync/start`, {
      method: "POST",
      credentials: "include",
      headers: {
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        sessionId: archive.sessionId,
        title: archive.name,
        sourceMetadata: JSON.stringify({ source: "extension" }),
        artifacts: [
          { key: "recording", kind: "recording", mimeType: "video/webm", bytes: recordingBlob.size, checksum: recordingChecksum },
          { key: "archive", kind: "network-log", mimeType: "application/json", bytes: jsonBlob.size, checksum: archiveChecksum }
        ]
      })
    });

    if (!startResponse.ok) {
      return { saved: false };
    }

    const payload = (await startResponse.json()) as CloudUploadStartPayload;

    for (const session of payload.uploadSessions) {
      const blob = session.key === "recording" ? recordingBlob : jsonBlob;
      const putResponse = await fetch(session.uploadUrl, {
        method: "PUT",
        credentials: "include",
        headers: {
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          "content-type": session.headers["content-type"]
        },
        body: blob
      });
      if (!putResponse.ok) {
        return { saved: false };
      }

      const checksum = session.key === "recording" ? recordingChecksum : archiveChecksum;
      const completeResponse = await fetch(`${cloudApiOrigin}/evidences/uploads/${encodeURIComponent(session.uploadId)}/complete`, {
        method: "POST",
        credentials: "include",
        headers: {
          ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          "content-type": "application/json"
        },
        body: JSON.stringify({
          bytes: blob.size,
          checksum,
          mimeType: session.headers["content-type"]
        })
      });

      if (!completeResponse.ok) {
        return { saved: false };
      }
    }

    return {
      saved: true,
      destination: "cloud",
      outputDir: "cloud"
    };
  } catch {
    return { saved: false };
  }
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
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
    audio: false
  });

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
    stopPromise
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
  }
}

function preferredMimeType(): string | undefined {
  const candidates = [
    "video/webm;codecs=vp8",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
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
