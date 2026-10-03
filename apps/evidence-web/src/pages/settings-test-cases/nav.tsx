import React from "react";
import { NavLink } from "react-router";
import { Bell, Bot, CircleDollarSign, Gauge, Globe, KeyRound, NotebookPen, Puzzle, Server, Tags, Webhook } from "lucide-react";

import { cn } from "../../lib/cn";

// Settings → Test cases section (unit 1c.5, ops.4). Rendered under the main settings nav.

export const testCaseSettingsTabs = [
  { to: "/settings/test-cases/environments", label: "Environments", icon: Globe },
  { to: "/settings/test-cases/credentials", label: "Credentials", icon: KeyRound },
  { to: "/settings/test-cases/macros", label: "Macros", icon: Puzzle },
  { to: "/settings/test-cases/tags", label: "Tags", icon: Tags },
  { to: "/settings/test-cases/ai-model", label: "AI model", icon: Bot },
  { to: "/settings/test-cases/model-spend", label: "Model spend", icon: CircleDollarSign },
  { to: "/settings/test-cases/runner-pools", label: "Runner pools", icon: Server },
  { to: "/settings/test-cases/test-runs", label: "Test runs", icon: Gauge },
  { to: "/settings/test-cases/notifications", label: "Notifications", icon: Bell },
  { to: "/settings/test-cases/webhooks", label: "Webhooks", icon: Webhook },
  { to: "/settings/test-cases/agent-notes", label: "Agent notes", icon: NotebookPen }
] as const;

export function TestCaseSettingsNav(): React.JSX.Element {
  return (
    <nav aria-label="Test case settings" className="mt-3 rounded-md border border-border bg-card p-2 shadow-soft">
      <div className="mb-2 px-2 py-1 font-mono text-xs font-semibold uppercase text-muted-foreground">Test cases</div>
      <div className="grid gap-1">
        {testCaseSettingsTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-base font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-secondary text-foreground shadow-soft"
                )
              }
            >
              <Icon className="size-4" aria-hidden />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
