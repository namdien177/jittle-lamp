import React, { useState } from "react";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import type { TestTag } from "@jittle-lamp/shared";

import { Button } from "../../components/ui/button";
import { ConfirmDialog, SimpleDialog } from "../../components/ui/dialog";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { EmptyState } from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { testAdminApi, type TagInput } from "../../test-cases/admin-api";
import { testAdminKeys, useTestAdminMutation, useTestPermissions, useTestTags } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { groupTagsByNamespace, tagColors, tagLabel } from "../../test-config/config-ui";
import { Hint } from "../../components/ui/tooltip";

// Settings → Tags (design.md §7 "Organising thousands"): namespaced, organisation-managed tags.

const namespacePattern = /^[a-z][a-z0-9-]{0,30}$/;

export function SettingsTestTagsPage(): React.JSX.Element {
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const tags = useTestTags();
  const [editing, setEditing] = useState<TestTag | "new" | null>(null);
  const [deleting, setDeleting] = useState<TestTag | null>(null);
  const remove = useTestAdminMutation((getToken, tagId: string) => testAdminApi.deleteTag(getToken, tagId), [testAdminKeys.tags]);
  const groups = groupTagsByNamespace(tags.data ?? []);

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Tags"
        description="Namespaces (team, feature, module, prio) group the test-case sidebar like folders, without the single-parent limit."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              New tag
            </Button>
          ) : null
        }
        bodyClassName="p-0 pt-0"
      >
        <ErrorNote error={tags.error ?? remove.error} className="m-4" />
        {tags.isPending ? (
          <Skeleton className="m-4 h-32" />
        ) : groups.length === 0 ? (
          <EmptyState className="m-4" icon={<Tags aria-hidden />} title="No tags yet" description="Define team:, feature: and module: tags so cases group in the sidebar." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Tag</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-24">Cases</TableHead>
                <TableHead className="w-24 pr-4 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <React.Fragment key={group.namespace}>
                  <TableRow className="bg-muted/60 hover:bg-muted/60">
                    <TableCell colSpan={4} className="pl-4 font-mono text-xs font-medium text-muted-foreground">
                      {group.namespace || "free tags"} · {group.tags.length}
                    </TableCell>
                  </TableRow>
                  {group.tags.map((tag) => (
                    <TableRow key={tag.id}>
                      <TableCell className="pl-4">
                        <span className="inline-flex items-center gap-2 font-mono text-sm">
                          <span className="size-3 rounded-full border border-black/10" style={{ background: tag.color }} aria-hidden />
                          {tagLabel(tag)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{tag.description ?? "—"}</TableCell>
                      <TableCell className="tabular-nums">{tag.count}</TableCell>
                      <TableCell className="pr-4 text-right">
                        {canManage ? (
                          <div className="flex justify-end gap-1">
                            <Hint label="Edit">
                              <Button variant="ghost" size="icon-sm" aria-label={`Edit tag ${tagLabel(tag)}`} onClick={() => setEditing(tag)}>
                                <Pencil aria-hidden />
                              </Button>
                            </Hint>
                            <Hint label="Delete">
                              <Button variant="ghost" size="icon-sm" aria-label={`Delete tag ${tagLabel(tag)}`} onClick={() => setDeleting(tag)}>
                                <Trash2 aria-hidden />
                              </Button>
                            </Hint>
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        )}
      </AdminCard>
      {editing ? <TagDialog tag={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={`Delete ${deleting ? tagLabel(deleting) : "tag"}?`}
        description={deleting && deleting.count > 0 ? `${deleting.count} cases keep the tag text but lose its colour and description.` : "No case uses it."}
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

function TagDialog(props: { tag: TestTag | null; onClose: () => void }): React.JSX.Element {
  const source = props.tag;
  const [namespace, setNamespace] = useState(source?.namespace ?? "");
  const [name, setName] = useState(source?.name ?? "");
  const [color, setColor] = useState(source?.color ?? tagColors[0] ?? "#22c55e");
  const [description, setDescription] = useState(source?.description ?? "");
  const [submitted, setSubmitted] = useState(false);
  const save = useTestAdminMutation((getToken, body: TagInput) => (source ? testAdminApi.updateTag(getToken, source.id, body) : testAdminApi.createTag(getToken, body)), [testAdminKeys.tags]);
  const namespaceError = namespace === "" || namespacePattern.test(namespace) ? undefined : "Lowercase letters, digits and dashes, or empty for a free tag.";
  const nameError = name.trim().length > 0 ? undefined : "Enter a name.";

  const submit = async () => {
    setSubmitted(true);
    if (namespaceError || nameError) return;
    await save.mutateAsync({ namespace, name: name.trim(), color, description: description.trim() ? description.trim() : null });
    props.onClose();
  };

  return (
    <SimpleDialog
      title={source ? `Edit ${tagLabel(source)}` : "New tag"}
      onClose={props.onClose}
      size="md"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={props.onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={save.isPending} onClick={() => void submit()}>
            {save.isPending ? "Saving…" : "Save tag"}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Namespace" htmlFor="tag-namespace" error={submitted ? namespaceError : undefined} hint="team, feature, module, prio…">
            <Input id="tag-namespace" value={namespace} onChange={(event) => setNamespace(event.target.value.trim().toLowerCase())} className="font-mono" placeholder="feature" />
          </Field>
          <Field label="Name" htmlFor="tag-name" error={submitted ? nameError : undefined}>
            <Input id="tag-name" value={name} onChange={(event) => setName(event.target.value)} className="font-mono" placeholder="login" maxLength={60} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-2 font-medium text-muted-foreground">Colour</legend>
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Tag colour">
            {tagColors.map((swatch) => (
              <button
                key={swatch}
                type="button"
                role="radio"
                aria-checked={color === swatch}
                aria-label={`Colour ${swatch}`}
                onClick={() => setColor(swatch)}
                className={cn("size-7 rounded-full border-2", pressable, color === swatch ? "border-foreground" : "border-transparent")}
                style={{ background: swatch }}
              />
            ))}
            <label className="ml-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
              Custom
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#22c55e"} onChange={(event) => setColor(event.target.value)} aria-label="Custom colour" className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent" />
            </label>
          </div>
        </fieldset>
        <Field label="Description" htmlFor="tag-description">
          <Input id="tag-description" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} />
        </Field>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Preview
          <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-xs text-foreground">
            <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden />
            {tagLabel({ namespace, name: name || "name" })}
          </span>
        </p>
        <ErrorNote error={save.error} />
      </form>
    </SimpleDialog>
  );
}
