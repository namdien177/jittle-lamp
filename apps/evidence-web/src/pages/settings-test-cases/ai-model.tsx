import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, KeyRound, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import { modelProviders } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/misc";
import { Select } from "../../components/ui/select";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useModelSettings, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import {
  maskedKeyLabel,
  modelFormRequirements,
  modelPresets,
  modelSettingsRequest,
  presetForModels,
  providerFromModelId,
  type ModelFormState
} from "../../test-config/config-ui";
import { ModelPricesCard } from "./model-prices";

// Settings → AI model (design.md §9.3 "Model key"): bring your own key per organisation, for any
// provider the runner supports. Keys are write-only; the API returns only whether each is
// configured and its last four characters. The base URL of an OpenAI-compatible endpoint is not a
// secret and is shown as saved.

const emptyForm: ModelFormState = { actModel: "", judgeModel: "", baseUrl: "", apiKey: "", judgeApiKey: "" };
// Development-only prefixes (claude-code/, mock:) are accepted but not advertised.
const productionPrefixes = modelProviders
  .filter((provider) => !provider.development)
  .map((provider) => `${provider.prefix}/`)
  .join(", ");
const pickerOptions = [...modelPresets.map((preset) => ({ value: preset.id, label: preset.label })), { value: "custom", label: "Custom model ids" }];

function ProviderHint(props: { modelId: string; id: string; error?: string | undefined }): React.JSX.Element {
  const hint = providerFromModelId(props.modelId);
  return (
    <span id={props.id} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <Badge variant={props.error ? "danger" : hint.tone === "ok" ? "success" : hint.tone === "warning" ? "warning" : "outline"}>{hint.provider}</Badge>
      <span className={props.error ? "text-destructive" : undefined}>{props.error ?? hint.note}</span>
    </span>
  );
}

type KeyRole = "key" | "judgeKey";

function KeyPanel(props: {
  role: KeyRole;
  title: string;
  configured: boolean;
  last4: string | null;
  canManage: boolean;
  optional: boolean;
  dropped: boolean;
  missing: boolean;
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const [replacing, setReplacing] = useState(false);
  const configured = props.configured && !props.dropped;
  const inputId = props.role === "key" ? "model-key" : "model-judge-key";
  useEffect(() => {
    if (!props.configured) setReplacing(false);
  }, [props.configured]);
  return (
    <div className="grid gap-2 rounded-md border border-border p-4" role="group" aria-labelledby={`${inputId}-title`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid size-9 place-items-center rounded-md border border-border bg-secondary text-primary">
          {configured ? <ShieldCheck className="size-4" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
        </span>
        <div className="mr-auto">
          <p id={`${inputId}-title`} className="font-semibold text-foreground">
            {props.title}
            {props.optional ? <span className="ml-2 text-sm font-normal text-muted-foreground">optional</span> : null}
          </p>
          <p className="font-mono text-sm text-muted-foreground" aria-label={props.configured ? `Key configured, ending in ${props.last4 ?? "unknown"}` : "No key configured"}>
            {maskedKeyLabel(props.configured, props.last4)}
          </p>
        </div>
        {props.configured && props.canManage ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setReplacing((value) => !value)}>
              {replacing ? "Keep current key" : "Replace"}
            </Button>
            <Button variant="destructive" size="sm" onClick={props.onRemove}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
      {props.dropped ? (
        <p className="flex items-start gap-2 text-sm text-warning" role="status">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          The saved key belongs to another provider and is removed when you save. Enter a key for the new provider.
        </p>
      ) : null}
      {(!props.configured || replacing || props.dropped) && props.canManage ? (
        <Field
          label={props.configured && !props.dropped ? "New key" : "Key"}
          htmlFor={inputId}
          error={props.error}
          hint={props.missing ? "Runs are blocked with MODEL_KEY_MISSING until a key is saved. Write-only: encrypted on the server and never shown again." : "Write-only. It is encrypted on the server and never shown again."}
        >
          <Input
            id={inputId}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={props.value}
            onChange={(event) => props.onChange(event.target.value)}
            className="font-mono"
            placeholder="Paste the provider's API key"
          />
        </Field>
      ) : null}
    </div>
  );
}

export function SettingsTestAiModelPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const settings = useModelSettings();
  const [form, setForm] = useState<ModelFormState>(emptyForm);
  const [confirmRemove, setConfirmRemove] = useState<KeyRole | null>(null);
  const update = (patch: Partial<ModelFormState>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setForm((current) => ({ ...current, actModel: data.actModel, judgeModel: data.judgeModel, baseUrl: data.baseUrl ?? current.baseUrl }));
  }, [settings.data]);

  const save = useTestAdminMutation(
    (getToken, body: Parameters<typeof testAdminApi.updateModelSettings>[1]) => testAdminApi.updateModelSettings(getToken, body),
    [testAdminKeys.modelSettings]
  );

  const saved = settings.data ?? null;
  const requirements = useMemo(() => modelFormRequirements(form, saved), [form, saved]);
  const hasErrors = Object.keys(requirements.errors).length > 0;
  const dirty = saved
    ? form.actModel.trim() !== saved.actModel ||
      form.judgeModel.trim() !== saved.judgeModel ||
      (requirements.showBaseUrl && form.baseUrl.trim() !== (saved.baseUrl ?? "")) ||
      form.apiKey.length > 0 ||
      form.judgeApiKey.length > 0
    : true;

  const submit = async () => {
    if (hasErrors) return;
    await save.mutateAsync(modelSettingsRequest(form, requirements));
    update({ apiKey: "", judgeApiKey: "" });
    toast.success("Model settings saved");
  };

  const removeKey = async (role: KeyRole) => {
    if (!saved) return;
    await save.mutateAsync({ actModel: saved.actModel, judgeModel: saved.judgeModel, ...(role === "key" ? { apiKey: null } : { judgeApiKey: null }) });
    setConfirmRemove(null);
    toast.success(role === "key" ? "Model key removed" : "Judge key removed");
  };

  const pickPreset = (id: string) => {
    const preset = modelPresets.find((entry) => entry.id === id);
    if (preset) update({ actModel: preset.actModel, judgeModel: preset.judgeModel });
  };

  const missingText = requirements.missing
    .map((item) => (item === "key" ? `a key for ${requirements.actProvider ?? "the act model"}` : `a judge key for ${requirements.judgeProvider ?? "the judge model"}`))
    .join(" and ");

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="AI model"
        description="Runs use any AI SDK provider with the organisation's own keys. Spend is attributed to the user who requested the run."
        actions={
          <Link to="/settings/test-cases/model-spend" className="text-sm font-semibold text-primary hover:underline">
            Model spend
          </Link>
        }
      >
        {settings.isPending ? (
          <Skeleton className="h-48" />
        ) : (
          <form
            className="grid gap-5"
            autoComplete="off"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <ErrorNote error={settings.error} />
            <fieldset disabled={!canManage} className="grid gap-5">
              <Field label="Provider" hint="Fills both model ids with an example for that provider; edit them freely.">
                <Select ariaLabel="Provider" value={presetForModels(form.actModel)} onValueChange={pickPreset} options={pickerOptions} disabled={!canManage} />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Act model" htmlFor="model-act">
                  <Input
                    id="model-act"
                    value={form.actModel}
                    onChange={(event) => update({ actModel: event.target.value })}
                    className="font-mono"
                    aria-describedby="model-act-hint"
                    aria-invalid={requirements.errors.actModel ? true : undefined}
                    placeholder="provider/model"
                  />
                  <ProviderHint modelId={form.actModel} id="model-act-hint" error={requirements.errors.actModel} />
                </Field>
                <Field label="Judge model" htmlFor="model-judge">
                  <Input
                    id="model-judge"
                    value={form.judgeModel}
                    onChange={(event) => update({ judgeModel: event.target.value })}
                    className="font-mono"
                    aria-describedby="model-judge-hint"
                    aria-invalid={requirements.errors.judgeModel ? true : undefined}
                    placeholder="provider/model"
                  />
                  <ProviderHint modelId={form.judgeModel} id="model-judge-hint" error={requirements.errors.judgeModel} />
                </Field>
              </div>
              <p className="text-sm text-muted-foreground">
                The act model drives the browser; the judge decides asserts, waits and extracts. The id prefix picks the provider:{" "}
                <code className="font-mono text-xs">{productionPrefixes}</code>. For example{" "}
                <code className="font-mono text-xs">openrouter/anthropic/claude-sonnet-5-5</code>,{" "}
                <code className="font-mono text-xs">openrouter/openai/gpt-5</code> or{" "}
                <code className="font-mono text-xs">openai-compatible/llama-3.3-70b</code> with a base URL.
              </p>

              {requirements.showBaseUrl ? (
                <Field
                  label="Base URL"
                  htmlFor="model-base-url"
                  error={requirements.errors.baseUrl}
                  hint="The endpoint's OpenAI-compatible API root, e.g. https://api.groq.com/openai/v1 or http://vllm.internal:8000/v1. Private hosts must be allowed with JL_OUTBOUND_ALLOW_HOSTS on the API server."
                >
                  <Input
                    id="model-base-url"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    value={form.baseUrl}
                    onChange={(event) => update({ baseUrl: event.target.value })}
                    className="font-mono"
                    aria-invalid={requirements.errors.baseUrl ? true : undefined}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
              ) : null}

              {requirements.showKey ? (
                <KeyPanel
                  role="key"
                  title={requirements.showJudgeKey ? `Act model key · ${requirements.actProvider ?? "provider"}` : `API key · ${requirements.actProvider ?? "provider"}`}
                  configured={saved?.keyConfigured ?? false}
                  last4={saved?.keyLast4 ?? null}
                  canManage={canManage}
                  optional={requirements.keyOptional}
                  dropped={requirements.keyDropped}
                  missing={requirements.missing.includes("key")}
                  value={form.apiKey}
                  error={requirements.errors.apiKey}
                  onChange={(apiKey) => update({ apiKey })}
                  onRemove={() => setConfirmRemove("key")}
                />
              ) : null}
              {requirements.showJudgeKey ? (
                <KeyPanel
                  role="judgeKey"
                  title={`Judge model key · ${requirements.judgeProvider ?? "provider"}`}
                  configured={saved?.judgeKeyConfigured ?? false}
                  last4={saved?.judgeKeyLast4 ?? null}
                  canManage={canManage}
                  optional={requirements.judgeKeyOptional}
                  dropped={requirements.judgeKeyDropped}
                  missing={requirements.missing.includes("judgeKey")}
                  value={form.judgeApiKey}
                  error={requirements.errors.judgeApiKey}
                  onChange={(judgeApiKey) => update({ judgeApiKey })}
                  onRemove={() => setConfirmRemove("judgeKey")}
                />
              ) : null}
              {requirements.missing.length > 0 ? (
                <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground" role="status">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  You can save without it, but runs are blocked with MODEL_KEY_MISSING until {missingText} is saved.
                </p>
              ) : null}
            </fieldset>
            <ErrorNote error={save.error} />
            {canManage ? (
              <div className="flex justify-end">
                <Button type="submit" className={pressable} disabled={save.isPending || !dirty || hasErrors}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </form>
        )}
      </AdminCard>
      <ModelPricesCard canManage={canManage} models={saved ? [saved.actModel, saved.judgeModel] : []} />
      <ConfirmDialog
        open={confirmRemove !== null}
        destructive
        title={confirmRemove === "judgeKey" ? "Remove the judge key?" : "Remove the model key?"}
        description="New runs are blocked with MODEL_KEY_MISSING until a key is configured again."
        confirmLabel="Remove key"
        busy={save.isPending}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) void removeKey(confirmRemove);
        }}
      />
    </div>
  );
}
