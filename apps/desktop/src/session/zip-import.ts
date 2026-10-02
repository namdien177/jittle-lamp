import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { zipSync } from "fflate";

import { recordingFileName, sessionArchiveFileName } from "@jittle-lamp/shared";

import { loadRemoteEvidence, type RemoteEvidenceRequest } from "./remote-evidence";
import { createDesktopSessionStrategies } from "./session-strategy";

const activeTempSessions = new Map<string, { videoPath: string }>();

export async function importZipBundle(zipBytes: Uint8Array) {
  const strategies = createDesktopSessionStrategies(activeTempSessions);
  return strategies.zip.load(zipBytes);
}

export async function openRemoteEvidence(input: RemoteEvidenceRequest) {
  return loadRemoteEvidence(input, activeTempSessions);
}

export async function clearTempSession(tempId: string): Promise<void> {
  const entry = activeTempSessions.get(tempId);
  if (!entry) return;

  activeTempSessions.delete(tempId);
  await rm(entry.videoPath, { force: true });
}

export async function loadLocalSession(folderPath: string) {
  const strategies = createDesktopSessionStrategies(activeTempSessions);
  return strategies.local.load(folderPath);
}

export async function buildSessionZip(sessionFolderPath: string): Promise<Uint8Array> {
  const eventsPath = join(sessionFolderPath, sessionArchiveFileName);
  const videoPath = join(sessionFolderPath, recordingFileName);

  const [eventsBytes, webmBytes] = await Promise.all([readFile(eventsPath), readFile(videoPath)]);

  return zipSync({
    [sessionArchiveFileName]: new Uint8Array(eventsBytes),
    [recordingFileName]: new Uint8Array(webmBytes)
  });
}
