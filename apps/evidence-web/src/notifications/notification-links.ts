import type { Notification } from "@jittle-lamp/shared";

// Where an in-app notification leads (design.md §10b). The backend may send a URL; otherwise the
// subject decides. Absolute URLs on another origin are not followed from the bell.

export const notificationPollMs = 30_000;

export function testRunHref(runId: string): string {
  return `/test-cases/runs/${encodeURIComponent(runId)}`;
}

export function importBatchHref(batchId: string): string {
  return `/test-cases/import/${encodeURIComponent(batchId)}`;
}

export const reviewQueueHref = "/test-cases/review";
export const runnerPoolsHref = "/settings/test-cases/runner-pools";

export function notificationHref(notification: Pick<Notification, "url" | "kind" | "subjectType" | "subjectId">, origin?: string): string | null {
  if (notification.url) {
    if (notification.url.startsWith("/")) return notification.url;
    try {
      const url = new URL(notification.url);
      if (origin && url.origin === origin) return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      // fall through to the subject
    }
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
