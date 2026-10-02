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
  instructionKey: string | null;
  environment: string | null;
  recordedAt: string;
  renderedCode: string;
  entry: TraceEntry;
};

export type CacheIndex = Record<string, { stepId: string; instructionKey: string }>;

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

export function createJlCacheStore(options: { dir: string; writable: boolean; indexPath?: string; environment?: string | null }): CacheStore {
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
      const step = digest ? index[digest] : undefined;
      const file: StepScriptFile = {
        schemaVersion: "jl-step-script-1",
        keyHash,
        stepId: step?.stepId ?? null,
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
