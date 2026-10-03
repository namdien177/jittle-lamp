import { redirect, type RouteObject } from "react-router";

export const testingSettingsBase = "/test-cases/settings";

// Testing → Settings routes (unit 1c.5, ops.4): organisation-wide configuration for test cases,
// under the Testing section at /test-cases/settings. Spread into the workspace children in router.tsx.
export const testingSettingsRoute: RouteObject = {
  path: "test-cases/settings",
  lazy: async () => ({ Component: (await import("./nav")).TestingSettingsLayout }),
  children: [
    { index: true, loader: () => redirect(`${testingSettingsBase}/variables`) },
    { path: "variables", lazy: async () => ({ Component: (await import("./variables")).SettingsTestVariablesPage }) },
    { path: "environments", lazy: async () => ({ Component: (await import("./environments")).SettingsTestEnvironmentsPage }) },
    { path: "credentials", lazy: async () => ({ Component: (await import("./credentials")).SettingsTestCredentialsPage }) },
    { path: "actions", lazy: async () => ({ Component: (await import("./macros")).SettingsTestMacrosPage }) },
    { path: "tags", lazy: async () => ({ Component: (await import("./tags")).SettingsTestTagsPage }) },
    { path: "ai-model", lazy: async () => ({ Component: (await import("./ai-model")).SettingsTestAiModelPage }) },
    { path: "model-spend", lazy: async () => ({ Component: (await import("./model-spend")).SettingsTestModelSpendPage }) },
    { path: "runner-pools", lazy: async () => ({ Component: (await import("./runner-pools")).SettingsTestRunnerPoolsPage }) },
    { path: "test-runs", lazy: async () => ({ Component: (await import("./test-runs")).SettingsTestRunsPage }) },
    { path: "notifications", lazy: async () => ({ Component: (await import("./notifications")).SettingsTestNotificationsPage }) },
    { path: "webhooks", lazy: async () => ({ Component: (await import("./webhooks")).SettingsTestWebhooksPage }) },
    { path: "agent-notes", lazy: async () => ({ Component: (await import("./agent-notes")).SettingsTestAgentNotesPage }) }
  ]
};

// Testing settings used to live under /settings/test-cases; stored notification links and bookmarks
// still point there. `macros` was renamed to `actions`.
const legacySections: Record<string, string> = { macros: "actions" };

export const legacyTestCaseSettingsRoutes: RouteObject[] = [
  { path: "test-cases", loader: () => redirect(`${testingSettingsBase}/variables`) },
  {
    path: "test-cases/:section",
    loader: ({ params }) => {
      const section = params.section ?? "";
      return redirect(`${testingSettingsBase}/${legacySections[section] ?? section}`);
    }
  }
];
