import { unzipSync } from "fflate";
import {
  parseSessionArchiveJson,
  pickSessionBundleFiles,
  sessionArchiveFileName,
  sessionArchiveSchema,
  sessionSchemaVersion,
  type SessionArchive,
} from "@jittle-lamp/shared";

import {
  api,
  type FetchToken,
  type ManualEvidenceUploadArtifact,
} from "./api";

type PreparedArtifact = ManualEvidenceUploadArtifact & {
  payload: Uint8Array;
};

type PreparedManualUpload = {
  sessionId: string;
  title: string;
  mode: "session-zip" | "raw-video";
  generatedArchive: boolean;
  sourceMetadata: string;
  artifacts: PreparedArtifact[];
};

export type ManualEvidenceUploadResult = {
  evidenceId: string;
  organizationId: string;
  title: string;
  mode: "session-zip" | "raw-video";
  generatedArchive: boolean;
};

export class UnsupportedUploadFileError extends Error {
  constructor() {
    super("Upload ZIP, MP4, WebM, or WebP.");
    this.name = "UnsupportedUploadFileError";
  }
}

export class InvalidEvidenceUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEvidenceUploadError";
  }
}

const textEncoder = new TextEncoder();
export const MAX_MANUAL_VIDEO_UPLOAD_BYTES = 60 * 1024 * 1024;

const assertVideoSize = (bytes: number): void => {
  if (bytes > MAX_MANUAL_VIDEO_UPLOAD_BYTES) {
    throw new InvalidEvidenceUploadError("Video files must be 60 MB or smaller.");
  }
};

const supportedVideoTypes = new Set(["video/mp4", "video/webm", "image/webp"]);
const videoMimeByExtension = new Map([
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
]);

function baseName(fileName: string): string {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  return name.replace(/\.[^.]+$/, "").trim() || "Manual upload";
}

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

function detectVideoMimeType(file: File): string | null {
  if (supportedVideoTypes.has(file.type)) return file.type;
  const lowerName = file.name.toLowerCase();
  for (const [extension, mimeType] of videoMimeByExtension) {
    if (lowerName.endsWith(extension)) return mimeType;
  }
  return null;
}

function createSessionId(): string {
  return `jl_manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function sha256Hex(payload: Uint8Array): Promise<string> {
  const stablePayload = new Uint8Array(payload.byteLength);
  stablePayload.set(payload);
  const digest = await crypto.subtle.digest("SHA-256", stablePayload.buffer);
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function archiveStats(archive: SessionArchive): {
  durationMs: number | null;
  actionCount: number | null;
  requestCount: number | null;
} {
  return {
    durationMs:
      typeof archive.summary.videoDurationMs === "number"
        ? archive.summary.videoDurationMs
        : null,
    actionCount:
      typeof archive.summary.actionCount === "number"
        ? archive.summary.actionCount
        : null,
    requestCount:
      typeof archive.summary.requestCount === "number"
        ? archive.summary.requestCount
        : null,
  };
}

function createSourceMetadata(input: {
  archive: SessionArchive;
  mode: PreparedManualUpload["mode"];
  file: File;
  generatedArchive: boolean;
  artifacts: PreparedArtifact[];
}): string {
  return JSON.stringify({
    localSessionId: input.archive.sessionId,
    artifactFormat: "split",
    uploadMode: input.mode,
    originalFileName: input.file.name,
    generatedArchive: input.generatedArchive,
    ...archiveStats(input.archive),
    artifacts: input.artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      checksum: artifact.checksum,
    })),
  });
}

async function readVideoDurationMs(file: File): Promise<number | null> {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return null;
  }

  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const finish = (value: number | null): void => {
      window.clearTimeout(timeout);
      video.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timeout = window.setTimeout(() => finish(null), 3000);
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const durationMs =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.round(video.duration * 1000)
          : null;
      finish(durationMs);
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

function createEmptyArchive(input: {
  sessionId: string;
  title: string;
  videoMimeType: string;
  videoBytes: number;
  durationMs: number | null;
}): SessionArchive {
  const now = new Date().toISOString();
  return sessionArchiveSchema.parse({
    schemaVersion: sessionSchemaVersion,
    sessionId: input.sessionId,
    name: input.title,
    createdAt: now,
    updatedAt: now,
    phase: "ready",
    page: {
      title: input.title,
      url: `https://manual-upload.jittle-lamp.local/${encodeURIComponent(input.sessionId)}`,
    },
    recorder: {
      extension: {
        kind: "browser-extension",
        name: "manual-upload",
        version: "unknown",
      },
    },
    summary: {
      videoDurationMs: input.durationMs,
      actionCount: 0,
      requestCount: 0,
    },
    artifacts: [
      {
        kind: "recording.webm",
        relativePath: `${input.sessionId}/recording.webm`,
        mimeType: input.videoMimeType,
        bytes: input.videoBytes,
      },
      {
        kind: "session.archive.json",
        relativePath: `${input.sessionId}/${sessionArchiveFileName}`,
        mimeType: "application/json",
      },
    ],
    sections: {
      actions: [],
      console: [],
      network: [],
    },
    annotations: [],
    notes: ["Manual video upload. No browser log or network trace was captured."],
  });
}

async function toPreparedArtifact(input: {
  key: "recording" | "archive";
  kind: ManualEvidenceUploadArtifact["kind"];
  mimeType: string;
  payload: Uint8Array;
}): Promise<PreparedArtifact> {
  return {
    key: input.key,
    kind: input.kind,
    mimeType: input.mimeType,
    bytes: input.payload.byteLength,
    checksum: `sha256:${await sha256Hex(input.payload)}`,
    payload: input.payload,
  };
}

async function prepareZipUpload(file: File): Promise<PreparedManualUpload> {
  let archiveJson: Uint8Array;
  let recordingWebm: Uint8Array;
  let archive: SessionArchive;
  try {
    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const files = unzipSync(zipBytes);
    const picked = pickSessionBundleFiles(files);
    archiveJson = picked.archiveJson;
    recordingWebm = picked.recordingWebm;
    assertVideoSize(recordingWebm.byteLength);
    archive = parseSessionArchiveJson(archiveJson);
  } catch (error) {
    throw new InvalidEvidenceUploadError(
      error instanceof Error
        ? error.message
        : "ZIP must include a session archive and recording.",
    );
  }
  const recordingArtifact = archive.artifacts.find(
    (artifact) => artifact.kind === "recording.webm",
  );
  const recording = await toPreparedArtifact({
    key: "recording",
    kind: "recording",
    mimeType: recordingArtifact?.mimeType || "video/webm",
    payload: Uint8Array.from(recordingWebm),
  });
  const archiveArtifact = await toPreparedArtifact({
    key: "archive",
    kind: "network-log",
    mimeType: "application/json",
    payload: Uint8Array.from(archiveJson),
  });
  const artifacts = [recording, archiveArtifact];

  return {
    sessionId: archive.sessionId,
    title: archive.name || baseName(file.name),
    mode: "session-zip",
    generatedArchive: false,
    sourceMetadata: createSourceMetadata({
      archive,
      mode: "session-zip",
      file,
      generatedArchive: false,
      artifacts,
    }),
    artifacts,
  };
}

async function prepareRawVideoUpload(
  file: File,
  mimeType: string,
): Promise<PreparedManualUpload> {
  const videoBytes = new Uint8Array(await file.arrayBuffer());
  const durationMs = await readVideoDurationMs(file);
  const title = baseName(file.name);
  const archive = createEmptyArchive({
    sessionId: createSessionId(),
    title,
    videoMimeType: mimeType,
    videoBytes: videoBytes.byteLength,
    durationMs,
  });
  const archivePayload = textEncoder.encode(`${JSON.stringify(archive, null, 2)}\n`);
  const recording = await toPreparedArtifact({
    key: "recording",
    kind: "recording",
    mimeType,
    payload: videoBytes,
  });
  const archiveArtifact = await toPreparedArtifact({
    key: "archive",
    kind: "network-log",
    mimeType: "application/json",
    payload: archivePayload,
  });
  const artifacts = [recording, archiveArtifact];

  return {
    sessionId: archive.sessionId,
    title,
    mode: "raw-video",
    generatedArchive: true,
    sourceMetadata: createSourceMetadata({
      archive,
      mode: "raw-video",
      file,
      generatedArchive: true,
      artifacts,
    }),
    artifacts,
  };
}

export async function prepareManualEvidenceUploadFile(
  file: File,
): Promise<PreparedManualUpload> {
  if (isZipFile(file)) return prepareZipUpload(file);

  const videoMimeType = detectVideoMimeType(file);
  if (videoMimeType) {
    assertVideoSize(file.size);
    return prepareRawVideoUpload(file, videoMimeType);
  }

  throw new UnsupportedUploadFileError();
}

export async function uploadManualEvidenceFile(input: {
  file: File;
  getToken: FetchToken;
}): Promise<ManualEvidenceUploadResult> {
  const prepared = await prepareManualEvidenceUploadFile(input.file);
  const started = await api.startManualEvidenceUpload(input.getToken, {
    sessionId: prepared.sessionId,
    title: prepared.title,
    sourceMetadata: prepared.sourceMetadata,
    artifacts: prepared.artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      checksum: artifact.checksum,
    })),
  });

  for (const artifact of prepared.artifacts) {
    const uploadSession = started.uploadSessions.find(
      (candidate) => candidate.key === artifact.key,
    );
    if (!uploadSession) throw new Error(`Missing upload session for ${artifact.key}.`);
    await api.uploadEvidenceBlob(
      input.getToken,
      uploadSession.uploadUrl,
      artifact.payload,
      artifact.mimeType,
    );
    await api.completeEvidenceUpload(input.getToken, uploadSession.uploadId, {
      bytes: artifact.bytes,
      checksum: artifact.checksum,
      mimeType: artifact.mimeType,
    });
  }

  return {
    evidenceId: started.evidenceId,
    organizationId: started.organizationId,
    title: prepared.title,
    mode: prepared.mode,
    generatedArchive: prepared.generatedArchive,
  };
}
