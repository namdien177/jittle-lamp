import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { safeParseSessionArchiveJson } from "@jittle-lamp/shared";

import { isSafeResourceId } from "../deep-link";
import type { ViewerPayload } from "../rpc";
import type { TempSessionRegistry } from "./session-strategy";

// Opens cloud evidence (for example a test run's recording) in the shared desktop viewer. The
// renderer asks the backend for short-lived signed artifact URLs (GET /evidences/:id/playback);
// the main process downloads them without the session token, the same way ZIP imports land in a
// temp session, so the viewer and its step filter work exactly as for local recordings.

export type RemoteEvidenceRequest = {
  evidenceId: string;
  archiveUrl: string;
  recordingUrl: string;
  recordingMimeType: string;
};

const maxArchiveBytes = 64 * 1024 * 1024;
const maxRecordingBytes = 1024 * 1024 * 1024;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const videoExtensions: Record<string, string> = { "video/webm": "webm", "video/mp4": "mp4" };

/** Signed artifact URLs must be HTTPS, or HTTP on loopback for local development backends. */
export function isAllowedArtifactUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname));
}

async function download(fetcher: typeof fetch, url: string, maxBytes: number, label: string): Promise<Uint8Array> {
  const response = await fetcher(url, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Unable to download the ${label} (${response.status}). The link may have expired; try again.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`The ${label} is too large to open.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`The ${label} is too large to open.`);
  return bytes;
}

export async function loadRemoteEvidence(
  input: RemoteEvidenceRequest,
  registry: TempSessionRegistry,
  options: { fetcher?: typeof fetch; tempRoot?: string } = {}
): Promise<ViewerPayload> {
  if (!isSafeResourceId(input.evidenceId)) throw new Error("Invalid evidence ID.");
  if (!isAllowedArtifactUrl(input.archiveUrl) || !isAllowedArtifactUrl(input.recordingUrl)) {
    throw new Error("Evidence artifacts must be served over HTTPS.");
  }
  const extension = videoExtensions[input.recordingMimeType];
  if (!extension) throw new Error(`Unsupported recording type ${input.recordingMimeType}.`);

  const fetcher = options.fetcher ?? fetch;
  const [archiveBytes, recordingBytes] = await Promise.all([
    download(fetcher, input.archiveUrl, maxArchiveBytes, "session archive"),
    download(fetcher, input.recordingUrl, maxRecordingBytes, "recording")
  ]);

  const parsed = safeParseSessionArchiveJson(archiveBytes);
  if (!parsed.success) throw new Error(`Invalid session archive: ${parsed.error.message}`);

  const tempId = crypto.randomUUID();
  const tempDir = resolve(join(options.tempRoot ?? tmpdir(), "jittle-lamp-temp"));
  await mkdir(tempDir, { recursive: true });
  const videoPath = join(tempDir, `${tempId}.${extension}`);
  await writeFile(videoPath, recordingBytes);
  registry.set(tempId, { videoPath });

  return {
    source: "cloud",
    archive: parsed.data,
    videoPath,
    videoMimeType: input.recordingMimeType,
    notes: "",
    tempId,
    evidenceId: input.evidenceId
  };
}
