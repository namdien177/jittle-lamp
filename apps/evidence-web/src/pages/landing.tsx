import React, { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowRight,
  Check,
  Copy,
  Network,
  PlayCircle,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import { PublicTopbar } from "../components/public-topbar";
import { Button, buttonVariants } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { cn } from "../lib/cn";
import { copyToClipboard } from "../utils";

const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/namdien177/jittle-lamp/main/scripts/release/install-macos-desktop.sh | bash";

function CopyInstall(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    void copyToClipboard(INSTALL_COMMAND).catch(() => undefined);
  };
  return (
    <div className="flex items-center gap-2 overflow-hidden rounded-lg border border-border-strong bg-black/40 pl-3 pr-1.5 font-mono text-base">
      <Terminal aria-hidden className="size-4 shrink-0 text-primary" />
      <code
        className="flex-1 truncate py-2.5 text-muted-foreground"
        title={INSTALL_COMMAND}
      >
        curl ... | bash
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="my-1 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-white/[0.08]"
      >
        {copied ? (
          <Check className="size-3.5 text-primary" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const STEPS: Array<{
  n: string;
  title: string;
  body: string;
  icon: React.ReactNode;
}> = [
  {
    n: "01",
    title: "Capture",
    body: "Record the browser session the moment a bug appears — video, clicks, console, and network in one pass.",
    icon: <PlayCircle aria-hidden />,
  },
  {
    n: "02",
    title: "Replay",
    body: "Scrub the timeline with every request and log lined up to the frame, so nothing gets lost in translation.",
    icon: <Network aria-hidden />,
  },
  {
    n: "03",
    title: "Hand off",
    body: "Share a scoped, organisation-only link. Reviewers see the same evidence — no “works on my machine”.",
    icon: <ShieldCheck aria-hidden />,
  },
];

export function LandingPage(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid-backdrop opacity-[0.5]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-[70vh] w-[80vw] max-w-5xl -translate-x-1/2 rounded-full bg-primary/10 blur-[140px]"
      />
      <div className="relative">
        <PublicTopbar />

        <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          {/* Hero */}
          <section className="grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="animate-rise space-y-7">
              <Badge variant="brand" className="px-2.5 py-1">
                <span className="size-1.5 rounded-full bg-primary" /> Evidence
                when bugs happen
              </Badge>
              <h1 className="font-display text-5xl font-extrabold leading-[0.95] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
                Capture the bug.
                <br />
                <span className="text-primary">Prove the fix.</span>
              </h1>
              <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
                Jittle Lamp turns a flaky browser moment into a shareable trail
                — screen recording, timeline, console, and network requests
                bundled into one piece of evidence your whole QA team can
                review.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="lg" onClick={() => navigate("/quick-view")}>
                  Open a session
                  <ArrowRight aria-hidden />
                </Button>
                <Link
                  to="/"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                  )}
                >
                  Go to workspace
                </Link>
              </div>
              <div className="max-w-md space-y-2 pt-2">
                <p className=" font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Install the desktop companion
                </p>
                <CopyInstall />
              </div>
            </div>

            <div className="animate-rise [animation-delay:120ms]">
              <MockReviewer />
            </div>
          </section>

          {/* How it works */}
          <section
            className="border-t border-border py-16"
            aria-label="How Jittle Lamp works"
          >
            <div className="grid gap-6 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <div
                  key={step.n}
                  className="animate-rise rounded-xl border border-border bg-card p-6"
                  style={{ animationDelay: `${i * 90}ms` }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary [&_svg]:size-5">
                      {step.icon}
                    </span>
                    <span className="font-mono text-base text-muted-foreground/60">
                      {step.n}
                    </span>
                  </div>
                  <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-base leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <footer className="flex flex-col items-center justify-between gap-3 border-t border-border py-8 text-base text-muted-foreground sm:flex-row">
            <span>© {new Date().getFullYear()} Jittle Lamp</span>
            <Link
              to="/privacy"
              className="transition-colors hover:text-foreground"
            >
              Privacy
            </Link>
          </footer>
        </main>
      </div>
    </div>
  );
}

/** A small, decorative mock of the evidence reviewer for the hero. */
function MockReviewer(): React.JSX.Element {
  const rows = [
    { t: "0:02", label: "GET /api/session", tone: "ok" as const },
    { t: "0:05", label: "Click “Submit order”", tone: "act" as const },
    { t: "0:06", label: "POST /api/orders", tone: "err" as const },
    { t: "0:06", label: "TypeError: cart is null", tone: "err" as const },
    { t: "0:09", label: "GET /api/retry", tone: "ok" as const },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-border-strong bg-card shadow-pop">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-destructive/70" />
        <span className="size-2.5 rounded-full bg-warning/70" />
        <span className="size-2.5 rounded-full bg-primary/70" />
        <span className="ml-2 truncate font-mono text-muted-foreground">
          checkout-regression.webm
        </span>
      </div>
      <div className="grid grid-cols-[1.3fr_1fr]">
        <div className="relative aspect-[4/3] border-r border-border bg-[radial-gradient(circle_at_50%_40%,#15201a,#0a0b0c)]">
          <div className="absolute inset-0 grid-backdrop opacity-40" />
          <div className="absolute inset-0 grid place-items-center">
            <PlayCircle
              className="size-12 text-primary/80"
              aria-hidden
              strokeWidth={1.5}
            />
          </div>
          <div className="absolute inset-x-3 bottom-3 h-1.5 rounded-full bg-white/10">
            <div className="h-full w-1/2 rounded-full bg-primary" />
          </div>
        </div>
        <ul className="divide-y divide-border">
          {rows.map((row, i) => (
            <li
              key={i}
              className={cn(
                "flex items-center gap-2 px-3 py-2.5 ",
                row.tone === "err"
                  ? "text-destructive"
                  : "text-muted-foreground",
                i === 2 && "bg-primary/[0.06]",
              )}
            >
              <span className="font-mono text-muted-foreground/60">
                {row.t}
              </span>
              <span className="truncate">{row.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
