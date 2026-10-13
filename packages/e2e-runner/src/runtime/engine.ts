import { defineEngine } from "e2e/engine";
import { surfaceOf, web } from "@e2e-dev/web";

import { installCaptureFromEnv, type CaptureHandle } from "./capture";
import { installInteractionLock, withLockLowered } from "./interaction-lock";
import { startLiveFrames, waitWhileTakenOver } from "./live";
import { closeQueryConnections } from "./query";
import { writeStepLog } from "./step-log";

type EngineHandle = ReturnType<typeof web>;
type AnyFn = (...args: unknown[]) => Promise<unknown>;

declare global {
  // Inner web() handles, newest last; the generated test reads its page through them.
  var __jlEngines: EngineHandle[] | undefined;
}

// `web()` wrapped so each attempt records when it started (the fallback anchor for step offsets),
// captures network, console and navigations for the session archive (e2e 0.19 removed the
// Playwright trace), and, for `--headed` runs, installs the interaction lock (design.md §5.4).
// The engine keeps web's name and version so cache keys are unchanged.
export function createJlEngine(options: { viewport: { width: number; height: number }; headed: boolean }) {
  const inner = web({ viewport: options.viewport });
  globalThis.__jlEngines = [...(globalThis.__jlEngines ?? []), inner];
  const { capabilities: _capabilities, ...rest } = inner as unknown as Record<string, unknown>;
  const startAttempt = rest.startAttempt as AnyFn | undefined;
  const endAttempt = rest.endAttempt as AnyFn | undefined;
  let capture: CaptureHandle | null = null;

  const pageOf = () => {
    try {
      return surfaceOf(inner)?.page() ?? null;
    } catch {
      return null;
    }
  };
  const live = Boolean(process.env.JL_LIVE_DIR);

  // Every engine action first waits out a live take-over; headed runs also lower the shield.
  const lowered = (name: "perform" | "performAt"): Record<string, AnyFn> => {
    const original = rest[name] as AnyFn | undefined;
    if ((!options.headed && !live) || !original) return {};
    return {
      [name]: async (...args: unknown[]) => {
        if (live) await waitWhileTakenOver(pageOf);
        const page = pageOf();
        return options.headed && page ? withLockLowered(page, () => original(...args)) : original(...args);
      }
    };
  };

  return defineEngine({
    ...rest,
    ...lowered("perform"),
    ...lowered("performAt"),
    async startAttempt(ctx: unknown) {
      await startAttempt?.(ctx);
      const at = new Date().toISOString();
      writeStepLog({ type: "attempt-started", at, videoStartedAt: at });
      const surface = surfaceOf(inner);
      // The context exists from here; the page only from the first open, so capture listens on
      // the context and picks pages up as they appear.
      if (surface) capture = installCaptureFromEnv(surface.context());
      if (options.headed && surface) await installInteractionLock(surface.context());
      if (live) startLiveFrames(pageOf);
    },
    async endAttempt(ctx: unknown) {
      // Body reads still in flight finish before the context closes under them.
      await capture?.flush();
      capture = null;
      // [Query] connections live for one attempt (roadmap §5.2).
      await closeQueryConnections();
      return endAttempt?.(ctx);
    }
  } as never) as EngineHandle;
}

export function currentPage() {
  for (const engine of [...(globalThis.__jlEngines ?? [])].reverse()) {
    try {
      const page = surfaceOf(engine)?.page();
      if (page) return page;
    } catch {
      // not the live instance
    }
  }
  return null;
}
