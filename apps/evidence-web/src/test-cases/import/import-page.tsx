import React, { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { FileSpreadsheet, FileText, ListChecks, Ticket, Upload } from "lucide-react";
import { lintTestCase, parseTranscriptDocument, type CreateImportRequest } from "@jittle-lamp/shared";

import { PageBody, PageHeader } from "../../components/page";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Field } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { SimpleSelect } from "../../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table";
import { cn } from "../../lib/cn";
import { testAdminApi } from "../admin-api";
import { testAdminKeys, useTestAdminMutation, useTestCredentials, useTestEnvironments, useTestPermissions } from "../admin-queries";
import { AdminCard, ErrorNote, LintBadge, LintFindingList, ReadOnlyNotice, TranscriptView, pressable } from "../admin-ui";
import { parseTagInput } from "../duplicate/find-replace";
import { lintCounts } from "./batch-state";
import { parseCsv, rowsToRecords, type TabularData } from "./csv";
import { gherkinToTranscript } from "./gherkin";
import {
  guessImportMapping,
  importFieldHints,
  importFieldLabels,
  importFields,
  mappingIsUsable,
  previewMappedRows,
  toImportMapping,
  type ImportField,
  type ImportFieldMapping
} from "./mapping";
import { bytesToBase64, readXlsxRows } from "./xlsx";

// Import wizard (design.md §7 "Import pipeline"): source → map and preview → batch page.

type SourceKind = "transcript-doc" | "gherkin" | "table" | "jira";

const sources: Array<{ kind: SourceKind; label: string; detail: string; icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }> }> = [
  { kind: "transcript-doc", label: "Transcript document", detail: ".md, one or many cases", icon: FileText },
  { kind: "gherkin", label: "Gherkin", detail: ".feature scenarios", icon: ListChecks },
  { kind: "table", label: "Spreadsheet", detail: ".csv or .xlsx with column mapping", icon: FileSpreadsheet },
  { kind: "jira", label: "Jira", detail: "Issues by JQL", icon: Ticket }
];

const NONE = "__none__";

type LoadedTable = { fileName: string; format: "csv" | "xlsx"; content: string; data: TabularData };

function Stepper(props: { step: 1 | 2 | 3; labels: [string, string, string] }): React.JSX.Element {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-sm" aria-label="Import steps">
      {props.labels.map((label, index) => {
        const number = index + 1;
        const state = number < props.step ? "done" : number === props.step ? "current" : "next";
        return (
          <li
            key={label}
            aria-current={state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-md border px-3 py-1.5",
              state === "current" && "border-primary/40 bg-primary/10 font-semibold text-foreground",
              state === "done" && "border-border text-foreground",
              state === "next" && "border-border text-muted-foreground"
            )}
          >
            <span className="font-mono text-xs">{number}</span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

function UploadButton(props: { label: string; accept: string; ariaLabel: string; onPick: (file: File | undefined) => void }): React.JSX.Element {
  return (
    <label
      className={cn(
        "inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-secondary px-3 text-sm font-semibold hover:bg-muted focus-within:ring-2 focus-within:ring-ring/55",
        pressable
      )}
    >
      <Upload className="size-4" aria-hidden />
      {props.label}
      <input type="file" className="sr-only" accept={props.accept} aria-label={props.ariaLabel} onChange={(event) => props.onPick(event.target.files?.[0])} />
    </label>
  );
}

export function TestCaseImportPage(): React.JSX.Element {
  const navigate = useNavigate();
  const permissions = useTestPermissions();
  const canImport = permissions.can("test_case.create");
  const environments = useTestEnvironments();
  const credentials = useTestCredentials();
  const jiraCredentials = (credentials.data ?? []).filter((credential) => credential.kind === "jira");

  const [kind, setKind] = useState<SourceKind>("transcript-doc");
  const [step, setStep] = useState<1 | 2>(1);
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<LoadedTable | null>(null);
  const [mapping, setMapping] = useState<ImportFieldMapping>({});
  const [tagsInput, setTagsInput] = useState("");
  const [environmentId, setEnvironmentId] = useState<string>(NONE);
  const [jql, setJql] = useState("");
  const [jiraCredentialId, setJiraCredentialId] = useState<string>(NONE);
  const [previewRow, setPreviewRow] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);

  const defaultTags = useMemo(() => parseTagInput(tagsInput), [tagsInput]);
  const createImport = useTestAdminMutation((getToken, body: CreateImportRequest) => testAdminApi.createImport(getToken, body), [testAdminKeys.cases]);

  const documentPreview = useMemo(() => {
    if (kind !== "transcript-doc" && kind !== "gherkin") return null;
    const source = kind === "gherkin" ? gherkinToTranscript(text).document : text;
    const parsed = parseTranscriptDocument(source);
    return {
      diagnostics: parsed.diagnostics,
      cases: parsed.cases.map((testCase) => ({ title: testCase.title, steps: testCase.steps.length, lint: lintTestCase(testCase) }))
    };
  }, [kind, text]);

  const tablePreview = useMemo(() => (table ? previewMappedRows(table.data.records, mapping, { defaultTags, limit: 50 }) : []), [table, mapping, defaultTags]);

  const onPickFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    try {
      if (kind === "table") {
        if (/\.xlsx$/i.test(file.name)) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const data = rowsToRecords(readXlsxRows(bytes));
          setTable({ fileName: file.name, format: "xlsx", content: bytesToBase64(bytes), data });
          setMapping(guessImportMapping(data.headers));
        } else {
          const content = await file.text();
          const data = rowsToRecords(parseCsv(content));
          setTable({ fileName: file.name, format: "csv", content, data });
          setMapping(guessImportMapping(data.headers));
        }
        setPreviewRow(0);
        setStep(1);
      } else {
        setText(await file.text());
        setFileName(file.name);
      }
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read the file.");
    }
  };

  const selectKind = (next: SourceKind) => {
    setKind(next);
    setStep(1);
    setFileError(null);
    setText("");
    setFileName(null);
    setTable(null);
  };

  const canSubmit =
    canImport &&
    !createImport.isPending &&
    (kind === "table"
      ? Boolean(table && table.data.records.length > 0) && mappingIsUsable(mapping) && step === 2
      : kind === "jira"
        ? jql.trim().length > 0 && jiraCredentialId !== NONE
        : (documentPreview?.cases.length ?? 0) > 0);

  const submit = async () => {
    const common = { defaultTags, environmentId: environmentId === NONE ? null : environmentId };
    let body: CreateImportRequest;
    if (kind === "table" && table) {
      body = { sourceKind: table.format, content: table.content, fileName: table.fileName, mapping: toImportMapping(mapping), ...common };
    } else if (kind === "jira") {
      body = { sourceKind: "jira", jql: jql.trim(), jiraCredentialId, ...common };
    } else {
      body = { sourceKind: kind === "gherkin" ? "gherkin" : "transcript-doc", content: text, fileName: fileName ?? (kind === "gherkin" ? "pasted.feature" : "pasted.transcript.md"), ...common };
    }
    const batchId = await createImport.mutateAsync(body);
    navigate(`/test-cases/import/${encodeURIComponent(batchId)}`);
  };

  const environmentOptions = [{ label: "No environment", value: NONE }, ...(environments.data ?? []).map((environment) => ({ label: environment.name, value: environment.id }))];
  const selectedPreview = tablePreview[previewRow] ?? tablePreview[0] ?? null;
  const wizardStep: 1 | 2 = kind === "table" ? step : text.trim() || kind === "jira" ? 2 : 1;

  return (
    <>
      <PageHeader
        eyebrow={
          <Link to="/test-cases" className="hover:text-foreground">
            Test cases
          </Link>
        }
        title="Import test cases"
        description="Every import becomes transcript documents with lint and duplicate checks. Imported cases land in the review queue."
        actions={
          <Link to="/test-cases/review" className="text-sm font-semibold text-primary hover:underline">
            Open review queue
          </Link>
        }
      />
      <PageBody className="max-w-6xl">
        <Stepper step={wizardStep} labels={["Source", kind === "table" ? "Map & preview" : "Preview", "Batch"]} />
        {!canImport && !permissions.loading ? <ReadOnlyNotice permission="test_case.create" /> : null}

        <div role="radiogroup" aria-label="Import source" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {sources.map((source) => {
            const Icon = source.icon;
            const active = source.kind === kind;
            return (
              <button
                key={source.kind}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => selectKind(source.kind)}
                className={cn(
                  "flex items-start gap-3 rounded-md border bg-card px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/55",
                  pressable,
                  active ? "border-primary/50 bg-primary/8 shadow-soft" : "border-border hover:border-border-strong"
                )}
              >
                <Icon className={cn("mt-0.5 size-5 shrink-0", active ? "text-primary" : "text-muted-foreground")} aria-hidden />
                <span>
                  <span className="block font-semibold text-foreground">{source.label}</span>
                  <span className="block text-sm text-muted-foreground">{source.detail}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="grid min-w-0 content-start gap-4">
            {kind === "jira" ? (
              <AdminCard title="Jira issues" description="Acceptance criteria and description go through AI generation. The Jira key becomes a link and the external id.">
                <div className="grid gap-4">
                  <Field label="Jira credential" hint={jiraCredentials.length === 0 ? "Add a credential of kind jira in Testing settings → Credentials." : undefined}>
                    <SimpleSelect
                      ariaLabel="Jira credential"
                      value={jiraCredentialId}
                      onValueChange={setJiraCredentialId}
                      options={[
                        { label: jiraCredentials.length ? "Choose a credential" : "No Jira credential", value: NONE },
                        ...jiraCredentials.map((credential) => ({ label: credential.profile, value: credential.id }))
                      ]}
                    />
                  </Field>
                  <Field label="JQL" htmlFor="import-jql">
                    <Textarea
                      id="import-jql"
                      value={jql}
                      onChange={(event) => setJql(event.target.value)}
                      placeholder='project = PCF AND labels = "e2e" AND status = "Ready for QA"'
                      className="font-mono text-sm"
                    />
                  </Field>
                </div>
              </AdminCard>
            ) : kind === "table" ? (
              <TableSource
                table={table}
                mapping={mapping}
                onMappingChange={setMapping}
                onPickFile={(file) => void onPickFile(file)}
                fileError={fileError}
                step={step}
                onContinue={() => setStep(2)}
                onBack={() => setStep(1)}
                preview={tablePreview}
                previewRow={previewRow}
                onPreviewRow={setPreviewRow}
              />
            ) : (
              <AdminCard
                title={kind === "gherkin" ? "Gherkin feature" : "Transcript document"}
                description={
                  kind === "gherkin"
                    ? "Given and When become [Act], Then becomes [Assert], Background runs first, Scenario Outline examples become a dataset."
                    : "A level-1 heading starts a case; metadata lines (Key, Tags, Env, Links, Params) follow the title."
                }
                actions={
                  <UploadButton
                    label="Upload file"
                    accept={kind === "gherkin" ? ".feature,.txt" : ".md,.markdown,.txt"}
                    ariaLabel={kind === "gherkin" ? "Upload a .feature file" : "Upload a transcript document"}
                    onPick={(file) => void onPickFile(file)}
                  />
                }
              >
                <div className="grid gap-3">
                  {fileName ? (
                    <p className="text-sm text-muted-foreground">
                      Loaded <span className="font-mono">{fileName}</span>
                    </p>
                  ) : null}
                  <ErrorNote error={fileError} />
                  <Textarea
                    aria-label={kind === "gherkin" ? "Feature file contents" : "Transcript document"}
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={12}
                    className="font-mono text-sm"
                    placeholder={
                      kind === "gherkin"
                        ? "Feature: Parent portal login\n\n  Scenario: …\n    Given …\n    When …\n    Then …"
                        : "# HQ admin logout returns a clean login form\nTags: team:qa-pcf, feature:login\n\n[Open] /login\n[Login: PCF_HQ_ADMIN] sign in\n…"
                    }
                  />
                  {documentPreview && text.trim() ? <DocumentPreview preview={documentPreview} /> : null}
                </div>
              </AdminCard>
            )}
          </div>

          <aside className="grid content-start gap-4">
            <AdminCard title="Options">
              <div className="grid gap-4">
                <Field label="Default tags" htmlFor="import-tags" hint="Comma separated, added to every case">
                  <Input id="import-tags" value={tagsInput} onChange={(event) => setTagsInput(event.target.value)} placeholder="team:qa-pcf, import:sheet" />
                </Field>
                <Field label="Environment">
                  <SimpleSelect ariaLabel="Environment for imported cases" value={environmentId} onValueChange={setEnvironmentId} options={environmentOptions} />
                </Field>
                <ErrorNote error={createImport.error} />
                <Button className={pressable} disabled={!canSubmit} onClick={() => void submit()}>
                  {createImport.isPending ? "Starting import…" : "Start import"}
                </Button>
                <p className="text-sm text-muted-foreground">The batch parses in the background. You decide create, update, skip or merge per row before anything is committed.</p>
              </div>
            </AdminCard>
          </aside>
        </div>

        {kind === "table" && step === 2 && selectedPreview ? (
          <AdminCard title={`Row ${selectedPreview.ordinal} as a transcript`} description="Preview only. Free-text steps may be split by the model on import; the lint stays the guard.">
            <TranscriptView transcript={selectedPreview.transcript} findings={selectedPreview.lint} label={`Transcript preview of row ${selectedPreview.ordinal}`} />
          </AdminCard>
        ) : null}
      </PageBody>
    </>
  );
}

function DocumentPreview(props: {
  preview: { diagnostics: Array<{ line: number; code: string; message: string }>; cases: Array<{ title: string; steps: number; lint: ReturnType<typeof lintTestCase> }> };
}): React.JSX.Element {
  const { preview } = props;
  return (
    <div className="grid gap-2">
      <p className="text-sm font-semibold text-foreground">
        {preview.cases.length} case{preview.cases.length === 1 ? "" : "s"} found
      </p>
      {preview.diagnostics.length > 0 ? (
        <ul className="text-sm text-warning">
          {preview.diagnostics.map((diagnostic) => (
            <li key={`${diagnostic.line}-${diagnostic.code}`}>
              L{diagnostic.line}: {diagnostic.message}
            </li>
          ))}
        </ul>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">#</TableHead>
            <TableHead>Title</TableHead>
            <TableHead className="w-20">Steps</TableHead>
            <TableHead className="w-28">Lint</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preview.cases.slice(0, 50).map((testCase, index) => {
            const counts = lintCounts(testCase.lint);
            return (
              <TableRow key={index}>
                <TableCell className="font-mono text-xs">{index + 1}</TableCell>
                <TableCell>
                  <span className="font-medium">{testCase.title || <em className="text-muted-foreground">untitled</em>}</span>
                  <LintFindingList findings={testCase.lint.filter((finding) => finding.severity !== "info").slice(0, 3)} className="mt-1" />
                </TableCell>
                <TableCell className="tabular-nums">{testCase.steps}</TableCell>
                <TableCell>
                  <LintBadge errors={counts.errors} warnings={counts.warnings} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TableSource(props: {
  table: LoadedTable | null;
  mapping: ImportFieldMapping;
  onMappingChange: (mapping: ImportFieldMapping) => void;
  onPickFile: (file: File | undefined) => void;
  fileError: string | null;
  step: 1 | 2;
  onContinue: () => void;
  onBack: () => void;
  preview: ReturnType<typeof previewMappedRows>;
  previewRow: number;
  onPreviewRow: (index: number) => void;
}): React.JSX.Element {
  const { table, mapping } = props;
  const columnOptions = [{ label: "Not mapped", value: NONE }, ...(table?.data.headers ?? []).map((header) => ({ label: header, value: header }))];
  const setField = (field: ImportField, column: string) => {
    const next: ImportFieldMapping = { ...mapping };
    if (column === NONE) delete next[field];
    else next[field] = column;
    props.onMappingChange(next);
  };
  const problems = props.preview.filter((row) => row.problem).length;
  const withLintErrors = props.preview.filter((row) => lintCounts(row.lint).errors > 0).length;

  return (
    <>
      <AdminCard
        title="Spreadsheet"
        description="The first row is the header. CSV (comma, semicolon or tab) and .xlsx (first sheet) are supported."
        actions={<UploadButton label={table ? "Replace file" : "Choose file"} accept=".csv,.tsv,.txt,.xlsx" ariaLabel="Upload a CSV or XLSX file" onPick={props.onPickFile} />}
      >
        <ErrorNote error={props.fileError} />
        {table ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-foreground">{table.fileName}</span> · {table.data.records.length.toLocaleString()} rows · {table.data.headers.length} columns
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Choose a file to map its columns.</p>
        )}
      </AdminCard>

      {table ? (
        <AdminCard
          title="Map columns"
          description="Which column feeds which field. Steps become [Act] lines, expected results become [Assert] lines under a checkpoint."
          actions={
            props.step === 1 ? (
              <Button size="sm" className={pressable} disabled={!mappingIsUsable(mapping)} onClick={props.onContinue}>
                Preview rows
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={props.onBack}>
                Edit mapping
              </Button>
            )
          }
        >
          <div className="grid gap-2 sm:grid-cols-2">
            {importFields.map((field) => (
              <div key={field} className="grid grid-cols-[8.5rem_minmax(0,1fr)] items-center gap-3 rounded-md border border-border px-3 py-2">
                <div>
                  <p className="text-sm font-semibold text-foreground">{importFieldLabels[field]}</p>
                  <p className="text-xs text-muted-foreground">{importFieldHints[field]}</p>
                </div>
                <SimpleSelect
                  size="sm"
                  ariaLabel={`Column for ${importFieldLabels[field]}`}
                  value={mapping[field] ?? NONE}
                  onValueChange={(value) => setField(field, value)}
                  options={columnOptions}
                  disabled={props.step === 2}
                />
              </div>
            ))}
          </div>
          {!mappingIsUsable(mapping) ? <p className="mt-3 text-sm text-warning">Map a title column and at least one of preconditions, steps or expected.</p> : null}
        </AdminCard>
      ) : null}

      {table && props.step === 2 ? (
        <AdminCard
          title="Preview"
          description={`First ${props.preview.length} of ${table.data.records.length.toLocaleString()} rows. Duplicate matching runs on the server after you start the import.`}
          actions={
            <div className="flex gap-2">
              {problems > 0 ? <Badge variant="danger">{problems} cannot import</Badge> : null}
              {withLintErrors > 0 ? <Badge variant="warning">{withLintErrors} with lint errors</Badge> : null}
            </div>
          }
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Title</TableHead>
                <TableHead className="w-28">External id</TableHead>
                <TableHead className="w-16">Steps</TableHead>
                <TableHead className="w-28">Lint</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {props.preview.map((row, index) => {
                const counts = lintCounts(row.lint);
                const selected = index === props.previewRow;
                return (
                  <TableRow key={row.ordinal} className={cn(selected && "bg-primary/8")}>
                    <TableCell className="font-mono text-xs">{row.ordinal}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        aria-pressed={selected}
                        className="text-left font-medium hover:underline"
                        onClick={() => props.onPreviewRow(index)}
                        aria-label={`Show transcript of row ${row.ordinal}`}
                      >
                        {row.title || <em className="text-muted-foreground">untitled</em>}
                      </button>
                      {row.problem ? <p className="text-sm text-destructive">{row.problem}</p> : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.externalId ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">{row.stepCount}</TableCell>
                    <TableCell>
                      <LintBadge errors={counts.errors} warnings={counts.warnings} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </AdminCard>
      ) : null}
    </>
  );
}
