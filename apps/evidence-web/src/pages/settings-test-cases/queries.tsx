import React, { useMemo, useState } from "react";
import { Database, Pencil, Plus } from "lucide-react";
import type { TestCredential, TestQuery } from "@jittle-lamp/shared";

import { Button } from "../../components/ui/button";
import { SimpleDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { EmptyState } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { SimpleSelect } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { Textarea } from "../../components/ui/textarea";
import { Hint } from "../../components/ui/tooltip";
import { formatRelativeTime } from "../../utils";
import { testAdminApi, type QueryInput } from "../../test-cases/admin-api";
import { testAdminKeys, useTestAdminMutation, useTestCredentials, useTestPermissions, useTestQueries } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { HoldToConfirmButton } from "../../test-cases/bits";
import { useToast } from "../../toast";
import { formatQueryParams, isPostgresCredential, parseQueryParams, queryFormErrors, queryFormValid, type QueryForm } from "./postgres-form";

// Settings → Queries (roadmap 2026-10-13 §5.2 tier 3): named SQL per postgres profile, run by
// `[Query: PROFILE, name=…]` without the model. The shared guard checks the statement as it is
// typed, against the chosen profile's schema allowlist, and the server checks it again on save.

export function SettingsTestQueriesPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const queries = useTestQueries();
  const credentials = useTestCredentials();
  const toast = useToast();
  const [editing, setEditing] = useState<TestQuery | "new" | null>(null);
  const remove = useTestAdminMutation((getToken, queryId: string) => testAdminApi.deleteQuery(getToken, queryId), [testAdminKeys.queries]);
  const profiles = useMemo(() => (credentials.data ?? []).filter(isPostgresCredential), [credentials.data]);
  const list = queries.data ?? [];

  const deleteQuery = (query: TestQuery) =>
    remove.mutate(query.id, {
      onSuccess: () => toast.success("Query deleted", `${query.profile} · ${query.name}`),
      onError: (error) => toast.error("Delete failed", error instanceof Error ? error.message : undefined)
    });

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Queries"
        description="[Query: PROFILE, name=k1-pending] runs a saved statement instead of asking the model."
        actions={
          canManage ? (
            <Hint label={profiles.length === 0 ? "Add a Postgres credential first" : "New query"}>
              <Button size="sm" className={pressable} disabled={profiles.length === 0} onClick={() => setEditing("new")}>
                <Plus aria-hidden />
                New query
              </Button>
            </Hint>
          ) : null
        }
        bodyClassName="p-0 pt-0"
      >
        <ErrorNote error={queries.error ?? remove.error} className="m-4" />
        {queries.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : list.length === 0 ? (
          <EmptyState className="m-4" icon={<Database aria-hidden />} title="No saved queries" description="Save a SELECT per Postgres profile for steps that should not involve the model." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Profile</TableHead>
                <TableHead className="w-28 whitespace-nowrap">Updated</TableHead>
                <TableHead className="w-40 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((query) => (
                <TableRow key={query.id}>
                  <TableCell className="pl-4">
                    <span className="font-mono text-sm font-semibold text-foreground">{query.name}</span>
                    <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={query.sqlText}>
                      {query.sqlText}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-sm">{query.profile}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{formatRelativeTime(query.updatedAt)}</TableCell>
                  <TableCell className="pr-4 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Hint label={canManage ? "Edit" : "View"}>
                        <Button variant="ghost" size="icon-sm" aria-label={`${canManage ? "Edit" : "View"} ${query.name}`} onClick={() => setEditing(query)}>
                          <Pencil aria-hidden />
                        </Button>
                      </Hint>
                      {canManage ? <HoldToConfirmButton label={`Delete ${query.name}`} disabled={remove.isPending} onConfirm={() => deleteQuery(query)} /> : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      {editing ? <QueryDialog query={editing === "new" ? null : editing} profiles={profiles} readOnly={!canManage} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function QueryDialog(props: { query: TestQuery | null; profiles: readonly TestCredential[]; readOnly: boolean; onClose: () => void }): React.JSX.Element {
  const source = props.query;
  const toast = useToast();
  const [form, setForm] = useState<QueryForm>({
    credentialId: source?.credentialId ?? props.profiles[0]?.id ?? "",
    name: source?.name ?? "",
    sqlText: source?.sqlText ?? "",
    paramsText: source ? formatQueryParams(source.params) : ""
  });
  const [submitted, setSubmitted] = useState(false);
  const save = useTestAdminMutation(
    (getToken, body: QueryInput) => (source ? testAdminApi.updateQuery(getToken, source.id, body) : testAdminApi.createQuery(getToken, body)),
    [testAdminKeys.queries]
  );
  const credential = props.profiles.find((profile) => profile.id === form.credentialId) ?? null;
  const errors = queryFormErrors(form, credential);
  const valid = queryFormValid(errors);
  const patch = (changes: Partial<QueryForm>) => setForm((current) => ({ ...current, ...changes }));

  const submit = async () => {
    setSubmitted(true);
    if (!valid || props.readOnly) return;
    try {
      const saved = await save.mutateAsync({ credentialId: form.credentialId, name: form.name.trim(), sqlText: form.sqlText.trim(), params: parseQueryParams(form.paramsText).params });
      toast.success(source ? "Query saved" : "Query added", `${saved.profile} · ${saved.name}`);
      props.onClose();
    } catch {
      // The error note below shows what the server refused.
    }
  };

  return (
    <SimpleDialog
      title={source ? (props.readOnly ? source.name : `Edit ${source.name}`) : "New query"}
      description={credential ? `Allowed schemas: ${credential.fields.schema_allowlist ?? "none"}` : undefined}
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
              {save.isPending ? "Saving…" : "Save query"}
            </Button>
          </>
        )
      }
    >
      <form
        className="grid gap-4"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={props.readOnly} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="query-name" error={submitted ? errors.name : undefined}>
              <Input id="query-name" value={form.name} className="font-mono" placeholder="k1-pending" onChange={(event) => patch({ name: event.target.value })} />
            </Field>
            <Field label="Profile" error={submitted ? errors.credentialId : undefined}>
              <SimpleSelect
                ariaLabel="Postgres profile"
                value={form.credentialId}
                onValueChange={(value) => patch({ credentialId: value })}
                disabled={props.readOnly}
                options={props.profiles.map((profile) => ({ label: profile.profile, value: profile.id }))}
              />
            </Field>
          </div>
          <Field label="SQL" htmlFor="query-sql" error={submitted && errors.sql.length > 0 ? errors.sql.join(" ") : undefined} hint={form.sqlText.trim().length > 0 && errors.sql.length > 0 && !submitted ? errors.sql.join(" ") : "One SELECT or WITH. $1, $2 … bind the params below."}>
            <Textarea id="query-sql" value={form.sqlText} rows={8} spellCheck={false} className="font-mono text-sm" placeholder="select id, name from students where level = $1 and status = 'PENDING'" onChange={(event) => patch({ sqlText: event.target.value })} />
          </Field>
          <Field label="Params" htmlFor="query-params" error={submitted ? errors.params : undefined} hint="Names in $n order, comma separated.">
            <Input id="query-params" value={form.paramsText} className="font-mono" placeholder="level, centre" onChange={(event) => patch({ paramsText: event.target.value })} />
          </Field>
        </fieldset>
        <ErrorNote error={save.error} />
      </form>
    </SimpleDialog>
  );
}
