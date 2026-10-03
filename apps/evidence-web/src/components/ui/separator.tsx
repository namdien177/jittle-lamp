import React from "react";
import { Separator as BaseSeparator } from "@base-ui/react/separator";

import { cn } from "../../lib/cn";

export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof BaseSeparator>): React.JSX.Element {
  return (
    <BaseSeparator
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      {...props}
    />
  );
}
