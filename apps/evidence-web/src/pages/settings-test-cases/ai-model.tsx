import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { modelProviders } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { SimpleSelect } from "../../components/ui/select";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useModelSettings, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { modelFormRequirements, modelPresets, presetForModels, providerFromModelId, type ModelFormState } from "../../test-config/config-ui";
import { ModelAccountsCard } from "./model-accounts";
import { ModelPricesCard } from "./model-prices";

// Settings → AI model (design.md §9.3): the act and judge model ids, and the organisation's model
// accounts for their providers. Keys live on the accounts; a run tries them in priority order and
// fails over on rate limits, exhausted quotas and rejected keys.

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

export function SettingsTestAiModelPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const settings = useModelSettings();
  const [form, setForm] = useState<ModelFormState>(emptyForm);
  const update = (patch: Partial<ModelFormState>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const data = settings.data;
    if (!data) return;
    setForm((current) => ({ ...current, actModel: data.actModel, judgeModel: data.judgeModel }));
  }, [settings.data]);

  const save = useTestAdminMutation(
    (getToken, body: Parameters<typeof testAdminApi.updateModelSettings>[1]) => testAdminApi.updateModelSettings(getToken, body),
    [testAdminKeys.modelSettings, testAdminKeys.modelAccounts]
  );

  const saved = settings.data ?? null;
  // Only the model ids are edited here; keys and endpoints belong to the accounts below.
  const requirements = useMemo(() => modelFormRequirements(form, saved), [form, saved]);
  const errors = { actModel: requirements.errors.actModel, judgeModel: requirements.errors.judgeModel };
  const hasErrors = Boolean(errors.actModel || errors.judgeModel);
  const dirty = saved ? form.actModel.trim() !== saved.actModel || form.judgeModel.trim() !== saved.judgeModel : true;

  const submit = async () => {
    if (hasErrors) return;
    await save.mutateAsync({ actModel: form.actModel.trim(), judgeModel: form.judgeModel.trim() });
    toast.success("Models saved");
  };

  const pickPreset = (id: string) => {
    const preset = modelPresets.find((entry) => entry.id === id);
    if (preset) update({ actModel: preset.actModel, judgeModel: preset.judgeModel });
  };

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="AI model"
        description="Runs use any AI SDK provider with the organisation's own keys. Spend is attributed to the user who requested the run and to the account that served each call."
        actions={
          <Link to="/test-cases/settings/model-spend" className="text-sm font-semibold text-primary hover:underline">
            Model spend
          </Link>
        }
      >
        {settings.isPending ? (
          <Skeleton className="h-40" />
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
                <SimpleSelect ariaLabel="Provider" value={presetForModels(form.actModel)} onValueChange={pickPreset} options={pickerOptions} disabled={!canManage} />
              </Field>
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Act model" htmlFor="model-act">
                  <Input
                    id="model-act"
                    value={form.actModel}
                    onChange={(event) => update({ actModel: event.target.value })}
                    className="font-mono"
                    aria-describedby="model-act-hint"
                    aria-invalid={errors.actModel ? true : undefined}
                    placeholder="provider/model"
                  />
                  <ProviderHint modelId={form.actModel} id="model-act-hint" error={errors.actModel} />
                </Field>
                <Field label="Judge model" htmlFor="model-judge">
                  <Input
                    id="model-judge"
                    value={form.judgeModel}
                    onChange={(event) => update({ judgeModel: event.target.value })}
                    className="font-mono"
                    aria-describedby="model-judge-hint"
                    aria-invalid={errors.judgeModel ? true : undefined}
                    placeholder="provider/model"
                  />
                  <ProviderHint modelId={form.judgeModel} id="model-judge-hint" error={errors.judgeModel} />
                </Field>
              </div>
              <p className="text-sm text-muted-foreground">
                The act model drives the browser; the judge decides asserts, waits and extracts. The id prefix picks the provider and so the accounts a
                run uses: <code className="font-mono text-xs">{productionPrefixes}</code>. For example{" "}
                <code className="font-mono text-xs">openrouter/anthropic/claude-sonnet-5-5</code>,{" "}
                <code className="font-mono text-xs">openrouter/openai/gpt-5</code> or{" "}
                <code className="font-mono text-xs">openai-compatible/llama-3.3-70b</code> with an OpenAI-compatible account.
              </p>
            </fieldset>
            <ErrorNote error={save.error} />
            {canManage ? (
              <div className="flex justify-end">
                <Button type="submit" className={pressable} disabled={save.isPending || !dirty || hasErrors}>
                  {save.isPending ? "Saving…" : "Save models"}
                </Button>
              </div>
            ) : null}
          </form>
        )}
      </AdminCard>
      <ModelAccountsCard canManage={canManage} actModel={saved?.actModel ?? form.actModel} judgeModel={saved?.judgeModel ?? form.judgeModel} />
      <ModelPricesCard canManage={canManage} models={saved ? [saved.actModel, saved.judgeModel] : []} />
    </div>
  );
}
