import React, { useMemo, useState } from "react";
import { Eye, Pencil, Plus, Puzzle, Trash2 } from "lucide-react";
import type { MacroParam, TestMacro } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, SimpleDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { EmptyState } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { SimpleSelect } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../utils";
import { testAdminApi, type MacroInput } from "../../test-cases/admin-api";
import { testAdminKeys, useTestAdminMutation, useTestMacros, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, LintFindingList, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { lintMacroBody } from "../../test-config/config-ui";

// Testing settings → Actions (design.md §4, §13 "macros"): named, parameterised step sequences such as Login.

const macroNamePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const paramNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function SettingsTestMacrosPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const macros = useTestMacros();
  const [editing, setEditing] = useState<TestMacro | "new" | null>(null);
  const [deleting, setDeleting] = useState<TestMacro | null>(null);
  const remove = useTestAdminMutation((getToken, macroId: string) => testAdminApi.deleteMacro(getToken, macroId), [testAdminKeys.macros]);

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Actions"
        description="Reusable step sequences (macros). Any tag that is not a built-in step calls one: [Login: PCF_HQ_ADMIN] runs Login with its first parameter. Editing an action re-records only the steps it expands to."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              New action
            </Button>
          ) : null
        }
        bodyClassName="p-0 pt-0"
      >
        <ErrorNote error={macros.error ?? remove.error} className="m-4" />
        {macros.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : (macros.data ?? []).length === 0 ? (
          <EmptyState className="m-4" icon={<Puzzle aria-hidden />} title="No actions yet" description="Start with Login: open the login page, fill the profile's username and password, submit." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Action</TableHead>
                <TableHead>Parameters</TableHead>
                <TableHead className="w-24">Version</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-32">Updated</TableHead>
                <TableHead className="w-24 pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(macros.data ?? []).map((macro) => (
                <TableRow key={macro.id}>
                  <TableCell className="pl-5 font-mono text-sm font-semibold">[{macro.name}]</TableCell>
                  <TableCell className="text-sm">
                    {macro.params.length === 0
                      ? "—"
                      : macro.params.map((param) => (
                          <span key={param.name} className="mr-2 inline-flex items-center gap-1 font-mono text-xs">
                            {param.name}
                            <span className="text-muted-foreground">
                              :{param.kind}
                              {param.required ? "" : "?"}
                            </span>
                          </span>
                        ))}
                  </TableCell>
                  <TableCell className="tabular-nums">v{macro.version}</TableCell>
                  <TableCell>
                    <Badge variant={macro.status === "active" ? "success" : "warning"}>{macro.status}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{formatRelativeTime(macro.updatedAt)}</TableCell>
                  <TableCell className="pr-5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`${canManage ? "Edit" : "View"} action ${macro.name}`} onClick={() => setEditing(macro)}>
                        {canManage ? <Pencil aria-hidden /> : <Eye aria-hidden />}
                      </Button>
                      {canManage ? (
                        <Button variant="ghost" size="icon-sm" aria-label={`Delete action ${macro.name}`} onClick={() => setDeleting(macro)}>
                          <Trash2 aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      {editing ? <MacroDialog macro={editing === "new" ? null : editing} macros={macros.data ?? []} readOnly={!canManage} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={`Delete action ${deleting?.name ?? ""}?`}
        description="Transcripts that call it will show an unknown-macro lint error."
        confirmLabel="Delete"
        busy={remove.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove.mutateAsync(deleting.id).finally(() => setDeleting(null));
        }}
      />
    </div>
  );
}

const kindOptions = [
  { label: "text", value: "text" },
  { label: "credential", value: "credential" },
  { label: "url", value: "url" }
] as const;

type ParamRow = { name: string; kind: MacroParam["kind"]; required: boolean; default: string };

function MacroDialog(props: { macro: TestMacro | null; macros: readonly TestMacro[]; readOnly: boolean; onClose: () => void }): React.JSX.Element {
  const source = props.macro;
  const [name, setName] = useState(source?.name ?? "");
  const [status, setStatus] = useState<"draft" | "active">(source?.status ?? "draft");
  const [params, setParams] = useState<ParamRow[]>(
    source ? source.params.map((param) => ({ name: param.name, kind: param.kind, required: param.required, default: param.default ?? "" })) : [{ name: "profile", kind: "credential", required: true, default: "" }]
  );
  const [transcript, setTranscript] = useState(source?.transcript ?? "");
  const [submitted, setSubmitted] = useState(false);

  const save = useTestAdminMutation(
    (getToken, body: MacroInput) => (source ? testAdminApi.updateMacro(getToken, source.id, body) : testAdminApi.createMacro(getToken, body)),
    [testAdminKeys.macros]
  );

  const others = props.macros.filter((macro) => macro.id !== source?.id);
  const lint = useMemo(() => lintMacroBody(transcript, params, others), [transcript, params, others]);
  const nameError = macroNamePattern.test(name) ? undefined : "Letters, digits, dashes and underscores, starting with a letter.";
  const paramErrors = params.flatMap((param, index) =>
    paramNamePattern.test(param.name) ? (params.findIndex((other) => other.name === param.name) === index ? [] : [`Parameter "${param.name}" appears twice.`]) : [`Parameter "${param.name || index + 1}" is not a valid name.`]
  );
  const lintErrors = lint.filter((finding) => finding.severity === "error").length;
  const valid = !nameError && paramErrors.length === 0 && transcript.trim().length > 0;

  const updateParam = (index: number, patch: Partial<ParamRow>) => setParams((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    setSubmitted(true);
    if (!valid || props.readOnly) return;
    await save.mutateAsync({
      name,
      status,
      transcript,
      params: params.map((param) => ({ name: param.name, kind: param.kind, required: param.required, default: param.default ? param.default : null }))
    });
    props.onClose();
  };

  return (
    <SimpleDialog
      title={source ? (props.readOnly ? `[${source.name}]` : `Edit [${source.name}]`) : "New action"}
      description={source ? `Version ${source.version}. Saving a changed body creates version ${source.version + 1}.` : "Agent-created actions arrive as drafts; activate one when it is reviewed."}
      onClose={props.onClose}
      size="xl"
      footer={
        props.readOnly ? (
          <Button size="sm" variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={props.onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button size="sm" className={pressable} disabled={save.isPending} onClick={() => void submit()}>
              {save.isPending ? "Saving…" : "Save action"}
            </Button>
          </>
        )
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={props.readOnly} className="grid gap-4">
          <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label="Name" htmlFor="macro-name" error={submitted ? nameError : undefined} hint="Called as [Name: value] or [Name: param=value, …]">
              <Input id="macro-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" placeholder="Login" />
            </Field>
            <div role="radiogroup" aria-label="Action status" className="flex h-10 overflow-hidden rounded-md border border-border">
              {(["draft", "active"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={status === value}
                  onClick={() => setStatus(value)}
                  className={cn("px-4 text-sm font-semibold capitalize", pressable, status === value ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-muted")}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            <span className="font-medium text-muted-foreground">Parameters</span>
            {params.length > 0 ? (
              <div className="grid grid-cols-[minmax(0,2fr)_8rem_6rem_minmax(0,2fr)_2.25rem] gap-2 text-xs font-medium text-muted-foreground">
                <span>Name</span>
                <span>Kind</span>
                <span>Required</span>
                <span>Default</span>
                <span />
              </div>
            ) : null}
            {params.map((param, index) => (
              <div key={index} className="grid grid-cols-[minmax(0,2fr)_8rem_6rem_minmax(0,2fr)_2.25rem] items-center gap-2">
                <Input aria-label={`Parameter ${index + 1} name`} value={param.name} className="font-mono text-sm" onChange={(event) => updateParam(index, { name: event.target.value })} />
                <SimpleSelect size="sm" ariaLabel={`Parameter ${param.name || index + 1} kind`} value={param.kind} onValueChange={(kind) => updateParam(index, { kind })} options={[...kindOptions]} disabled={props.readOnly} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={param.required} onChange={(event) => updateParam(index, { required: event.target.checked })} aria-label={`Parameter ${param.name || index + 1} required`} />
                  required
                </label>
                <Input aria-label={`Parameter ${param.name || index + 1} default`} value={param.default} onChange={(event) => updateParam(index, { default: event.target.value })} />
                <Button variant="ghost" size="icon-sm" aria-label={`Remove parameter ${param.name || index + 1}`} onClick={() => setParams((current) => current.filter((_row, rowIndex) => rowIndex !== index))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
            ))}
            {!props.readOnly ? (
              <div>
                <Button variant="ghost" size="xs" onClick={() => setParams((current) => [...current, { name: "", kind: "text", required: false, default: "" }])}>
                  <Plus aria-hidden />
                  Add parameter
                </Button>
              </div>
            ) : null}
            {paramErrors.map((error) => (
              <p key={error} className="text-sm text-destructive">
                {error}
              </p>
            ))}
          </div>

          <Field label="Body" htmlFor="macro-body" hint="Steps only, no title. Use {param} for parameters.">
            <Textarea
              id="macro-body"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              rows={9}
              className="font-mono text-sm"
              aria-describedby="macro-lint"
              placeholder={"[Open] /login\n[Act] type the username of {profile} into Email\n[Act] type the password of {profile} into Password\n[Act] click Sign in\n[Wait] the dashboard is visible"}
            />
          </Field>
          <div id="macro-lint" aria-live="polite" className="grid gap-1">
            {transcript.trim() ? (
              lint.length === 0 ? (
                <p className="text-sm text-primary">No lint findings.</p>
              ) : (
                <>
                  <p className="text-sm font-semibold text-foreground">
                    {lint.length} lint finding{lint.length === 1 ? "" : "s"}
                    {lintErrors > 0 ? ` · ${lintErrors} error${lintErrors === 1 ? "" : "s"}` : ""}
                  </p>
                  <LintFindingList findings={lint} />
                </>
              )
            ) : null}
          </div>
        </fieldset>
        <ErrorNote error={save.error} />
      </form>
    </SimpleDialog>
  );
}
