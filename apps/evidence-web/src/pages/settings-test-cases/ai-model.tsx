import React, { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { Link } from "react-router";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/misc";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useModelSettings, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { maskedKeyLabel, providerFromModelId } from "../../test-config/config-ui";

// Settings → AI model (design.md §9.3 "Model key"): bring your own key per organisation. The key is
// write-only; the API returns only whether one is configured and its last four characters.

const DEFAULT_ACT = "anthropic/claude-opus-5-5";
const DEFAULT_JUDGE = "anthropic/claude-sonnet-5-5";

function ProviderHint(props: { modelId: string; id: string }): React.JSX.Element {
  const hint = providerFromModelId(props.modelId);
  return (
    <span id={props.id} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
      <Badge variant={hint.tone === "ok" ? "success" : hint.tone === "warning" ? "warning" : "outline"}>{hint.provider}</Badge>
      {hint.note}
    </span>
  );
}

export function SettingsTestAiModelPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const settings = useModelSettings();
  const [actModel, setActModel] = useState(DEFAULT_ACT);
  const [judgeModel, setJudgeModel] = useState(DEFAULT_JUDGE);
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!settings.data) return;
    setActModel(settings.data.actModel);
    setJudgeModel(settings.data.judgeModel);
  }, [settings.data]);

  const save = useTestAdminMutation(
    (getToken, body: { actModel: string; judgeModel: string; apiKey?: string | null }) => testAdminApi.updateModelSettings(getToken, body),
    [testAdminKeys.modelSettings]
  );

  const keyConfigured = settings.data?.keyConfigured ?? false;
  const showKeyInput = !keyConfigured || replacing;
  const keyError = apiKey.length > 0 && apiKey.length < 8 ? "The key looks too short." : undefined;
  const dirty = settings.data ? actModel !== settings.data.actModel || judgeModel !== settings.data.judgeModel || apiKey.length > 0 : true;

  const submit = async () => {
    if (keyError || !actModel.trim() || !judgeModel.trim()) return;
    await save.mutateAsync({ actModel: actModel.trim(), judgeModel: judgeModel.trim(), ...(apiKey ? { apiKey } : {}) });
    setApiKey("");
    setReplacing(false);
    toast.success("Model settings saved");
  };

  const removeKey = async () => {
    await save.mutateAsync({ actModel: actModel.trim(), judgeModel: judgeModel.trim(), apiKey: null });
    setConfirmRemove(false);
    toast.success("Model key removed");
  };

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="AI model"
        description="Every run uses the organisation's key. Spend is attributed to the user who requested the run."
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
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <ErrorNote error={settings.error} />
            <fieldset disabled={!canManage} className="grid gap-5">
              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Act model" htmlFor="model-act">
                  <Input id="model-act" value={actModel} onChange={(event) => setActModel(event.target.value)} className="font-mono" aria-describedby="model-act-hint" placeholder={DEFAULT_ACT} />
                  <ProviderHint modelId={actModel} id="model-act-hint" />
                </Field>
                <Field label="Judge model" htmlFor="model-judge">
                  <Input id="model-judge" value={judgeModel} onChange={(event) => setJudgeModel(event.target.value)} className="font-mono" aria-describedby="model-judge-hint" placeholder={DEFAULT_JUDGE} />
                  <ProviderHint modelId={judgeModel} id="model-judge-hint" />
                </Field>
              </div>
              <p className="text-sm text-muted-foreground">
                The act model drives the browser; the judge decides asserts, waits and extracts. The id prefix picks the provider: <code className="font-mono text-xs">anthropic/</code>,{" "}
                <code className="font-mono text-xs">openai/</code>, <code className="font-mono text-xs">openrouter/&lt;vendor&gt;/&lt;model&gt;</code>, <code className="font-mono text-xs">openai-compatible/</code>.
              </p>

              <div className="grid gap-2 rounded-md border border-border p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="grid size-9 place-items-center rounded-md border border-border bg-secondary text-primary">
                    {keyConfigured ? <ShieldCheck className="size-4" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
                  </span>
                  <div className="mr-auto">
                    <p className="font-semibold text-foreground">Provider API key</p>
                    <p className="font-mono text-sm text-muted-foreground" aria-label={keyConfigured ? `Key configured, ending in ${settings.data?.keyLast4 ?? "unknown"}` : "No key configured"}>
                      {maskedKeyLabel(keyConfigured, settings.data?.keyLast4 ?? null)}
                      {settings.data?.provider ? ` · ${settings.data.provider}` : ""}
                    </p>
                  </div>
                  {keyConfigured && canManage ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => setReplacing((value) => !value)}>
                        {replacing ? "Keep current key" : "Replace"}
                      </Button>
                      <Button variant="destructive" size="sm" onClick={() => setConfirmRemove(true)}>
                        Remove
                      </Button>
                    </>
                  ) : null}
                </div>
                {showKeyInput && canManage ? (
                  <Field label={keyConfigured ? "New key" : "Key"} htmlFor="model-key" error={keyError} hint="Write-only. It is encrypted on the server and never shown again.">
                    <Input id="model-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} className="font-mono" placeholder="sk-…" />
                  </Field>
                ) : null}
              </div>
            </fieldset>
            <ErrorNote error={save.error} />
            {canManage ? (
              <div className="flex justify-end">
                <Button type="submit" className={pressable} disabled={save.isPending || !dirty || Boolean(keyError)}>
                  {save.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </form>
        )}
      </AdminCard>
      <ConfirmDialog
        open={confirmRemove}
        destructive
        title="Remove the model key?"
        description="New runs are blocked with MODEL_KEY_MISSING until a key is configured again."
        confirmLabel="Remove key"
        busy={save.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => void removeKey()}
      />
    </div>
  );
}
