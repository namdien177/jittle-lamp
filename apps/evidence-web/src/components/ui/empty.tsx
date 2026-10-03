import React from "react";

import { cn } from "../../lib/cn";

/** shadcn `Empty` pattern: a quiet, centred placeholder for lists with no rows. */
export function EmptyState(props: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      data-slot="empty"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center",
        props.className
      )}
    >
      {props.icon ? (
        <div className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
          {props.icon}
        </div>
      ) : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{props.title}</p>
        {props.description ? <p className="mx-auto max-w-sm text-sm text-muted-foreground">{props.description}</p> : null}
      </div>
      {props.action ? <div className="mt-1">{props.action}</div> : null}
    </div>
  );
}
