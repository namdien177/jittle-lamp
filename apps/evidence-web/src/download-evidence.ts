import { zipSync } from "fflate";

import { recordingFileName, sessionArchiveFileName } from "@jittle-lamp/shared";

import { api, type FetchToken } from "./api";

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download asset (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadEvidenceAsZip(input: {
  getToken: FetchToken;
  evidenceId: string;
  orgId?: string | undefined;
  title: string;
}): Promise<void> {
  const { getToken, evidenceId, orgId, title } = input;

  const artifactResult = await api.listEvidenceArtifacts(getToken, evidenceId, orgId);
  const recording = artifactResult.artifacts.find((artifact) => artifact.kind === "recording");
  const archive = artifactResult.artifacts.find((artifact) => artifact.kind === "network-log");
  if (!recording || !archive) {
    throw new Error("Evidence is missing the recording or archive artifact.");
  }

  const [recordingReadUrl, archiveReadUrl] = await Promise.all([
    api.createArtifactReadUrl(getToken, evidenceId, recording.id, orgId),
    api.createArtifactReadUrl(getToken, evidenceId, archive.id, orgId)
  ]);

  const [recordingBytes, archiveBytes] = await Promise.all([
    fetchBytes(recordingReadUrl.url),
    fetchBytes(archiveReadUrl.url)
  ]);

  const zip = zipSync({
    [sessionArchiveFileName]: archiveBytes,
    [recordingFileName]: recordingBytes
  });

  const blob = new Blob([zip.slice().buffer as ArrayBuffer], { type: "application/zip" });
  const filename = `${slugify(title) || evidenceId}.zip`;
  triggerDownload(blob, filename);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
