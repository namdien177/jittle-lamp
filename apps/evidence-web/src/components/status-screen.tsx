import React from "react";

import { cn } from "../lib/cn";
import { Wordmark } from "./brand";
import { Spinner } from "./ui/misc";

/** Full-viewport centered panel used for loading / error / gated states. */
export function StatusScreen(props: {
  title: string;
  detail?: React.ReactNode;
  tone?: "neutral" | "error";
  loading?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden bg-background p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop opacity-[0.4]" />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-1/3 left-1/2 h-[60vh] w-[60vh] -translate-x-1/2 rounded-full bg-primary/10 blur-[120px]"
      />
      <section
        aria-live="polite"
        className="relative w-full max-w-md animate-rise rounded-xl border border-border-strong bg-card/80 p-7 shadow-pop backdrop-blur"
      >
        <Wordmark className="mb-5" />
        <div className="flex items-center gap-2">
          {props.loading ? <Spinner className="text-primary" /> : null}
          <h1
            className={cn(
              "font-display text-lg font-semibold tracking-tight",
              props.tone === "error" ? "text-destructive" : "text-foreground"
            )}
          >
            {props.title}
          </h1>
        </div>
        {props.detail ? <p className="mt-2 text-sm text-muted-foreground">{props.detail}</p> : null}
        {props.children ? <div className="mt-5">{props.children}</div> : null}
      </section>
    </main>
  );
}
