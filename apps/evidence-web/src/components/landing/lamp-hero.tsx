import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowRight, FolderOpen } from "lucide-react";

import { cn } from "../../lib/cn";
import { useInView, usePrefersReducedMotion } from "./use-in-view";

export const CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh";

/** Hand-placed around the edges so the headline never sits on top of a bug. */
const BUGS: Array<{ x: number; y: number; r: number; s: number }> = [
  { x: 7, y: 20, r: 24, s: 1 },
  { x: 15, y: 60, r: -48, s: 0.85 },
  { x: 6, y: 84, r: 120, s: 1.1 },
  { x: 25, y: 10, r: 160, s: 0.8 },
  { x: 27, y: 88, r: -20, s: 0.95 },
  { x: 44, y: 95, r: 70, s: 0.75 },
  { x: 71, y: 91, r: -130, s: 1 },
  { x: 89, y: 78, r: 200, s: 0.9 },
  { x: 94, y: 46, r: -70, s: 1.05 },
  { x: 86, y: 15, r: 35, s: 0.85 },
  { x: 66, y: 7, r: -160, s: 0.9 },
  { x: 18, y: 38, r: 95, s: 0.8 },
];

export function BugGlyph({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} fill="none">
      <g className="jl-bug-legs" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M11 13 6 10M10 17H4.5M11 21l-5 3.5M21 13l5-3M22 17h5.5M21 21l5 3.5" />
      </g>
      <path d="M13 8.5 11 5M19 8.5 21 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <ellipse cx="16" cy="11" rx="4" ry="3.2" fill="currentColor" />
      <ellipse cx="16" cy="19" rx="6" ry="7.5" fill="currentColor" />
      <path d="M16 12.5v13.5" stroke="var(--jl-bug-seam, #0b0c0d)" strokeWidth="1.2" />
    </svg>
  );
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Counts up from page load, like the recorder's own badge. */
function RecClock(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = performance.now();
    const id = window.setInterval(() => setSeconds(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatClock(seconds)}</span>;
}

export function LampHero(): React.JSX.Element {
  const sectionRef = useRef<HTMLElement>(null);
  const litRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const lampRef = useRef<{ x: number; y: number; tx: number; ty: number; lastPointer: number } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [watchRef, onScreen] = useInView<HTMLDivElement>();
  const [caught, setCaught] = useState<ReadonlySet<number>>(() => new Set());
  const [pops, setPops] = useState<Array<{ id: number; x: number; y: number }>>([]);
  const [coarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches
  );
  const allCaught = caught.size === BUGS.length;

  // The lamp eases toward the pointer instead of snapping to it, and drifts on
  // its own when nobody is steering, so the page never looks dead.
  useEffect(() => {
    const section = sectionRef.current;
    const lit = litRef.current;
    const glow = glowRef.current;
    if (!section || !lit || !glow) return;

    const rect = { w: section.clientWidth, h: section.clientHeight };
    // Kept in a ref so pausing off screen and resuming does not snap the lamp back.
    const lamp = (lampRef.current ??= {
      x: rect.w * 0.3,
      y: rect.h * 0.45,
      tx: rect.w * 0.3,
      ty: rect.h * 0.45,
      lastPointer: -Infinity,
    });
    let frame = 0;

    const paint = (): void => {
      lit.style.setProperty("--lx", `${lamp.x}px`);
      lit.style.setProperty("--ly", `${lamp.y}px`);
      glow.style.transform = `translate3d(${lamp.x - 450}px, ${lamp.y - 450}px, 0)`;
    };

    const onPointer = (event: PointerEvent): void => {
      const box = section.getBoundingClientRect();
      lamp.tx = event.clientX - box.left;
      lamp.ty = event.clientY - box.top;
      lamp.lastPointer = performance.now();
      if (reducedMotion) {
        lamp.x = lamp.tx;
        lamp.y = lamp.ty;
        paint();
      }
    };
    const onResize = (): void => {
      rect.w = section.clientWidth;
      rect.h = section.clientHeight;
    };

    section.addEventListener("pointermove", onPointer);
    section.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onResize);
    paint();

    if (!reducedMotion && onScreen) {
      const tick = (now: number): void => {
        if (now - lamp.lastPointer > 2600) {
          const t = now / 1000;
          lamp.tx = rect.w * (0.5 + 0.36 * Math.sin(t * 0.37));
          lamp.ty = rect.h * (0.5 + 0.3 * Math.sin(t * 0.53 + 1.2));
        }
        lamp.x += (lamp.tx - lamp.x) * 0.09;
        lamp.y += (lamp.ty - lamp.y) * 0.09;
        paint();
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frame);
      section.removeEventListener("pointermove", onPointer);
      section.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onResize);
    };
  }, [reducedMotion, onScreen]);

  const catchBug = (index: number): void => {
    if (caught.has(index)) return;
    const bug = BUGS[index];
    if (!bug) return;
    setCaught((prev) => new Set(prev).add(index));
    const id = performance.now();
    setPops((prev) => [...prev, { id, x: bug.x, y: bug.y }]);
    window.setTimeout(() => setPops((prev) => prev.filter((p) => p.id !== id)), 900);
  };

  return (
    <section
      ref={sectionRef}
      className="jl-hero relative isolate flex min-h-[calc(100svh-3.5rem)] items-center overflow-hidden"
      data-lights-on={allCaught || undefined}
    >
      <div ref={watchRef} aria-hidden className="pointer-events-none absolute inset-0" />
      <div aria-hidden className="jl-hero-dim pointer-events-none absolute inset-0" />
      <div ref={glowRef} aria-hidden className="jl-hero-glow pointer-events-none absolute left-0 top-0" />

      {/* Everything inside this layer only exists where the lamp shines. */}
      <div ref={litRef} className="jl-hero-lit pointer-events-none absolute inset-0">
        <div aria-hidden className="jl-hero-lit-grid absolute inset-0" />
        {BUGS.map((bug, i) =>
          caught.has(i) ? null : (
            <button
              key={i}
              type="button"
              aria-label={`Catch bug ${i + 1}`}
              onClick={() => catchBug(i)}
              className="jl-bug pointer-events-auto absolute"
              style={
                {
                  left: `${bug.x}%`,
                  top: `${bug.y}%`,
                  "--bug-r": `${bug.r}deg`,
                  "--bug-s": bug.s,
                  "--bug-delay": `${(i * 0.73) % 4}s`,
                } as React.CSSProperties
              }
            >
              <BugGlyph className="size-9" />
            </button>
          )
        )}
      </div>

      {/* Caught bugs stay visible in the dark, framed like a capture. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {BUGS.map((bug, i) =>
          caught.has(i) ? (
            <span
              key={i}
              className="jl-caught absolute"
              style={{ left: `${bug.x}%`, top: `${bug.y}%` }}
            >
              <BugGlyph className="size-5" />
            </span>
          ) : null
        )}
        {pops.map((pop) => (
          <span
            key={pop.id}
            className="jl-pop absolute font-mono text-xs font-medium text-primary"
            style={{ left: `${pop.x}%`, top: `${pop.y}%` }}
          >
            +1 evidence
          </span>
        ))}
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-4 py-20 text-center sm:px-6 [&_a]:pointer-events-auto [&_button]:pointer-events-auto pointer-events-none">
        <div className="jl-stagger mx-auto flex max-w-4xl flex-col items-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1 pl-2 pr-3 font-mono text-xs text-muted-foreground backdrop-blur">
            <span className="jl-rec-dot size-2 rounded-full bg-[#ff4d5e]" />
            <span className="font-semibold text-foreground">REC</span>
            <RecClock />
            <span className="text-white/20">/</span>
            evidence for QA teams
          </span>

          <h1 className="mt-7 text-balance text-[clamp(2.75rem,8vw,6.25rem)] font-bold leading-[0.95] tracking-[-0.045em] text-foreground">
            Bugs hide in the dark.
            <br />
            Bring a <span className="jl-lamp-word">lamp.</span>
          </h1>

          <p className="mt-7 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
            Jittle Lamp records the video, clicks, network and console of a browser session on one
            clock. Replay it, share it, hand it to a dev or an AI. The bug report <em>is</em> the
            proof.
          </p>

          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <a
              href={CHROME_EXTENSION_URL}
              target="_blank"
              rel="noreferrer"
              className="jl-cta-primary group inline-flex h-12 items-center gap-2 rounded-lg px-5 text-base font-semibold"
            >
              Add to Chrome, it's free
              <ArrowRight aria-hidden className="size-4 transition-transform duration-200 ease-out group-hover:translate-x-0.5" />
            </a>
            <Link
              to="/quick-view"
              className="jl-cta-ghost inline-flex h-12 items-center gap-2 rounded-lg px-5 text-base font-medium"
            >
              <FolderOpen aria-hidden className="size-4" />
              Open a recording
            </Link>
          </div>

          <div
            className={cn(
              "mt-10 inline-flex min-h-9 items-center gap-3 rounded-full border px-4 py-1.5 text-sm transition-colors duration-300",
              allCaught
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-white/10 bg-black/30 text-muted-foreground"
            )}
            aria-live="polite"
          >
            <BugGlyph className={cn("size-4", allCaught ? "text-primary" : "text-foreground/70")} />
            {caught.size === 0 ? (
              <span>
                {coarse ? "Drag" : "Move"} the lamp. {BUGS.length} bugs are hiding on this page.
              </span>
            ) : allCaught ? (
              <span>
                All {BUGS.length} caught. Lights on.{" "}
                <a href={CHROME_EXTENSION_URL} target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-4 hover:underline">
                  Now try your own app
                </a>
              </span>
            ) : (
              <>
                <span className="tabular-nums">
                  <span className="font-semibold text-foreground">{caught.size}</span> / {BUGS.length} caught
                </span>
                <span className="flex gap-1" aria-hidden>
                  {BUGS.map((_, i) => (
                    <span
                      key={i}
                      className={cn(
                        "size-1.5 rounded-full transition-colors duration-200",
                        i < caught.size ? "bg-primary" : "bg-white/15"
                      )}
                    />
                  ))}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
