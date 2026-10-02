import type { ApiEvidencePlayback } from "./api";

/** Picks the playable recording and the session archive from a playback response. */
export function selectPlaybackArtifacts(
  playback: Pick<ApiEvidencePlayback, "artifacts" | "readUrls">
): { archiveUrl: string; recordingUrl: string; recordingMimeType: string } | null {
  let archiveUrl: string | null = null;
  let recording: { url: string; mimeType: string } | null = null;
  for (const readUrl of playback.readUrls) {
    const artifact = playback.artifacts.find((candidate) => candidate.id === readUrl.artifactId);
    if (!artifact) continue;
    if (artifact.kind === "network-log") archiveUrl = readUrl.url;
    if (artifact.kind === "recording" && ["video/webm", "video/mp4"].includes(artifact.mimeType)) {
      recording = { url: readUrl.url, mimeType: artifact.mimeType };
    }
  }
  return archiveUrl && recording ? { archiveUrl, recordingUrl: recording.url, recordingMimeType: recording.mimeType } : null;
}
