import { defineEngine } from "e2e/engine";
import { surfaceOf, web } from "@e2e-dev/web";

import { installInteractionLock, withLockLowered } from "./interaction-lock";
import { startLiveFrames, waitWhileTakenOver } from "./live";
import { writeStepLog } from "./step-log";

type EngineHandle = ReturnType<typeof web>;
type AnyFn = (...args: unknown[]) => Promise<unknown>;

declare global {
  // Inner web() handles, newest last; the generated test reads its page through them.
  var __jlEngines: EngineHandle[] | undefined;
}

// `web()` wrapped so each attempt records when the video started (step offsets are measured from
// it) and, for `--headed` runs, installs the interaction lock (design.md §5.4). The engine keeps
// web's name and version so cache keys are unchanged.
export function createJlEngine(options: { viewport: { width: number; height: number }; headed: boolean }) {
  const inner = web({ viewport: options.viewport });
  globalThis.__jlEngines = [...(globalThis.__jlEngines ?? []), inner];
  const { capabilities: _capabilities, ...rest } = inner as unknown as Record<string, unknown>;
  const startAttempt = rest.startAttempt as AnyFn | undefined;

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
      if (options.headed) {
        const surface = surfaceOf(inner);
        if (surface) await installInteractionLock(surface.context());
      }
      if (live) startLiveFrames(pageOf);
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
