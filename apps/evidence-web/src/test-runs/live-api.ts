import { z } from "zod/v4";
import { liveStateSchema, type LiveState } from "@jittle-lamp/shared";

import type { FetchToken } from "../api";
import { apiOrigin } from "../env";
import type { LiveInput, Size } from "./live-model";

// Client for the live view routes (packages/shared/src/test-live.ts). Frames are fetched with the
// session token and shown through object URLs, so no frame URL is ever shareable.

export class LiveApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "LiveApiError";
    this.status = status;
    this.code = code;
  }
}

async function call(getToken: FetchToken, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("Sign in is required.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    throw new LiveApiError(payload?.error?.message ?? `Request failed (${response.status}).`, response.status, payload?.error?.code ?? null);
  }
  return response;
}

const runPath = (runId: string) => `/test-runs/${encodeURIComponent(runId)}/live`;

export type LiveFrame = { blob: Blob; frameAt: number; viewport: Size | null };

const inputResponseSchema = z.object({ accepted: z.number().int(), lastSeq: z.number().int().nullable() });

export const liveApi = {
  watch: async (getToken: FetchToken, runId: string): Promise<LiveState> =>
    liveStateSchema.parse(await (await call(getToken, `${runPath(runId)}/watch`, { method: "POST", body: "{}" })).json()),

  // null until the runner has sent a frame (404).
  frame: async (getToken: FetchToken, runId: string, signal?: AbortSignal): Promise<LiveFrame | null> => {
    try {
      const response = await call(getToken, `${runPath(runId)}/frame`, signal ? { signal, cache: "no-store" } : { cache: "no-store" });
      const width = Number(response.headers.get("x-frame-width"));
      const height = Number(response.headers.get("x-frame-height"));
      return {
        blob: await response.blob(),
        frameAt: Number(response.headers.get("x-frame-at")) || Date.now(),
        viewport: width > 0 && height > 0 ? { width, height } : null
      };
    } catch (error) {
      if (error instanceof LiveApiError && error.status === 404) return null;
      throw error;
    }
  },

  takeover: async (getToken: FetchToken, runId: string, action: "start" | "stop"): Promise<LiveState> =>
    liveStateSchema.parse(await (await call(getToken, `${runPath(runId)}/takeover`, { method: "POST", body: JSON.stringify({ action }) })).json()),

  input: async (getToken: FetchToken, runId: string, events: readonly LiveInput[]) =>
    inputResponseSchema.parse(await (await call(getToken, `${runPath(runId)}/input`, { method: "POST", body: JSON.stringify({ events }) })).json())
};
