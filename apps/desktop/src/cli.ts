import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { recordingFileName, sessionArchiveFileName } from "@jittle-lamp/shared";

import { loadResolvedCompanionConfig } from "./companion/config";
import { markSessionRemoteSynced } from "./companion/sessions-db";

const apiOrigin = (process.env.JITTLE_LAMP_API_ORIGIN?.trim() || "http://127.0.0.1:3001").replace(/\/+$/, "");

type UploadArtifact = {
  key: "recording" | "archive";
  kind: "recording" | "network-log";
  mimeType: string;
  bytes: number;
  checksum: string;
  payload: Uint8Array;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command !== "upload-evidence") {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const sessionId = args.flags["session-id"];
  if (!sessionId) {
    throw new Error("Missing required flag --session-id");
  }

  const token = args.flags.token || process.env.JITTLE_LAMP_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Missing access token. Provide --token or JITTLE_LAMP_ACCESS_TOKEN.");
  }

  const title = args.flags.title || sessionId;
  const replaceEvidenceId = args.flags["replace-evidence-id"];

  const config = await loadResolvedCompanionConfig();
  const sessionFolder = resolve(join(config.outputDir, sessionId));
  const safeOutputDir = resolve(config.outputDir);
  if (!sessionFolder.startsWith(`${safeOutputDir}/`) && sessionFolder !== safeOutputDir) {
    throw new Error("Invalid session id: path traversal detected.");
  }

  const [recordingPayload, archivePayload] = await Promise.all([
    readFile(join(sessionFolder, recordingFileName)),
    readFile(join(sessionFolder, sessionArchiveFileName))
  ]);

  const artifacts: UploadArtifact[] = [
    {
      key: "recording",
      kind: "recording",
      mimeType: "video/webm",
      bytes: recordingPayload.byteLength,
      checksum: `sha256:${await sha256Hex(recordingPayload)}`,
      payload: Uint8Array.from(recordingPayload)
    },
    {
      key: "archive",
      kind: "network-log",
      mimeType: "application/json",
      bytes: archivePayload.byteLength,
      checksum: `sha256:${await sha256Hex(archivePayload)}`,
      payload: Uint8Array.from(archivePayload)
    }
  ];

  const sourceMetadata = JSON.stringify({
    localSessionId: sessionId,
    artifactFormat: "split",
    artifacts: artifacts.map((artifact) => ({
      key: artifact.key,
      kind: artifact.kind,
      mimeType: artifact.mimeType,
      bytes: artifact.bytes,
      checksum: artifact.checksum
    }))
  });

  const started = await authedFetch<{
    evidenceId: string;
    organizationId: string;
    uploadSessions: Array<{
      key: string;
      uploadId: string;
      uploadUrl: string;
    }>;
  }>(token, "/evidences/desktop-session-sync", {
    method: "POST",
    body: JSON.stringify({
      sessionId,
      title,
      sourceMetadata,
      ...(replaceEvidenceId ? { replaceEvidenceId } : {}),
      artifacts: artifacts.map((artifact) => ({
        key: artifact.key,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        bytes: artifact.bytes,
        checksum: artifact.checksum
      }))
    })
  });

  for (const artifact of artifacts) {
    const uploadSession = started.uploadSessions.find((candidate) => candidate.key === artifact.key);
    if (!uploadSession) {
      throw new Error(`Missing upload session for ${artifact.key}`);
    }

    const uploadResponse = await fetch(uploadSession.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": artifact.mimeType,
        authorization: `Bearer ${token}`
      },
      body: new Blob([toArrayBuffer(artifact.payload)], { type: artifact.mimeType })
    });
    if (!uploadResponse.ok) {
      throw new Error(`Upload failed for ${artifact.key} (${uploadResponse.status})`);
    }

    await authedFetch(token, `/uploads/${encodeURIComponent(uploadSession.uploadId)}/complete`, {
      method: "POST",
      body: JSON.stringify({
        bytes: artifact.bytes,
        checksum: artifact.checksum,
        mimeType: artifact.mimeType
      })
    });
  }

  markSessionRemoteSynced({
    sessionId,
    evidenceId: started.evidenceId,
    orgId: started.organizationId
  });

  console.info(JSON.stringify({
    ok: true,
    command: "upload-evidence",
    sessionId,
    title,
    evidenceId: started.evidenceId,
    organizationId: started.organizationId,
    uploadedArtifacts: artifacts.map((artifact) => ({ key: artifact.key, bytes: artifact.bytes }))
  }, null, 2));
}

async function authedFetch<T = unknown>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");

  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status})${message ? `: ${message.slice(0, 300)}` : ""}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function parseArgs(input: string[]): { command: string | null; flags: Record<string, string> } {
  const [command, ...rest] = input;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      flags[key] = "true";
      continue;
    }
    flags[key] = value;
    index += 1;
  }
  return { command: command ?? null, flags };
}

function printUsage(): void {
  console.info(`Usage:\n  bun run --cwd apps/desktop cli upload-evidence --session-id <session-id> [--title <title>] [--replace-evidence-id <evidence-id>] [--token <bearer-token>]\n\nEnvironment:\n  JITTLE_LAMP_ACCESS_TOKEN   Bearer token from an authenticated desktop session.`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`jittle-lamp CLI error: ${message}`);
  process.exitCode = 1;
});
