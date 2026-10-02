import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { safeParseSessionArchiveJson } from "@jittle-lamp/shared";
import { z } from "zod/v4";

import { isSafeResourceId } from "../deep-link";
import type { ViewerPayload } from "../rpc";
import type { TempSessionRegistry } from "./session-strategy";

// Opens uploaded evidence (for example a test run's recording) in the shared desktop viewer.
// The renderer passes only the evidence ID and its session token. The main process asks the
// configured API origin for playback links itself (GET /evidences/:id/playback), downloads only
// the URLs that response names (HTTPS, or the API origin itself for a local dev backend, no
// redirects), validates the archive before touching the recording, and streams the recording to
// a temp file that is removed with the viewer session or when the app quits.

export type RemoteEvidenceRequest = {
  evidenceId: string;
  authToken: string;
};

const maxArchiveBytes = 64 * 1024 * 1024;
const maxRecordingBytes = 1024 * 1024 * 1024;
const videoExtensions: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4" };

// GET /evidences/:id/playback (apps/backend/src/routes/evidence-uploads.ts); only the fields used here.
const playbackResponseSchema = z.object({
  artifacts: z.array(z.object({ id: z.string().min(1), kind: z.string(), mimeType: z.string() })),
  readUrls: z.array(z.object({ artifactId: z.string().min(1), url: z.string().min(1) }))
});
export type EvidencePlayback = z.infer<typeof playbackResponseSchema>;

/**
 * Artifact URLs must be HTTPS without credentials, or on the configured API origin (a local
 * dev-auth backend serves in-memory artifacts from its own origin). Loopback services such as the
 * companion server on 127.0.0.1:48115 are therefore never reachable through this path.
 */
export function isAllowedArtifactUrl(value: string, apiOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  let api: URL | null = null;
  try {
    api = new URL(apiOrigin);
  } catch {
    api = null;
  }
  if (api && url.origin === api.origin) return true;
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "::1" || /^127\./.test(host) || host === "0.0.0.0");
}

/** Picks the session archive and a playable recording from a playback response. */
export function selectPlaybackArtifacts(
  playback: EvidencePlayback
): { archiveUrl: string; recordingUrl: string; recordingMimeType: string } | null {
  let archiveUrl: string | null = null;
  let recording: { url: string; mimeType: string } | null = null;
  for (const readUrl of playback.readUrls) {
    const artifact = playback.artifacts.find((candidate) => candidate.id === readUrl.artifactId);
    if (!artifact) continue;
    if (artifact.kind === "network-log") archiveUrl = readUrl.url;
    if (artifact.kind === "recording" && artifact.mimeType in videoExtensions) {
      recording = { url: readUrl.url, mimeType: artifact.mimeType };
    }
  }
  return archiveUrl && recording ? { archiveUrl, recordingUrl: recording.url, recordingMimeType: recording.mimeType } : null;
}

async function fetchChecked(fetcher: typeof fetch, url: string, label: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetcher(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000), ...init });
  if (!response.ok) throw new Error(`Unable to load the ${label} (${response.status}).`);
  return response;
}

function tooLarge(response: Response, maxBytes: number): boolean {
  const declared = Number(response.headers.get("content-length") ?? "0");
  return Number.isFinite(declared) && declared > maxBytes;
}

async function readCapped(response: Response, maxBytes: number, label: string): Promise<Uint8Array> {
  if (tooLarge(response, maxBytes)) throw new Error(`The ${label} is too large to open.`);
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`The ${label} is too large to open.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function streamToFile(response: Response, path: string, maxBytes: number, label: string): Promise<void> {
  if (tooLarge(response, maxBytes)) throw new Error(`The ${label} is too large to open.`);
  if (!response.body) throw new Error(`The ${label} is empty.`);
  let total = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      callback(total > maxBytes ? new Error(`The ${label} is too large to open.`) : null, chunk);
    }
  });
  try {
    await pipeline(Readable.fromWeb(response.body as unknown as NodeReadableStream), cap, createWriteStream(path, { flags: "wx" }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function loadRemoteEvidence(
  input: RemoteEvidenceRequest,
  registry: TempSessionRegistry,
  options: { apiOrigin: string; fetcher?: typeof fetch; tempRoot?: string }
): Promise<ViewerPayload> {
  if (!isSafeResourceId(input.evidenceId)) throw new Error("Invalid evidence ID.");
  if (!input.authToken) throw new Error("Sign in to open cloud evidence.");
  const fetcher = options.fetcher ?? fetch;
  const apiOrigin = options.apiOrigin.replace(/\/+$/, "");

  const playbackResponse = await fetchChecked(fetcher, `${apiOrigin}/evidences/${input.evidenceId}/playback`, "evidence playback links", {
    headers: { authorization: `Bearer ${input.authToken}` },
    signal: AbortSignal.timeout(30_000)
  });
  const playback = playbackResponseSchema.safeParse(await playbackResponse.json().catch(() => null));
  if (!playback.success) throw new Error("The backend returned unexpected playback links.");
  const artifacts = selectPlaybackArtifacts(playback.data);
  if (!artifacts) throw new Error("This evidence has no playable recording and session archive yet.");
  if (!isAllowedArtifactUrl(artifacts.archiveUrl, apiOrigin) || !isAllowedArtifactUrl(artifacts.recordingUrl, apiOrigin)) {
    throw new Error("Evidence artifacts must be served over HTTPS.");
  }

  // The archive is small and validated before the recording is downloaded at all.
  const archiveBytes = await readCapped(await fetchChecked(fetcher, artifacts.archiveUrl, "session archive"), maxArchiveBytes, "session archive");
  const parsed = safeParseSessionArchiveJson(archiveBytes);
  if (!parsed.success) throw new Error(`Invalid session archive: ${parsed.error.message}`);

  const tempId = crypto.randomUUID();
  const tempDir = resolve(join(options.tempRoot ?? tmpdir(), "jittle-lamp-temp"));
  await mkdir(tempDir, { recursive: true });
  const videoPath = join(tempDir, `${tempId}.${videoExtensions[artifacts.recordingMimeType] ?? "webm"}`);
  await streamToFile(await fetchChecked(fetcher, artifacts.recordingUrl, "recording"), videoPath, maxRecordingBytes, "recording");
  registry.set(tempId, { videoPath });

  return {
    source: "cloud",
    archive: parsed.data,
    videoPath,
    videoMimeType: artifacts.recordingMimeType,
    notes: "",
    tempId,
    evidenceId: input.evidenceId
  };
}
