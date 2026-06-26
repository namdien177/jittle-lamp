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
        "mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        props.className,
      )}
    >
      <div className="min-w-0 space-y-2">
        {props.eyebrow ? (
          <p className="jl-eyebrow">
            {props.eyebrow}
          </p>
        ) : null}
        <h1>
          {props.title}
        </h1>
        {props.description ? (
          <p className="jl-lead max-w-2xl">
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
        "flex w-full flex-1 flex-col gap-5",
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
              "-mb-px border-b-2 px-3 py-2.5 text-base font-semibold transition-colors",
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
