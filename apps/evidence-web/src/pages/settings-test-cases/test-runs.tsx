import React, { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/misc";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useTestAdminMutation, useTestPermissions, useTestRunSettings } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { runSettingsFromForm, runSettingsToForm, type RunSettingsForm, type RunSettingsValue } from "../../test-config/config-ui";

// Settings → Test runs (design.md §10, §10.4, §14): concurrency, dedupe, queue caps, rate limit,
// retention and the daily model budget.

type FieldSpec = { key: keyof RunSettingsForm; label: string; hint: string; suffix?: string; step?: string };

const groups: Array<{ title: string; description: string; fields: FieldSpec[] }> = [
  {
    title: "Queue",
    description: "One queue per organisation. Extra requests wait or are rejected with QUEUE_FULL.",
    fields: [
      { key: "maxConcurrentRuns", label: "Concurrent runs (cloud pool)", hint: "Self-hosted pools set their own limit" },
      { key: "maxQueuedRuns", label: "Queued runs", hint: "Organisation-wide cap" },
      { key: "maxQueuedPerCase", label: "Queued runs per case", hint: "With different parameters or environments" }
    ]
  },
  {
    title: "Dedupe and rate limit",
    description: "Identical requests attach to the running run; a finished run is reused inside the window unless forced.",
    fields: [
      { key: "dedupeWindowSeconds", label: "Dedupe window", hint: "0 turns reuse of finished runs off", suffix: "s" },
      { key: "tokenBucketSize", label: "Requests per window", hint: "Per user or token; CI tokens have their own bucket" },
      { key: "tokenBucketWindowSeconds", label: "Rate window", hint: "Rejected requests get RATE_LIMITED", suffix: "s" }
    ]
  },
  {
    title: "Retention and budget",
    description: "The latest run per case is always kept. Over budget, new runs wait with BUDGET_EXCEEDED.",
    fields: [
      { key: "failedDays", label: "Keep failed and blocked runs", hint: "Evidence goes to the bin afterwards", suffix: "days" },
      { key: "passedDays", label: "Keep passed runs", hint: "Evidence goes to the bin afterwards", suffix: "days" },
      { key: "dailyBudgetUsd", label: "Daily model budget", hint: "Empty for no limit", suffix: "USD", step: "0.01" }
    ]
  }
];

export function SettingsTestRunsPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const settings = useTestRunSettings();
  const [form, setForm] = useState<RunSettingsForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof RunSettingsForm, string>>>({});

  useEffect(() => {
    if (settings.data) setForm(runSettingsToForm(settings.data));
  }, [settings.data]);

  const save = useTestAdminMutation((getToken, body: RunSettingsValue) => testAdminApi.updateRunSettings(getToken, body), [testAdminKeys.runSettings]);

  const submit = async () => {
    if (!form) return;
    const result = runSettingsFromForm(form);
    setErrors(result.errors);
    if (!result.value) return;
    await save.mutateAsync(result.value);
    toast.success("Run settings saved");
  };

  const dirty = Boolean(form && settings.data && JSON.stringify(form) !== JSON.stringify(runSettingsToForm(settings.data)));

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <ErrorNote error={settings.error} />
      {!form ? (
        <Skeleton className="h-96" />
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={!canManage} className="grid gap-4">
            {groups.map((group) => (
              <AdminCard key={group.title} title={group.title} description={group.description}>
                <div className="grid gap-4 sm:grid-cols-3">
                  {group.fields.map((field) => (
                    <Field key={field.key} label={field.label} htmlFor={`run-${field.key}`} error={errors[field.key]} hint={field.hint}>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`run-${field.key}`}
                          type="number"
                          inputMode="decimal"
                          step={field.step ?? "1"}
                          min={0}
                          value={form[field.key]}
                          aria-invalid={Boolean(errors[field.key])}
                          onChange={(event) => setForm((current) => (current ? { ...current, [field.key]: event.target.value } : current))}
                          className="tabular-nums"
                        />
                        {field.suffix ? <span className="shrink-0 text-sm text-muted-foreground">{field.suffix}</span> : null}
                      </div>
                    </Field>
                  ))}
                </div>
              </AdminCard>
            ))}
          </fieldset>
          <ErrorNote error={save.error} />
          {canManage ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={!dirty || save.isPending} onClick={() => settings.data && (setForm(runSettingsToForm(settings.data)), setErrors({}))}>
                Reset
              </Button>
              <Button type="submit" className={pressable} disabled={!dirty || save.isPending}>
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          ) : null}
        </form>
      )}
    </div>
  );
}
