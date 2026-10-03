import type { Notification } from "@jittle-lamp/shared";

// Where an in-app notification leads (design.md §10b). The backend may send a URL; otherwise the
// subject decides. Absolute URLs on another origin are not followed from the bell.

export const notificationPollMs = 30_000;

export function testRunHref(runId: string): string {
  return `/test-runs/${encodeURIComponent(runId)}`;
}

export function importBatchHref(batchId: string): string {
  return `/test-cases/import/${encodeURIComponent(batchId)}`;
}

export const reviewQueueHref = "/test-cases/review";
export const runnerPoolsHref = "/test-cases/settings/runner-pools";

// Backend URLs whose screens live elsewhere in the web app.
const pathAliases: Record<string, string> = {
  "/test-cases?status=review": reviewQueueHref,
  "/settings/runner-pools": runnerPoolsHref,
  // Testing settings moved from /settings/test-cases; older notifications still carry it.
  "/settings/test-cases/runner-pools": runnerPoolsHref
};

function localPath(url: string, origin?: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return pathAliases[url] ?? url;
  try {
    const parsed = new URL(url);
    if (origin && parsed.origin === origin) return localPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    // not a URL; use the subject
  }
  return null;
}

export function notificationHref(notification: Pick<Notification, "url" | "kind" | "subjectType" | "subjectId">, origin?: string): string | null {
  if (notification.url) {
    const path = localPath(notification.url, origin);
    if (path) return path;
  }
  switch (notification.kind) {
    case "run.finished":
    case "run.blocked":
      return testRunHref(notification.subjectId);
    case "import.finished":
      return importBatchHref(notification.subjectId);
    case "review.pending_count":
      return reviewQueueHref;
    case "runner.offline":
      return runnerPoolsHref;
    case "batch.finished":
      return notification.subjectType === "test_run" ? testRunHref(notification.subjectId) : null;
  }
}

export function unreadBadgeLabel(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 99 ? "99+" : String(unread);
}

export function bellAccessibleName(unread: number): string {
  return unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
}
