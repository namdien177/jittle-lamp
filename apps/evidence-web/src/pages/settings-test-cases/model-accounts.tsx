import React, { useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Eraser, MoreHorizontal, Pause, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import type { ModelAccount } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, SimpleDialog } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Hint, TruncatedText } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useModelAccounts, useTestAdminMutation } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, Toggle, pressable } from "../../test-cases/admin-ui";
import {
  accountFormFrom,
  accountFormRequest,
  accountProviderOptions,
  accountStatusView,
  budgetMeter,
  groupAccounts,
  moveAccount,
  neededProviders,
  overBudgetOptions,
  pausePresets,
  providerLabel,
  type AccountForm,
  type BudgetMeterView,
  type StatusView
} from "../../test-config/model-accounts-ui";
import { formatUsd } from "../../test-config/cost-report";

// Settings → AI model → Accounts (design.md §9.3): several keys per provider, tried top to
// bottom like CLIProxy. Keys are write-only; the API returns the last four characters.

const toneVariant: Record<StatusView["tone"], "success" | "warning" | "danger" | "muted"> = {
  success: "success",
  warning: "warning",
  danger: "danger",
  muted: "muted"
};

export function AccountStatusBadge(props: { account: ModelAccount; now: number }): React.JSX.Element {
  const view = accountStatusView(props.account, props.now);
  return (
    <span className="grid gap-0.5">
      <Badge variant={toneVariant[view.tone]}>{view.label}</Badge>
      {view.detail ? <span className="text-xs text-muted-foreground">{view.detail}</span> : null}
    </span>
  );
}

const meterColor: Record<BudgetMeterView["tone"], string> = {
  ok: "bg-primary",
  warning: "bg-warning",
  danger: "bg-destructive"
};

// Spend against one budget, or the spend alone when there is no budget.
export function BudgetMeter(props: { label: string; spentUsd: number; budgetUsd: number | null; className?: string }): React.JSX.Element {
  const meter = budgetMeter(props.spentUsd, props.budgetUsd);
  return (
    <div className={cn("grid min-w-36 gap-1", props.className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="whitespace-nowrap text-muted-foreground">{props.label}</span>
        <span className={cn("whitespace-nowrap tabular-nums", meter?.tone === "danger" ? "text-destructive" : meter?.tone === "warning" ? "text-warning" : "text-foreground")}>
          {meter ? meter.label : `${formatUsd(props.spentUsd)}, no limit`}
        </span>
      </div>
      {meter ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={`${props.label} budget`}
          aria-valuemin={0}
          aria-valuemax={props.budgetUsd ?? 0}
          aria-valuenow={props.spentUsd}
          aria-valuetext={meter.label}
        >
          <div className={cn("h-full rounded-full transition-[width] duration-300", meterColor[meter.tone])} style={{ width: `${Math.max(meter.ratio * 100, props.spentUsd > 0 ? 2 : 0)}%` }} />
        </div>
      ) : (
        <div className="h-1.5 rounded-full border border-dashed border-border" aria-hidden />
      )}
    </div>
  );
}

export function ModelAccountsCard(props: { canManage: boolean; actModel: string; judgeModel: string }): React.JSX.Element {
  const toast = useToast();
  const accounts = useModelAccounts();
  const [now, setNow] = useState(() => Date.now());
  const [editing, setEditing] = useState<{ account: ModelAccount | null; provider: string } | null>(null);
  const [deleting, setDeleting] = useState<ModelAccount | null>(null);
  const invalidate = [testAdminKeys.modelAccounts, testAdminKeys.modelSettings];
  const update = useTestAdminMutation(
    (getToken, input: { id: string; body: Parameters<typeof testAdminApi.updateModelAccount>[2] }) => testAdminApi.updateModelAccount(getToken, input.id, input.body),
    invalidate
  );
  const reorder = useTestAdminMutation((getToken, body: { provider: string; ids: string[] }) => testAdminApi.reorderModelAccounts(getToken, body), invalidate);
  const remove = useTestAdminMutation((getToken, accountId: string) => testAdminApi.deleteModelAccount(getToken, accountId), invalidate);

  const needed = useMemo(() => neededProviders(props.actModel, props.judgeModel), [props.actModel, props.judgeModel]);
  // Recomputed with each refetch, so pauses and cooldowns read right without a timer per row.
  const groups = useMemo(() => groupAccounts(accounts.data ?? [], needed, now), [accounts.data, needed, now]);
  const busy = update.isPending || reorder.isPending || remove.isPending;

  const patch = async (account: ModelAccount, body: Parameters<typeof testAdminApi.updateModelAccount>[2], message: string) => {
    await update.mutateAsync({ id: account.id, body });
    setNow(Date.now());
    toast.success(message);
  };

  const move = async (provider: string, ids: string[], id: string, delta: -1 | 1) => {
    await reorder.mutateAsync({ provider, ids: moveAccount(ids, id, delta) });
  };

  const defaultProvider = needed.find((prefix) => !groups.some((group) => group.provider === prefix && group.accounts.length > 0)) ?? needed[0] ?? "openrouter";

  return (
    <AdminCard
      title="Accounts"
      description="Keys per provider, tried top to bottom. A rate limit, an exhausted quota or a rejected key moves the call to the next account during the run. Spend counts finished runs; budgets reset at 00:00 UTC (daily) and on the 1st (monthly)."
      actions={
        props.canManage ? (
          <Button size="sm" className={pressable} onClick={() => setEditing({ account: null, provider: defaultProvider })}>
            <Plus aria-hidden />
            Add account
          </Button>
        ) : null
      }
    >
      <div className="grid gap-5">
        <ErrorNote error={accounts.error ?? update.error ?? reorder.error ?? remove.error} />
        {accounts.isPending ? (
          <Skeleton className="h-32" />
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts yet. Add one for the provider of the act and judge models.</p>
        ) : (
          groups.map((group) => (
            <section key={group.provider} className="grid gap-2" aria-labelledby={`accounts-${group.provider}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 id={`accounts-${group.provider}`} className="text-sm font-semibold text-foreground">
                  {group.label}
                </h3>
                {group.needed ? <Badge variant="brand">Used by the models</Badge> : <Badge variant="outline">Not used by the current models</Badge>}
                <span className="text-xs text-muted-foreground">
                  {group.usable} of {group.accounts.length} usable
                </span>
                {props.canManage ? (
                  <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setEditing({ account: null, provider: group.provider })}>
                    <Plus aria-hidden />
                    Add {group.label} account
                  </Button>
                ) : null}
              </div>
              {group.needed && group.usable === 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground" role="status">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {group.accounts.length === 0
                    ? `Runs are blocked with MODEL_KEY_MISSING until a ${group.label} account is added.`
                    : "No account can serve runs right now: runs wait with BUDGET_EXCEEDED while every account is over budget, and are blocked with MODEL_KEY_MISSING while all are disabled or paused."}
                </p>
              ) : null}
              {group.accounts.length > 0 ? (
                <ol className="grid divide-y divide-border rounded-md border border-border">
                  {group.accounts.map((account, index) => {
                    const ids = group.accounts.map((entry) => entry.id);
                    const paused = account.pausedUntil !== null && account.pausedUntil > now;
                    return (
                      <li key={account.id} className={cn("grid items-center gap-3 px-3 py-2.5 md:grid-cols-[auto_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_auto]", !account.enabled && "opacity-70")}>
                        <div className="flex items-center gap-1">
                          <span className="w-5 text-center font-mono text-xs text-muted-foreground" aria-label={`Priority ${index + 1}`}>
                            {index + 1}
                          </span>
                          {props.canManage && group.accounts.length > 1 ? (
                            <span className="flex flex-col">
                              <Button variant="ghost" size="icon-xs" aria-label={`Move ${account.label} up`} disabled={index === 0 || busy} onClick={() => void move(group.provider, ids, account.id, -1)}>
                                <ArrowUp aria-hidden />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`Move ${account.label} down`}
                                disabled={index === group.accounts.length - 1 || busy}
                                onClick={() => void move(group.provider, ids, account.id, 1)}
                              >
                                <ArrowDown aria-hidden />
                              </Button>
                            </span>
                          ) : null}
                        </div>
                        <div className="min-w-0">
                          <TruncatedText className="font-medium text-foreground">{account.label}</TruncatedText>
                          <p className="truncate font-mono text-xs text-muted-foreground">
                            {account.keyConfigured ? `••••${account.keyLast4 ?? ""}` : "no key"}
                            {account.baseUrl ? ` · ${account.baseUrl}` : ""}
                          </p>
                          {account.lastErrorMessage && account.lastErrorCode !== null ? (
                            <Hint label={account.lastErrorMessage}>
                              <p className="truncate text-xs text-muted-foreground">Last error: {account.lastErrorMessage}</p>
                            </Hint>
                          ) : null}
                        </div>
                        <AccountStatusBadge account={account} now={now} />
                        <div className="grid gap-1.5">
                          <BudgetMeter label="Today" spentUsd={account.usage.todayUsd} budgetUsd={account.dailyBudgetUsd} />
                          <BudgetMeter label="This month" spentUsd={account.usage.monthUsd} budgetUsd={account.monthlyBudgetUsd} />
                        </div>
                        <div className="flex justify-end gap-1">
                          {props.canManage ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger
                                render={
                                  <button
                                    type="button"
                                    aria-label={`Actions for ${account.label}`}
                                    disabled={busy}
                                    className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                                  >
                                    <MoreHorizontal className="size-4" aria-hidden />
                                  </button>
                                }
                              />
                              <DropdownMenuContent>
                                <DropdownMenuItem onClick={() => setEditing({ account, provider: account.provider })}>
                                  <Pencil aria-hidden />
                                  Edit
                                </DropdownMenuItem>
                                {paused ? (
                                  <DropdownMenuItem onClick={() => void patch(account, { pausedUntil: null }, `${account.label} resumed`)}>
                                    <Play aria-hidden />
                                    Resume now
                                  </DropdownMenuItem>
                                ) : (
                                  pausePresets.map((preset) => (
                                    <DropdownMenuItem key={preset.ms} onClick={() => void patch(account, { pausedUntil: Date.now() + preset.ms }, `${account.label} paused`)}>
                                      <Pause aria-hidden />
                                      {preset.label}
                                    </DropdownMenuItem>
                                  ))
                                )}
                                <DropdownMenuItem
                                  onClick={() => void patch(account, { enabled: !account.enabled }, account.enabled ? `${account.label} disabled` : `${account.label} enabled`)}
                                >
                                  <Power aria-hidden />
                                  {account.enabled ? "Disable" : "Enable"}
                                </DropdownMenuItem>
                                {account.cooldownUntil !== null || account.lastErrorCode !== null ? (
                                  <DropdownMenuItem onClick={() => void patch(account, { clearCooldown: true }, `Cleared the errors of ${account.label}`)}>
                                    <Eraser aria-hidden />
                                    Clear cooldown and error
                                  </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem variant="destructive" onClick={() => setDeleting(account)}>
                                  <Trash2 aria-hidden />
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : null}
            </section>
          ))
        )}
      </div>
      {editing ? (
        <AccountDialog
          account={editing.account}
          provider={editing.provider}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setNow(Date.now());
            setEditing(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={`Delete ${deleting?.label ?? "account"}?`}
        description="The key is removed. Its past spend stays in Model spend as a deleted account."
        confirmLabel="Delete account"
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void remove
            .mutateAsync(deleting.id)
            .then(() => toast.success("Account deleted"))
            .finally(() => setDeleting(null));
        }}
      />
    </AdminCard>
  );
}

function AccountDialog(props: { account: ModelAccount | null; provider: string; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const toast = useToast();
  const existing = props.account;
  const [form, setForm] = useState<AccountForm>(() => accountFormFrom(existing, props.provider));
  const [submitted, setSubmitted] = useState(false);
  const update = (patch: Partial<AccountForm>) => setForm((current) => ({ ...current, ...patch }));
  const invalidate = [testAdminKeys.modelAccounts, testAdminKeys.modelSettings];
  const create = useTestAdminMutation((getToken, body: Parameters<typeof testAdminApi.createModelAccount>[1]) => testAdminApi.createModelAccount(getToken, body), invalidate);
  const save = useTestAdminMutation(
    (getToken, body: Parameters<typeof testAdminApi.updateModelAccount>[2]) => testAdminApi.updateModelAccount(getToken, existing?.id ?? "", body),
    invalidate
  );
  const result = accountFormRequest(form, existing);
  const errors = submitted ? result.errors : {};
  const provider = accountProviderOptions.find((entry) => entry.prefix === form.provider);
  const pending = create.isPending || save.isPending;

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(result.errors).length > 0) return;
    if (existing) await save.mutateAsync(result.body);
    else await create.mutateAsync({ provider: form.provider, ...result.body });
    toast.success(existing ? "Account saved" : "Account added");
    props.onSaved();
  };

  return (
    <SimpleDialog
      size="lg"
      onClose={props.onClose}
      title={existing ? `Edit ${existing.label}` : "Add model account"}
      description="Runs try a provider's accounts in priority order. New accounts go to the bottom; reorder them on the page."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={props.onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} onClick={() => void submit()} disabled={pending}>
            {pending ? "Saving…" : existing ? "Save" : "Add account"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        autoComplete="off"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Provider" hint={existing ? "An account's provider cannot change." : undefined}>
            <SimpleSelect
              ariaLabel="Provider"
              value={form.provider}
              disabled={Boolean(existing)}
              onValueChange={(value) => update({ provider: value })}
              options={accountProviderOptions.map((entry) => ({ value: entry.prefix, label: entry.label }))}
            />
          </Field>
          <Field label="Name" htmlFor="account-label" error={errors.label}>
            <Input id="account-label" value={form.label} maxLength={80} onChange={(event) => update({ label: event.target.value })} placeholder="Team A, Backup, Free tier…" />
          </Field>
        </div>
        {provider?.keyEnv ? (
          <Field
            label={existing?.keyConfigured ? "New key" : provider.keyRequired ? "Key" : "Key (optional)"}
            htmlFor="account-key"
            error={errors.apiKey}
            hint={existing?.keyConfigured ? `Stored key ends in ${existing.keyLast4 ?? "····"}. Leave empty to keep it.` : "Write-only. It is encrypted on the server and never shown again."}
          >
            <Input
              id="account-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              className="font-mono"
              value={form.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
              placeholder={`Paste the ${provider.label} API key`}
            />
          </Field>
        ) : null}
        {provider?.baseUrlEnv ? (
          <Field
            label="Base URL"
            htmlFor="account-base-url"
            error={errors.baseUrl}
            hint="The endpoint's OpenAI-compatible API root, e.g. https://api.groq.com/openai/v1. Private hosts must be allowed with JL_OUTBOUND_ALLOW_HOSTS on the API server."
          >
            <Input
              id="account-base-url"
              type="url"
              inputMode="url"
              spellCheck={false}
              className="font-mono"
              value={form.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/v1"
            />
          </Field>
        ) : null}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Daily budget (USD)" htmlFor="account-daily" error={errors.dailyBudget} hint="Empty for no limit. Resets at 00:00 UTC.">
            <Input id="account-daily" inputMode="decimal" value={form.dailyBudget} onChange={(event) => update({ dailyBudget: event.target.value })} placeholder="No limit" />
          </Field>
          <Field label="Monthly budget (USD)" htmlFor="account-monthly" error={errors.monthlyBudget} hint="Empty for no limit. Resets on the 1st (UTC).">
            <Input id="account-monthly" inputMode="decimal" value={form.monthlyBudget} onChange={(event) => update({ monthlyBudget: event.target.value })} placeholder="No limit" />
          </Field>
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-foreground">When a run spends the budget</legend>
          {overBudgetOptions.map((option) => (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2",
                form.overBudget === option.value ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/50"
              )}
            >
              <input
                type="radio"
                name="account-over-budget"
                className="peer sr-only"
                checked={form.overBudget === option.value}
                onChange={() => update({ overBudget: option.value })}
              />
              <span
                aria-hidden
                className={cn(
                  "mt-1 grid size-4 shrink-0 place-items-center rounded-full border peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50",
                  form.overBudget === option.value ? "border-primary" : "border-input bg-background"
                )}
              >
                {form.overBudget === option.value ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{option.label}</span>
                <span className="block text-sm text-muted-foreground">{option.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Toggle
          checked={form.enabled}
          onChange={(enabled) => update({ enabled })}
          label="Enabled"
          description={`Disabled accounts stay saved but runs never use them. ${providerLabel(form.provider)} accounts are tried in priority order.`}
        />
        <ErrorNote error={create.error ?? save.error} />
        <button type="submit" hidden />
      </form>
    </SimpleDialog>
  );
}
