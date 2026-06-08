import React from "react";

import { cn } from "../lib/cn";

function ModernLoader(): React.JSX.Element {
  return (
    <div aria-hidden className="jl-modern-loader">
      <span className="jl-modern-loader-ring" />
      <span className="jl-modern-loader-dot" />
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

  return (
    <main className={cn("jl-status-screen", isLoading ? "jl-status-screen-loading" : null)}>
      <div aria-hidden className="jl-status-mesh" />
      <div aria-hidden className="jl-status-sweep" />
      <section
        aria-live="polite"
        className={cn(
          "relative w-full animate-rise border border-border-strong shadow-pop backdrop-blur",
          isLoading
            ? "jl-status-panel max-w-[22rem] px-6 py-7"
            : "max-w-md rounded-lg bg-card/80 p-7"
        )}
      >
        {isLoading ? <ModernLoader /> : null}
        <div className={cn(isLoading ? "mt-5 text-center" : "flex items-center gap-2")}>
          <h1
            className={cn(
              "font-display font-semibold tracking-tight",
              isLoading ? "text-xl leading-tight" : "text-lg",
              props.tone === "error" ? "text-destructive" : "text-foreground"
            )}
          >
            {props.title}
          </h1>
          {props.detail ? (
            <p className={cn("mt-2 text-base text-muted-foreground", isLoading ? "mx-auto max-w-sm" : null)}>
              {props.detail}
            </p>
          ) : null}
        </div>
        {props.children ? <div className="mt-5">{props.children}</div> : null}
      </section>
    </main>
  );
}
