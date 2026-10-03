import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { DuplicateTestCaseRequest, TestCaseDetail } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SimpleDialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import { useAuth } from "../auth";
import { testAdminApi } from "./admin-api";
import { testAdminKeys, useActiveOrgId, useTestAdminMutation, useTestPermissions } from "./admin-queries";
import { ErrorNote, ReadOnlyNotice, ReplacementPreview, Toggle, pressable } from "./admin-ui";
import {
  activeReplacements,
  applyReplacements,
  countReplacements,
  defaultDuplicateTitle,
  duplicateTitleForRequest,
  estimateInheritedSteps,
  parseTagInput,
  replacementSegments,
  type Replacement
} from "./duplicate/find-replace";
import { caseEditorHref } from "./review/review-queue-state";
import { Hint } from "../components/ui/tooltip";

// Duplicate dialog (design.md §7 "Duplicate"). The test-cases page renders it for `?duplicate=<id,id>`
// (and the `d` key); other screens can render it directly with `caseIds`.

type DuplicateResult = { sourceId: string; sourceKey: string; newId: string; newKey: string; title: string; inheritedScripts: number } | { sourceId: string; sourceKey: string; error: string };

export function DuplicateTestCaseDialog(props: { caseIds: readonly string[]; onClose: () => void; onDuplicated?: (results: DuplicateResult[]) => void }): React.JSX.Element {
  const auth = useAuth();
  const orgId = useActiveOrgId();
  const permissions = useTestPermissions();
  const canCreate = permissions.can("test_case.create");
  const getToken = () => auth.getToken();
  const sourcesQuery = useQueries({
    queries: props.caseIds.map((caseId) => ({
      queryKey: testAdminKeys.testCase(orgId, caseId),
      queryFn: () => testAdminApi.getTestCase(getToken, caseId),
      enabled: Boolean(orgId)
    }))
  });
  const sources = sourcesQuery.map((query) => query.data).filter((source): source is TestCaseDetail => Boolean(source));
  const loading = sourcesQuery.some((query) => query.isPending);
  const loadError = sourcesQuery.find((query) => query.error)?.error ?? null;
  const single = props.caseIds.length === 1;
  const first = sources[0] ?? null;

  const [typedTitle, setTypedTitle] = useState<string | null>(null);
  const [tagsInput, setTagsInput] = useState("");
  const [rows, setRows] = useState<Replacement[]>([{ find: "", replace: "" }]);
  const [copy, setCopy] = useState({ links: true, tags: true, environment: true, datasets: true });
  const [mode, setMode] = useState<"copy" | "variant">("copy");
  const [inheritScripts, setInheritScripts] = useState(true);
  const [results, setResults] = useState<DuplicateResult[] | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);

  // Default tags once the sources load. The title stays derived until the user types one.
  const firstId = first?.id ?? null;
  useEffect(() => {
    if (!first) return;
    setTagsInput(first.tags.join(", "));
  }, [firstId]);

  const replacements = activeReplacements(rows);
  const title = typedTitle ?? (first ? defaultDuplicateTitle(first.title, replacements) : "");
  const previewSource = sources[Math.min(previewIndex, sources.length - 1)] ?? null;
  const preview = useMemo(() => {
    if (!previewSource) return null;
    const next = applyReplacements(previewSource.transcript, replacements);
    return {
      segments: replacementSegments(previewSource.transcript, replacements),
      changes: countReplacements(previewSource.transcript, replacements) + countReplacements(previewSource.title, replacements),
      estimate: estimateInheritedSteps(previewSource.transcript, next)
    };
  }, [previewSource, JSON.stringify(replacements)]);

  const duplicate = useTestAdminMutation(
    async (token, input: { source: TestCaseDetail; body: DuplicateTestCaseRequest }) => testAdminApi.duplicateTestCase(token, input.source.id, input.body),
    [testAdminKeys.cases]
  );

  const submit = async () => {
    const tags = parseTagInput(tagsInput);
    const collected: DuplicateResult[] = [];
    for (const source of sources) {
      const body: DuplicateTestCaseRequest = {
        ...withTitle(duplicateTitleForRequest({ single, edited: typedTitle !== null, title })),
        replacements,
        copy,
        mode,
        inheritScripts,
        ...(single && copy.tags ? { tags } : {})
      };
      try {
        const response = await duplicate.mutateAsync({ source, body });
        collected.push({
          sourceId: source.id,
          sourceKey: source.key,
          newId: response.testCase.id,
          newKey: response.testCase.key,
          title: response.testCase.title,
          inheritedScripts: response.inheritedScripts
        });
      } catch (error) {
        collected.push({ sourceId: source.id, sourceKey: source.key, error: error instanceof Error ? error.message : "Duplicate failed." });
      }
    }
    setResults(collected);
    props.onDuplicated?.(collected);
  };

  const updateRow = (index: number, patch: Partial<Replacement>) => setRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  const busy = duplicate.isPending;
  const titleLabel = single ? (first ? `Duplicate ${first.key}` : "Duplicate test case") : `Duplicate ${props.caseIds.length} test cases`;

  if (results) {
    const ok = results.filter((result): result is Extract<DuplicateResult, { newId: string }> => "newId" in result);
    const failed = results.filter((result): result is Extract<DuplicateResult, { error: string }> => "error" in result);
    const inherited = ok.reduce((sum, result) => sum + result.inheritedScripts, 0);
    return (
      <SimpleDialog
        title={ok.length === 1 ? `Created ${ok[0]?.newKey}` : `Created ${ok.length} cases`}
        description={`${inherited} step script${inherited === 1 ? "" : "s"} inherited. Those steps replay on the first run instead of calling the agent.`}
        onClose={props.onClose}
        size="md"
        footer={
          <Button size="sm" onClick={props.onClose}>
            Done
          </Button>
        }
      >
        <ul className="grid gap-2">
          {ok.map((result) => (
            <li key={result.newId} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span className="min-w-0">
                <Link to={caseEditorHref(result.newId)} onClick={props.onClose} className="font-mono text-xs text-primary hover:underline">
                  {result.newKey}
                </Link>{" "}
                <span className="text-foreground">{result.title}</span>
                <span className="block text-xs text-muted-foreground">from {result.sourceKey}</span>
              </span>
              <Badge variant={result.inheritedScripts > 0 ? "success" : "muted"}>{result.inheritedScripts} scripts inherited</Badge>
            </li>
          ))}
          {failed.map((result) => (
            <li key={result.sourceId} className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {result.sourceKey}: {result.error}
            </li>
          ))}
        </ul>
      </SimpleDialog>
    );
  }

  return (
    <SimpleDialog
      title={titleLabel}
      description={single ? undefined : "The same find/replace and options apply to every selected case. Each copy takes the replaced title, or “<title> (copy)” when the replacements leave it unchanged."}
      onClose={props.onClose}
      size="xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" className={pressable} disabled={!canCreate || busy || loading || sources.length === 0 || (single && title.trim().length === 0)} onClick={() => void submit()}>
            {busy ? "Duplicating…" : single ? "Duplicate" : `Duplicate ${sources.length}`}
          </Button>
        </>
      }
    >
      {!canCreate && !permissions.loading ? <ReadOnlyNotice permission="test_case.create" /> : null}
      <ErrorNote error={loadError} />
      {loading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <form
          className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="grid content-start gap-4">
            {single ? (
              <Field label="New title" htmlFor="duplicate-title">
                <Input id="duplicate-title" value={title} onChange={(event) => setTypedTitle(event.target.value)} maxLength={300} />
              </Field>
            ) : null}
            {single ? (
              <Field label="Tags" htmlFor="duplicate-tags" hint="Comma separated">
                <Input id="duplicate-tags" value={tagsInput} disabled={!copy.tags} onChange={(event) => setTagsInput(event.target.value)} />
              </Field>
            ) : null}

            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium text-muted-foreground">Find → replace</legend>
              {rows.map((row, index) => (
                <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.25rem] gap-2">
                  <Input aria-label={`Find ${index + 1}`} placeholder="HQ_ADMIN" value={row.find} className="font-mono text-sm" onChange={(event) => updateRow(index, { find: event.target.value })} />
                  <Input aria-label={`Replace ${index + 1}`} placeholder="BRANCH_ADMIN" value={row.replace} className="font-mono text-sm" onChange={(event) => updateRow(index, { replace: event.target.value })} />
                  <Hint label="Remove">
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove replacement ${index + 1}`} onClick={() => setRows((current) => (current.length === 1 ? [{ find: "", replace: "" }] : current.filter((_row, rowIndex) => rowIndex !== index)))}>
                      <Trash2 aria-hidden />
                    </Button>
                  </Hint>
                </div>
              ))}
              <div>
                <Button variant="ghost" size="xs" onClick={() => setRows((current) => [...current, { find: "", replace: "" }])}>
                  <Plus aria-hidden />
                  Add replacement
                </Button>
              </div>
            </fieldset>

            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium text-muted-foreground">Copy</legend>
              <div className="grid grid-cols-2 gap-2">
                <Toggle label="Links" checked={copy.links} onChange={(links) => setCopy((current) => ({ ...current, links }))} />
                <Toggle label="Tags" checked={copy.tags} onChange={(tags) => setCopy((current) => ({ ...current, tags }))} />
                <Toggle label="Environment" checked={copy.environment} onChange={(environment) => setCopy((current) => ({ ...current, environment }))} />
                <Toggle label="Datasets" checked={copy.datasets} onChange={(datasets) => setCopy((current) => ({ ...current, datasets }))} />
              </div>
            </fieldset>

            <fieldset className="grid gap-2" role="radiogroup">
              <legend className="mb-1 font-medium text-muted-foreground">Mode</legend>
              {(
                [
                  ["copy", "Independent copy", "A new case with its own steps."],
                  ["variant", "Variant", "Linked with Duplicate-of; the source shows it as a derived case."]
                ] as const
              ).map(([value, label, description]) => (
                <label key={value} className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2", mode === value ? "border-primary/50 bg-primary/8" : "border-border")}>
                  <input type="radio" name="duplicate-mode" className="mt-1 accent-[var(--primary)]" checked={mode === value} onChange={() => setMode(value)} />
                  <span>
                    <span className="block font-medium text-foreground">{label}</span>
                    <span className="block text-sm text-muted-foreground">{description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <Toggle
              label="Inherit step scripts"
              description="Steps whose instruction is unchanged reuse the source's cached scripts, so the first run replays them."
              checked={inheritScripts}
              onChange={setInheritScripts}
            />
          </div>

          <div className="grid content-start gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-muted-foreground">Preview</p>
              {!single && sources.length > 1 ? (
                <div className="flex flex-wrap gap-1" role="tablist" aria-label="Preview case">
                  {sources.map((source, index) => (
                    <button
                      key={source.id}
                      type="button"
                      role="tab"
                      aria-selected={index === previewIndex}
                      className={cn("rounded-md border px-2 py-0.5 font-mono text-xs", pressable, index === previewIndex ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground")}
                      onClick={() => setPreviewIndex(index)}
                    >
                      {source.key}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            {preview && previewSource ? (
              <>
                <ReplacementPreview segments={preview.segments} label={`Transcript of the copy of ${previewSource.key}`} />
                <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
                  {preview.changes} replacement{preview.changes === 1 ? "" : "s"}.{" "}
                  {inheritScripts ? (
                    <>
                      <span className="font-semibold text-foreground">
                        {preview.estimate.unchanged} of {preview.estimate.total}
                      </span>{" "}
                      steps unchanged → they can inherit {previewSource.key}'s scripts ({previewSource.stats.cachedSteps} cached).
                    </>
                  ) : (
                    "Scripts are not inherited; every step runs through the agent on the first run."
                  )}
                </p>
              </>
            ) : null}
          </div>
        </form>
      )}
    </SimpleDialog>
  );
}

function withTitle(title: string | undefined): { title?: string } {
  return title === undefined ? {} : { title };
}
