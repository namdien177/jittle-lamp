import type { RouteObject } from "react-router";

// Workspace routes for import, batch and review (unit 1c.4). Spread into the workspace children in
// router.tsx next to the `test-cases` route; static segments win over a `test-cases/:id` route.
export const testCaseAdminRoutes: RouteObject[] = [
  { path: "test-cases/import", lazy: async () => ({ Component: (await import("./import/import-page")).TestCaseImportPage }) },
  { path: "test-cases/import/:batchId", lazy: async () => ({ Component: (await import("./import/batch-page")).TestCaseImportBatchPage }) },
  { path: "test-cases/review", lazy: async () => ({ Component: (await import("./review/review-queue-page")).TestCaseReviewQueuePage }) }
];
