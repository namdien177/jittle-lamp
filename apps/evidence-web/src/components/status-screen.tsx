import React from "react";

import { cn } from "../lib/cn";

function ModernLoader(): React.JSX.Element {
  return (
    <div aria-hidden className="jl-modern-loader">
      <span className="jl-modern-loader-ring" />
    </div>
  );
}

/** Full-viewport centered panel used for loading / error / gated states. */
export function StatusScreen(props: {
  title: string;
  detail?: React.ReactNode;
  tone?: "neutral" | "error";
  loading?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  const isLoading = Boolean(props.loading);

  if (isLoading) {
    return (
      <main className="jl-status-screen jl-status-screen-loading">
        <div className="jl-status-loading" aria-live="polite">
          <ModernLoader />
          <h1 className="jl-status-loading-title">{props.title}</h1>
          {props.detail ? (
            <p className="jl-status-loading-detail">{props.detail}</p>
          ) : null}
          {props.children ? <div className="mt-5">{props.children}</div> : null}
        </div>
      </main>
    );
  }

  return (
    <main className="jl-status-screen">
      <section
        aria-live="polite"
        className="relative w-full max-w-md animate-rise rounded-lg border border-border bg-card p-7 shadow-soft"
      >
        <div className="flex items-center gap-2">
          <h1
            className={cn(
              "font-display text-lg font-semibold tracking-tight",
              props.tone === "error" ? "text-destructive" : "text-foreground"
            )}
          >
            {props.title}
          </h1>
          {props.detail ? (
            <p className="mt-2 text-base text-muted-foreground">{props.detail}</p>
          ) : null}
        </div>
        {props.children ? <div className="mt-5">{props.children}</div> : null}
      </section>
    </main>
  );
}
