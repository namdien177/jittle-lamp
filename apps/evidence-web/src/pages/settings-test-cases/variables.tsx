import React, { useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Copy, Eye, EyeOff, FileUp, MoreHorizontal, Pencil, Plus, Search, Trash2, Variable, X } from "lucide-react";
import type { TestEnvironment } from "@jittle-lamp/shared";

import { SettingsPageTitle } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { ConfirmDialog, SimpleDialog } from "../../components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../components/ui/dropdown-menu";
import { EmptyState } from "../../components/ui/empty";
import { Field, FieldLabel } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { SimpleSelect } from "../../components/ui/select";
import { Skeleton } from "../../components/ui/skeleton";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/cn";
import { useToast } from "../../toast";
import { copyToClipboard } from "../../utils";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useActiveOrgId, useTestEnvironments, useTestPermissions, useTokenGetter } from "../../test-cases/admin-queries";
import { ErrorNote, ReadOnlyNotice } from "../../test-cases/admin-ui";
import {
  applyVariableChange,
  environmentVariablePattern,
  groupVariables,
  parseDotenv,
  rowsToRecord,
  saveVariableMaps,
  variableConflicts,
  type KeyValueRow,
  type VariableChange,
  type VariableRow
} from "../../test-config/config-ui";
import { testingSettingsBase } from "./routes";
import { Hint, TruncatedText } from "../../components/ui/tooltip";

// Testing → Settings → Variables: every environment's variables in one list, modelled on Vercel's
// environment variables page. A key can hold a different value per environment; values are
// plaintext and reach the agent as {NAME}. Secrets belong in Credentials.

const ALL = "all";

function useSaveVariables(environments: readonly TestEnvironment[]) {
  const getToken = useTokenGetter();
  const queryClient = useQueryClient();
  const orgId = useActiveOrgId();
  const key = testAdminKeys.environments(orgId);
  return useMutation({
    mutationFn: (change: VariableChange) =>
      saveVariableMaps(
        applyVariableChange(environments, change),
        (id) => environments.find((environment) => environment.id === id)?.name ?? id,
        (id, variables) => testAdminApi.updateEnvironmentVariables(getToken, id, variables),
        // Each saved environment goes into the cache at once, so a later edit starts from it
        // even if a following PATCH fails.
        (saved) => queryClient.setQueryData<TestEnvironment[]>(key, (current) => current?.map((environment) => (environment.id === saved.id ? saved : environment)))
      ),
    // Success or not, reload before the caller continues.
    onSettled: () => queryClient.invalidateQueries({ queryKey: key })
  });
}

export function SettingsTestVariablesPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const environmentsQuery = useTestEnvironments();
  const environments = useMemo(() => environmentsQuery.data ?? [], [environmentsQuery.data]);
  const rows = useMemo(() => groupVariables(environments), [environments]);
  const [query, setQuery] = useState("");
  const [environmentFilter, setEnvironmentFilter] = useState<string>(ALL);
  const [editing, setEditing] = useState<VariableRow | null>(null);
  const [removing, setRemoving] = useState<VariableRow | null>(null);
  const remove = useSaveVariables(environments);
  const toast = useToast();

  const visible = rows.filter(
    (row) =>
      (environmentFilter === ALL || row.environmentIds.includes(environmentFilter)) &&
      (query.trim() === "" || row.key.toLowerCase().includes(query.trim().toLowerCase()))
  );
  const environmentName = (id: string) => environments.find((environment) => environment.id === id)?.name ?? id;

  return (
    <div className="grid gap-5">
      <SettingsPageTitle
        title="Variables"
        description={
          <>
            Plaintext values a step reads as <code className="rounded bg-muted px-1 font-mono text-xs">{"{NAME}"}</code>. Each environment keeps its own value. Put passwords and tokens in{" "}
            <Link to={`${testingSettingsBase}/credentials`} className="font-medium text-foreground underline underline-offset-2">
              Credentials
            </Link>
            .
          </>
        }
      />
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}

      {environmentsQuery.isPending ? (
        <Skeleton className="h-40" />
      ) : environments.length === 0 ? (
        <EmptyState
          icon={<Variable aria-hidden />}
          title="Create an environment first"
          description="Variables are stored per environment, for example pcf-uat and preprod."
          action={
            <Link to={`${testingSettingsBase}/environments`} className="text-sm font-medium text-foreground underline underline-offset-2">
              Go to Environments
            </Link>
          }
        />
      ) : (
        <>
          {canManage ? <AddVariablesCard environments={environments} /> : null}

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <label className="relative min-w-48 flex-1">
                <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search keys…" aria-label="Search variables" className="h-7 border-transparent bg-transparent pl-7 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent" />
              </label>
              <SimpleSelect
                ariaLabel="Filter by environment"
                size="sm"
                className="w-48"
                value={environmentFilter}
                onValueChange={setEnvironmentFilter}
                options={[{ label: "All environments", value: ALL }, ...environments.map((environment) => ({ label: environment.name, value: environment.id }))]}
              />
            </div>
            <ErrorNote error={environmentsQuery.error} className="m-3" />
            {visible.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">{rows.length === 0 ? "No variables yet." : "No variables match."}</p>
            ) : (
              <ul className="divide-y divide-border" aria-label="Variables">
                {visible.map((row) => (
                  <VariableListRow
                    key={`${row.key}\u0000${row.value}`}
                    row={row}
                    environmentNames={row.environmentIds.map(environmentName)}
                    allEnvironments={row.environmentIds.length === environments.length && environments.length > 1}
                    canManage={canManage}
                    onEdit={() => setEditing(row)}
                    onRemove={() => setRemoving(row)}
                    onCopy={() => {
                      void copyToClipboard(row.value).then(() => toast.success("Copied", row.key));
                    }}
                  />
                ))}
              </ul>
            )}
          </Card>
        </>
      )}

      {editing ? <EditVariableDialog row={editing} environments={environments} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={removing !== null}
        destructive
        title={`Remove ${removing?.key ?? "variable"}?`}
        description={
          removing ? (
            <>
              It is removed from {removing.environmentIds.map(environmentName).join(", ")}. Cases that use {`{${removing.key}}`} there stop with MISSING_VARIABLE.
              {remove.error ? <ErrorNote error={remove.error} className="mt-3" /> : null}
            </>
          ) : undefined
        }
        confirmLabel="Remove"
        busy={remove.isPending}
        onCancel={() => {
          remove.reset();
          setRemoving(null);
        }}
        onConfirm={() => {
          if (!removing) return;
          // On failure the dialog stays open with the error so the user can retry.
          remove
            .mutateAsync({ remove: { key: removing.key, environmentIds: removing.environmentIds } })
            .then(() => {
              toast.success("Variable removed", removing.key);
              setRemoving(null);
            })
            .catch(() => undefined);
        }}
      />
    </div>
  );
}

function VariableListRow(props: {
  row: VariableRow;
  environmentNames: string[];
  allEnvironments: boolean;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onCopy: () => void;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <li className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <TruncatedText render={<p />} className="font-mono text-[13px] font-medium text-foreground">
          {props.row.key}
        </TruncatedText>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {props.allEnvironments ? (
            <Badge variant="outline">All environments</Badge>
          ) : (
            props.environmentNames.map((name) => (
              <Badge key={name} variant="outline" className="font-mono">
                {name}
              </Badge>
            ))
          )}
        </div>
      </div>
      <div className="col-span-2 flex min-w-0 items-center gap-1 sm:col-span-1">
        <Hint label={revealed ? "Hide value" : "Show value"}>
          <Button variant="ghost" size="icon-xs" aria-label={revealed ? `Hide ${props.row.key}` : `Show ${props.row.key}`} onClick={() => setRevealed((value) => !value)}>
            {revealed ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </Hint>
        {revealed ? (
          <TruncatedText render={<code />} className="font-mono text-[13px] text-foreground">
            {props.row.value || "(empty)"}
          </TruncatedText>
        ) : (
          <code className="min-w-0 truncate font-mono text-[13px] tracking-widest text-muted-foreground">••••••••••</code>
        )}
      </div>
      <div className="col-start-2 row-start-1 flex items-center gap-2 sm:col-start-3">
        <DropdownMenu>
          <Hint label="More actions">
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${props.row.key}`} />}>
              <MoreHorizontal aria-hidden />
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={props.onCopy}>
              <Copy aria-hidden />
              Copy value
            </DropdownMenuItem>
            {props.canManage ? (
              <>
                <DropdownMenuItem onClick={props.onEdit}>
                  <Pencil aria-hidden />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={props.onRemove}>
                  <Trash2 aria-hidden />
                  Remove
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function EnvironmentPicker(props: {
  environments: readonly TestEnvironment[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}): React.JSX.Element {
  const all = props.environments.length > 0 && props.selected.length === props.environments.length;
  const toggle = (id: string, checked: boolean) =>
    props.onChange(checked ? props.environments.map((environment) => environment.id).filter((candidate) => candidate === id || props.selected.includes(candidate)) : props.selected.filter((candidate) => candidate !== id));
  return (
    <div className="flex flex-col gap-2">
      <FieldLabel>Environments</FieldLabel>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <Checkbox
            checked={all}
            indeterminate={!all && props.selected.length > 0}
            onCheckedChange={(checked) => props.onChange(checked ? props.environments.map((environment) => environment.id) : [])}
          />
          All environments
        </label>
        {props.environments.map((environment) => (
          <label key={environment.id} className="flex items-center gap-2 font-mono text-[13px]">
            <Checkbox checked={props.selected.includes(environment.id)} onCheckedChange={(checked) => toggle(environment.id, checked)} />
            {environment.name}
          </label>
        ))}
      </div>
    </div>
  );
}

const emptyRow = (): KeyValueRow => ({ key: "", value: "" });

function AddVariablesCard(props: { environments: readonly TestEnvironment[] }): React.JSX.Element {
  const toast = useToast();
  const [rows, setRows] = useState<KeyValueRow[]>([emptyRow()]);
  const [selected, setSelected] = useState<string[]>(() => props.environments.map((environment) => environment.id));
  const [submitted, setSubmitted] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const save = useSaveVariables(props.environments);

  const result = rowsToRecord(rows, environmentVariablePattern, "Key");
  const entries = Object.entries(result.record).map(([key, value]) => ({ key, value }));
  const conflicts = variableConflicts(props.environments, entries, selected);
  const errors = [...result.errors, ...(entries.length === 0 ? ["Add at least one key."] : []), ...(selected.length === 0 ? ["Pick at least one environment."] : [])];

  const update = (index: number, patch: Partial<KeyValueRow>) => setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  // Pasting `.env` text into a key field fills one row per line, as on Vercel.
  const absorb = (index: number, text: string): boolean => {
    const parsed = parseDotenv(text);
    if (parsed.length === 0 || (parsed.length === 1 && !text.includes("="))) return false;
    setRows((current) => [...current.slice(0, index), ...parsed, ...current.slice(index + 1)].filter((row, rowIndex, list) => row.key || row.value || list.length === 1 || rowIndex === list.length - 1));
    return true;
  };

  const submit = async () => {
    setSubmitted(true);
    if (errors.length > 0) return;
    try {
      await save.mutateAsync({ set: { entries, environmentIds: selected } });
    } catch {
      return;
    }
    toast.success(entries.length === 1 ? "Variable saved" : `${entries.length} variables saved`, selected.length === props.environments.length ? "All environments" : `${selected.length} environment${selected.length === 1 ? "" : "s"}`);
    setRows([emptyRow()]);
    setSubmitted(false);
  };

  return (
    <Card>
      <form
        className="grid gap-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Add variables</h2>
            <p className="text-xs text-muted-foreground">Tip: paste a .env file into a key field to fill every row.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <FileUp aria-hidden />
            Import .env
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".env,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void file.text().then((text) => {
                const parsed = parseDotenv(text);
                if (parsed.length === 0) toast.warning("Nothing imported", "No KEY=VALUE lines in that file.");
                else setRows((current) => [...current.filter((row) => row.key || row.value), ...parsed]);
              });
            }}
          />
        </div>

        <div className="grid gap-2">
          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.75rem] gap-2 text-xs font-medium text-muted-foreground">
            <span>Key</span>
            <span>Value</span>
            <span />
          </div>
          {rows.map((row, index) => (
            <div key={index} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_1.75rem] items-start gap-2">
              <Input
                aria-label={`Key ${index + 1}`}
                value={row.key}
                placeholder="e.g. PARENT_URL"
                className="font-mono"
                aria-invalid={submitted && row.key !== "" && !environmentVariablePattern.test(row.key.trim()) ? true : undefined}
                onChange={(event) => update(index, { key: event.target.value })}
                onPaste={(event) => {
                  if (absorb(index, event.clipboardData.getData("text"))) event.preventDefault();
                }}
              />
              <Textarea
                aria-label={`Value ${index + 1}`}
                value={row.value}
                rows={1}
                className="min-h-8 resize-y font-mono"
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Hint label="Remove row">
                <Button variant="ghost" size="icon-sm" aria-label={`Remove row ${index + 1}`} disabled={rows.length === 1 && !row.key && !row.value} onClick={() => setRows((current) => (current.length === 1 ? [emptyRow()] : current.filter((_row, rowIndex) => rowIndex !== index)))}>
                  <X aria-hidden />
                </Button>
              </Hint>
            </div>
          ))}
          <div>
            <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setRows((current) => [...current, emptyRow()])}>
              <Plus aria-hidden />
              Add another
            </Button>
          </div>
        </div>

        <EnvironmentPicker environments={props.environments} selected={selected} onChange={setSelected} />

        {submitted && errors.length > 0 ? (
          <ul className="grid gap-0.5 text-xs text-destructive">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
        {conflicts.length > 0 ? <p className="text-xs text-warning">Replaces {conflicts.join(", ")}.</p> : null}
        <ErrorNote error={save.error} />

        <div className="-mx-4 -mb-4 flex justify-end border-t border-border bg-muted/40 px-4 py-2.5">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function EditVariableDialog(props: { row: VariableRow; environments: readonly TestEnvironment[]; onClose: () => void }): React.JSX.Element {
  const toast = useToast();
  const [key, setKey] = useState(props.row.key);
  const [value, setValue] = useState(props.row.value);
  const [selected, setSelected] = useState<string[]>(props.row.environmentIds);
  const save = useSaveVariables(props.environments);
  const trimmedKey = key.trim();
  const keyError = environmentVariablePattern.test(trimmedKey) ? undefined : "Letters, digits and underscores, not starting with a digit.";
  const conflicts = variableConflicts(props.environments, [{ key: trimmedKey, value }], selected, { key: props.row.key, environmentIds: props.row.environmentIds });

  const submit = async () => {
    if (keyError || selected.length === 0) return;
    try {
      await save.mutateAsync({
        remove: { key: props.row.key, environmentIds: props.row.environmentIds },
        set: { entries: [{ key: trimmedKey, value }], environmentIds: selected }
      });
    } catch {
      return;
    }
    toast.success("Variable updated", trimmedKey);
    props.onClose();
  };

  return (
    <SimpleDialog
      title={`Edit ${props.row.key}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={props.onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" disabled={save.isPending || Boolean(keyError) || selected.length === 0} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Key" htmlFor="variable-key" error={keyError}>
          <Input id="variable-key" value={key} onChange={(event) => setKey(event.target.value)} className="font-mono" />
        </Field>
        <Field label="Value" htmlFor="variable-value">
          <Textarea id="variable-value" value={value} onChange={(event) => setValue(event.target.value)} rows={3} className="font-mono" />
        </Field>
        <EnvironmentPicker environments={props.environments} selected={selected} onChange={setSelected} />
        {selected.length === 0 ? <p className="text-xs text-destructive">Pick at least one environment, or remove the variable instead.</p> : null}
        {conflicts.length > 0 ? <p className="text-xs text-warning">Replaces {conflicts.join(", ")}.</p> : null}
        <ErrorNote error={save.error} />
      </form>
    </SimpleDialog>
  );
}
