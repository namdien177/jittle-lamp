import React from "react";
import { NavLink } from "react-router";

import { cn } from "../lib/cn";

export function PageHeader(props: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 border-b border-border px-5 py-6 sm:flex-row sm:items-start sm:justify-between sm:px-8",
        props.className,
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {props.eyebrow ? (
          <p className="font-mono font-semibold uppercase tracking-[0.12em] text-primary">
            {props.eyebrow}
          </p>
        ) : null}
        <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
          {props.title}
        </h1>
        {props.description ? (
          <p className="max-w-2xl text-base text-muted-foreground">
            {props.description}
          </p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {props.actions}
        </div>
      ) : null}
    </header>
  );
}

export function PageBody(props: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-1 flex-col gap-5 px-5 py-6 sm:px-8",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

export type TabItem = { to: string; label: string; end?: boolean };

/** Underline tab strip backed by react-router NavLink (for nested route tabs). */
export function PageTabs(props: {
  items: TabItem[];
  className?: string;
}): React.JSX.Element {
  return (
    <nav
      className={cn("flex gap-1 border-b border-border", props.className)}
      aria-label="Section tabs"
    >
      {props.items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end ?? false}
          className={({ isActive }) =>
            cn(
              "-mb-px border-b-2 px-3 py-2.5 text-base font-medium transition-colors",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
