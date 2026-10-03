import React from "react";

import { cn } from "../../lib/cn";

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-[18px] min-w-[18px] select-none items-center justify-center gap-0.5 rounded-[4px] border border-border bg-muted px-1 font-sans text-[11px] font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}
