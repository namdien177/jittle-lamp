import React, { useState } from "react";
import { Eye, KeyRound, Lock, Pencil, Plus, RotateCw, Trash2, Undo2 } from "lucide-react";
import type { TestCredential, TestEnvironment } from "@jittle-lamp/shared";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { EmptyState, Skeleton } from "../../components/ui/misc";
import { Select } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { formatRelativeTime } from "../../utils";
import { testAdminApi, type CredentialInput } from "../../test-cases/admin-api";
import { testAdminKeys, useTestAdminMutation, useTestCredentials, useTestEnvironments, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, KeyValueEditor, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { credentialFieldPattern, recordToRows, rowsToRecord, type KeyValueRow } from "../../test-config/config-ui";

// Settings → Credentials (design.md §9.3). Secret fields are write-only: the API returns names only,
// inputs are password fields, and values live in component state only until the request is sent.

const SHARED = "__shared__";
const MASK = "••••••••";

const kindLabels: Record<TestCredential["kind"], string> = {
  login: "Login",
  model_key: "Model key",
  jira: "Jira",
  github_app: "GitHub app",
  gitlab_token: "GitLab token",
  slack_webhook: "Slack webhook"
};

const editableKinds = ["login", "jira", "github_app", "gitlab_token", "slack_webhook"] as const;
const profilePattern = /^[A-Z][A-Z0-9_]{0,62}$/;

function environmentName(environmentId: string | null, environments: readonly TestEnvironment[]): string {
  if (!environmentId) return "All environments";
  return environments.find((environment) => environment.id === environmentId)?.name ?? "Unknown environment";
}

export function SettingsTestCredentialsPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const credentials = useTestCredentials();
  const environments = useTestEnvironments();
  const [editing, setEditing] = useState<TestCredential | "new" | null>(null);
  const [rotating, setRotating] = useState<TestCredential | null>(null);
  const [deleting, setDeleting] = useState<TestCredential | null>(null);
  const remove = useTestAdminMutation((getToken, credentialId: string) => testAdminApi.deleteCredential(getToken, credentialId), [testAdminKeys.credentials]);
  const list = (credentials.data ?? []).filter((credential) => credential.kind !== "model_key");

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Credentials"
        description="Transcripts name a profile ([Login: PCF_HQ_ADMIN]); the runner fills secret fields into the page and never shows them to the model."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              New credential
            </Button>
          ) : null
        }
        bodyClassName="p-0 pt-0"
      >
        <ErrorNote error={credentials.error ?? remove.error} className="m-5" />
        {credentials.isPending ? (
          <Skeleton className="m-5 h-32" />
        ) : list.length === 0 ? (
          <EmptyState className="m-5" icon={<KeyRound aria-hidden />} title="No credentials yet" description="Add a login profile per role, for example PCF_HQ_ADMIN with a username and a password." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Profile</TableHead>
                <TableHead>Scope</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead className="w-28 whitespace-nowrap">Last used</TableHead>
                <TableHead className="w-32 pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((credential) => (
                <TableRow key={credential.id}>
                  <TableCell className="pl-5">
                    <span className="font-mono text-sm font-semibold text-foreground">{credential.profile}</span>
                    <span className="mt-0.5 block">
                      <Badge variant="outline" className="px-1.5 py-0 text-[11px]">
                        {kindLabels[credential.kind]}
                      </Badge>
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{environmentName(credential.environmentId, environments.data ?? [])}</TableCell>
                  <TableCell>
                    <dl className="grid gap-0.5 text-sm">
                      {Object.entries(credential.fields).map(([key, value]) => (
                        <div key={key} className="flex min-w-0 gap-1.5">
                          <dt className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{key}</dt>
                          <dd className="min-w-0 truncate text-foreground" title={value}>
                            {value}
                          </dd>
                        </div>
                      ))}
                      {credential.secretFieldNames.map((field) => (
                        <div key={field} className="flex items-center gap-1.5">
                          <dt className="flex shrink-0 items-center gap-1 font-mono text-xs text-muted-foreground">
                            <Lock className="size-3" aria-hidden />
                            {field}
                          </dt>
                          <dd className="font-mono text-foreground">
                            <span aria-hidden>{MASK}</span>
                            <span className="sr-only">hidden, write-only</span>
                          </dd>
                        </div>
                      ))}
                      {Object.keys(credential.fields).length + credential.secretFieldNames.length === 0 ? <span className="text-muted-foreground">—</span> : null}
                    </dl>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{credential.lastUsedAt ? formatRelativeTime(credential.lastUsedAt) : "Never"}</TableCell>
                  <TableCell className="pr-5 text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" aria-label={`${canManage ? "Edit" : "View"} ${credential.profile}`} onClick={() => setEditing(credential)}>
                        {canManage ? <Pencil aria-hidden /> : <Eye aria-hidden />}
                      </Button>
                      {canManage ? (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={`Rotate secrets of ${credential.profile}`} disabled={credential.secretFieldNames.length === 0} onClick={() => setRotating(credential)}>
                            <RotateCw aria-hidden />
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label={`Delete ${credential.profile}`} onClick={() => setDeleting(credential)}>
                            <Trash2 aria-hidden />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      {editing ? <CredentialDialog credential={editing === "new" ? null : editing} environments={environments.data ?? []} readOnly={!canManage} onClose={() => setEditing(null)} /> : null}
      {rotating ? <RotateDialog credential={rotating} onClose={() => setRotating(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={`Delete ${deleting?.profile ?? "credential"}?`}
        description="Runs whose transcripts reference this profile will be blocked with MISSING_CREDENTIAL."
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

type SecretRow = { name: string; value: string; stored: boolean; remove: boolean };

function SecretInput(props: { id?: string; label: string; value: string; onChange: (value: string) => void; placeholder: string; disabled?: boolean }): React.JSX.Element {
  return (
    <Input
      id={props.id}
      type="password"
      autoComplete="new-password"
      spellCheck={false}
      aria-label={props.label}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
      className="font-mono"
    />
  );
}

function CredentialDialog(props: { credential: TestCredential | null; environments: readonly TestEnvironment[]; readOnly: boolean; onClose: () => void }): React.JSX.Element {
  const source = props.credential;
  const [profile, setProfile] = useState(source?.profile ?? "");
  const [kind, setKind] = useState<CredentialInput["kind"]>(source?.kind ?? "login");
  const [environmentId, setEnvironmentId] = useState(source?.environmentId ?? SHARED);
  const [fields, setFields] = useState<KeyValueRow[]>(source ? recordToRows(source.fields) : [{ key: "username", value: "" }]);
  const [secrets, setSecrets] = useState<SecretRow[]>(
    source ? source.secretFieldNames.map((name) => ({ name, value: "", stored: true, remove: false })) : [{ name: "password", value: "", stored: false, remove: false }]
  );
  const [submitted, setSubmitted] = useState(false);

  const save = useTestAdminMutation(
    (getToken, body: CredentialInput) => (source ? testAdminApi.updateCredential(getToken, source.id, body) : testAdminApi.createCredential(getToken, body)),
    [testAdminKeys.credentials]
  );

  const fieldResult = rowsToRecord(fields, credentialFieldPattern, "Field");
  const secretErrors = secrets
    .filter((row) => !row.stored && (row.name || row.value))
    .flatMap((row) => (credentialFieldPattern.test(row.name) ? [] : [`Secret field "${row.name || "(empty)"}" is not a valid name.`]));
  const profileError = profilePattern.test(profile) ? undefined : "Upper-case letters, digits and underscores, starting with a letter.";
  const valid = !profileError && fieldResult.errors.length === 0 && secretErrors.length === 0;

  const updateSecret = (index: number, patch: Partial<SecretRow>) => setSecrets((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    setSubmitted(true);
    if (!valid || props.readOnly) return;
    const secretFields: Record<string, string | null> = {};
    for (const row of secrets) {
      if (row.stored && row.remove) secretFields[row.name] = null;
      else if (row.value.length > 0 && row.name) secretFields[row.name] = row.value;
    }
    await save.mutateAsync({ profile, kind, environmentId: environmentId === SHARED ? null : environmentId, fields: fieldResult.record, secretFields });
    setSecrets((current) => current.map((row) => ({ ...row, value: "" })));
    props.onClose();
  };

  const kindOptions = (source?.kind === "model_key" ? (["model_key", ...editableKinds] as const) : editableKinds).map((value) => ({ label: kindLabels[value], value }));

  return (
    <Dialog
      title={source ? (props.readOnly ? source.profile : `Edit ${source.profile}`) : "New credential"}
      description={source ? `Key version ${source.keyVersion} · last used ${source.lastUsedAt ? formatRelativeTime(source.lastUsedAt) : "never"}` : "Secret values are encrypted on the server and never shown again."}
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
              {save.isPending ? "Saving…" : "Save credential"}
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
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Profile" htmlFor="cred-profile" error={submitted ? profileError : undefined} className="sm:col-span-1">
              <Input id="cred-profile" value={profile} onChange={(event) => setProfile(event.target.value.toUpperCase())} className="font-mono" placeholder="PCF_HQ_ADMIN" />
            </Field>
            <Field label="Kind">
              <Select ariaLabel="Credential kind" value={kind} onValueChange={setKind} options={kindOptions} disabled={props.readOnly} />
            </Field>
            <Field label="Environment">
              <Select
                ariaLabel="Environment scope"
                value={environmentId}
                onValueChange={setEnvironmentId}
                disabled={props.readOnly}
                options={[{ label: "All environments", value: SHARED }, ...props.environments.map((environment) => ({ label: environment.name, value: environment.id }))]}
              />
            </Field>
          </div>

          <div className="grid gap-2">
            <span className="font-semibold uppercase tracking-[0.06em] text-muted-foreground">Public fields</span>
            <KeyValueEditor rows={fields} onChange={setFields} keyLabel="Field" valueLabel="Value" keyPlaceholder="username" valuePlaceholder="qa-admin@example.com" addLabel="Add public field" disabled={props.readOnly} />
            {fieldResult.errors.map((error) => (
              <p key={error} className="text-sm text-destructive">
                {error}
              </p>
            ))}
          </div>

          <div className="grid gap-2">
            <span className="font-semibold uppercase tracking-[0.06em] text-muted-foreground">Secret fields · write-only</span>
            {secrets.map((row, index) => (
              <div key={index} className={cn("grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.25rem] items-center gap-2", row.remove && "opacity-60")}>
                {row.stored ? (
                  <span className="flex h-10 items-center gap-1.5 rounded-md border border-border bg-muted px-3 font-mono text-sm">
                    <Lock className="size-3.5 text-muted-foreground" aria-hidden />
                    {row.name}
                  </span>
                ) : (
                  <Input aria-label={`Secret field name ${index + 1}`} value={row.name} placeholder="password" className="font-mono text-sm" onChange={(event) => updateSecret(index, { name: event.target.value })} />
                )}
                {props.readOnly ? (
                  <span className="flex h-10 items-center rounded-md border border-border bg-muted px-3 font-mono text-sm text-muted-foreground">{MASK}</span>
                ) : (
                  <SecretInput
                    label={row.stored ? `Replace ${row.name}` : `Value of secret field ${row.name || index + 1}`}
                    value={row.value}
                    disabled={row.remove}
                    placeholder={row.stored ? (row.remove ? "will be removed" : `${MASK} stored · type to replace`) : "value"}
                    onChange={(value) => updateSecret(index, { value })}
                  />
                )}
                {props.readOnly ? (
                  <span />
                ) : row.stored ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={row.remove ? `Keep ${row.name}` : `Remove ${row.name}`}
                    aria-pressed={row.remove}
                    onClick={() => updateSecret(index, { remove: !row.remove, value: "" })}
                  >
                    {row.remove ? <Undo2 aria-hidden /> : <Trash2 aria-hidden />}
                  </Button>
                ) : (
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove secret field ${row.name || index + 1}`} onClick={() => setSecrets((current) => current.filter((_row, rowIndex) => rowIndex !== index))}>
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </div>
            ))}
            {!props.readOnly ? (
              <div>
                <Button variant="ghost" size="xs" onClick={() => setSecrets((current) => [...current, { name: "", value: "", stored: false, remove: false }])}>
                  <Plus aria-hidden />
                  Add secret field
                </Button>
              </div>
            ) : null}
            {secretErrors.map((error) => (
              <p key={error} className="text-sm text-destructive">
                {error}
              </p>
            ))}
            <p className="text-sm text-muted-foreground">Stored values are never sent back to the browser. Leave a field empty to keep its value.</p>
          </div>
        </fieldset>
        <ErrorNote error={save.error} />
      </form>
    </Dialog>
  );
}

function RotateDialog(props: { credential: TestCredential; onClose: () => void }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const rotate = useTestAdminMutation(
    (getToken, secretFields: Record<string, string>) => testAdminApi.rotateCredential(getToken, props.credential.id, secretFields),
    [testAdminKeys.credentials]
  );
  const filled = Object.fromEntries(Object.entries(values).filter(([, value]) => value.length > 0));
  // Rotation replaces every secret field, so each one needs its new value.
  const complete = props.credential.secretFieldNames.every((field) => (values[field] ?? "").length > 0);
  const submit = async () => {
    if (!complete) return;
    await rotate.mutateAsync(filled);
    setValues({});
    props.onClose();
  };
  return (
    <Dialog
      title={`Rotate ${props.credential.profile}`}
      description="Enter a new value for every secret field. The old values are discarded and the credential is re-encrypted with the current key."
      onClose={props.onClose}
      size="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={rotate.isPending}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={rotate.isPending || !complete} onClick={() => void submit()}>
            {rotate.isPending ? "Rotating…" : "Rotate"}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {props.credential.secretFieldNames.map((field) => (
          <Field key={field} label={field} htmlFor={`rotate-${field}`}>
            <SecretInput id={`rotate-${field}`} label={`New ${field}`} value={values[field] ?? ""} placeholder={`new ${field}`} onChange={(value) => setValues((current) => ({ ...current, [field]: value }))} />
          </Field>
        ))}
        <ErrorNote error={rotate.error} />
      </form>
    </Dialog>
  );
}
