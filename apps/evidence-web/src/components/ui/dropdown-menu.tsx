import React from "react";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "../../lib/cn";

// shadcn/ui DropdownMenu on Base UI's Menu.

export const DropdownMenu = Menu.Root;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuSub = Menu.SubmenuRoot;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export function DropdownMenuTrigger(props: React.ComponentProps<typeof Menu.Trigger>): React.JSX.Element {
  return <Menu.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

const popupClass =
  "jl-scroll max-h-[min(var(--available-height,24rem),24rem)] min-w-[11rem] origin-[var(--transform-origin)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-pop outline-none transition-[opacity,transform] duration-150 ease-[cubic-bezier(.23,1,.32,1)] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0";

export function DropdownMenuContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof Menu.Popup> & {
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  sideOffset?: number;
}): React.JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner className="z-[960] outline-none" align={align} side={side} sideOffset={sideOffset}>
        <Menu.Popup data-slot="dropdown-menu-content" className={cn(popupClass, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

const itemClass =
  "relative flex h-7 w-full cursor-default select-none items-center gap-2 rounded-md px-2 text-sm text-foreground outline-none data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground";

export function DropdownMenuItem({
  className,
  variant = "default",
  inset,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { variant?: "default" | "destructive"; inset?: boolean }): React.JSX.Element {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(
        itemClass,
        inset && "pl-8",
        variant === "destructive" && "text-destructive data-[highlighted]:bg-destructive/10 [&_svg:not([class*='text-'])]:text-destructive",
        className
      )}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof Menu.CheckboxItem>): React.JSX.Element {
  return (
    <Menu.CheckboxItem data-slot="dropdown-menu-checkbox-item" className={cn(itemClass, "pl-8", className)} {...props}>
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <Menu.CheckboxItemIndicator>
          <Check className="size-3.5 text-foreground" aria-hidden />
        </Menu.CheckboxItemIndicator>
      </span>
      {children}
    </Menu.CheckboxItem>
  );
}

export function DropdownMenuLabel({ className, inset, ...props }: React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }): React.JSX.Element {
  return <div data-slot="dropdown-menu-label" className={cn("px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground", inset && "pl-8", className)} {...props} />;
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof Menu.Separator>): React.JSX.Element {
  return <Menu.Separator data-slot="dropdown-menu-separator" className={cn("-mx-1 my-1 h-px bg-border", className)} {...props} />;
}

export function DropdownMenuShortcut({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return <span data-slot="dropdown-menu-shortcut" className={cn("ml-auto text-xs tracking-wide text-muted-foreground", className)} {...props} />;
}

export function DropdownMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof Menu.SubmenuTrigger>): React.JSX.Element {
  return (
    <Menu.SubmenuTrigger data-slot="dropdown-menu-sub-trigger" className={cn(itemClass, "data-[popup-open]:bg-accent", className)} {...props}>
      {children}
      <ChevronRight className="ml-auto size-3.5" aria-hidden />
    </Menu.SubmenuTrigger>
  );
}

export function DropdownMenuSubContent({ className, ...props }: React.ComponentProps<typeof Menu.Popup>): React.JSX.Element {
  return (
    <Menu.Portal>
      <Menu.Positioner className="z-[961] outline-none" side="right" align="start" sideOffset={2}>
        <Menu.Popup data-slot="dropdown-menu-sub-content" className={cn(popupClass, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}
