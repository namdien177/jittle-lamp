import React from "react";
import { Bell, Globe, MessageSquare } from "lucide-react";
import type { NotificationChannel, NotificationKind } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/misc";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useNotificationChannels, useNotificationSubscriptions, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, Toggle } from "../../test-cases/admin-ui";
import { isSubscribed, notificationKinds, toggleSubscription, type NotificationSubscriptions } from "../../notifications/subscriptions";

// Settings → Notifications (design.md §10b): your in-app subscriptions per event, and the
// organisation's channels. The beta ships the in-app channel only; Slack and webhook channels are
// listed when the backend has them and marked phase 2 otherwise.

const eventLabels: Record<NotificationKind, { title: string; description: string }> = {
  "run.finished": { title: "Runs finished", description: "Yours always arrive. On: also runs other people requested." },
  "run.blocked": { title: "Runs blocked", description: "Missing credential, no runner, budget. Yours always arrive." },
  "batch.finished": { title: "Batches finished", description: "Dataset and suite runs. Yours always arrive." },
  "import.finished": { title: "Imports finished", description: "Yours always arrive. On: also imports by others." },
  "review.pending_count": { title: "Review queue", description: "Cases waiting for approval. On by default if you can approve." },
  "runner.offline": { title: "Runner offline", description: "A pool lost its workers. On by default if you manage test settings." }
};

function ChannelRow(props: { icon: React.ReactNode; title: string; detail: string; status: React.ReactNode }): React.JSX.Element {
  return (
    <li className="flex items-center gap-3 rounded-md border border-border px-4 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-secondary text-muted-foreground">{props.icon}</span>
      <div className="mr-auto min-w-0">
        <p className="font-semibold text-foreground">{props.title}</p>
        <p className="text-sm text-muted-foreground">{props.detail}</p>
      </div>
      {props.status}
    </li>
  );
}

function channelDetail(channel: NotificationChannel): string {
  const kinds = channel.filter.kinds.length > 0 ? channel.filter.kinds.join(", ") : "all events";
  const target = channel.kind === "webhook" ? (channel.config.url ?? "webhook") : channel.kind === "slack" ? "Slack webhook credential" : channel.kind;
  return `${target} · ${kinds}`;
}

export function SettingsTestNotificationsPage(): React.JSX.Element {
  const channels = useNotificationChannels();
  // No channel endpoint yet (404) means the backend only has the in-app channel.
  const external = (channels.data ?? []).filter((channel) => channel.kind !== "in_app");
  const hasSlack = external.some((channel) => channel.kind === "slack");
  const hasWebhook = external.some((channel) => channel.kind === "webhook");

  return (
    <div className="grid gap-4">
      <AdminCard title="Channels" description="Every run, batch, import and review event goes through one bus; channels decide where it is delivered.">
        {channels.isPending && !channels.isError ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="grid gap-2">
            <ChannelRow
              icon={<Bell className="size-4" aria-hidden />}
              title="In-app"
              detail="The bell in the web and desktop apps. Each person sees events for their runs, runs they attached to, imports and the review queue."
              status={<Badge variant="success">Always on</Badge>}
            />
            {external.map((channel) => (
              <ChannelRow
                key={channel.id}
                icon={channel.kind === "slack" ? <MessageSquare className="size-4" aria-hidden /> : <Globe className="size-4" aria-hidden />}
                title={channel.kind === "slack" ? "Slack" : channel.kind === "webhook" ? "Webhook" : channel.kind}
                detail={channelDetail(channel)}
                status={<Badge variant={channel.enabled ? "success" : "muted"}>{channel.enabled ? "Enabled" : "Disabled"}</Badge>}
              />
            ))}
            {!hasSlack ? <ChannelRow icon={<MessageSquare className="size-4" aria-hidden />} title="Slack" detail="Post run and batch results to a channel." status={<Badge variant="outline">Phase 2</Badge>} /> : null}
            {!hasWebhook ? <ChannelRow icon={<Globe className="size-4" aria-hidden />} title="Webhook" detail="POST event JSON to your endpoint." status={<Badge variant="outline">Phase 2</Badge>} /> : null}
          </ul>
        )}
      </AdminCard>
      <SubscriptionsCard />
    </div>
  );
}

function SubscriptionsCard(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const subscriptions = useNotificationSubscriptions();
  const save = useTestAdminMutation((getToken, body: NotificationSubscriptions) => testAdminApi.putNotificationSubscriptions(getToken, body), [testAdminKeys.notificationSubscriptions]);
  const flags = { canApprove: permissions.can("test_case.approve"), canManageConfig: permissions.can("test_config.manage") };
  const current: NotificationSubscriptions = { subscribed: subscriptions.data?.subscribed ?? [], unsubscribed: subscriptions.data?.unsubscribed ?? [] };

  const onToggle = (kind: NotificationKind, on: boolean) => {
    void save.mutateAsync(toggleSubscription(current, kind, on)).catch(() => toast.error("Could not save the notification setting."));
  };

  return (
    <AdminCard title="My notifications" description="Delivered to the bell in the web and desktop apps. These settings are yours, per organisation.">
      <ErrorNote error={subscriptions.error ?? save.error} />
      {subscriptions.isPending ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {notificationKinds.map((kind) => (
            <Toggle
              key={kind}
              label={eventLabels[kind].title}
              description={eventLabels[kind].description}
              checked={isSubscribed(kind, current, flags)}
              disabled={save.isPending}
              onChange={(on) => onToggle(kind, on)}
            />
          ))}
        </div>
      )}
    </AdminCard>
  );
}
