import React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Hand, MousePointerClick, PauseCircle, Radio, Undo2 } from "lucide-react";
import type { TestRunDetail } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { cn } from "../lib/cn";
import { useAuthToken } from "../queries";
import { useToast } from "../toast";
import { useTestOrgId } from "../test-cases/org";
import { testQueryKeys } from "../test-cases/queries";
import { liveApi, type LiveFrame } from "./live-api";
import {
  LIVE_FRAME_INTERVAL_MS,
  LIVE_INPUT_FLUSH_MS,
  LIVE_WATCH_INTERVAL_MS,
  canTakeOver,
  LEAVE_CHORD_LABEL,
  coalesceInputs,
  containedRect,
  isLeaveChord,
  frameAge,
  keyToLiveInput,
  liveViewport,
  takeoverRole,
  toViewportPoint,
  wheelDeltaPixels,
  type LiveInput,
  type Rect,
  type Size
} from "./live-model";

// Live view of a running run (design.md §5.4, unit 2.3). While the panel is open it keeps the
// run "watched" (every 10 s) and fetches the latest frame every second. The requester, or someone
// with test_run.cancel_any, can take over: the agent pauses before its next action and the
// person's clicks, keys and scrolling are replayed in the run's browser, tagged user:takeover and
// never cached.

type ShownFrame = { url: string; frameAt: number; viewport: Size | null };

function useLiveFrames(runId: string, enabled: boolean): ShownFrame | null {
  const getToken = useAuthToken();
  const [frame, setFrame] = React.useState<ShownFrame | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    const watch = () => void liveApi.watch(getToken, runId).catch(() => undefined);
    watch();
    const timer = window.setInterval(watch, LIVE_WATCH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, getToken, runId]);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let busy = false;
    let lastAt = 0;
    const controller = new AbortController();
    const fetchFrame = () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      liveApi
        .frame(getToken, runId, controller.signal)
        .then((next: LiveFrame | null) => {
          if (cancelled || !next || next.frameAt === lastAt) return;
          lastAt = next.frameAt;
          const url = URL.createObjectURL(next.blob);
          setFrame((previous) => {
            if (previous) URL.revokeObjectURL(previous.url);
            return { url, frameAt: next.frameAt, viewport: next.viewport };
          });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    fetchFrame();
    const timer = window.setInterval(fetchFrame, LIVE_FRAME_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [enabled, getToken, runId]);

  React.useEffect(
    () => () => {
      setFrame((previous) => {
        if (previous) URL.revokeObjectURL(previous.url);
        return null;
      });
    },
    [runId]
  );
  return frame;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function useElementRect(ref: React.RefObject<HTMLElement | null>): Rect | null {
  const [rect, setRect] = React.useState<Rect | null>(null);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setRect({ left: 0, top: 0, width: box.width, height: box.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return rect;
}

// Buffers input briefly and sends it in order; typed characters are merged into one event.
function useInputSender(runId: string, active: boolean, onError: (error: unknown) => void) {
  const getToken = useAuthToken();
  const queue = React.useRef<LiveInput[]>([]);
  const timer = React.useRef<number | null>(null);
  const sending = React.useRef<Promise<unknown>>(Promise.resolve());

  const flush = React.useCallback(() => {
    timer.current = null;
    const events = coalesceInputs(queue.current.splice(0));
    if (events.length === 0) return;
    sending.current = sending.current.then(() => liveApi.input(getToken, runId, events).catch(onError));
  }, [getToken, onError, runId]);

  const send = React.useCallback(
    (event: LiveInput, immediate = false) => {
      if (!active) return;
      queue.current.push(event);
      if (immediate) {
        if (timer.current !== null) window.clearTimeout(timer.current);
        flush();
      } else if (timer.current === null) {
        timer.current = window.setTimeout(flush, LIVE_INPUT_FLUSH_MS);
      }
    },
    [active, flush]
  );

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  return { send, flush };
}

export function LiveViewPanel(props: { run: TestRunDetail; currentUserIds: readonly string[]; canCancelAny: boolean; fallback: React.ReactNode }): React.JSX.Element {
  const { run, currentUserIds } = props;
  const live = run.live;
  const toast = useToast();
  const queryClient = useQueryClient();
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const frame = useLiveFrames(run.id, Boolean(live?.available));
  const now = useNow(500);
    const stageRef = React.useRef<HTMLDivElement | null>(null);
  const releaseRef = React.useRef<HTMLButtonElement | null>(null);
  const stage = useElementRect(stageRef);
  const role = takeoverRole(live, currentUserIds);
  const holding = role === "mine";
  const mayTakeOver = canTakeOver(run, currentUserIds, props.canCancelAny);
  const [pending, setPending] = React.useState<"start" | "stop" | null>(null);
  const viewport = liveViewport(live, frame?.viewport ?? null);
  const shown = stage ? containedRect(stage, viewport) : null;
  const age = frameAge(frame?.frameAt ?? live?.frameAt ?? null, now);
  const current = run.steps.find((step) => step.stepId === run.currentStepId) ?? null;
  const paused = run.status === "paused" || Boolean(live?.paused);

  const reportInputError = React.useCallback(
    (error: unknown) => toast.error("Input not delivered", error instanceof Error ? error.message : undefined),
    [toast]
  );
  const { send, flush } = useInputSender(run.id, holding, reportInputError);
  const scroll = React.useRef<{ deltaY: number; x: number; y: number; timer: number | null }>({ deltaY: 0, x: 0, y: 0, timer: null });

  const takeover = async (action: "start" | "stop") => {
    setPending(action);
    try {
      if (action === "stop") flush();
      await liveApi.takeover(getToken, run.id, action);
      await queryClient.invalidateQueries({ queryKey: testQueryKeys.run(orgId, run.id) });
      if (action === "start") window.requestAnimationFrame(() => stageRef.current?.focus());
    } catch (error) {
      toast.error(action === "start" ? "Could not take over" : "Could not release", error instanceof Error ? error.message : undefined);
    } finally {
      setPending(null);
    }
  };

  const pointFrom = (event: { clientX: number; clientY: number }) => {
    const element = stageRef.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return toViewportPoint(event, { left: box.left, top: box.top, width: box.width, height: box.height }, viewport);
  };

  const onClick = (event: React.MouseEvent) => {
    if (!holding) return;
    stageRef.current?.focus();
    const point = pointFrom(event);
    if (point) send({ kind: "click", ...point, button: "left", double: false }, true);
  };
  const onContextMenu = (event: React.MouseEvent) => {
    if (!holding) return;
    event.preventDefault();
    const point = pointFrom(event);
    if (point) send({ kind: "click", ...point, button: "right", double: false }, true);
  };
  const onWheel = (event: React.WheelEvent) => {
    if (!holding) return;
    const point = pointFrom(event);
    if (!point) return;
    const pending = scroll.current;
    pending.deltaY += wheelDeltaPixels(event.deltaY, event.deltaMode);
    pending.x = point.x;
    pending.y = point.y;
    if (pending.timer === null) {
      pending.timer = window.setTimeout(() => {
        const { deltaY, x, y } = scroll.current;
        scroll.current = { deltaY: 0, x, y, timer: null };
        if (deltaY !== 0) send({ kind: "scroll", x, y, deltaY }, true);
      }, 120);
    }
  };
    const onKeyDown = (event: React.KeyboardEvent) => {
    if (!holding) return;
    const keys = { key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey };
    if (isLeaveChord(keys)) {
      event.preventDefault();
      releaseRef.current?.focus();
      return;
    }
    const input = keyToLiveInput({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing
    });
    if (!input) return;
    event.preventDefault();
    send(input, input.kind === "press");
  };

  if (!live?.available) return <>{props.fallback}</>;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#0d0e10] text-white/85">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/10 px-4 py-2 text-[12.5px]">
        <span className="inline-flex items-center gap-1.5 font-semibold text-white">
          <Radio className={cn("size-3.5", age.stale ? "text-white/40" : "text-red-400")} aria-hidden />
          Live
        </span>
        <span className="text-white/55" aria-live="off">
          frame {age.label} · {viewport.width}×{viewport.height}
        </span>
                {live.framesHidden ? (
          <span className="text-[11.5px] text-white/55">frames hidden after a secret was entered</span>
        ) : null}
        {paused ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[11.5px] font-semibold text-amber-200">
            <PauseCircle className="size-3.5" aria-hidden /> paused
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {holding ? (
                        <Button ref={releaseRef} size="xs" variant="secondary" className="jl-tc-press" disabled={pending !== null} onClick={() => void takeover("stop")}>
              <Undo2 aria-hidden /> {pending === "stop" ? "Releasing…" : "Release"}
            </Button>
          ) : mayTakeOver ? (
            <Button size="xs" className="jl-tc-press" disabled={pending !== null} onClick={() => void takeover("start")}>
              <Hand aria-hidden /> {pending === "start" ? "Taking over…" : "Take over"}
            </Button>
          ) : null}
        </span>
      </div>

      {holding ? (
        <div role="status" className="jl-tc-enter flex items-center gap-2 border-b border-amber-300/30 bg-amber-300/12 px-4 py-2 text-[13px] text-amber-100">
          <MousePointerClick className="size-4 shrink-0" aria-hidden />
                    <span>
            <strong className="font-semibold">Paused: you control the browser.</strong> Nothing you do is cached. Keys go to the run;{" "}
            <kbd className="rounded border border-amber-200/40 px-1 font-mono text-[11.5px]">{LEAVE_CHORD_LABEL}</kbd> moves focus to Release.
          </span>
        </div>
      ) : role === "other" ? (
        <div role="status" className="jl-tc-enter border-b border-white/10 bg-white/5 px-4 py-2 text-[13px] text-white/75">
          Paused: someone else controls the browser.
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 p-4">
        <div
          ref={stageRef}
          role={holding ? "application" : "img"}
                    aria-label={
            holding
              ? `Remote browser. Clicks, keys and scrolling go to the run. Press ${LEAVE_CHORD_LABEL} to move focus to Release.`
              : "Live view of the run's browser"
          }
          aria-roledescription={holding ? "remote browser" : undefined}
          tabIndex={holding ? 0 : -1}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onWheel={onWheel}
          onKeyDown={onKeyDown}
          className={cn(
            "absolute inset-4 outline-none",
            holding && "cursor-crosshair focus-visible:ring-2 focus-visible:ring-amber-300/70"
          )}
        >
          {frame && shown ? (
            <img
              src={frame.url}
              alt={current ? `Live frame during: ${current.label}` : "Live frame"}
              draggable={false}
              className={cn("absolute select-none rounded-md border shadow-2xl", holding ? "border-amber-300/60" : "border-white/10")}
              style={{ left: shown.left, top: shown.top, width: shown.width, height: shown.height }}
            />
          ) : (
            <p className="grid h-full place-items-center text-[13.5px] text-white/60">Waiting for the first frame…</p>
          )}
        </div>
      </div>

      <p className="flex items-center gap-2 border-t border-white/10 px-4 py-2 text-[13px] text-white/70" aria-live="polite">
        {current ? (
          <>
            {run.status === "paused" ? (
              <span className="rounded bg-amber-300/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-amber-200">step paused</span>
            ) : (
              <span className="jl-tc-pulse inline-block size-2 rounded-full bg-primary" aria-hidden />
            )}
            <span className="truncate">
              {current.ordinal}. {current.label}
            </span>
          </>
        ) : (
          <span>{paused ? "Paused before the next step." : "Starting…"}</span>
        )}
      </p>
    </div>
  );
}
