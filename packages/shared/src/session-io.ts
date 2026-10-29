import { ZodError } from "zod/v4";

import {
  isRecordingArtifactKind,
  recordingArtifactKinds,
  recordingArtifactMimeTypes,
  sessionArchiveSchema,
  type RecordingArtifactKind,
  type SessionArchive
} from "./session";

export const sessionArchiveFileName = "session.archive.json";
// The extension's recording. Bundles from the native macOS app carry `recording.mp4` instead; the
// file name always matches the artifact kind.
export const recordingFileName = "recording.webm";
export const recordingMp4FileName = "recording.mp4";
export const recordingFileNames: readonly RecordingArtifactKind[] = recordingArtifactKinds;

// Bundle file name for a recording of this MIME type; anything but MP4 keeps the WebM name.
export function recordingFileNameForMimeType(mimeType: string): RecordingArtifactKind {
  return mimeType.split(";")[0]?.trim().toLowerCase() === "video/mp4" ? recordingMp4FileName : recordingFileName;
}

export type SessionBundleFiles = {
  archiveJson: Uint8Array;
  recording: Uint8Array;
  recordingFileName: RecordingArtifactKind;
  recordingMimeType: string;
};

export interface SessionLoader<TSource, TLoaded> {
  load(source: TSource): Promise<TLoaded> | TLoaded;
}

export interface SessionExporter<TInput, TOutput> {
  export(input: TInput): Promise<TOutput> | TOutput;
}

export function parseSessionArchiveJson(input: string | Uint8Array): SessionArchive {
  const jsonText = typeof input === "string" ? input : new TextDecoder().decode(input);
  return sessionArchiveSchema.parse(JSON.parse(jsonText));
}

export function safeParseSessionArchiveJson(input: string | Uint8Array): ReturnType<typeof sessionArchiveSchema.safeParse> {
  const jsonText = typeof input === "string" ? input : new TextDecoder().decode(input);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (e) {
    return {
      success: false,
      error: new ZodError([
        {
          code: "custom",
          input: jsonText,
          message: e instanceof Error ? e.message : "Invalid JSON",
          path: []
        }
      ]) as unknown as ZodError<SessionArchive>
    };
  }
  return sessionArchiveSchema.safeParse(raw);
}

export function pickSessionBundleFiles(files: Record<string, Uint8Array>): SessionBundleFiles {
  let archiveJson: Uint8Array | null = null;
  const recordings = new Map<RecordingArtifactKind, Uint8Array>();

  for (const [path, content] of Object.entries(files)) {
    const name = path.split("/").pop();
    if (name === sessionArchiveFileName) archiveJson = content;
    if (name && isRecordingArtifactKind(name)) recordings.set(name, content);
  }

  if (!archiveJson) {
    throw new Error(`${sessionArchiveFileName} not found in bundle.`);
  }

  const [recordingEntry, ...extraRecordings] = recordings;
  if (!recordingEntry) {
    throw new Error(`${recordingFileNames.join(" or ")} not found in bundle.`);
  }
  if (extraRecordings.length > 0) {
    throw new Error(`Bundle must contain only one of ${recordingFileNames.join(" or ")}.`);
  }

  const [name, recording] = recordingEntry;
  return { archiveJson, recording, recordingFileName: name, recordingMimeType: recordingArtifactMimeTypes[name] };
}
