import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ActionTrace, CacheReadResult, CacheStore, TraceEntry } from "e2e";

import { renderPlaywright } from "../cache/render";
import { takeoverSteps } from "./live";

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
      // Nothing done during a take-over is cached (design.md §5.4).
      if (candidates.some((candidate) => takeoverSteps().has(candidate.stepId))) return undefined;
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
      if (candidates.some((candidate) => takeoverSteps().has(candidate.stepId))) return undefined;
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

// ---------------------------------------------------------------------------------------------
// Assert checks (roadmap 2026-10-13 §4.1): the deterministic sibling of a UI script, keyed by
// transcript step id instead of e2e's key hash. Same two backends as the action store: the
// backend's `test_step_scripts` rows of kind `assert-check` through the run token, or a `checks/`
// directory next to the file store. Types are repeated here (no shared imports in the worker).
// ---------------------------------------------------------------------------------------------

export type AssertCheckLocator = { role: string; name: string } | { label: string } | { text: string } | { testId: string };

export type AssertCheck = {
  schemaVersion: "jl-assert-check-1";
  // null only with the `url` matcher.
  locator: AssertCheckLocator | null;
  matcher: "visible" | "text" | "url";
  expected: string | null;
  recordedAt: string;
};

export type CheckStore = {
  readonly writable: boolean;
  read(stepId: string): Promise<AssertCheck | null>;
  write(stepId: string, check: AssertCheck, meta: { instructionKey: string | null; renderedCode: string }): Promise<void>;
  // Marks the active check of the step stale; allowed in every mode that reads.
  stale(stepId: string, reason: string): Promise<void>;
};

export function isAssertCheck(value: unknown): value is AssertCheck {
  const check = value as Partial<AssertCheck> | null;
  if (typeof check !== "object" || check === null || check.schemaVersion !== "jl-assert-check-1") return false;
  if (!["visible", "text", "url"].includes(check.matcher as string)) return false;
  if (check.expected !== null && typeof check.expected !== "string") return false;
  if (check.locator === null) return check.matcher === "url";
  const locator = check.locator as Record<string, unknown> | undefined;
  if (typeof locator !== "object" || locator === null) return false;
  if ("role" in locator) return typeof locator.role === "string" && typeof locator.name === "string";
  return ["label", "text", "testId"].some((field) => typeof locator[field] === "string");
}

export function createBackendCheckStore(options: { apiUrl: string; runId: string; runToken: string; writable: boolean; fetch?: typeof fetch }): CheckStore {
  const fetchImpl = options.fetch ?? fetch;
  const url = (stepId: string) =>
    new URL(`/test-runs/${encodeURIComponent(options.runId)}/cache/check/${encodeURIComponent(stepId)}`, options.apiUrl);
  const headers = { authorization: `Bearer ${options.runToken}`, "content-type": "application/json" };
  const put = async (stepId: string, body: unknown) => {
    const response = await fetchImpl(url(stepId), { method: "PUT", headers, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`backend check write failed: HTTP ${response.status}`);
  };
  return {
    writable: options.writable,
    async read(stepId) {
      const response = await fetchImpl(url(stepId), { headers: { authorization: headers.authorization } });
      // A backend older than assert checks answers 404: no check, and nothing to write later.
      if (!response.ok) return null;
      const body = (await response.json()) as { status?: string; check?: unknown };
      return body.status === "hit" && isAssertCheck(body.check) ? body.check : null;
    },
    async write(stepId, check, meta) {
      if (!options.writable) return;
      await put(stepId, { check, instructionKey: meta.instructionKey, renderedCode: meta.renderedCode });
    },
    async stale(stepId, reason) {
      await put(stepId, { stale: true, reason });
    }
  };
}

export type CheckFile = {
  schemaVersion: "jl-step-check-1";
  stepId: string;
  instructionKey: string | null;
  environment: string | null;
  status: "active" | "stale";
  staleReason: string | null;
  renderedCode: string;
  check: AssertCheck;
};

export function createFileCheckStore(options: { dir: string; writable: boolean; environment?: string | null }): CheckStore {
  const pathFor = (stepId: string) => join(options.dir, `${stepId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  const readFile = (stepId: string): CheckFile | null => {
    const path = pathFor(stepId);
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckFile>;
      return isAssertCheck(file.check) && file.schemaVersion === "jl-step-check-1" ? (file as CheckFile) : null;
    } catch {
      return null;
    }
  };
  const save = (stepId: string, file: CheckFile) => {
    mkdirSync(options.dir, { recursive: true });
    writeFileSync(pathFor(stepId), `${JSON.stringify(file, null, 2)}\n`);
  };
  return {
    writable: options.writable,
    async read(stepId) {
      const file = readFile(stepId);
      return file && file.status === "active" ? file.check : null;
    },
    async write(stepId, check, meta) {
      if (!options.writable) return;
      save(stepId, {
        schemaVersion: "jl-step-check-1",
        stepId,
        instructionKey: meta.instructionKey,
        environment: options.environment ?? process.env.JL_ENV_NAME ?? null,
        status: "active",
        staleReason: null,
        renderedCode: meta.renderedCode,
        check
      });
    },
    async stale(stepId, reason) {
      const file = readFile(stepId);
      if (!file) return;
      save(stepId, { ...file, status: "stale", staleReason: reason });
    }
  };
}

// Picks the backend when the run carries a token (daemon runs), else the directory under the
// file store (`JL_CACHE_DIR/checks`). The writable flag follows the cache mode the runner set.
export function createJlCheckStore(options: { dir?: string; writable?: boolean } = {}): CheckStore {
  const writable = options.writable ?? process.env.JL_CACHE_MODE === "read-write";
  const apiUrl = process.env.JL_CACHE_API_URL;
  const runId = process.env.JL_RUN_ID;
  const runToken = process.env.JL_RUN_TOKEN;
  if (apiUrl && runId && runToken) return createBackendCheckStore({ apiUrl, runId, runToken, writable });
  return createFileCheckStore({ dir: options.dir ?? join(process.env.JL_CACHE_DIR ?? join(".e2e", "cache"), "checks"), writable });
}
