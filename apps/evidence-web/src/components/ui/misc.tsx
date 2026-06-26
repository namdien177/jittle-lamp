import React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "../../lib/cn";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical";
}): React.JSX.Element {
  return (
    <div
      role="separator"
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  );
}

export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "rounded-md bg-[linear-gradient(90deg,var(--muted)_0%,color-mix(in_srgb,var(--muted)_40%,white_6%)_50%,var(--muted)_100%)] bg-[length:200%_100%] animate-shimmer",
        className
      )}
      {...props}
    />
  );
}

export function Spinner({
  className,
  ...props
}: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return <Loader2 className={cn("size-4 animate-spin", className)} aria-hidden {...props} />;
}

export function EmptyState(props: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-strong bg-card/70 px-6 py-14 text-center",
        props.className
      )}
    >
      {props.icon ? (
        <div className="flex size-12 items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground [&_svg]:size-5">
          {props.icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-base font-semibold text-foreground">{props.title}</p>
        {props.description ? (
          <p className="mx-auto max-w-sm text-base text-muted-foreground">{props.description}</p>
        ) : null}
      </div>
      {props.action ? <div className="mt-1">{props.action}</div> : null}
    </div>
  );
}
