import React, { useEffect, useRef, useState } from "react";
import { ArrowLeftRight, MousePointer2, MousePointerClick, Pause, Play, Terminal } from "lucide-react";

import { cn } from "../../lib/cn";
import { useInView, usePrefersReducedMotion } from "./use-in-view";

/**
 * A scripted checkout bug, replayed the way the real viewer shows evidence: the
 * page on the left, the event stream on the right, one shared clock underneath.
 * Everything is derived from `t`, so scrubbing and clicking rows just move `t`.
 */

const DURATION = 9.5;

type Kind = "action" | "network" | "console";
type Tone = "ok" | "err" | "warn";

type DemoEvent = {
  t: number;
  kind: Kind;
  label: string;
  meta: string;
  tone?: Tone;
  detail: Array<[string, string]>;
};

const EVENTS: DemoEvent[] = [
  { t: 0.1, kind: "action", label: "Navigate", meta: "/checkout", detail: [["url", "https://acme.shop/checkout"], ["frame", "0:00.1"]] },
  { t: 0.3, kind: "network", label: "GET /api/cart", meta: "200 · 38ms", detail: [["status", "200 OK · 38ms"], ["response", '{"items":1,"total":48}']] },
  { t: 1.6, kind: "action", label: "Click", meta: 'button "+"', detail: [["selector", 'button[aria-label="Increase qty"]'], ["frame", "0:01.6"]] },
  { t: 1.7, kind: "network", label: "PATCH /api/cart", meta: "200 · 51ms", detail: [["status", "200 OK · 51ms"], ["request", '{"qty":2}']] },
  { t: 2.5, kind: "action", label: "Click", meta: 'input "Promo code"', detail: [["selector", 'input[name="promo"]'], ["frame", "0:02.5"]] },
  { t: 3.3, kind: "action", label: "Type", meta: "•••••• (redacted)", detail: [["value", "redacted at capture, never stored"], ["frame", "0:03.3"]] },
  { t: 3.5, kind: "network", label: "POST /api/promo", meta: "200 · 64ms", detail: [["status", "200 OK · 64ms"], ["response", '{"discount":0.1}']] },
  { t: 4.4, kind: "action", label: "Click", meta: 'button "Place order"', detail: [["selector", 'button[name="place-order"]'], ["frame", "0:04.4"]] },
  { t: 4.6, kind: "network", label: "POST /api/orders", meta: "500 · 212ms", tone: "err", detail: [["status", "500 Internal Server Error · 212ms"], ["response", '{"error":"cart.total is undefined"}']] },
  { t: 4.7, kind: "console", label: "TypeError", meta: "reading 'total' of undefined", tone: "err", detail: [["message", "Cannot read properties of undefined (reading 'total')"], ["stack", "at submitOrder (checkout.tsx:88:21)"]] },
  { t: 6.8, kind: "action", label: "Click", meta: 'button "Place order"', detail: [["selector", 'button[name="place-order"]'], ["frame", "0:06.8"]] },
  { t: 7.0, kind: "network", label: "POST /api/orders", meta: "500 · 198ms", tone: "err", detail: [["status", "500 Internal Server Error · 198ms"], ["response", '{"error":"cart.total is undefined"}']] },
  { t: 7.1, kind: "console", label: "warn", meta: "retry limit reached", tone: "warn", detail: [["message", "checkout: retry limit reached"], ["stack", "at retryOrder (checkout.tsx:112:9)"]] },
];

const CLICKS = [1.6, 2.5, 4.4, 6.8];

/** Cursor waypoints in % of the page; it holds still between `t` and the next move. */
const PATH: Array<{ t: number; x: number; y: number }> = [
  { t: 0, x: 34, y: 90 },
  { t: 1.35, x: 49.5, y: 31 },
  { t: 1.9, x: 49.5, y: 31 },
  { t: 2.35, x: 21, y: 57 },
  { t: 3.9, x: 21, y: 57 },
  { t: 4.3, x: 78, y: 75 },
  { t: 8.2, x: 78, y: 75 },
  { t: 9.5, x: 34, y: 90 },
];

function easeInOut(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function cursorAt(t: number): { x: number; y: number } {
  for (let i = 0; i < PATH.length - 1; i++) {
    const a = PATH[i]!;
    const b = PATH[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const p = easeInOut((t - a.t) / Math.max(b.t - a.t, 0.0001));
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
    }
  }
  const last = PATH[PATH.length - 1]!;
  return { x: last.x, y: last.y };
}

function formatT(t: number): string {
  const tenths = Math.floor(Math.max(0, t) * 10 + 1e-6);
  return `0:${String(Math.floor(tenths / 10)).padStart(2, "0")}.${tenths % 10}`;
}

const KIND_ICON: Record<Kind, React.ReactNode> = {
  action: <MousePointerClick aria-hidden />,
  network: <ArrowLeftRight aria-hidden />,
  console: <Terminal aria-hidden />,
};

function markerColor(event: DemoEvent): string {
  if (event.tone === "err") return "bg-[#ff4d5e]";
  if (event.tone === "warn") return "bg-warning";
  if (event.kind === "network") return "bg-[#5eb1ff]";
  return "bg-foreground/50";
}

function FakeCheckout({ t }: { t: number }): React.JSX.Element {
  const qty = t >= 1.6 ? 2 : 1;
  const typed = "SPRING".slice(0, Math.max(0, Math.min(6, Math.floor((t - 2.6) / 0.11))));
  const focused = t >= 2.5 && t < 4.4;
  const discounted = t >= 3.5;
  const subtotal = 48 * qty;
  const total = discounted ? subtotal * 0.9 : subtotal;
  const pending = (t >= 4.4 && t < 4.6) || (t >= 6.8 && t < 7.0);
  const error = (t >= 4.7 && t < 6.8) || t >= 7.1;
  const secondError = t >= 7.1;
  const cursor = cursorAt(t);
  const lastClick = CLICKS.filter((c) => c <= t).pop();
  const sinceClick = lastClick === undefined ? Infinity : t - lastClick;
  const pressed = sinceClick < 0.14;

  return (
    <div className="relative h-full w-full select-none overflow-hidden bg-[#f6f5f1] text-[#1d1d1b] [font-size:clamp(9px,1.25vw,13px)]">
      <div className="absolute inset-x-0 top-0 flex h-[12%] items-center justify-between border-b border-black/[0.07] px-[5%]">
        <span className="font-bold tracking-tight">acme<span className="text-[#178a42]">.</span>shop</span>
        <span className="text-black/45">Checkout</span>
      </div>

      <div className="absolute left-[5%] top-[19%] flex h-[22%] w-[52%] items-center gap-[4%] rounded-[0.6em] border border-black/[0.07] bg-white px-[3%]">
        <div className="aspect-square h-[70%] rounded-[0.5em] bg-[radial-gradient(circle_at_35%_30%,#cfe8d6,#7fb38f)]" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">Lamp shade, moss</div>
          <div className="text-black/45">$48.00</div>
        </div>
        <div className="flex items-center gap-[0.5em] rounded-[0.5em] border border-black/10 px-[0.5em] py-[0.2em] tabular-nums">
          <span className="text-black/40">−</span>
          <span className="w-[1em] text-center font-medium">{qty}</span>
          <span className={cn("rounded px-[0.25em]", pressed && lastClick === 1.6 && "bg-black/10")}>+</span>
        </div>
      </div>

      <div className="absolute left-[5%] top-[50%] flex h-[13%] w-[52%] items-center gap-[3%]">
        <div
          className={cn(
            "flex h-full flex-1 items-center rounded-[0.5em] border bg-white px-[0.8em] font-mono tracking-wider",
            focused ? "border-[#178a42] ring-2 ring-[#178a42]/20" : "border-black/10"
          )}
        >
          {typed || <span className="font-sans tracking-normal text-black/35">Promo code</span>}
          {focused && t >= 2.6 && t < 3.4 ? <span className="ml-px h-[1.1em] w-px animate-pulse bg-black/70" /> : null}
        </div>
        <span className={cn("rounded-[0.5em] px-[0.8em] py-[0.5em] font-medium", discounted ? "bg-[#178a42]/10 text-[#178a42]" : "bg-black/[0.05] text-black/50")}>
          {discounted ? "Applied" : "Apply"}
        </span>
      </div>

      <div className="absolute right-[5%] top-[19%] flex h-[68%] w-[33%] flex-col gap-[0.6em] rounded-[0.6em] border border-black/[0.07] bg-white p-[4%]">
        <div className="font-semibold">Summary</div>
        <div className="flex justify-between text-black/55"><span>Subtotal</span><span className="tabular-nums">${subtotal.toFixed(2)}</span></div>
        <div className="flex justify-between text-black/55">
          <span>Promo</span>
          <span className="tabular-nums">{discounted ? `−$${(subtotal * 0.1).toFixed(2)}` : "—"}</span>
        </div>
        <div className="mt-auto flex justify-between border-t border-black/[0.07] pt-[0.6em] font-semibold">
          <span>Total</span><span className="tabular-nums">${total.toFixed(2)}</span>
        </div>
        <div
          className={cn(
            "flex h-[22%] items-center justify-center rounded-[0.5em] bg-[#1d1d1b] font-semibold text-white transition-transform duration-100",
            pressed && (lastClick === 4.4 || lastClick === 6.8) && "scale-[0.97]"
          )}
        >
          {pending ? <span className="size-[1em] animate-spin rounded-full border-2 border-white/30 border-t-white" /> : "Place order"}
        </div>
      </div>

      <div
        className={cn(
          "absolute bottom-[5%] left-[5%] flex w-[52%] items-center gap-[0.6em] rounded-[0.6em] border border-[#e5484d]/30 bg-[#fff1f1] px-[0.9em] py-[0.6em] text-[#b4232a] shadow-sm transition-[opacity,transform] duration-200 ease-out",
          error ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
        )}
      >
        <span className="grid size-[1.3em] shrink-0 place-items-center rounded-full bg-[#e5484d] text-[0.8em] font-bold text-white">!</span>
        <span className="truncate font-medium">{secondError ? "Still failing. Please contact support." : "Couldn't place your order. Try again."}</span>
      </div>

      {lastClick !== undefined && sinceClick < 0.45 ? (
        <span
          aria-hidden
          className="absolute size-8 rounded-full border-2 border-[#178a42]"
          style={{
            left: `${cursor.x}%`,
            top: `${cursor.y}%`,
            opacity: 1 - sinceClick / 0.45,
            transform: `translate(-50%, -50%) scale(${0.5 + sinceClick * 2.6})`,
          }}
        />
      ) : null}
      <MousePointer2
        aria-hidden
        className="absolute size-[1.6em] fill-[#1d1d1b] text-white drop-shadow"
        style={{
          left: `${cursor.x}%`,
          top: `${cursor.y}%`,
          transform: `translate(-15%, -10%) scale(${pressed ? 0.85 : 1})`,
        }}
      />
    </div>
  );
}

export function ReplayDemo(): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const [rootRef, inView] = useInView<HTMLDivElement>({ rootMargin: "-80px" });
  const [t, setT] = useState(() => (reducedMotion ? 4.75 : 0));
  const [playing, setPlaying] = useState(!reducedMotion);
  const [pinned, setPinned] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing || !inView) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      setT((prev) => (prev + dt >= DURATION ? 0 : prev + dt));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, inView]);

  const activeIndex = EVENTS.reduce((acc, ev, i) => (ev.t <= t ? i : acc), -1);
  const selectedIndex = pinned ?? activeIndex;
  const selected = selectedIndex >= 0 ? EVENTS[selectedIndex] : undefined;
  const errorCount = EVENTS.filter((ev) => ev.tone === "err" && ev.t <= t).length;

  const seekFromPointer = (clientX: number): void => {
    const track = trackRef.current;
    if (!track) return;
    const box = track.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    setT(p * DURATION);
    setPinned(null);
  };

  const togglePlay = (): void => {
    if (!playing) setPinned(null);
    if (!playing && t >= DURATION - 0.05) setT(0);
    setPlaying((p) => !p);
  };

  return (
    <div ref={rootRef} className="jl-replay overflow-hidden rounded-xl border border-white/10 bg-[#0d0e10] shadow-[0_40px_120px_-40px_rgba(34,197,94,0.25),0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">checkout-place-order-500.webm</span>
        <span
          className={cn(
            "ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-xs transition-colors duration-200",
            errorCount > 0 ? "bg-[#ff4d5e]/15 text-[#ff7a86]" : "bg-white/5 text-muted-foreground"
          )}
        >
          <span className={cn("size-1.5 rounded-full", errorCount > 0 ? "bg-[#ff4d5e]" : "bg-white/30")} />
          {errorCount} {errorCount === 1 ? "error" : "errors"}
        </span>
      </div>

      <div className="grid lg:grid-cols-[1.55fr_1fr]">
        <div className="border-b border-white/[0.07] p-3 sm:p-4 lg:border-b-0 lg:border-r">
          <div className="overflow-hidden rounded-lg border border-white/10">
            <div className="flex items-center gap-2 bg-[#1a1b1e] px-3 py-1.5">
              <span className="flex-1 truncate rounded bg-black/40 px-2 py-0.5 text-center font-mono text-[11px] text-white/45">
                acme.shop/checkout
              </span>
            </div>
            <div className="aspect-[16/10]">
              <FakeCheckout t={t} />
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <ol className="flex-1 py-1.5" aria-label="Recorded events">
            {EVENTS.map((ev, i) => {
              const past = ev.t <= t;
              const isSelected = i === selectedIndex;
              return (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => {
                      setT(ev.t + 0.02);
                      setPinned(i);
                      setPlaying(false);
                    }}
                    className={cn(
                      "relative flex w-full items-center gap-2.5 px-4 py-[5px] text-left text-[13px] transition-[opacity,background-color] duration-200 ease-out",
                      past ? "opacity-100" : "opacity-30",
                      isSelected && (ev.tone === "err" ? "bg-[#ff4d5e]/10" : "bg-white/[0.06]"),
                      "jl-row-hover"
                    )}
                  >
                    {isSelected ? (
                      <span aria-hidden className={cn("absolute inset-y-1 left-0 w-0.5 rounded-full", ev.tone === "err" ? "bg-[#ff4d5e]" : "bg-primary")} />
                    ) : null}
                    <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground/70">{formatT(ev.t)}</span>
                    <span
                      className={cn(
                        "grid size-5 shrink-0 place-items-center rounded [&_svg]:size-3",
                        ev.tone === "err" ? "bg-[#ff4d5e]/15 text-[#ff7a86]" : ev.tone === "warn" ? "bg-warning/15 text-warning" : ev.kind === "network" ? "bg-[#5eb1ff]/12 text-[#7fc0ff]" : "bg-white/[0.06] text-foreground/70"
                      )}
                    >
                      {KIND_ICON[ev.kind]}
                    </span>
                    <span className={cn("shrink-0 font-medium", ev.tone === "err" ? "text-[#ff8a94]" : "text-foreground")}>{ev.label}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">{ev.meta}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="hidden min-h-[92px] border-t border-white/[0.07] bg-black/25 px-4 py-3 font-mono text-[11px] sm:block">
            {selected ? (
              <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1">
                {selected.detail.map(([k, v]) => (
                  <React.Fragment key={k}>
                    <dt className="text-muted-foreground/70">{k}</dt>
                    <dd className={cn("truncate", selected.tone === "err" ? "text-[#ffb3ba]" : "text-foreground/85")}>{v}</dd>
                  </React.Fragment>
                ))}
              </dl>
            ) : (
              <span className="text-muted-foreground/60">Press play, or click any row to jump to its frame.</span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-white/[0.07] px-4 py-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-transform duration-150 ease-out active:scale-[0.94]"
        >
          {playing ? <Pause className="size-3.5 fill-current" aria-hidden /> : <Play className="size-3.5 translate-x-px fill-current" aria-hidden />}
        </button>
        <span className="w-[4.5rem] shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
          {formatT(t)}
        </span>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={0}
          aria-label="Replay position"
          aria-valuemin={0}
          aria-valuemax={DURATION}
          aria-valuenow={Number(t.toFixed(1))}
          aria-valuetext={formatT(t)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setPlaying(false);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) seekFromPointer(e.clientX);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
              e.preventDefault();
              setPlaying(false);
              setPinned(null);
              setT((prev) => Math.min(DURATION, Math.max(0, prev + (e.key === "ArrowRight" ? 0.5 : -0.5))));
            }
          }}
          className="relative h-8 flex-1 cursor-pointer touch-none"
        >
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/10" />
          <div
            className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary/60"
            style={{ width: `${(t / DURATION) * 100}%` }}
          />
          {EVENTS.map((ev, i) => (
            <span
              key={i}
              aria-hidden
              className={cn(
                "absolute top-1/2 w-[3px] -translate-x-1/2 rounded-full",
                ev.tone ? "h-4 -translate-y-1/2" : "h-2.5 -translate-y-1/2",
                markerColor(ev)
              )}
              style={{ left: `${(ev.t / DURATION) * 100}%` }}
            />
          ))}
          <span
            aria-hidden
            className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#0d0e10] bg-primary shadow-[0_0_0_4px_rgba(34,197,94,0.18)]"
            style={{ left: `${(t / DURATION) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
