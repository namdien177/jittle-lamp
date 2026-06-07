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
  bufferVideo?: boolean;
  signal?: AbortSignal;
}): Promise<LoadedSession> {
  const fetchInit = input.signal ? { signal: input.signal } : undefined;
  const response = await fetch(input.archiveUrl, fetchInit);
  if (!response.ok) {
    throw new Error(`Unable to load session archive (${response.status}).`);
  }

  const archive = parseSessionArchiveJson(await response.text());
  const recordingArtifact = archive.artifacts.find((artifact) => artifact.kind === "recording.webm");
  let videoUrl = input.videoUrl;
  let recordingBytes = new Uint8Array();

  if (input.bufferVideo) {
    const videoResponse = await fetch(input.videoUrl, fetchInit);
    if (!videoResponse.ok) {
      throw new Error(`Unable to load recording (${videoResponse.status}).`);
    }
    recordingBytes = new Uint8Array(await videoResponse.arrayBuffer());
    const blob = createVideoBlob(recordingBytes, recordingArtifact?.mimeType || "video/webm");
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
