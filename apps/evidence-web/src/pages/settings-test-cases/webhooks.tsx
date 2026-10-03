import React, { useMemo, useState } from "react";
import { GitBranch, Pencil, Plus, RotateCw, ShieldCheck, Trash2, Webhook } from "lucide-react";
import type { WebhookEndpoint, WebhookRule } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { Select } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { formatRelativeTime } from "../../utils";
import { testAdminApi } from "../../test-cases/admin-api";
import {
  testAdminKeys,
  useTestAdminMutation,
  useTestCredentials,
  useTestEnvironments,
  useTestPermissions,
  useTestSuites,
  useWebhookDeliveries,
  useWebhooks
} from "../../test-cases/admin-queries";
import { AdminCard, CopyBlock, ErrorNote, ReadOnlyNotice, Toggle, pressable } from "../../test-cases/admin-ui";
import {
  credentialKindForProvider,
  deliveryTone,
  describeRule,
  draftToRule,
  emptyRuleDraft,
  providerSetup,
  ruleToDraft,
  shortSha,
  webhookEventLabels,
  type RuleDraft,
  type WebhookEventKind
} from "../../test-config/webhook-ui";

// Settings → Webhooks (design.md §10c, unit 2.1): GitLab and GitHub call a signed endpoint; rules
// map events to a suite and an environment and decide what is reported back (commit status, MR
// note, callback). The secret is shown once.

type Provider = WebhookEndpoint["provider"];

const providerLabels: Record<Provider, string> = { gitlab: "GitLab", github: "GitHub", generic: "Generic" };

function useNames() {
  const suites = useTestSuites();
  const environments = useTestEnvironments();
  return useMemo(
    () => ({
      suites: Object.fromEntries((suites.data ?? []).map((suite) => [suite.id, suite.name])),
      environments: Object.fromEntries((environments.data ?? []).map((environment) => [environment.id, environment.name]))
    }),
    [suites.data, environments.data]
  );
}

export function SettingsTestWebhooksPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const webhooks = useWebhooks();
  const names = useNames();
  const [editing, setEditing] = useState<WebhookEndpoint | "new" | null>(null);
  const [issued, setIssued] = useState<{ endpoint: WebhookEndpoint; secret: string } | null>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);
  const [rotating, setRotating] = useState<WebhookEndpoint | null>(null);
  const update = useTestAdminMutation(
    (getToken, input: { id: string; enabled: boolean }) => testAdminApi.updateWebhook(getToken, input.id, { enabled: input.enabled }),
    [testAdminKeys.webhooks]
  );
  const remove = useTestAdminMutation((getToken, endpointId: string) => testAdminApi.deleteWebhook(getToken, endpointId), [testAdminKeys.webhooks]);
  const rotate = useTestAdminMutation((getToken, endpointId: string) => testAdminApi.rotateWebhookSecret(getToken, endpointId), [testAdminKeys.webhooks]);

  if (!canManage && !permissions.loading) {
    return (
      <div className="grid gap-4">
        <ReadOnlyNotice permission="test_config.manage" />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <AdminCard
        title="CI webhooks"
        description="GitLab and GitHub trigger a suite on push, merge request, pipeline or deployment and get the verdict back as a commit status."
        actions={
          <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
            <Plus aria-hidden />
            New webhook
          </Button>
        }
      >
        <ErrorNote error={webhooks.error ?? update.error ?? remove.error ?? rotate.error} />
        {webhooks.isPending ? (
          <Skeleton className="h-40" />
        ) : (webhooks.data ?? []).length === 0 ? (
          <EmptyState icon={<Webhook aria-hidden />} title="No webhooks" description="Add a GitLab or GitHub webhook to run a suite for every merge request or deployment." />
        ) : (
          <div className="grid gap-4">
            {(webhooks.data ?? []).map((endpoint) => (
              <section key={endpoint.id} aria-label={`${providerLabels[endpoint.provider]} webhook`} className="rounded-md border border-border">
                <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                  <Webhook className="size-4 text-muted-foreground" aria-hidden />
                  <h3 className="text-sm font-semibold text-foreground">{providerLabels[endpoint.provider]}</h3>
                  <Badge variant={endpoint.enabled ? "success" : "muted"}>{endpoint.enabled ? "Enabled" : "Disabled"}</Badge>
                  <span className="text-sm text-muted-foreground">created {formatRelativeTime(endpoint.createdAt)}</span>
                  <span className="ml-auto flex items-center gap-1">
                    <Toggle
                      checked={endpoint.enabled}
                      label="Enabled"
                      disabled={update.isPending}
                      onChange={(enabled) => void update.mutateAsync({ id: endpoint.id, enabled })}
                    />
                    <Button variant="ghost" size="xs" className={pressable} onClick={() => setEditing(endpoint)}>
                      <Pencil aria-hidden /> Rules
                    </Button>
                    <Button variant="ghost" size="xs" className={pressable} onClick={() => setRotating(endpoint)}>
                      <RotateCw aria-hidden /> New secret
                    </Button>
                    <Button variant="ghost" size="icon-sm" aria-label="Delete webhook" onClick={() => setDeleting(endpoint)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                </header>
                <div className="grid gap-3 px-4 py-3">
                  <CopyBlock label="Endpoint URL" value={endpoint.url} />
                  <ul className="grid gap-2" aria-label="Rules">
                    {endpoint.rules.map((rule, index) => (
                      <RuleSummary key={index} index={index} rule={rule} names={names} />
                    ))}
                  </ul>
                  <Deliveries endpointId={endpoint.id} />
                </div>
              </section>
            ))}
          </div>
        )}
      </AdminCard>
      {editing ? (
        <WebhookDialog
          endpoint={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onCreated={(created) => {
            setEditing(null);
            setIssued(created);
          }}
        />
      ) : null}
      {issued ? <SecretDialog endpoint={issued.endpoint} secret={issued.secret} onClose={() => setIssued(null)} /> : null}
      <ConfirmDialog
        open={rotating !== null}
        title="Issue a new secret?"
        description="The current secret stops working at once. Paste the new one into the provider's webhook settings."
        confirmLabel="New secret"
        busy={rotate.isPending}
        onCancel={() => setRotating(null)}
        onConfirm={() => {
          if (!rotating) return;
          void rotate
            .mutateAsync(rotating.id)
            .then((response) => setIssued(response))
            .finally(() => setRotating(null));
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title="Delete this webhook?"
        description="Deliveries to its URL are refused from now on. Batches it already started keep running."
        confirmLabel="Delete webhook"
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove.mutateAsync(deleting.id).finally(() => setDeleting(null));
        }}
      />
    </div>
  );
}

function RuleSummary(props: { index: number; rule: WebhookRule; names: { suites: Record<string, string>; environments: Record<string, string> } }): React.JSX.Element {
  const described = describeRule(props.rule, props.names);
  return (
    <li className="grid gap-0.5 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="flex items-center gap-2 font-medium text-foreground">
        <GitBranch className="size-3.5 text-muted-foreground" aria-hidden />
        Rule {props.index + 1}: when {described.when}
      </span>
      <span className="text-muted-foreground">Run {described.run}</span>
      <span className="text-muted-foreground">Report: {described.report}</span>
    </li>
  );
}

function Deliveries(props: { endpointId: string }): React.JSX.Element {
  const deliveries = useWebhookDeliveries(props.endpointId);
  const items = (deliveries.data ?? []).slice(0, 8);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground">Recent deliveries</span>
      {deliveries.isPending ? (
        <Skeleton className="h-16" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing received yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Result</TableHead>
              <TableHead className="w-48">Event</TableHead>
              <TableHead className="w-24">Commit</TableHead>
              <TableHead>Detail</TableHead>
              <TableHead className="w-28">When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((delivery) => (
              <TableRow key={delivery.id}>
                <TableCell>
                  <Badge variant={deliveryTone(delivery.status)}>{delivery.status}</Badge>
                </TableCell>
                <TableCell className="text-sm">{delivery.eventType}</TableCell>
                <TableCell className="font-mono text-xs">{shortSha(delivery.triggerRef)}</TableCell>
                <TableCell className="max-w-[28rem] truncate text-sm text-muted-foreground" title={delivery.error ?? undefined}>
                  {delivery.error ?? (delivery.batchId ? "Suite queued" : "")}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{formatRelativeTime(delivery.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function WebhookDialog(props: { endpoint: WebhookEndpoint | null; onClose: () => void; onCreated: (created: { endpoint: WebhookEndpoint; secret: string }) => void }): React.JSX.Element {
  const [provider, setProvider] = useState<Provider>(props.endpoint?.provider ?? "gitlab");
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => (props.endpoint ? props.endpoint.rules.map(ruleToDraft) : [emptyRuleDraft()]));
  const [error, setError] = useState<string | null>(null);
  const create = useTestAdminMutation((getToken, body: { provider: Provider; rules: WebhookRule[] }) => testAdminApi.createWebhook(getToken, { ...body, enabled: true }), [testAdminKeys.webhooks]);
  const update = useTestAdminMutation((getToken, input: { id: string; rules: WebhookRule[] }) => testAdminApi.updateWebhook(getToken, input.id, { rules: input.rules }), [testAdminKeys.webhooks]);
  const busy = create.isPending || update.isPending;

  const submit = async () => {
    const rules: WebhookRule[] = [];
    for (const [index, draft] of drafts.entries()) {
      const result = draftToRule(draft);
      if (!result.ok) {
        setError(`Rule ${index + 1}: ${result.error}`);
        return;
      }
      rules.push(result.rule);
    }
    setError(null);
    if (props.endpoint) {
      await update.mutateAsync({ id: props.endpoint.id, rules });
      props.onClose();
    } else {
      props.onCreated(await create.mutateAsync({ provider, rules }));
    }
  };

  return (
    <Dialog
      title={props.endpoint ? `${providerLabels[props.endpoint.provider]} webhook rules` : "New webhook"}
      description="Each matching rule starts the suite once per commit; a retriggered pipeline joins the running batch."
      onClose={props.onClose}
      size="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={busy} onClick={() => void submit()}>
            {busy ? "Saving…" : props.endpoint ? "Save rules" : "Create webhook"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {props.endpoint ? null : (
          <Field label="Provider" htmlFor="webhook-provider">
            <Select<Provider>
              ariaLabel="Provider"
              value={provider}
              onValueChange={setProvider}
              options={[
                { value: "gitlab", label: "GitLab" },
                { value: "github", label: "GitHub" },
                { value: "generic", label: "Generic (signed JSON)" }
              ]}
            />
          </Field>
        )}
        {drafts.map((draft, index) => (
          <RuleEditor
            key={index}
            index={index}
            provider={props.endpoint?.provider ?? provider}
            draft={draft}
            onChange={(next) => setDrafts((current) => current.map((item, position) => (position === index ? next : item)))}
            {...(drafts.length > 1 ? { onRemove: () => setDrafts((current) => current.filter((_, position) => position !== index)) } : {})}
          />
        ))}
        <Button size="sm" variant="secondary" className={`${pressable} justify-self-start`} onClick={() => setDrafts((current) => [...current, emptyRuleDraft()])}>
          <Plus aria-hidden /> Add rule
        </Button>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <ErrorNote error={create.error ?? update.error} />
      </div>
    </Dialog>
  );
}

function RuleEditor(props: { index: number; provider: Provider; draft: RuleDraft; onChange: (draft: RuleDraft) => void; onRemove?: () => void }): React.JSX.Element {
  const { draft } = props;
  const suites = useTestSuites();
  const environments = useTestEnvironments();
  const credentials = useTestCredentials();
  const credentialKind = credentialKindForProvider(props.provider);
  const reportCredentials = (credentials.data ?? []).filter((credential) => credential.kind === credentialKind);
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) => props.onChange({ ...draft, [key]: value });
  const toggleEvent = (event: WebhookEventKind, on: boolean) =>
    set("events", on ? [...new Set([...draft.events, event])] : draft.events.filter((item) => item !== event));
  const id = `rule-${props.index}`;

  return (
    <fieldset className="grid gap-3 rounded-md border border-border p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">Rule {props.index + 1}</legend>
      {props.onRemove ? (
        <Button variant="ghost" size="xs" className="justify-self-end" onClick={props.onRemove}>
          <Trash2 aria-hidden /> Remove rule
        </Button>
      ) : null}
      <div className="grid gap-1.5">
        <span className="text-sm font-medium text-foreground">When</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {(Object.keys(webhookEventLabels) as WebhookEventKind[]).map((event) => (
            <Toggle key={event} checked={draft.events.includes(event)} label={webhookEventLabels[event]} onChange={(on) => toggleEvent(event, on)} />
          ))}
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Branches" htmlFor={`${id}-branches`} hint="Globs, comma separated; empty matches every branch">
          <Input id={`${id}-branches`} value={draft.branches} onChange={(event) => set("branches", event.target.value)} placeholder="main, release/*" className="font-mono" />
        </Field>
        <Field label="Labels" htmlFor={`${id}-labels`} hint="Any of these MR labels; empty matches all">
          <Input id={`${id}-labels`} value={draft.labels} onChange={(event) => set("labels", event.target.value)} placeholder="e2e" className="font-mono" />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Suite" htmlFor={`${id}-suite`}>
          <Select<string>
            ariaLabel="Suite"
            value={draft.suiteId}
            onValueChange={(value) => set("suiteId", value)}
            options={[{ value: "", label: "Choose a suite" }, ...(suites.data ?? []).map((suite) => ({ value: suite.id, label: suite.name }))]}
          />
        </Field>
        <Field label="Priority" htmlFor={`${id}-priority`} hint="0–100; manual runs use 30">
          <Input id={`${id}-priority`} type="number" min={0} max={100} value={draft.priority} onChange={(event) => set("priority", event.target.value)} />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Run against" htmlFor={`${id}-env-mode`}>
          <Select<RuleDraft["environmentMode"]>
            ariaLabel="Run against"
            value={draft.environmentMode}
            onValueChange={(value) => set("environmentMode", value)}
            options={[
              { value: "fixed", label: "A fixed environment" },
              { value: "review_app_url", label: "The review app URL from the event" },
              { value: "deployment_url", label: "The deployment URL from the event" }
            ]}
          />
        </Field>
        <Field label={draft.environmentMode === "fixed" ? "Environment" : "Base environment (variables, credentials, pool)"} htmlFor={`${id}-env`}>
          <Select<string>
            ariaLabel="Environment"
            value={draft.environmentId}
            onValueChange={(value) => set("environmentId", value)}
            options={[{ value: "", label: "Choose an environment" }, ...(environments.data ?? []).map((environment) => ({ value: environment.id, label: environment.name }))]}
          />
        </Field>
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium text-foreground">Report back</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Toggle checked={draft.commitStatus} label="Commit status" disabled={!credentialKind} onChange={(on) => set("commitStatus", on)} />
          <Toggle checked={draft.mrNote} label={props.provider === "github" ? "PR comment" : "MR note"} disabled={!credentialKind} onChange={(on) => set("mrNote", on)} />
        </div>
        {credentialKind ? (
          <Field label={props.provider === "github" ? "GitHub credential (token field)" : "GitLab credential (token field)"} htmlFor={`${id}-credential`}>
            <Select<string>
              ariaLabel="Report credential"
              value={draft.credentialId}
              onValueChange={(value) => set("credentialId", value)}
              options={[
                { value: "", label: reportCredentials.length === 0 ? `No ${credentialKind} credential yet` : "Choose a credential" },
                ...reportCredentials.map((credential) => ({ value: credential.id, label: credential.profile }))
              ]}
            />
          </Field>
        ) : null}
        <Field label="Callback URL" htmlFor={`${id}-callback`} hint="Optional: receives the batch result JSON, signed with X-Jl-Signature-256">
          <Input id={`${id}-callback`} value={draft.callbackUrl} onChange={(event) => set("callbackUrl", event.target.value)} placeholder="https://ci.example.com/jittle-lamp" />
        </Field>
      </div>
    </fieldset>
  );
}

function SecretDialog(props: { endpoint: WebhookEndpoint; secret: string; onClose: () => void }): React.JSX.Element {
  return (
    <Dialog
      title={`${providerLabels[props.endpoint.provider]} webhook ready`}
      onClose={props.onClose}
      size="lg"
      closeOnOverlay={false}
      footer={
        <Button size="sm" onClick={props.onClose}>
          I have copied the secret
        </Button>
      }
    >
      <div className="flex gap-3 rounded-md border border-primary/30 bg-primary/10 p-3 text-sm text-foreground">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p>The secret is shown once. Deliveries without it are refused, and a delivery seen before is refused as a replay.</p>
      </div>
      <CopyBlock label="Endpoint URL" value={props.endpoint.url} />
      <CopyBlock label="Secret" value={props.secret} />
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        {providerSetup(props.endpoint.provider).map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </Dialog>
  );
}
