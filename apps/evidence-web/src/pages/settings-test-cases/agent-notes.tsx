import React, { useEffect, useState } from "react";
import { NotebookPen } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/misc";
import { cn } from "../../lib/cn";
import { useOrganizationMembers } from "../../queries";
import { useToast } from "../../toast";
import { formatRelativeTime } from "../../utils";
import { testAdminApi } from "../../test-cases/admin-api";
import { testAdminKeys, useActiveOrgId, useAgentNotes, useTestAdminMutation, useTestPermissions } from "../../test-cases/admin-queries";
import { AdminCard, ErrorNote, ReadOnlyNotice, pressable } from "../../test-cases/admin-ui";
import { notesBudget } from "../../test-config/webhook-ui";

// Settings → Agent notes (phase 2 unit 2.4): organisation memory for the agent. The runner puts
// these notes before each environment's agent instructions on every run.

export function SettingsTestAgentNotesPage(): React.JSX.Element {
  const toast = useToast();
  const permissions = useTestPermissions();
  const canManage = permissions.can("test_config.manage");
  const notes = useAgentNotes();
  const orgId = useActiveOrgId();
  const members = useOrganizationMembers(orgId, { limit: 200 });
  const [text, setText] = useState("");
  const save = useTestAdminMutation((getToken, value: string) => testAdminApi.saveAgentNotes(getToken, value), [testAdminKeys.agentNotes]);
  const budget = notesBudget(text);
  const dirty = notes.data ? text !== notes.data.notes : false;

  useEffect(() => {
    if (notes.data) setText(notes.data.notes);
  }, [notes.data]);

  const author = notes.data?.updatedBy ? members.data?.members.find((member) => member.userId === notes.data?.updatedBy) : null;
  const authorName = author ? author.displayName || author.email || "a member" : notes.data?.updatedBy ? "a former member" : null;

  const submit = async () => {
    if (budget.over) return;
    await save.mutateAsync(text);
    toast.success("Agent notes saved", "Runs that start from now on use them.");
  };

  return (
    <div className="grid gap-4">
      {!canManage && !permissions.loading ? <ReadOnlyNotice permission="test_config.manage" /> : null}
      <AdminCard
        title="Agent notes"
        description="What every run's agent should know about your apps: naming rules, banners to dismiss, records it must not touch. Put before each environment's own instructions."
        actions={
          canManage ? (
            <Button size="sm" className={pressable} disabled={!dirty || budget.over || save.isPending} onClick={() => void submit()}>
              {save.isPending ? "Saving…" : "Save notes"}
            </Button>
          ) : null
        }
      >
        <ErrorNote error={notes.error ?? save.error} />
        {notes.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <div className="grid gap-2">
            <label htmlFor="agent-notes" className="sr-only">
              Agent notes
            </label>
            <Textarea
              id="agent-notes"
              value={text}
              readOnly={!canManage}
              onChange={(event) => setText(event.target.value)}
              rows={14}
              spellCheck
              className="font-mono text-[13px] leading-relaxed"
              placeholder={"Records created by tests start with E2E-.\nDismiss the cookie banner before anything else.\nNever delete or archive existing records."}
              aria-describedby="agent-notes-meta"
            />
            <div id="agent-notes-meta" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className={cn("font-mono text-xs", budget.over ? "font-semibold text-destructive" : budget.remaining < 1024 ? "text-warning" : undefined)} aria-live="polite">
                {budget.label}
              </span>
              <span className="flex items-center gap-1.5">
                <NotebookPen className="size-3.5" aria-hidden />
                {notes.data?.updatedAt ? `Last updated ${formatRelativeTime(notes.data.updatedAt)}${authorName ? ` by ${authorName}` : ""}` : "Never saved"}
              </span>
              {dirty ? <span className="text-warning">Unsaved changes</span> : null}
            </div>
            {budget.over ? (
              <p role="alert" className="text-sm text-destructive">
                Notes are limited to 16 KB. Shorten them by {Math.abs(budget.remaining).toLocaleString("en-US")} bytes.
              </p>
            ) : null}
          </div>
        )}
      </AdminCard>
    </div>
  );
}
