import React, { useEffect, useState } from "react";
import { Check, FolderDown, KeyRound, Link2, Lock, Sparkles, X } from "lucide-react";

import { cn } from "../../lib/cn";
import { useInView, usePrefersReducedMotion } from "./use-in-view";

function Card({
  className,
  eyebrow,
  title,
  body,
  children,
  index,
}: {
  className?: string;
  eyebrow: React.ReactNode;
  title: string;
  body: string;
  children?: React.ReactNode;
  index: number;
}): React.JSX.Element {
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, rootMargin: "-60px" });
  return (
    <div
      ref={ref}
      data-in={inView || undefined}
      style={{ "--reveal-delay": `${(index % 3) * 70}ms` } as React.CSSProperties}
      className={cn(
        "jl-reveal jl-bento-card group relative flex flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#111214] p-6",
        className
      )}
    >
      <p className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-primary">
        {eyebrow}
      </p>
      <h3 className="mt-3 text-xl font-semibold tracking-tight text-foreground">{title}</h3>
      <p className="mt-1.5 max-w-md text-base leading-relaxed text-muted-foreground">{body}</p>
      {children ? <div className="mt-6 flex-1">{React.Children.only(children)}</div> : null}
    </div>
  );
}

/** Ticks a number up once its card scrolls into view. */
function useCountUp(target: number, run: boolean, ms = 1400): number {
  const reducedMotion = usePrefersReducedMotion();
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (reducedMotion) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number): void => {
      const p = Math.min(1, (now - start) / ms);
      setValue(Math.round(target * (1 - Math.pow(1 - p, 3))));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, target, ms, reducedMotion]);
  return value;
}

function RecorderVisual(): React.JSX.Element {
  const [ref, inView] = useInView<HTMLDivElement>({ once: true });
  const clicks = useCountUp(14, inView);
  const requests = useCountUp(63, inView);
  const logs = useCountUp(9, inView);
  const stats = [
    { label: "Clicks & inputs", value: clicks, tone: "text-foreground" },
    { label: "Network requests", value: requests, tone: "text-[#7fc0ff]" },
    { label: "Console logs", value: logs, tone: "text-warning" },
  ];
  return (
    <div ref={ref} className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-stretch">
      <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-black/30 px-4 py-3">
        <span className="relative grid size-9 place-items-center rounded-full bg-[#ff4d5e]/15">
          <span className="jl-rec-dot size-3 rounded-full bg-[#ff4d5e]" />
        </span>
        <div>
          <div className="text-sm font-semibold">Recording this tab</div>
          <div className="font-mono text-xs text-muted-foreground">video · actions · network · console</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2.5">
            <div className={cn("font-mono text-2xl font-semibold tabular-nums", s.tone)}>{s.value}</div>
            <div className="truncate text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareVisual(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 py-2 pl-3 pr-2 font-mono text-xs">
        <Link2 aria-hidden className="size-3.5 shrink-0 text-primary" />
        <span className="truncate text-foreground/85">jittle.app/share/k3f9-place-order</span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Lock aria-hidden className="size-3" /> Organisation members only
        </span>
        <span className="flex -space-x-1.5" aria-hidden>
          {["#f59e0b", "#5eb1ff", "#22c55e"].map((c) => (
            <span key={c} className="size-5 rounded-full border-2 border-[#111214]" style={{ background: c }} />
          ))}
        </span>
      </div>
    </div>
  );
}

const AI_ANSWER = [
  "POST /api/orders returned 500 at 0:04.6,",
  "100ms before the TypeError at checkout.tsx:88.",
  "cart.total is undefined after the promo is applied.",
];

function AiVisual(): React.JSX.Element {
  const [ref, inView] = useInView<HTMLDivElement>({ once: true });
  return (
    <div ref={ref} data-in={inView || undefined} className="jl-ai rounded-lg border border-white/10 bg-black/40 p-4 font-mono text-xs leading-relaxed">
      <div className="text-muted-foreground">
        <span className="text-primary">›</span> why does checkout fail in this recording?
      </div>
      <div className="mt-2 space-y-0.5 text-foreground/85">
        {AI_ANSWER.map((line, i) => (
          <div key={i} className="jl-ai-line" style={{ "--line": i } as React.CSSProperties}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

const STEPS: Array<{ tag: string; text: string; ok: boolean }> = [
  { tag: "Open", text: "acme.shop/checkout", ok: true },
  { tag: "Click", text: "Increase quantity", ok: true },
  { tag: "Type", text: 'Promo code "SPRING"', ok: true },
  { tag: "Click", text: "Place order", ok: true },
  { tag: "Checkpoint", text: "Order confirmation is shown", ok: false },
];

function TestCaseVisual(): React.JSX.Element {
  const [ref, inView] = useInView<HTMLOListElement>({ once: true });
  return (
    <ol ref={ref} data-in={inView || undefined} className="jl-steps space-y-1.5 font-mono text-xs">
      {STEPS.map((step, i) => (
        <li
          key={i}
          className={cn(
            "jl-step flex items-center gap-2.5 rounded-md border px-3 py-2",
            step.tag === "Checkpoint" ? "border-[#ff4d5e]/25 bg-[#ff4d5e]/[0.06]" : "border-white/[0.07] bg-black/25"
          )}
          style={{ "--step": i } as React.CSSProperties}
        >
          <span className={cn("shrink-0", step.tag === "Checkpoint" ? "text-[#ff8a94]" : "text-primary")}>
            {step.tag === "Checkpoint" ? "##" : `[${step.tag}]`}
          </span>
          <span className="truncate text-foreground/85">{step.text}</span>
          <span
            className={cn(
              "jl-step-result ml-auto grid size-4 shrink-0 place-items-center rounded-full [&_svg]:size-2.5",
              step.ok ? "bg-primary/20 text-primary" : "bg-[#ff4d5e]/20 text-[#ff7a86]"
            )}
          >
            {step.ok ? <Check aria-hidden strokeWidth={3} /> : <X aria-hidden strokeWidth={3} />}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function FeatureBento(): React.JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-6">
      <Card
        index={0}
        className="md:col-span-4"
        eyebrow={<>01 · Capture</>}
        title="One click in Chrome. Everything recorded."
        body="The extension records the tab while you test. Video, clicks, navigation, requests and logs land on a single timeline."
      >
        <RecorderVisual />
      </Card>
      <Card
        index={1}
        className="md:col-span-2"
        eyebrow={<>02 · Share</>}
        title="Send a link, not a story"
        body="Reviewers open the same replay, scoped to your organisation."
      >
        <ShareVisual />
      </Card>
      <Card
        index={2}
        className="md:col-span-3"
        eyebrow={
          <>
            <Sparkles aria-hidden /> Hand it to AI
          </>
        }
        title="Your agent reads the evidence"
        body="Point Claude or any MCP client at a recording. It reads the actions, requests and errors and tells you what broke."
      >
        <AiVisual />
      </Card>
      <Card
        index={3}
        className="md:col-span-3"
        eyebrow={<>Then never again</>}
        title="Turn the bug into a test case"
        body="Write steps in plain language. Runners replay them in a real browser and record fresh evidence each time."
      >
        <TestCaseVisual />
      </Card>
      <Card
        index={4}
        className="md:col-span-2"
        eyebrow={
          <>
            <Lock aria-hidden /> Private by default
          </>
        }
        title="Typed values stay put"
        body="Inputs and URLs are sanitised at capture. Passwords never reach a recording."
      />
      <Card
        index={5}
        className="md:col-span-2"
        eyebrow={
          <>
            <FolderDown aria-hidden /> Local first
          </>
        }
        title="Your disk, then the cloud"
        body="The desktop companion saves every session to a folder you choose. Upload when you're ready."
      />
      <Card
        index={6}
        className="md:col-span-2"
        eyebrow={
          <>
            <KeyRound aria-hidden /> Automate
          </>
        }
        title="Evidence from CI"
        body="Test runners upload recordings with an API token, so failed builds come with proof attached."
      />
    </div>
  );
}
