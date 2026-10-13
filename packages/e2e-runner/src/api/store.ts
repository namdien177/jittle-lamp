import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ApiRequestScript } from "@jittle-lamp/shared";

// Where API scripts live (roadmap 2026-10-13 §2.3 step 5): a `test_step_scripts` row of kind
// `api-requests` on the backend for daemon runs (per-run token, same stale and version rules as
// UI scripts), or one JSON file per step under `<cache dir>/api` for local runs. Both the runner
// (after a run) and the worker (marking a script stale on hand-off) use this module, so it keeps
// to type imports from shared.

export type ApiScriptFile = {
  schemaVersion: "jl-api-script-file-1";
  stepId: string;
  environment: string | null;
  status: "active" | "stale";
  staleReason: string | null;
  recordedAt: string;
  script: ApiRequestScript;
};

export type ApiScriptStore = {
  read: (stepId: string) => Promise<ApiRequestScript | null>;
  write: (script: ApiRequestScript) => Promise<void>;
  markStale: (stepId: string, reason: string) => Promise<void>;
};

const fileName = (stepId: string) => `${stepId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

export function createFileApiScriptStore(options: { dir: string; environment?: string | null }): ApiScriptStore {
  const pathFor = (stepId: string) => join(options.dir, "api", fileName(stepId));
  const readFile = (stepId: string): ApiScriptFile | null => {
    const path = pathFor(stepId);
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as Partial<ApiScriptFile>;
      if (file.schemaVersion !== "jl-api-script-file-1" || !file.script) return null;
      return file as ApiScriptFile;
    } catch {
      return null;
    }
  };
  return {
    async read(stepId) {
      const file = readFile(stepId);
      // A stale script is kept for the reviewer; it is not replayed.
      if (!file || file.status !== "active") return null;
      return file.script;
    },
    async write(script) {
      mkdirSync(join(options.dir, "api"), { recursive: true });
      const file: ApiScriptFile = {
        schemaVersion: "jl-api-script-file-1",
        stepId: script.stepId,
        environment: options.environment ?? process.env.JL_ENV_NAME ?? null,
        status: "active",
        staleReason: null,
        recordedAt: script.recordedAt,
        script
      };
      writeFileSync(pathFor(script.stepId), `${JSON.stringify(file, null, 2)}\n`);
    },
    async markStale(stepId, reason) {
      const file = readFile(stepId);
      if (!file) return;
      writeFileSync(pathFor(stepId), `${JSON.stringify({ ...file, status: "stale", staleReason: reason }, null, 2)}\n`);
    }
  };
}

export function createBackendApiScriptStore(options: { apiUrl: string; runId: string; runToken: string; fetch?: typeof fetch }): ApiScriptStore {
  const fetchImpl = options.fetch ?? fetch;
  const url = (stepId: string) => new URL(`/test-runs/${encodeURIComponent(options.runId)}/cache/api/${encodeURIComponent(stepId)}`, options.apiUrl);
  const headers = { authorization: `Bearer ${options.runToken}`, "content-type": "application/json" };
  return {
    async read(stepId) {
      const response = await fetchImpl(url(stepId), { headers: { authorization: headers.authorization } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`API script read failed: HTTP ${response.status}`);
      const body = (await response.json()) as { status?: string; script?: ApiRequestScript };
      return body.status === "hit" && body.script ? body.script : null;
    },
    async write(script) {
      const response = await fetchImpl(url(script.stepId), { method: "PUT", headers, body: JSON.stringify({ script }) });
      if (!response.ok) throw new Error(`API script write failed: HTTP ${response.status}`);
    },
    async markStale(stepId, reason) {
      const response = await fetchImpl(url(stepId), { method: "PUT", headers, body: JSON.stringify({ stale: true, reason }) });
      if (!response.ok) throw new Error(`API script stale mark failed: HTTP ${response.status}`);
    }
  };
}

// The store a process uses: the backend when a run token is present, else the local directory.
export function createApiScriptStoreFromEnv(env: Readonly<Record<string, string | undefined>>, fallbackDir: string | null): ApiScriptStore | null {
  if (env.JL_CACHE_API_URL && env.JL_RUN_ID && env.JL_RUN_TOKEN) {
    return createBackendApiScriptStore({ apiUrl: env.JL_CACHE_API_URL, runId: env.JL_RUN_ID, runToken: env.JL_RUN_TOKEN });
  }
  const dir = env.JL_API_CACHE_DIR ?? fallbackDir;
  return dir ? createFileApiScriptStore({ dir, environment: env.JL_ENV_NAME ?? null }) : null;
}
