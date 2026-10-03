import React from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router";

import { cn } from "../lib/cn";

// The workspace shell owns one header bar per view (sidebar toggle, breadcrumb, actions), like
// Linear. Pages describe their title and actions with <PageHeader>; it renders into that bar.

type PageHeaderSlots = { title: HTMLElement | null; actions: HTMLElement | null };

const PageHeaderSlotContext = React.createContext<PageHeaderSlots>({ title: null, actions: null });

export function PageHeaderSlotProvider(props: { slots: PageHeaderSlots; children: React.ReactNode }): React.JSX.Element {
  return <PageHeaderSlotContext.Provider value={props.slots}>{props.children}</PageHeaderSlotContext.Provider>;
}

export function PageHeader(props: {
  /** Kept for older call sites; the breadcrumb already shows where the page sits. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element | null {
  const slots = React.useContext(PageHeaderSlotContext);
  // Still the page's h1, just sized to sit in the header bar.
  const title = <h1 className="truncate text-[13px] font-medium leading-normal tracking-normal text-foreground">{props.title}</h1>;
  const actions = props.actions ? <div className="flex items-center gap-1.5">{props.actions}</div> : null;

  // Outside the workspace shell (public pages) the header renders inline.
  if (!slots.title) {
    return (
      <header className={cn("mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", props.className)}>
        <div className="min-w-0 space-y-1">
          <h1>{props.title}</h1>
          {props.description ? <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p> : null}
        </div>
        {actions}
      </header>
    );
  }

  return (
    <>
      {createPortal(title, slots.title)}
      {actions && slots.actions ? createPortal(actions, slots.actions) : null}
      {props.description ? <p className={cn("-mt-1 mb-4 max-w-2xl text-sm text-muted-foreground", props.className)}>{props.description}</p> : null}
    </>
  );
}

export function PageBody(props: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={cn("flex w-full flex-1 flex-col gap-4", props.className)}>{props.children}</div>;
}

export type TabItem = { to: string; label: string; end?: boolean };

/** Underline tab strip backed by react-router NavLink (for nested route tabs). */
export function PageTabs(props: { items: TabItem[]; className?: string }): React.JSX.Element {
  return (
    <nav className={cn("flex gap-4 border-b border-border", props.className)} aria-label="Section tabs">
      {props.items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          className={({ isActive }) =>
            cn(
              "-mb-px border-b-2 py-2 text-[13px] font-medium transition-colors",
              isActive ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------------------------
// Settings layout (Vercel project settings): a quiet section list on the left, content on the right.
// ---------------------------------------------------------------------------------------------

export type SettingsNavItem = {
  to: string;
  label: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  end?: boolean;
};
export type SettingsNavGroup = { label?: string; items: readonly SettingsNavItem[] };

export function SettingsNav(props: { label: string; groups: readonly SettingsNavGroup[] }): React.JSX.Element {
  return (
    <nav aria-label={props.label} className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
      {props.groups.map((group, index) => (
        <div key={group.label ?? index} className="flex shrink-0 gap-1 lg:flex-col lg:gap-px">
          {group.label ? <p className="hidden px-2 pb-1 text-xs font-medium text-muted-foreground lg:block">{group.label}</p> : null}
          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end ?? false}
                className={({ isActive }) =>
                  cn(
                    "flex h-7 items-center gap-2 whitespace-nowrap rounded-md px-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    isActive && "bg-accent text-foreground"
                  )
                }
              >
                {Icon ? <Icon className="size-3.5 shrink-0" aria-hidden /> : null}
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export function SettingsLayout(props: {
  nav: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn("mx-auto grid w-full max-w-6xl gap-5 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8", props.className)}>
      <aside className="min-w-0 lg:sticky lg:top-0 lg:self-start">{props.nav}</aside>
      <div className="min-w-0 max-w-4xl">{props.children}</div>
    </div>
  );
}

/** Heading of one settings page, inside SettingsLayout. */
export function SettingsPageTitle(props: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-1">
        {/* The header bar already holds the page h1. */}
        <h2 className="text-xl">{props.title}</h2>
        {props.description ? <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p> : null}
      </div>
      {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
    </div>
  );
}
