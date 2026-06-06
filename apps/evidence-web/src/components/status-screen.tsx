import React from "react";

import { cn } from "../lib/cn";
import { Wordmark } from "./brand";

const LOADER_BARS = Array.from({ length: 14 }, (_, index) => index);
const LOADER_NODES = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"] as const;

function LoadingScanner(): React.JSX.Element {
  return (
    <div aria-hidden className="jl-load-scanner">
      <div className="jl-load-orbit jl-load-orbit-a" />
      <div className="jl-load-orbit jl-load-orbit-b" />
      <div className="jl-load-console">
        <div className="jl-load-console-glass">
          <div className="jl-load-map">
            <div className="jl-load-playhead" />
            <div className="jl-load-radar" />
            <div className="jl-load-path jl-load-path-a" />
            <div className="jl-load-path jl-load-path-b" />
            <div className="jl-load-path jl-load-path-c" />
            {LOADER_NODES.map((node) => (
              <span key={node} className={cn("jl-load-node", `jl-load-node-${node}`)} />
            ))}
          </div>
          <div className="jl-load-bars">
            {LOADER_BARS.map((bar) => (
              <span key={bar} />
            ))}
          </div>
        </div>
      </div>
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
            ? "jl-status-panel max-w-[34rem] px-6 py-7 sm:px-8"
            : "max-w-md rounded-lg bg-card/80 p-7"
        )}
      >
        <Wordmark className={cn(isLoading ? "mb-7" : "mb-5")} />
        {isLoading ? <LoadingScanner /> : null}
        <div className={cn(isLoading ? "mt-7 text-center" : "flex items-center gap-2")}>
          <h1
            className={cn(
              "font-display font-semibold tracking-tight",
              isLoading ? "text-2xl leading-tight sm:text-3xl" : "text-lg",
              props.tone === "error" ? "text-destructive" : "text-foreground"
            )}
          >
            {props.title}
          </h1>
          {props.detail ? (
            <p className={cn("mt-2 text-sm text-muted-foreground", isLoading ? "mx-auto max-w-sm" : null)}>
              {props.detail}
            </p>
          ) : null}
        </div>
        {props.children ? <div className="mt-5">{props.children}</div> : null}
      </section>
    </main>
  );
}
