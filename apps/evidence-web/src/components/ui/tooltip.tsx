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
            "flex max-w-[min(22rem,calc(100vw-1rem))] origin-[var(--transform-origin)] items-center gap-2 rounded-md border border-border bg-popover px-2 py-1 text-xs font-medium leading-snug text-popover-foreground shadow-pop [overflow-wrap:anywhere]",
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

/** A tooltip on one element: `<Hint label="Copy link"><Button … /></Hint>`. The child gets the trigger props. */
export function Hint(props: {
  label: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  disabled?: boolean;
  children: React.ReactElement;
}): React.JSX.Element {
  return (
    <Tooltip {...(props.disabled !== undefined ? { disabled: props.disabled } : {})}>
      <TooltipTrigger render={props.children} />
      <TooltipContent side={props.side ?? "top"} align={props.align ?? "center"}>
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Single-line text that truncates with an ellipsis and shows the full text in a tooltip, only when
 * it is actually cut off. `render` picks the element (span by default) and carries the classes.
 */
export function TruncatedText(props: {
  children: React.ReactNode;
  label?: React.ReactNode;
  className?: string;
  render?: React.ReactElement<{ className?: string }>;
  side?: "top" | "bottom" | "left" | "right";
}): React.JSX.Element {
  const [truncated, setTruncated] = React.useState(false);
  const element = props.render ?? <span />;
  return (
    <Tooltip disabled={!truncated}>
      <TooltipTrigger
        render={React.cloneElement(element, { className: cn("block min-w-0 truncate", element.props.className, props.className) })}
        onPointerEnter={(event) => {
          const target = event.currentTarget;
          setTruncated(target.scrollWidth > target.clientWidth + 1);
        }}
        onFocus={(event) => {
          const target = event.currentTarget;
          setTruncated(target.scrollWidth > target.clientWidth + 1);
        }}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent side={props.side ?? "top"}>{props.label ?? props.children}</TooltipContent>
    </Tooltip>
  );
}
