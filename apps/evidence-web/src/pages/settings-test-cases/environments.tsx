import React, { useState } from "react";
import { Link } from "react-router";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import type { RunnerPool, TestEnvironment } from "@jittle-lamp/shared";

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
import { testAdminApi, type EnvironmentInput } from "../../test-cases/admin-api";
import { testAdminKeys, useRunnerPools, useTestAdminMutation, useTestEnvironments, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { agentInstructionsCounter, environmentNamePattern, isHttpUrl, runnerPoolValue } from "../../test-config/config-ui";
import { testingSettingsBase } from "./routes";
import { Hint, TruncatedText } from "../../components/ui/tooltip";

// Settings → Environments (design.md §9.3, §14): base URL, variables, runner pool, agent instructions.

export function runnerPoolLabel(value: string, pools: readonly RunnerPool[]): string {
  if (value === "cloud") return "cloud";
  const pool = pools.find((item) => runnerPoolValue(item) === value || `self-hosted:${item.id}` === value);
  return pool ? `self-hosted · ${pool.name}` : value;
}

export function SettingsTestEnvironmentsPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const environments = useTestEnvironments();
  const pools = useRunnerPools();
  const [editing, setEditing] = useState<TestEnvironment | "new" | null>(null);
  const [deleting, setDeleting] = useState<TestEnvironment | null>(null);
  const remove = useTestAdminMutation((getToken, environmentId: string) => testAdminApi.deleteEnvironment(getToken, environmentId), [testAdminKeys.environments]);

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Environments"
        description="Where cases run: base URL, runner pool and agent instructions. Values for {NAME} live in Variables."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              New environment
            </Button>
          ) : null
        }
        bodyClassName="p-0 pt-0"
      >
        <ErrorNote error={environments.error ?? remove.error} className="m-4" />
        {environments.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : (environments.data ?? []).length === 0 ? (
          <EmptyState className="m-4" title="No environments yet" description="Add one per target, for example pcf-uat with its base URL and the pool that can reach it." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Base URL</TableHead>
                <TableHead>Runner pool</TableHead>
                <TableHead className="w-24">Variables</TableHead>
                <TableHead className="w-24 whitespace-nowrap">Used by</TableHead>
                <TableHead className="w-28 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(environments.data ?? []).map((environment) => (
                <TableRow key={environment.id}>
                  <TableCell className="pl-4">
                    <span className="whitespace-nowrap font-mono text-sm font-semibold text-foreground">{environment.name}</span>
                    {environment.agentInstructions ? <span className="block whitespace-nowrap text-xs text-muted-foreground">instructions · {environment.agentInstructions.length.toLocaleString()} chars</span> : null}
                  </TableCell>
                  <TableCell className="max-w-64 font-mono text-xs">
                    <TruncatedText>{environment.baseUrl}</TruncatedText>
                  </TableCell>
                  <TableCell>
                    <Badge variant={environment.runnerPool === "cloud" ? "default" : "outline"}>{runnerPoolLabel(environment.runnerPool, pools.data ?? [])}</Badge>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <Link to={`${testingSettingsBase}/variables`} className="hover:underline">
                      {Object.keys(environment.variables).length}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {environment.usedByCases} case{environment.usedByCases === 1 ? "" : "s"}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <div className="flex justify-end gap-1">
                      <Hint label={canManage ? "Edit" : "View"}>
                        <Button variant="ghost" size="icon-sm" aria-label={`${canManage ? "Edit" : "View"} ${environment.name}`} onClick={() => setEditing(environment)}>
                          {canManage ? <Pencil aria-hidden /> : <Eye aria-hidden />}
                        </Button>
                      </Hint>
                      {canManage ? (
                        <Hint label="Delete">
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${environment.name}`} onClick={() => setDeleting(environment)}>
                            <Trash2 aria-hidden />
                          </Button>
                        </Hint>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      {editing ? <EnvironmentDialog environment={editing === "new" ? null : editing} pools={pools.data ?? []} readOnly={!canManage} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={`Delete ${deleting?.name ?? "environment"}?`}
        description={deleting && deleting.usedByCases > 0 ? `${deleting.usedByCases} cases use it; they fall back to no environment.` : "Cases that do not use it are not affected."}
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

function EnvironmentDialog(props: { environment: TestEnvironment | null; pools: readonly RunnerPool[]; readOnly: boolean; onClose: () => void }): React.JSX.Element {
  const source = props.environment;
  const [name, setName] = useState(source?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? "https://");
  const [runnerPool, setRunnerPool] = useState(source?.runnerPool ?? "cloud");
  const [agentInstructions, setAgentInstructions] = useState(source?.agentInstructions ?? "");
  const [notes, setNotes] = useState(source?.notes ?? "");
  const [submitted, setSubmitted] = useState(false);

  const save = useTestAdminMutation(
    (getToken, body: EnvironmentInput) => (source ? testAdminApi.updateEnvironment(getToken, source.id, body) : testAdminApi.createEnvironment(getToken, body)),
    [testAdminKeys.environments]
  );

  const counter = agentInstructionsCounter(agentInstructions);
  const nameError = environmentNamePattern.test(name) ? undefined : "Lowercase letters, digits and dashes, starting with a letter or digit.";
  const urlError = isHttpUrl(baseUrl) ? undefined : "Enter an http(s) URL.";
  const poolOptions = [
    { label: "cloud", value: "cloud" },
    ...props.pools.filter((pool) => pool.kind === "self-hosted").map((pool) => ({ label: `self-hosted · ${pool.name}`, value: runnerPoolValue(pool) }))
  ];
  if (!poolOptions.some((option) => option.value === runnerPool)) poolOptions.push({ label: `${runnerPool} (no such pool)`, value: runnerPool });
  const valid = !nameError && !urlError && !counter.over;

  const submit = async () => {
    setSubmitted(true);
    if (!valid || props.readOnly) return;
    await save.mutateAsync({
      name,
      baseUrl: baseUrl.trim(),
      // Variables are edited on the Variables page; keep what the environment has.
      variables: source?.variables ?? {},
      runnerPool,
      agentInstructions: agentInstructions.trim() ? agentInstructions : null,
      notes: notes.trim() ? notes : null
    });
    props.onClose();
  };

  return (
    <SimpleDialog
      title={source ? (props.readOnly ? source.name : `Edit ${source.name}`) : "New environment"}
      description={source ? `Used by ${source.usedByCases} case${source.usedByCases === 1 ? "" : "s"}.` : undefined}
      onClose={props.onClose}
      size="lg"
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
              {save.isPending ? "Saving…" : "Save environment"}
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="env-name" error={submitted ? nameError : undefined} hint="Used in transcripts as Env: pcf-uat">
              <Input id="env-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" placeholder="pcf-uat" />
            </Field>
            <Field label="Runner pool" hint="Runs go to a worker of this pool">
              <SimpleSelect ariaLabel="Runner pool" value={runnerPool} onValueChange={setRunnerPool} options={poolOptions} disabled={props.readOnly} />
            </Field>
          </div>
          <Field label="Base URL" htmlFor="env-base-url" error={submitted ? urlError : undefined} hint="[Open] /path resolves against it">
            <Input id="env-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="font-mono" inputMode="url" />
          </Field>
          {source ? (
            <p className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
              <span>
                {Object.keys(source.variables).length} variable{Object.keys(source.variables).length === 1 ? "" : "s"} in this environment.
              </span>
              <Link to={`${testingSettingsBase}/variables`} className="font-medium text-foreground underline underline-offset-2" onClick={props.onClose}>
                Manage variables
              </Link>
            </p>
          ) : null}
          <Field label="Agent instructions" htmlFor="env-agent-instructions">
            <Textarea
              id="env-agent-instructions"
              value={agentInstructions}
              onChange={(event) => setAgentInstructions(event.target.value)}
              rows={5}
              aria-describedby="env-agent-instructions-counter"
              placeholder="Shared UAT. Never delete or bulk-edit existing records; create test records with the E2E prefix."
            />
            <span id="env-agent-instructions-counter" className={cn("text-right font-mono text-xs tabular-nums", counter.over ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
              {counter.label}
              {counter.over ? " · too long" : ""}
            </span>
          </Field>
          <Field label="Notes" htmlFor="env-notes">
            <Textarea id="env-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} maxLength={2000} />
          </Field>
        </fieldset>
        <ErrorNote error={save.error} />
      </form>
    </SimpleDialog>
  );
}
