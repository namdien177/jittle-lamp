import React from "react";

import { cn } from "../../lib/cn";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex select-none items-center gap-1.5 text-sm font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
