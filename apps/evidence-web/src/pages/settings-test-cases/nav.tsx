import React from "react";
import { Outlet, useLocation } from "react-router";
import {
  Bell,
  Bot,
  CircleDollarSign,
  Gauge,
  Globe,
  KeyRound,
  NotebookPen,
  Server,
  Tags,
  Variable,
  Webhook,
  Zap
} from "lucide-react";

import { PageHeader, SettingsLayout, SettingsNav, type SettingsNavGroup } from "../../components/page";
import { testingSettingsBase } from "./routes";

// Testing → Settings: organisation-wide configuration for test cases, reached from the Testing
// section of the sidebar. Laid out like Vercel's project settings.

export const testingSettingsGroups = [
  {
    label: "Run inputs",
    items: [
      { to: `${testingSettingsBase}/variables`, label: "Variables", icon: Variable },
      { to: `${testingSettingsBase}/environments`, label: "Environments", icon: Globe },
      { to: `${testingSettingsBase}/credentials`, label: "Credentials", icon: KeyRound },
      { to: `${testingSettingsBase}/actions`, label: "Actions", icon: Zap }
    ]
  },
  {
    label: "Authoring",
    items: [
      { to: `${testingSettingsBase}/tags`, label: "Tags", icon: Tags },
      { to: `${testingSettingsBase}/agent-notes`, label: "Agent notes", icon: NotebookPen }
    ]
  },
  {
    label: "AI",
    items: [
      { to: `${testingSettingsBase}/ai-model`, label: "Model", icon: Bot },
      { to: `${testingSettingsBase}/model-spend`, label: "Spend", icon: CircleDollarSign }
    ]
  },
  {
    label: "Execution",
    items: [
      { to: `${testingSettingsBase}/runner-pools`, label: "Runner pools", icon: Server },
      { to: `${testingSettingsBase}/test-runs`, label: "Run limits", icon: Gauge }
    ]
  },
  {
    label: "Integrations",
    items: [
      { to: `${testingSettingsBase}/notifications`, label: "Notifications", icon: Bell },
      { to: `${testingSettingsBase}/webhooks`, label: "Webhooks", icon: Webhook }
    ]
  }
] as const satisfies readonly SettingsNavGroup[];

export function testingSettingsLabel(pathname: string): string | null {
  for (const group of testingSettingsGroups) {
    for (const item of group.items) if (pathname.startsWith(item.to)) return item.label;
  }
  return null;
}

export function TestingSettingsLayout(): React.JSX.Element {
  const location = useLocation();
  return (
    <>
      <PageHeader title={testingSettingsLabel(location.pathname) ?? "Settings"} />
      <SettingsLayout nav={<SettingsNav label="Testing settings" groups={testingSettingsGroups} />}>
        <Outlet />
      </SettingsLayout>
    </>
  );
}
