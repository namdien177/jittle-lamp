import { existsSync, readFileSync } from "node:fs";

import type { ApiPolicy, ApiRequestScript } from "@jittle-lamp/shared";

import { createApiScriptStoreFromEnv } from "../api/store";
import { ApiReplayHandoff, replayApi, type ReplayStore } from "./api-replay";
import { currentPage } from "./engine";
import { getOutput, outputText } from "./outputs";
import { writeStepLog } from "./step-log";

// `jl.replayApiOrFallback` (roadmap 2026-10-13 §2.4): the generated test calls this for a step
// whose effective mode is API. The runner resolved the step's active API script before the run
// (JL_API_SCRIPTS); the script replays with the browser's cookies, and a failed check hands the
// step to the UI call, marking the script stale. Runs inside the e2e worker.

type ApiStepsFile = {
  apiOrigins: string[];
  apiPolicy: ApiPolicy & { authHeaders?: string[]; authStorageKeys?: string[] };
  scripts: Record<string, ApiRequestScript>;
};

let loaded: ApiStepsFile | null = null;
const store: ReplayStore = new Map();

function apiSteps(): ApiStepsFile {
  if (loaded) return loaded;
  const path = process.env.JL_API_SCRIPTS;
  loaded = { apiOrigins: [], apiPolicy: { allowedPaths: [], maxRequestsPerStep: 50, rateLimitPerSecond: 10 }, scripts: {} };
  if (path && existsSync(path)) {
    try {
      loaded = { ...loaded, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<ApiStepsFile>) };
    } catch {
      // Unreadable: every API step runs through the UI.
    }
  }
  return loaded;
}

function paramValue(name: string): string | undefined {
  const output = getOutput(name);
  if (output !== undefined) return outputText(output);
  const env = process.env[`JL_VAR_${name}`];
  return env;
}

export async function replayApiOrFallback(stepId: string, ui: () => Promise<unknown>): Promise<unknown> {
  const config = apiSteps();
  const script = config.scripts[stepId];
  // No active script for the step: nothing to replay, the UI runs as it always did.
  if (!script) return ui();
  const page = currentPage();
  // The browser session is the auth source; without a page there are no cookies to send.
  if (!page) return ui();
  const context = page.context();
  try {
    const result = await replayApi(script, {
      stepId,
      baseUrl: process.env.JL_ENV_BASE_URL ?? null,
      apiOrigins: config.apiOrigins,
      apiPolicy: config.apiPolicy,
      fetch,
      cookies: async () => (await context.cookies()).map((cookie) => ({ name: cookie.name, value: cookie.value })),
      bearerToken: async () => {
        for (const key of config.apiPolicy.authStorageKeys ?? []) {
          const value = await page.evaluate((name: string) => window.localStorage.getItem(name), key).catch(() => null);
          if (value) return value;
        }
        return null;
      },
      param: paramValue,
      store,
      onSetCookie: async (cookies) => {
        await context.addCookies(cookies.map((cookie) => ({ name: cookie.name, value: cookie.value, url: cookie.url })));
      }
    });
    writeStepLog({ type: "api-replay", at: new Date().toISOString(), stepId, outcome: "replayed", count: result.count, mutations: result.mutations, items: result.items, seq: null, reason: null });
    return { summary: `${result.count} request${result.count === 1 ? "" : "s"} replayed (${result.mutations} mutation${result.mutations === 1 ? "" : "s"})` };
  } catch (error) {
    if (!(error instanceof ApiReplayHandoff)) throw error;
    writeStepLog({
      type: "api-replay",
      at: new Date().toISOString(),
      stepId,
      outcome: "handoff",
      count: error.items.length,
      mutations: error.items.filter((item) => item.mutation).length,
      items: error.items,
      seq: error.seq,
      reason: error.reason
    });
    // The script no longer matches the app: stale, as updateStepScripts does for UI scripts.
    const scriptStore = createApiScriptStoreFromEnv(process.env, process.env.JL_API_CACHE_DIR ?? null);
    await scriptStore?.markStale(stepId, `API replay stopped at request ${error.seq}: ${error.reason}`).catch(() => undefined);
    return ui();
  }
}
