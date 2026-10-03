import React from "react";
import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeft } from "lucide-react";

import { cn } from "../../lib/cn";
import { Button } from "./button";
import { Kbd } from "./kbd";
import { Sheet, SheetContent, SheetTitle } from "./sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

// shadcn/ui Sidebar, trimmed to what the workspace uses: icon collapse on desktop, a sheet on
// small screens, a persisted state, ⌘B / `[` to toggle and a rail on the sidebar edge.

const SIDEBAR_STORAGE_KEY = "jl-sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 767px)";

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

export function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext);
  if (!context) throw new Error("useSidebar must be used within a SidebarProvider.");
  return context;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState(() => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches);
  React.useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setIsMobile(media.matches);
    media.addEventListener("change", onChange);
    onChange();
    return () => media.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export const sidebarShortcutLabel = typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘B" : "Ctrl+B";

export function SidebarProvider({
  className,
  style,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [open, setOpenState] = React.useState(() => typeof window === "undefined" || window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "true");

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next);
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(!next));
  }, []);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value);
    else setOpen(!open);
  }, [isMobile, open, setOpen]);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const chord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b";
      const bracket = event.key === "[" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target);
      if (!chord && !bracket) return;
      if (bracket && document.querySelector("[role='dialog']")) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({ state: open ? "expanded" : "collapsed", open, setOpen, openMobile, setOpenMobile, isMobile, toggleSidebar }),
    [open, setOpen, openMobile, isMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": "15rem", "--sidebar-width-icon": "3.25rem", ...style } as React.CSSProperties}
        className={cn("group/sidebar-wrapper flex h-svh w-full overflow-hidden bg-sidebar", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="left" showCloseButton={false} className="w-[var(--sidebar-width)] bg-sidebar p-0 text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div data-slot="sidebar" data-mobile="true" className="flex h-full w-full flex-col">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      data-slot="sidebar"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      className="group peer relative hidden shrink-0 text-sidebar-foreground md:block"
    >
      <div
        className={cn(
          "relative h-svh w-[var(--sidebar-width)] transition-[width] duration-200 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none",
          "group-data-[collapsible=icon]:w-[var(--sidebar-width-icon)]"
        )}
      >
        <div data-slot="sidebar-inner" className={cn("flex h-full w-full flex-col overflow-hidden", className)} {...props}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>): React.JSX.Element {
  const { toggleSidebar, state, isMobile } = useSidebar();
  const label = isMobile ? "Open navigation" : state === "expanded" ? "Collapse sidebar" : "Expand sidebar";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            data-slot="sidebar-trigger"
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={cn("text-muted-foreground", className)}
            onClick={(event) => {
              onClick?.(event);
              toggleSidebar();
            }}
            {...props}
          >
            <PanelLeft aria-hidden />
          </Button>
        }
      />
      <TooltipContent side="bottom">
        {label}
        {!isMobile ? <Kbd>{sidebarShortcutLabel}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Thin hit area on the sidebar's right edge; clicking it toggles the sidebar. */
export function SidebarRail({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  const { toggleSidebar, state } = useSidebar();
  return (
    // The rail is as tall as the window, so the tooltip follows the pointer vertically.
    <Tooltip trackCursorAxis="y">
      <TooltipTrigger
        render={
          <button
            type="button"
            data-slot="sidebar-rail"
            aria-label="Toggle sidebar"
            tabIndex={-1}
            onClick={toggleSidebar}
            className={cn(
              "absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-w-resize transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px hover:after:bg-border-strong md:flex",
              "group-data-[state=collapsed]:cursor-e-resize",
              className
            )}
            {...props}
          />
        }
      />
      <TooltipContent side="right">
        {state === "expanded" ? "Collapse sidebar" : "Expand sidebar"}
        <Kbd>{sidebarShortcutLabel}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** The main content panel, inset from the window edges like Linear's. */
export function SidebarInset({ className, ...props }: React.HTMLAttributes<HTMLElement>): React.JSX.Element {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:my-2 md:mr-2 md:rounded-lg md:border md:border-sidebar-border md:shadow-soft",
        className
      )}
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="sidebar-header" className={cn("flex flex-col gap-1 p-2", className)} {...props} />;
}

export function SidebarFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="sidebar-footer" className={cn("mt-auto flex flex-col gap-1 p-2", className)} {...props} />;
}

export function SidebarContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      data-slot="sidebar-content"
      className={cn("jl-scroll flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden group-data-[collapsible=icon]:overflow-hidden", className)}
      {...props}
    />
  );
}

export function SidebarSeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div role="separator" data-slot="sidebar-separator" className={cn("mx-2 h-px shrink-0 bg-sidebar-border", className)} {...props} />;
}

export function SidebarGroup({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="sidebar-group" className={cn("relative flex w-full min-w-0 flex-col px-2 py-1", className)} {...props} />;
}

export function SidebarGroupLabel({ className, render, ...props }: useRender.ComponentProps<"div">): React.JSX.Element {
  return useRender({
    defaultTagName: "div",
    render,
    props: mergeProps<"div">(
      {
        "data-slot": "sidebar-group-label",
        className: cn(
          "flex h-7 shrink-0 select-none items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-[margin,opacity] duration-200",
          "group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:-mt-7 group-data-[collapsible=icon]:opacity-0",
          className
        )
      } as React.ComponentProps<"div">,
      props
    )
  });
}

export function SidebarGroupContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div data-slot="sidebar-group-content" className={cn("w-full text-sm", className)} {...props} />;
}

export function SidebarMenu({ className, ...props }: React.HTMLAttributes<HTMLUListElement>): React.JSX.Element {
  return <ul data-slot="sidebar-menu" className={cn("flex w-full min-w-0 flex-col gap-px", className)} {...props} />;
}

export function SidebarMenuItem({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>): React.JSX.Element {
  return <li data-slot="sidebar-menu-item" className={cn("group/menu-item relative", className)} {...props} />;
}

export const sidebarMenuButtonVariants = cva(
  [
    "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md px-2 text-left text-[13px] font-medium text-sidebar-foreground outline-none ring-sidebar-ring transition-[width,height,padding,background-color,color] duration-150",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent disabled:pointer-events-none disabled:opacity-50",
    "aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
    "group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2!",
    "[&>span:last-child]:truncate [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground aria-[current=page]:[&_svg]:text-sidebar-accent-foreground data-[active=true]:[&_svg]:text-sidebar-accent-foreground"
  ].join(" "),
  {
    variants: {
      size: {
        default: "h-7",
        sm: "h-6 text-xs",
        lg: "h-9 group-data-[collapsible=icon]:p-1!"
      }
    },
    defaultVariants: { size: "default" }
  }
);

export function SidebarMenuButton({
  render,
  size,
  tooltip,
  isActive,
  className,
  ...props
}: useRender.ComponentProps<"button"> &
  VariantProps<typeof sidebarMenuButtonVariants> & { tooltip?: React.ReactNode; isActive?: boolean }): React.JSX.Element {
  const { state, isMobile } = useSidebar();
  const button = useRender({
    defaultTagName: "button",
    render,
    props: mergeProps<"button">(
      {
        "data-slot": "sidebar-menu-button",
        "data-active": isActive ? "true" : undefined,
        className: cn(sidebarMenuButtonVariants({ size }), className)
      } as React.ComponentProps<"button">,
      props
    )
  });

  if (!tooltip || state !== "collapsed" || isMobile) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" align="center">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export function SidebarMenuBadge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      data-slot="sidebar-menu-badge"
      className={cn(
        "pointer-events-none absolute right-1.5 top-1/2 flex h-4 min-w-4 -translate-y-1/2 select-none items-center justify-center rounded px-1 text-[11px] font-medium tabular-nums text-muted-foreground",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

export function SidebarMenuAction({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      data-slot="sidebar-menu-action"
      className={cn(
        "absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none transition-[transform,opacity] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&_svg]:size-3.5",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

export function SidebarMenuSub({ className, ...props }: React.HTMLAttributes<HTMLUListElement>): React.JSX.Element {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      className={cn(
        "ml-[15px] flex min-w-0 flex-col gap-px border-l border-sidebar-border py-0.5 pl-2",
        "group-data-[collapsible=icon]:hidden",
        className
      )}
      {...props}
    />
  );
}

export function SidebarMenuSubItem({ className, ...props }: React.LiHTMLAttributes<HTMLLIElement>): React.JSX.Element {
  return <li data-slot="sidebar-menu-sub-item" className={cn("relative", className)} {...props} />;
}

export function SidebarMenuSubButton({ render, className, isActive, ...props }: useRender.ComponentProps<"a"> & { isActive?: boolean }): React.JSX.Element {
  return useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        "data-slot": "sidebar-menu-sub-button",
        "data-active": isActive ? "true" : undefined,
        className: cn(
          "flex h-6 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-[13px] text-sidebar-foreground/80 outline-none ring-sidebar-ring transition-colors",
          "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
          "aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground",
          "[&>span:last-child]:truncate [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
          className
        )
      } as React.ComponentProps<"a">,
      props
    )
  });
}
