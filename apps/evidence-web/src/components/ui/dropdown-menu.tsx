import React from "react";
import { Menu } from "@base-ui/react/menu";

import { cn } from "../../lib/cn";

export function DropdownMenu(props: {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
}): React.JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          // base-ui clones the trigger onto the provided element so callers can
          // pass any styled button.
          props.trigger as React.ReactElement
        }
      />
      <Menu.Portal>
        <Menu.Positioner
          className="z-[960] outline-none"
          align={props.align ?? "end"}
          sideOffset={6}
        >
          <Menu.Popup
            className={cn(
              "min-w-[12rem] overflow-hidden rounded-lg border border-border-strong bg-popover p-1 text-popover-foreground shadow-pop",
              "transition-[opacity,transform] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
              props.className
            )}
          >
            {props.children}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function DropdownMenuItem(props: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}): React.JSX.Element {
  return (
    <Menu.Item
      disabled={props.disabled ?? false}
      onClick={props.onClick ?? (() => undefined)}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-base outline-none [&_svg]:size-4",
        "data-[highlighted]:bg-white/[0.06] data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        props.destructive
          ? "text-destructive data-[highlighted]:bg-destructive/12"
          : "text-foreground"
      )}
    >
      {props.children}
    </Menu.Item>
  );
}

export function DropdownMenuLabel(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-2.5 pb-1 pt-1.5 text-sm font-semibold uppercase tracking-[0.06em] text-muted-foreground/80">
      {props.children}
    </div>
  );
}

export function DropdownMenuSeparator(): React.JSX.Element {
  return <Menu.Separator className="my-1 h-px bg-border" />;
}
