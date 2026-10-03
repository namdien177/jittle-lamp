import React, { useState } from "react";
import { Bell, Globe, MessageSquare, Pencil, Plus, Send, Trash2 } from "lucide-react";
import type { NotificationChannel, NotificationKind } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/misc";
import { Select } from "../../components/ui/select";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import {
  testAdminKeys,
  useNotificationChannels,
  useNotificationSubscriptions,
  useTestAdminMutation,
  useTestCredentials,
  useTestPermissions
} from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, Toggle, pressable } from "../../test-cases/admin-ui";
import { channelFilterSummary, notificationKindLabels, splitList } from "../../test-config/webhook-ui";
import { isSubscribed, notificationKinds, toggleSubscription, type NotificationSubscriptions } from "../../notifications/subscriptions";

// Settings → Notifications (design.md §10b, units 1c.5 and 2.2): every run, batch, import and
// review event goes through one bus. In-app is always on, with per-person subscriptions; Slack and
// outgoing-webhook channels are added here, filtered by event kind and by the tags of the cases an
// event is about. A backend without channel routes (404) shows in-app only.

const eventLabels: Record<NotificationKind, { title: string; description: string }> = {
  "run.finished": { title: "Runs finished", description: "Yours always arrive. On: also runs other people requested." },
  "run.blocked": { title: "Runs blocked", description: "Missing credential, no runner, budget. Yours always arrive." },
  "batch.finished": { title: "Batches finished", description: "Dataset and suite runs. Yours always arrive." },
  "import.finished": { title: "Imports finished", description: "Yours always arrive. On: also imports by others." },
  "review.pending_count": { title: "Review queue", description: "Cases waiting for approval. On by default if you can approve." },
  "runner.offline": { title: "Runner offline", description: "A pool lost its workers. On by default if you manage test settings." }
};

type ExternalKind = "slack" | "webhook";

function ChannelRow(props: { icon: React.ReactNode; title: string; detail: string; status: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <li className="rounded-md border border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-secondary text-muted-foreground">{props.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-foreground">{props.title}</p>
          <p className="text-sm text-muted-foreground">{props.detail}</p>
        </div>
        {props.actions ? null : props.status}
      </div>
      {props.actions ? <div className="mt-2 flex flex-wrap items-center gap-1 pl-12">{props.actions}</div> : null}
    </li>
  );
}

export function SettingsTestNotificationsPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const channels = useNotificationChannels();
  const credentials = useTestCredentials();
  const [editing, setEditing] = useState<NotificationChannel | "new" | null>(null);
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const update = useTestAdminMutation(
    (getToken, input: { id: string; enabled: boolean }) => testAdminApi.updateNotificationChannel(getToken, input.id, { enabled: input.enabled }),
    [testAdminKeys.notificationChannels]
  );
  const remove = useTestAdminMutation((getToken, channelId: string) => testAdminApi.deleteNotificationChannel(getToken, channelId), [testAdminKeys.notificationChannels]);
  const test = useTestAdminMutation((getToken, channelId: string) => testAdminApi.testNotificationChannel(getToken, channelId), []);
  const external = (channels.data ?? []).filter((channel) => channel.kind === "slack" || channel.kind === "webhook");
  const credentialName = (id: string | undefined) => (credentials.data ?? []).find((credential) => credential.id === id)?.profile ?? "deleted credential";

  const sendTest = async (channel: NotificationChannel) => {
    try {
      const result = await test.mutateAsync(channel.id);
      if (result.delivered) toast.success("Test message sent", channel.kind === "slack" ? "Check the Slack channel." : "Check your endpoint.");
      else toast.error("Test message failed", result.error ?? undefined);
    } catch (error) {
      toast.error("Test message failed", error instanceof Error ? error.message : undefined);
    }
  };

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Channels"
        description="Every run, batch, import and review event goes through one bus; channels decide where it is delivered."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              Add channel
            </Button>
          ) : null
        }
      >
        <ErrorNote error={update.error ?? remove.error} />
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
                title={
                  channel.kind === "slack"
                    ? `Slack${channel.config.channel ? ` ${channel.config.channel}` : ""} · ${credentialName(channel.config.credentialId)}`
                    : `Webhook · ${channel.config.url ?? ""}`
                }
                detail={channelFilterSummary(channel.filter)}
                status={<Badge variant={channel.enabled ? "success" : "muted"}>{channel.enabled ? "Enabled" : "Disabled"}</Badge>}
                actions={
                  canManage ? (
                    <span className="flex items-center gap-1">
                      <Toggle checked={channel.enabled} label="Enabled" disabled={update.isPending} onChange={(enabled) => void update.mutateAsync({ id: channel.id, enabled })} />
                      <Button variant="ghost" size="xs" className={pressable} disabled={test.isPending} onClick={() => void sendTest(channel)}>
                        <Send aria-hidden /> Send test
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Edit channel" onClick={() => setEditing(channel)}>
                        <Pencil aria-hidden />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label="Delete channel" onClick={() => setDeleting(channel)}>
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  ) : null
                }
              />
            ))}
          </ul>
        )}
      </AdminCard>
      <SubscriptionsCard />
      {editing ? <ChannelDialog channel={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title="Delete this channel?"
        description="Events stop going to it. The Slack credential stays in Credentials."
        confirmLabel="Delete channel"
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove.mutateAsync(deleting.id).finally(() => setDeleting(null));
        }}
      />
    </div>
  );
}

function ChannelDialog(props: { channel: NotificationChannel | null; onClose: () => void }): React.JSX.Element {
  const credentials = useTestCredentials();
  const slackCredentials = (credentials.data ?? []).filter((credential) => credential.kind === "slack_webhook");
  const [kind, setKind] = useState<ExternalKind>(props.channel?.kind === "webhook" ? "webhook" : "slack");
  const [credentialId, setCredentialId] = useState(props.channel?.config.credentialId ?? "");
  const [label, setLabel] = useState(props.channel?.config.channel ?? "");
  const [url, setUrl] = useState(props.channel?.config.url ?? "");
  const [kinds, setKinds] = useState<NotificationKind[]>(props.channel?.filter.kinds ?? ["run.finished", "run.blocked", "batch.finished"]);
  const [tags, setTags] = useState((props.channel?.filter.tags ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  const save = useTestAdminMutation(
    (getToken, body: { kind: ExternalKind; config: Record<string, string>; filter: { kinds: NotificationKind[]; tags: string[] } }) =>
      props.channel ? testAdminApi.updateNotificationChannel(getToken, props.channel.id, body) : testAdminApi.createNotificationChannel(getToken, { ...body, enabled: true }),
    [testAdminKeys.notificationChannels]
  );

  const submit = async () => {
    if (kind === "slack" && !credentialId) return setError("Choose the Slack webhook credential.");
    if (kind === "webhook" && !/^https?:\/\/\S+$/i.test(url.trim())) return setError("The URL must start with http:// or https://.");
    setError(null);
    await save.mutateAsync({
      kind,
      config: kind === "slack" ? { credentialId, ...(label.trim() ? { channel: label.trim() } : {}) } : { url: url.trim() },
      filter: { kinds, tags: splitList(tags) }
    });
    props.onClose();
  };

  return (
    <Dialog
      title={props.channel ? "Edit channel" : "Add channel"}
      description="Slack posts a short message with the outcome, the case and a link to the run."
      onClose={props.onClose}
      size="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : props.channel ? "Save channel" : "Add channel"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {props.channel ? null : (
          <Field label="Kind" htmlFor="channel-kind">
            <Select<ExternalKind>
              ariaLabel="Channel kind"
              value={kind}
              onValueChange={setKind}
              options={[
                { value: "slack", label: "Slack (incoming webhook)" },
                { value: "webhook", label: "Webhook (event JSON)" }
              ]}
            />
          </Field>
        )}
        {kind === "slack" ? (
          <>
            <Field label="Slack webhook credential" htmlFor="channel-credential" hint="A slack_webhook credential whose secret field url holds the incoming-webhook URL.">
              <Select<string>
                ariaLabel="Slack webhook credential"
                value={credentialId}
                onValueChange={setCredentialId}
                options={[
                  { value: "", label: slackCredentials.length === 0 ? "Create one in Credentials first" : "Choose a credential" },
                  ...slackCredentials.map((credential) => ({ value: credential.id, label: credential.profile }))
                ]}
              />
            </Field>
            <Field label="Channel label" htmlFor="channel-label" hint="Shown here only; the webhook decides the Slack channel.">
              <Input id="channel-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="#qa-runs" maxLength={80} />
            </Field>
          </>
        ) : (
          <Field label="URL" htmlFor="channel-url">
            <Input id="channel-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://chat.example.com/hooks/jittle-lamp" />
          </Field>
        )}
        <div className="grid gap-1.5">
          <span className="text-sm font-medium text-foreground">Events</span>
          <p className="text-sm text-muted-foreground">None selected sends every event.</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(notificationKindLabels) as NotificationKind[]).map((item) => (
              <Toggle
                key={item}
                checked={kinds.includes(item)}
                label={notificationKindLabels[item]}
                onChange={(on) => setKinds((current) => (on ? [...new Set([...current, item])] : current.filter((value) => value !== item)))}
              />
            ))}
          </div>
        </div>
        <Field label="Case tags" htmlFor="channel-tags" hint="Only events about cases with any of these tags; empty sends all.">
          <Input id="channel-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="team:qa-pcf, prio:p1" className="font-mono" />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ErrorNote error={save.error} />
      </div>
    </Dialog>
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
