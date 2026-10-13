import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

// Whether the page had network traffic just now, read from the capture log the engine wrapper
// writes (runtime/capture.ts: one JSON line per finished request in `requests.jsonl`). The
// settle logic retries an inconclusive judgement only when a request finished within the last
// second; a quiet page is judged once (roadmap 2026-10-13 §4.5). Only the tail of the file is
// read: a long run's log can be large and the recent lines are at the end.

export const recentNetworkWindowMs = 1000;
const tailBytes = 64 * 1024;

function readTail(path: string): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// The latest `finishedAt` among the requests in the log tail, or null when none finished.
export function lastRequestFinishedAt(log: string): number | null {
  let latest: number | null = null;
  for (const line of log.split("\n")) {
    // The first line of a tail read may be cut; a parse failure skips it.
    if (!line.includes('"finishedAt"')) continue;
    try {
      const record = JSON.parse(line) as { finishedAt?: unknown };
      if (typeof record.finishedAt !== "string") continue;
      const at = Date.parse(record.finishedAt);
      if (Number.isNaN(at)) continue;
      if (latest === null || at > latest) latest = at;
    } catch {
      // cut or foreign line
    }
  }
  return latest;
}

export function hadRecentNetwork(options: { captureDir?: string | undefined; now?: number; windowMs?: number } = {}): boolean {
  const dir = options.captureDir ?? process.env.JL_CAPTURE_DIR;
  // Without a capture log nothing says the page is quiet: keep the retry.
  if (!dir) return true;
  const path = join(dir, "requests.jsonl");
  if (!existsSync(path)) return false;
  const latest = lastRequestFinishedAt(readTail(path));
  if (latest === null) return false;
  return (options.now ?? Date.now()) - latest <= (options.windowMs ?? recentNetworkWindowMs);
}
