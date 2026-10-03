import React, { useState } from "react";
import { Info } from "lucide-react";

import type { ModelPriceRow } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { useToast } from "../../toast";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useModelPrices, useTestAdminMutation } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, pressable } from "../../test-cases/admin-ui";
import {
  formatUsdPerMtok,
  modelPriceHint,
  modelPriceStatus,
  priceFormFromRow,
  priceFromForm,
  removeOrganizationPrice,
  upsertOrganizationPrice,
  type PriceForm
} from "../../test-config/config-ui";

// Settings → AI model → Model prices: the price table a run's tokens are costed with when the
// provider does not report a cost (design.md §5.1). Defaults cover the Anthropic ids; the
// organisation adds or overrides a row per model id through PUT /model-prices.

type Editing = { form: PriceForm; editedModelId: string | null };

export function ModelPricesCard(props: { canManage: boolean; models: readonly string[] }): React.JSX.Element {
  const toast = useToast();
  const prices = useModelPrices();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const save = useTestAdminMutation((getToken, rows: Parameters<typeof testAdminApi.saveModelPrices>[1]) => testAdminApi.saveModelPrices(getToken, rows), [
    testAdminKeys.modelPrices
  ]);
  // The organisation's own rows first, then the defaults.
  const rows: ModelPriceRow[] = [...(prices.data ?? [])].sort(
    (a, b) => Number(b.source === "organization") - Number(a.source === "organization") || a.modelId.localeCompare(b.modelId)
  );
  const result = editing ? priceFromForm(editing.form) : null;
  const errors = submitted ? (result?.errors ?? {}) : {};
  const models = [...new Set(props.models.map((model) => model.trim()).filter(Boolean))];

  const startEdit = (row: ModelPriceRow | null, modelId = "") => {
    setSubmitted(false);
    setEditing({ form: priceFormFromRow(row, modelId), editedModelId: row && row.source === "organization" ? row.modelId : null });
  };
  const update = (patch: Partial<PriceForm>) => setEditing((current) => (current ? { ...current, form: { ...current.form, ...patch } } : current));

  const submit = async () => {
    setSubmitted(true);
    if (!editing || !result?.price) return;
    await save.mutateAsync(upsertOrganizationPrice(rows, result.price, editing.editedModelId));
    toast.success(`Price saved for ${result.price.modelId}`);
    setEditing(null);
  };

  const remove = async (modelId: string) => {
    await save.mutateAsync(removeOrganizationPrice(rows, modelId));
    setConfirmRemove(null);
    toast.success(`Organisation price removed for ${modelId}`);
  };

  return (
    <AdminCard
      title="Model prices"
      description="USD per million tokens. A run's cost comes from these rows when the provider does not report one; a model without a row shows its cost as unknown. Rows marked Organisation override the defaults."
      actions={
        props.canManage ? (
          <Button variant="secondary" size="sm" onClick={() => startEdit(null)}>
            Add price
          </Button>
        ) : null
      }
    >
      {prices.isPending ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="grid gap-4">
          <ErrorNote error={prices.error} />
          {models.length > 0 ? (
            <ul className="grid gap-2" aria-label="Cost of the configured models">
              {models.map((modelId) => {
                const status = modelPriceStatus(rows, modelId);
                return (
                  <li key={modelId} className="flex flex-wrap items-start gap-2 text-sm text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <code className="font-mono text-xs text-foreground">{modelId}</code> · {modelPriceHint(rows, modelId)}
                    </span>
                    {status.kind === "unknown" && props.canManage ? (
                      <Button variant="secondary" size="sm" onClick={() => startEdit(null, modelId)}>
                        Add price for this model
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {editing && props.canManage ? (
            <form
              className="grid gap-4 rounded-md border border-border p-4"
              aria-label={editing.editedModelId ? `Edit price for ${editing.editedModelId}` : "Add a model price"}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <Field label="Model id" htmlFor="price-model" error={errors.modelId} hint="The id as runs report it, e.g. openai-compatible/llama-3.3-70b or openai/gpt-5. Router ids (openrouter/…, gateway/…) fall back to the vendor's row.">
                <Input id="price-model" value={editing.form.modelId} onChange={(event) => update({ modelId: event.target.value })} className="font-mono" spellCheck={false} placeholder="provider/model" />
              </Field>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Input" htmlFor="price-input" error={errors.input} hint="USD per 1M input tokens">
                  <Input id="price-input" inputMode="decimal" value={editing.form.input} onChange={(event) => update({ input: event.target.value })} placeholder="0.00" />
                </Field>
                <Field label="Cached input" htmlFor="price-cached" error={errors.cachedInput} hint="USD per 1M cached input tokens; empty is 0">
                  <Input id="price-cached" inputMode="decimal" value={editing.form.cachedInput} onChange={(event) => update({ cachedInput: event.target.value })} placeholder="0.00" />
                </Field>
                <Field label="Output" htmlFor="price-output" error={errors.output} hint="USD per 1M output and reasoning tokens">
                  <Input id="price-output" inputMode="decimal" value={editing.form.output} onChange={(event) => update({ output: event.target.value })} placeholder="0.00" />
                </Field>
              </div>
              <ErrorNote error={save.error} />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
                <Button type="submit" className={pressable} disabled={save.isPending}>
                  {save.isPending ? "Saving…" : "Save price"}
                </Button>
              </div>
            </form>
          ) : null}

          <Table aria-label="Effective model prices">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Model id</TableHead>
                <TableHead className="w-20 text-right">Input</TableHead>
                <TableHead className="w-20 text-right">Cached</TableHead>
                <TableHead className="w-20 text-right">Output</TableHead>
                {props.canManage ? (
                  <TableHead className="w-px pr-4">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.modelId}>
                  <TableCell className="pl-4">
                    <span className="block font-mono text-sm [overflow-wrap:anywhere]">{row.modelId}</span>
                    {row.source === "organization" ? (
                      <Badge variant="success" className="mt-1">
                        Organisation
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsdPerMtok(row.inputUsdPerMtok)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsdPerMtok(row.cachedInputUsdPerMtok)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatUsdPerMtok(row.outputUsdPerMtok)}</TableCell>
                  {props.canManage ? (
                    <TableCell className="whitespace-nowrap pr-4">
                      <div className="flex justify-end gap-2">
                        <Button variant="secondary" size="sm" onClick={() => startEdit(row)} aria-label={`${row.source === "organization" ? "Edit" : "Override"} the price of ${row.modelId}`}>
                          {row.source === "organization" ? "Edit" : "Override"}
                        </Button>
                        {row.source === "organization" ? (
                          <Button variant="destructive" size="sm" onClick={() => setConfirmRemove(row.modelId)} aria-label={`Remove the organisation price of ${row.modelId}`}>
                            Remove
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <ConfirmDialog
        open={confirmRemove !== null}
        destructive
        title="Remove this organisation price?"
        description={`Runs of ${confirmRemove ?? "this model"} use the default price again, or show the cost as unknown if there is none.`}
        confirmLabel="Remove price"
        busy={save.isPending}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => {
          if (confirmRemove) void remove(confirmRemove);
        }}
      />
    </AdminCard>
  );
}
