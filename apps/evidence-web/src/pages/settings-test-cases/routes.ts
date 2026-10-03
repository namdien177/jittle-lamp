import { redirect, type RouteObject } from "react-router";

// Settings → Test cases routes (unit 1c.5, ops.4). Spread into the `settings` children in router.tsx.
export const testCaseSettingsRoutes: RouteObject[] = [
  { path: "test-cases", loader: () => redirect("/settings/test-cases/environments") },
  { path: "test-cases/environments", lazy: async () => ({ Component: (await import("./environments")).SettingsTestEnvironmentsPage }) },
  { path: "test-cases/credentials", lazy: async () => ({ Component: (await import("./credentials")).SettingsTestCredentialsPage }) },
  { path: "test-cases/macros", lazy: async () => ({ Component: (await import("./macros")).SettingsTestMacrosPage }) },
  { path: "test-cases/tags", lazy: async () => ({ Component: (await import("./tags")).SettingsTestTagsPage }) },
  { path: "test-cases/ai-model", lazy: async () => ({ Component: (await import("./ai-model")).SettingsTestAiModelPage }) },
  { path: "test-cases/model-spend", lazy: async () => ({ Component: (await import("./model-spend")).SettingsTestModelSpendPage }) },
  { path: "test-cases/runner-pools", lazy: async () => ({ Component: (await import("./runner-pools")).SettingsTestRunnerPoolsPage }) },
  { path: "test-cases/test-runs", lazy: async () => ({ Component: (await import("./test-runs")).SettingsTestRunsPage }) },
  { path: "test-cases/notifications", lazy: async () => ({ Component: (await import("./notifications")).SettingsTestNotificationsPage }) },
  { path: "test-cases/webhooks", lazy: async () => ({ Component: (await import("./webhooks")).SettingsTestWebhooksPage }) },
  { path: "test-cases/agent-notes", lazy: async () => ({ Component: (await import("./agent-notes")).SettingsTestAgentNotesPage }) }
];
