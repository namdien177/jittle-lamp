import React, { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  MessageSquare,
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
const CHROME_EXTENSION_URL =
  "https://chromewebstore.google.com/detail/ddllejobfkkbmijlflllnnfihfbmhmfh";

function CopyInstall(): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
    void copyToClipboard(INSTALL_COMMAND).catch(() => undefined);
  };
  return (
    <div className="flex items-center gap-2 overflow-hidden rounded-md border border-border-strong bg-muted pl-3 pr-1.5 font-mono text-base">
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
        className="my-1 inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
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

const FEATURES: Array<{
  title: string;
  body: string;
  icon: React.ReactNode;
}> = [
  {
    title: "Record",
    body: "Capture video, clicks, inputs, navigation, console logs, and network requests in one run.",
    icon: <PlayCircle aria-hidden />,
  },
  {
    title: "Review",
    body: "Scrub the video with actions, logs, and requests lined up on the same clock.",
    icon: <Network aria-hidden />,
  },
  {
    title: "Discuss",
    body: "Keep comments and notes attached to the evidence, not lost in chat history.",
    icon: <MessageSquare aria-hidden />,
  },
  {
    title: "Export",
    body: "Download a reviewed ZIP with the same archive, recording, and merge annotations.",
    icon: <FileArchive aria-hidden />,
  },
  {
    title: "Share",
    body: "Create scoped share links for the people who need to inspect the proof.",
    icon: <ShieldCheck aria-hidden />,
  },
  {
    title: "Automate",
    body: "Upload evidence from CI and test runners through API tokens.",
    icon: <Download aria-hidden />,
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
      <div className="relative">
        <PublicTopbar />

        <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <section className="py-16 text-center sm:py-20">
            <div className="mx-auto max-w-3xl animate-rise space-y-6">
              <Badge variant="brand" className="mx-auto px-2.5 py-1">
                <span className="size-1.5 rounded-full bg-primary" />
                QA evidence tool
              </Badge>
              <h1 className="font-display text-5xl font-extrabold leading-none text-foreground sm:text-6xl lg:text-7xl">
                Capture. Review. Prove.
              </h1>
              <p className="mx-auto max-w-xl text-lg leading-relaxed text-muted-foreground">
                Record a bug or test run with video, actions, network, and logs.
                Then review, discuss, share, and hand it to AI or automation.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button size="lg" onClick={() => navigate("/quick-view")}>
                  Try quick view
                  <ArrowRight aria-hidden />
                </Button>
                <Link
                  to="/"
                  className={cn(
                    buttonVariants({ variant: "outline", size: "lg" }),
                  )}
                >
                  Open dashboard
                </Link>
              </div>
            </div>

            <div className="mx-auto mt-12 max-w-5xl animate-rise [animation-delay:120ms]">
              <MockReviewer />
            </div>
          </section>

          <section className="py-14" id="features">
            <div className="mb-8">
              <p className="jl-eyebrow">What it does</p>
              <h2 className="mt-2 font-display text-3xl font-bold">
                One proof bundle for your whole team
              </h2>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <div key={feature.title} className="jl-proto-card p-6">
                  <span className="mb-4 flex size-10 items-center justify-center rounded-md bg-secondary text-primary [&_svg]:size-5">
                    {feature.icon}
                  </span>
                  <h3 className="font-display text-lg font-bold">{feature.title}</h3>
                  <p className="mt-2 text-base leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section
            className="jl-page-band -mx-4 px-4 py-14 sm:-mx-6 sm:px-6"
            aria-label="How Jittle Lamp works"
          >
            <p className="jl-eyebrow">How it works</p>
            <h2 className="mt-2 font-display text-3xl font-bold">
              Record to proof in minutes
            </h2>
            <div className="mt-8 grid gap-4 md:grid-cols-3">
              {STEPS.map((step, i) => (
                <div
                  key={step.n}
                  className="animate-rise rounded-md border border-border bg-background p-6"
                  style={{ animationDelay: `${i * 90}ms` }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex size-10 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary [&_svg]:size-5">
                      {step.icon}
                    </span>
                    <span className="font-mono text-base text-muted-foreground/60">
                      {step.n}
                    </span>
                  </div>
                  <h3 className="mt-4 font-display text-lg font-bold">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 text-base leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 py-14 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="jl-eyebrow">Install tools</p>
              <h2 className="mt-2 font-display text-3xl font-bold">
                Start from desktop or browser
              </h2>
              <p className="jl-lead mt-2 max-w-xl">
                Use the desktop companion for intake and the Chrome extension
                for capture.
              </p>
            </div>
            <a
              href={CHROME_EXTENSION_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(buttonVariants({ variant: "primary", size: "lg" }))}
            >
              Add to Chrome
              <ExternalLink aria-hidden />
            </a>
            <div className="lg:col-span-2">
              <CopyInstall />
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
    <div className="overflow-hidden rounded-md border border-border-strong bg-card shadow-pop">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-destructive/70" />
        <span className="size-2.5 rounded-full bg-warning/70" />
        <span className="size-2.5 rounded-full bg-primary/70" />
        <span className="ml-2 truncate font-mono text-muted-foreground">
          checkout-regression.webm
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[1.3fr_1fr]">
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
