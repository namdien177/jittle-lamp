import React, { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Copy, FolderOpen, Terminal } from "lucide-react";

import { PublicTopbar } from "../components/public-topbar";
import { CHROME_EXTENSION_URL, LampHero } from "../components/landing/lamp-hero";
import { ReplayDemo } from "../components/landing/replay-demo";
import { FeatureBento } from "../components/landing/feature-bento";
import { useInView } from "../components/landing/use-in-view";
import { copyToClipboard } from "../utils";
import { Hint } from "../components/ui/tooltip";

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
    <div className="flex w-full max-w-md items-center gap-2 overflow-hidden rounded-lg border border-white/10 bg-black/40 pl-3 pr-1.5 font-mono text-sm">
      <Terminal aria-hidden className="size-4 shrink-0 text-primary" />
      <Hint label={INSTALL_COMMAND}>
        <code className="flex-1 truncate py-2.5 text-left text-muted-foreground">
          curl -fsSL …/install-macos-desktop.sh | bash
        </code>
      </Hint>
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy install command"
        className="my-1 inline-flex w-[5.5rem] shrink-0 items-center justify-center gap-1.5 rounded-md bg-white/[0.07] px-2.5 py-1.5 font-medium text-foreground transition-[background-color,transform] duration-150 ease-out hover:bg-white/[0.12] active:scale-[0.97]"
      >
        <span key={copied ? "y" : "n"} className="jl-swap inline-flex items-center gap-1.5">
          {copied ? <Check className="size-3.5 text-primary" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: React.ReactNode;
  body: string;
}): React.JSX.Element {
  const [ref, inView] = useInView<HTMLDivElement>({ once: true, rootMargin: "-80px" });
  return (
    <div ref={ref} data-in={inView || undefined} className="jl-reveal mx-auto mb-10 max-w-2xl text-center">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-primary">{eyebrow}</p>
      <h2 className="mt-3 text-balance text-[clamp(2rem,4.5vw,3.25rem)] font-bold leading-[1.02] tracking-[-0.035em]">
        {title}
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-pretty text-lg leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

export function LandingPage(): React.JSX.Element {
  return (
    // The landing is always dark: a lamp needs the lights off.
    <div className="dark jl-landing relative min-h-screen overflow-x-clip bg-[#08090a] text-foreground">
      <PublicTopbar />

      <main>
        <LampHero />

        <section className="relative px-4 py-24 sm:px-6 sm:py-32">
          <div aria-hidden className="jl-section-glow pointer-events-none absolute inset-x-0 top-0 h-[600px]" />
          <div className="relative mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="The replay"
              title={
                <>
                  Every click, request and error.
                  <br className="hidden sm:block" /> On one clock.
                </>
              }
              body="This is a real bug, recorded. Scrub the timeline or click any row to jump to that frame. Your team gets exactly this view."
            />
            <ReplayDemo />
          </div>
        </section>

        <section className="px-4 py-24 sm:px-6 sm:py-28" id="features">
          <div className="mx-auto max-w-6xl">
            <SectionHeading
              eyebrow="From bug to fix"
              title="Catch it once. Prove it forever."
              body="Capture on the spot, share the proof, let an agent read it, then lock the fix in with a test that records its own evidence."
            />
            <FeatureBento />
          </div>
        </section>

        <section className="relative overflow-hidden px-4 py-28 sm:px-6 sm:py-36">
          <div aria-hidden className="jl-final-glow pointer-events-none absolute left-1/2 top-1/2 size-[900px] -translate-x-1/2 -translate-y-1/2" />
          <div className="relative mx-auto flex max-w-3xl flex-col items-center text-center">
            <h2 className="text-balance text-[clamp(2.25rem,6vw,4.5rem)] font-bold leading-[0.98] tracking-[-0.04em]">
              Your next bug report takes <span className="jl-lamp-word">ten seconds.</span>
            </h2>
            <p className="mt-5 max-w-lg text-lg text-muted-foreground">
              Install the extension, hit record, reproduce the bug. That's the whole report.
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
              <Link to="/quick-view" className="jl-cta-ghost inline-flex h-12 items-center gap-2 rounded-lg px-5 text-base font-medium">
                <FolderOpen aria-hidden className="size-4" />
                Open a recording
              </Link>
            </div>
            <div className="mt-10 flex w-full flex-col items-center gap-2">
              <span className="text-sm text-muted-foreground">Desktop companion for macOS</span>
              <CopyInstall />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06]">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6">
          <span>© {new Date().getFullYear()} Jittle Lamp</span>
          <nav className="flex gap-5">
            <Link to="/quick-view" className="transition-colors hover:text-foreground">Quick view</Link>
            <Link to="/privacy" className="transition-colors hover:text-foreground">Privacy</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
