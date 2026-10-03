import type { NotificationKind } from "@jittle-lamp/shared";

// Per-user notification preferences over GET/PUT /notifications/subscriptions (design.md §10b).
// Events about your own runs and imports always arrive; a subscription adds the same events for
// everyone else's. Review and runner events go by default to people who can act on them
// (test_case.approve, test_config.manage) unless they opt out.

export type NotificationSubscriptions = { subscribed: NotificationKind[]; unsubscribed: NotificationKind[] };

export const notificationKinds: readonly NotificationKind[] = ["run.finished", "run.blocked", "batch.finished", "import.finished", "review.pending_count", "runner.offline"];

export function defaultOn(kind: NotificationKind, permissions: { canApprove: boolean; canManageConfig: boolean }): boolean {
  if (kind === "review.pending_count") return permissions.canApprove;
  if (kind === "runner.offline") return permissions.canManageConfig;
  return false;
}

export function isSubscribed(kind: NotificationKind, value: NotificationSubscriptions, permissions: { canApprove: boolean; canManageConfig: boolean }): boolean {
  if (value.subscribed.includes(kind)) return true;
  if (value.unsubscribed.includes(kind)) return false;
  return defaultOn(kind, permissions);
}

export function toggleSubscription(value: NotificationSubscriptions, kind: NotificationKind, on: boolean): NotificationSubscriptions {
  const subscribed = value.subscribed.filter((item) => item !== kind);
  const unsubscribed = value.unsubscribed.filter((item) => item !== kind);
  return on ? { subscribed: [...subscribed, kind], unsubscribed } : { subscribed, unsubscribed: [...unsubscribed, kind] };
}
