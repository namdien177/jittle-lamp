import React from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";

import { cn } from "../../lib/cn";

// shadcn/ui Tooltip on Base UI primitives.

export function TooltipProvider({ delay = 300, ...props }: React.ComponentProps<typeof BaseTooltip.Provider>): React.JSX.Element {
  return <BaseTooltip.Provider delay={delay} {...props} />;
}

export const Tooltip = BaseTooltip.Root;

export function TooltipTrigger(props: React.ComponentProps<typeof BaseTooltip.Trigger>): React.JSX.Element {
  return <BaseTooltip.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  side = "top",
  align = "center",
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof BaseTooltip.Popup> & {
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}): React.JSX.Element {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner className="z-[980]" side={side} align={align} sideOffset={sideOffset}>
        <BaseTooltip.Popup
          data-slot="tooltip-content"
          className={cn(
            "flex origin-[var(--transform-origin)] items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-pop",
            "transition-[opacity,transform] duration-100 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[instant]:transition-none data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
