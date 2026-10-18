import { unzipSync } from "fflate";
import {
  parseSessionArchiveJson,
  pickSessionBundleFiles,
  type ActionMergeGroup,
  type SessionArchive,
  type SessionLoader,
  type TimelineItem
} from "@jittle-lamp/shared";
import { deriveTimeline, getArchiveMergeGroups } from "@jittle-lamp/viewer-core";

export type LoadedSession = {
  archive: SessionArchive;
  videoUrl: string;
  recordingBytes: Uint8Array;
  timeline: TimelineItem[];
  mergeGroups: ActionMergeGroup[];
};

function createVideoBlob(bytes: Uint8Array, mimeType: string): Blob {
  const stableBytes = Uint8Array.from(bytes);
  return new Blob([stableBytes], { type: mimeType });
}

export class WebSessionZipLoader implements SessionLoader<File, LoadedSession> {
  async load(file: File): Promise<LoadedSession> {
    const buffer = await file.arrayBuffer();
    const files = unzipSync(new Uint8Array(buffer));
    const { archiveJson, recordingWebm } = pickSessionBundleFiles(files);

    const archive = parseSessionArchiveJson(archiveJson);

    const recordingArtifact = archive.artifacts.find((artifact) => artifact.kind === "recording.webm");
    const blob = createVideoBlob(recordingWebm, recordingArtifact?.mimeType || "video/webm");
    const videoUrl = URL.createObjectURL(blob);

    return {
      archive,
      videoUrl,
      recordingBytes: Uint8Array.from(recordingWebm),
      timeline: deriveTimeline(archive),
      mergeGroups: getArchiveMergeGroups(archive)
    };
  }
}

export async function loadSessionZip(file: File): Promise<LoadedSession> {
  return new WebSessionZipLoader().load(file);
}

export async function loadRemoteSessionArtifacts(input: {
  archiveUrl: string;
  videoUrl: string;
  videoMimeType?: string;
  bufferVideo?: boolean;
  signal?: AbortSignal;
}): Promise<LoadedSession> {
  const fetchInit = input.signal ? { signal: input.signal } : undefined;
  // The video does not depend on the archive, so both downloads start together.
  const recordingBytesPromise = input.bufferVideo ? fetchRecordingBytes(input.videoUrl, fetchInit) : null;
  if (!input.bufferVideo) preconnectTo(input.videoUrl);
  // Keep a failed video download from surfacing as an unhandled rejection while the archive loads.
  recordingBytesPromise?.catch(() => undefined);

  const response = await fetch(input.archiveUrl, fetchInit);
  if (!response.ok) {
    throw new Error(`Unable to load session archive (${response.status}).`);
  }

  const archive = parseSessionArchiveJson(await response.text());
  const recordingArtifact = archive.artifacts.find((artifact) => artifact.kind === "recording.webm");
  let videoUrl = input.videoUrl;
  let recordingBytes: Uint8Array = new Uint8Array();

  if (recordingBytesPromise) {
    recordingBytes = await recordingBytesPromise;
    const blob = createVideoBlob(recordingBytes, input.videoMimeType || recordingArtifact?.mimeType || "video/webm");
    videoUrl = URL.createObjectURL(blob);
  }

  return {
    archive,
    videoUrl,
    recordingBytes,
    timeline: deriveTimeline(archive),
    mergeGroups: getArchiveMergeGroups(archive)
  };
}

async function fetchRecordingBytes(url: string, init: RequestInit | undefined): Promise<Uint8Array> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Unable to load recording (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// Opens the connection to the video host while the archive downloads, so the player's first
// request skips DNS and TLS setup.
function preconnectTo(url: string): void {
  if (typeof document === "undefined") return;
  let origin: string;
  try {
    origin = new URL(url, window.location.href).origin;
  } catch {
    return;
  }
  if (origin === window.location.origin) return;
  if (document.head.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
  const link = document.createElement("link");
  link.rel = "preconnect";
  link.href = origin;
  document.head.append(link);
}
