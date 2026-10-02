import React from "react";
import { Bell, Globe, MessageSquare } from "lucide-react";
import type { NotificationChannel, NotificationKind } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/misc";
import { useNotificationChannels } from "../../test-cases/admin-queries";
import { AdminCard } from "../../test-cases/admin-ui";

// Settings → Notifications (design.md §10b): the beta ships the in-app channel only. Slack and
// webhook channels are listed when the backend has them and marked phase 2 otherwise.

const eventDescriptions: Record<NotificationKind, string> = {
  "run.finished": "A run you requested or attached to finished",
  "run.blocked": "A run is blocked (missing credential, no runner, budget)",
  "batch.finished": "A dataset or suite batch finished",
  "import.finished": "An import batch is ready or committed",
  "review.pending_count": "Cases are waiting in the review queue",
  "runner.offline": "A runner pool has no live worker"
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
      <AdminCard title="Events" description="Delivered in-app during the beta.">
        <ul className="grid gap-2 text-sm">
          {(Object.keys(eventDescriptions) as NotificationKind[]).map((kind) => (
            <li key={kind} className="flex flex-wrap items-baseline gap-x-3">
              <code className="w-44 shrink-0 font-mono text-xs text-foreground">{kind}</code>
              <span className="text-muted-foreground">{eventDescriptions[kind]}</span>
            </li>
          ))}
        </ul>
      </AdminCard>
    </div>
  );
}
