import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ActionTrace, CacheReadResult, CacheStore, TraceEntry } from "e2e";

import { renderPlaywright } from "../cache/render";

// File-backed `cache.store` (handover 0.4): one JSON file per e2e cache key in `.e2e/cache`. The
// e2e record is stored untouched under `entry`; alongside it the runner keeps which transcript step
// the record belongs to and the rendered Playwright view. The step mapping comes from an index the
// runner writes before the run: instructionDigest → { stepId, instructionKey }.

export type StepScriptFile = {
  schemaVersion: "jl-step-script-1";
  keyHash: string;
  stepId: string | null;
  // Every step with this instruction (repeated lines share one e2e digest).
  stepIds: string[];
  instructionKey: string | null;
  environment: string | null;
  recordedAt: string;
  renderedCode: string;
  entry: TraceEntry;
};

export type CacheIndex = Record<string, Array<{ stepId: string; instructionKey: string }>>;

function readIndex(path: string | undefined): CacheIndex {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as CacheIndex;
}

export function isTraceEntry(value: unknown): value is TraceEntry {
  const entry = value as Partial<TraceEntry> | null;
  return (
    typeof entry === "object" &&
    entry !== null &&
    entry.schemaVersion === "trace-1" &&
    typeof entry.createdAt === "string" &&
    typeof entry.payload === "object" &&
    entry.payload !== null &&
    Array.isArray(entry.payload.actions)
  );
}

// Backend-backed store (handover 1b.2): with a run token, entries live in the case's
// test_step_scripts on the backend instead of a local directory. No shared imports here: this
// module runs inside the e2e worker.
export function createBackendCacheStore(options: {
  apiUrl: string;
  runId: string;
  runToken: string;
  writable: boolean;
  indexPath?: string;
  fetch?: typeof fetch;
}): CacheStore {
  const fetchImpl = options.fetch ?? fetch;
  const url = (keyHash: string) =>
    new URL(`/test-runs/${encodeURIComponent(options.runId)}/cache/${encodeURIComponent(keyHash)}`, options.apiUrl);
  const headers = { authorization: `Bearer ${options.runToken}` };
  return {
    writable: options.writable,
    async read(keyHash: string): Promise<CacheReadResult> {
      const response = await fetchImpl(url(keyHash), { headers });
      if (response.status === 404) return { status: "miss" };
      if (!response.ok) return { status: "invalid", reason: `backend cache read failed: HTTP ${response.status}` };
      const body = (await response.json()) as { status?: string; entry?: unknown };
      if (body.status !== "hit") return { status: "miss" };
      if (!isTraceEntry(body.entry)) return { status: "invalid", reason: "backend returned a malformed entry" };
      return { status: "hit", entry: body.entry, bytes: JSON.stringify(body.entry).length };
    },
    async write(keyHash: string, payload: ActionTrace) {
      if (!options.writable) return undefined;
      const index = readIndex(options.indexPath ?? process.env.JL_CACHE_INDEX);
      const digest = payload.recordedFor?.instructionDigest;
      const candidates = digest ? (index[digest] ?? []) : [];
      const entry: TraceEntry = { schemaVersion: "trace-1", createdAt: new Date().toISOString(), payload };
      const body = JSON.stringify({
        entry,
        stepIds: candidates.map((candidate) => candidate.stepId),
        instructionKey: candidates[0]?.instructionKey ?? null,
        renderedCode: renderPlaywright(payload)
      });
      const response = await fetchImpl(url(keyHash), { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body });
      if (!response.ok) throw new Error(`backend cache write failed: HTTP ${response.status}`);
      return { bytes: body.length };
    }
  };
}

export function createJlCacheStore(options: { dir: string; writable: boolean; indexPath?: string; environment?: string | null }): CacheStore {
  const apiUrl = process.env.JL_CACHE_API_URL;
  const runId = process.env.JL_RUN_ID;
  const runToken = process.env.JL_RUN_TOKEN;
  if (apiUrl && runId && runToken) {
    return createBackendCacheStore({ apiUrl, runId, runToken, writable: options.writable, ...(options.indexPath ? { indexPath: options.indexPath } : {}) });
  }
  return createFileCacheStore(options);
}

export function createFileCacheStore(options: { dir: string; writable: boolean; indexPath?: string; environment?: string | null }): CacheStore {
  const pathFor = (keyHash: string) => join(options.dir, `${keyHash.replace(/[^A-Za-z0-9_-]/g, "")}.json`);
  return {
    writable: options.writable,
    async read(keyHash: string): Promise<CacheReadResult> {
      const path = pathFor(keyHash);
      if (!existsSync(path)) return { status: "miss" };
      const raw = readFileSync(path, "utf8");
      try {
        const file = JSON.parse(raw) as Partial<StepScriptFile>;
        if (!isTraceEntry(file.entry)) return { status: "invalid", reason: "not a jl step script", bytes: raw.length };
        return { status: "hit", entry: file.entry, bytes: raw.length };
      } catch (error) {
        return { status: "invalid", reason: error instanceof Error ? error.message : "unreadable", bytes: raw.length };
      }
    },
    async write(keyHash: string, payload: ActionTrace) {
      if (!options.writable) return undefined;
      mkdirSync(options.dir, { recursive: true });
      const index = readIndex(options.indexPath ?? process.env.JL_CACHE_INDEX);
      const digest = payload.recordedFor?.instructionDigest;
      const candidates = digest ? (index[digest] ?? []) : [];
      const step = candidates[0];
      const file: StepScriptFile = {
        schemaVersion: "jl-step-script-1",
        keyHash,
        stepId: step?.stepId ?? null,
        stepIds: candidates.map((candidate) => candidate.stepId),
        instructionKey: step?.instructionKey ?? null,
        environment: options.environment ?? process.env.JL_ENV_NAME ?? null,
        recordedAt: new Date().toISOString(),
        renderedCode: renderPlaywright(payload),
        entry: { schemaVersion: "trace-1", createdAt: new Date().toISOString(), payload }
      };
      const body = `${JSON.stringify(file, null, 2)}\n`;
      writeFileSync(pathFor(keyHash), body);
      return { bytes: body.length };
    },
    async delete(keyHash: string) {
      rmSync(pathFor(keyHash), { force: true });
    }
  };
}
