import {
  applyLintFix,
  emptyTranscriptMetadata,
  loginProfileArg,
  parseStepLine,
  parseTranscriptDocument,
  resolveStepType,
  serializeStepLine,
  serializeTestCase,
  trigramSimilarity,
  type LintFinding,
  type LintFix,
  type MacroParam,
  type ParamDeclaration,
  type ParsedTestCase,
  type StepArg,
  type TranscriptDataset,
  type TranscriptMetadata,
  type TranscriptStep,
  type TranscriptStepType
} from "@jittle-lamp/shared";

// Editor model of the structured step editor (design.md §7). The editor holds rows, not text; the
// transcript document is a projection of the rows and back, so the Text toggle is lossless. All
// operations are pure and return a new document, which keeps them testable and undo-friendly.

export type StepRow = {
  kind: "step";
  rowId: string;
  // Id of the parsed step this row came from; null for rows added in the editor.
  stepId: string | null;
  // Tag as written; null is bare text, which is an Act.
  tag: string | null;
  args: StepArg[];
  text: string;
  disabled: boolean;
};

export type HeadingRow = {
  kind: "heading";
  rowId: string;
  checkpointId: string | null;
  title: string;
  // `## Checkpoint: title` (true) or a plain `## title` heading (false).
  prefixed: boolean;
};

export type EditorRow = StepRow | HeadingRow;

export type EditorDoc = {
  title: string;
  metadata: TranscriptMetadata;
  dataset: TranscriptDataset | null;
  rows: EditorRow[];
  // Steps of the saved version; parsing re-matches against them so unchanged lines keep their id.
  baseSteps: Pick<TranscriptStep, "stepId" | "instructionKey">[];
};

export const stepTypeCycle = ["Act", "Assert", "Open", "Login", "Wait", "Screenshot", "Extract", "Note"] as const;

let rowSequence = 0;
export function newRowId(): string {
  rowSequence += 1;
  return `n${rowSequence}`;
}

export function emptyEditorDoc(title = ""): EditorDoc {
  return {
    title,
    metadata: emptyTranscriptMetadata(),
    dataset: null,
    rows: [{ kind: "step", rowId: newRowId(), stepId: null, tag: null, args: [], text: "", disabled: false }],
    baseSteps: []
  };
}

export function isBlankRow(row: EditorRow): boolean {
  return row.kind === "step" && row.tag === null && row.text.trim().length === 0;
}

export function rowStepType(row: StepRow): TranscriptStepType {
  return resolveStepType(row.tag).type;
}

// ---------------------------------------------------------------------------------------------
// Document <-> rows
// ---------------------------------------------------------------------------------------------

export function docFromTestCase(
  testCase: ParsedTestCase,
  options: { baseSteps?: EditorDoc["baseSteps"]; previous?: EditorDoc } = {}
): EditorDoc {
  // Keep row ids of rows whose step survived (lint fixes, text toggles) so focus and React keys hold.
  const previousRowIds = new Map<string, string>();
  if (options.previous) {
    const mapped = mapRowsToSteps(options.previous, testCaseFromDoc(options.previous));
    for (const [rowId, step] of mapped.steps) previousRowIds.set(step.stepId, rowId);
    for (const [rowId, checkpointId] of mapped.checkpoints) previousRowIds.set(checkpointId, rowId);
  }
  const usedRowIds = new Set<string>();
  const rowIdFor = (key: string, fallback: string) => {
    const reused = previousRowIds.get(key);
    const candidate = reused ?? fallback;
    const rowId = usedRowIds.has(candidate) ? newRowId() : candidate;
    usedRowIds.add(rowId);
    return rowId;
  };

  const stepRow = (step: TranscriptStep): StepRow => ({
    kind: "step",
    rowId: rowIdFor(step.stepId, `s:${step.stepId}`),
    stepId: step.stepId,
    tag: step.tag,
    args: step.args.map((arg) => ({ ...arg })),
    text: step.text,
    disabled: step.disabled
  });

  const rows: EditorRow[] = testCase.steps.filter((step) => step.checkpointId === null).map(stepRow);
  for (const checkpoint of testCase.checkpoints) {
    rows.push({
      kind: "heading",
      rowId: rowIdFor(checkpoint.checkpointId, `h:${checkpoint.checkpointId}`),
      checkpointId: checkpoint.checkpointId,
      title: checkpoint.title,
      prefixed: checkpoint.prefixed
    });
    rows.push(...testCase.steps.filter((step) => step.checkpointId === checkpoint.checkpointId).map(stepRow));
  }

  return {
    title: testCase.title,
    metadata: testCase.metadata,
    dataset: testCase.dataset,
    rows,
    baseSteps: options.baseSteps ?? options.previous?.baseSteps ?? testCase.steps.map(({ stepId, instructionKey }) => ({ stepId, instructionKey }))
  };
}

export function docFromTranscript(text: string, baseSteps: EditorDoc["baseSteps"] = [], previous?: EditorDoc): EditorDoc {
  const parsed = parseTranscriptDocument(text, baseSteps.length > 0 ? { previousSteps: [baseSteps] } : {});
  const testCase = parsed.cases[0] ?? emptyParsedCase();
  return docFromTestCase(testCase, { baseSteps, ...(previous ? { previous } : {}) });
}

function emptyParsedCase(): ParsedTestCase {
  return { title: "", line: 1, metadata: emptyTranscriptMetadata(), checkpoints: [], steps: [], dataset: null };
}

// A plain `## title` heading whose title itself reads as `Checkpoint: …` or `Dataset…` would
// parse back as something else, so it is written in the prefixed form.
function headingLine(row: HeadingRow): string {
  const prefixed = row.prefixed || /^(?:checkpoint\s*:|dataset(?:\s*:|\s*$))/i.test(row.title.trim());
  return prefixed ? `## Checkpoint: ${row.title}`.trimEnd() : `## ${row.title}`.trimEnd();
}

// Bare text is an Act, but a bare line that starts like a heading, a disabled marker, a tag
// (`[x] done`) or a table row would parse back as something else and the step would be lost or
// moved. Such rows are written with an explicit [Act] tag, which keeps the same instruction key.
export function bareTextNeedsTag(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/^#/.test(trimmed) || /^\/\/\s/.test(trimmed) || /^\/\/$/.test(trimmed) || trimmed.startsWith("|")) return true;
  return parseStepLine(trimmed).tag !== null;
}

export function serializeRowLine(row: StepRow): string {
  if (row.tag === null && bareTextNeedsTag(row.text)) return serializeStepLine({ ...row, tag: "Act" });
  return serializeStepLine(row);
}

// Same layout as serializeTestCase: metadata, then steps without a checkpoint, then one block per
// checkpoint, then the dataset; blocks are separated by one blank line.
export function serializeEditorDoc(doc: EditorDoc): string {
  const lines: string[] = [];
  const header = serializeTestCase({ ...emptyParsedCase(), title: doc.title, metadata: doc.metadata });
  if (header.length > 0) lines.push(header);

  const pushBlock = (block: string[]) => {
    if (block.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(...block);
  };

  let block: string[] = [];
  for (const row of doc.rows) {
    if (row.kind === "heading") {
      pushBlock(block);
      block = [headingLine(row)];
      continue;
    }
    if (isBlankRow(row)) continue;
    block.push(serializeRowLine(row));
  }
  pushBlock(block);

  if (doc.dataset) {
    const datasetText = serializeTestCase({ ...emptyParsedCase(), dataset: doc.dataset });
    pushBlock(datasetText.split("\n"));
  }
  return lines.join("\n");
}

// Text mode edit: a single case replaces the doc; text holding several `# title` cases keeps the
// doc as it was (null) so switching back never drops cases.
export function textModeUpdate(text: string, doc: EditorDoc): { doc: EditorDoc | null; cases: number } {
  const cases = parseTranscriptDocument(text).cases.filter((testCase) => testCase.title.trim().length > 0).length;
  if (cases > 1) return { doc: null, cases };
  return { doc: docFromTranscript(text, doc.baseSteps, doc), cases };
}

export function testCaseFromDoc(doc: EditorDoc): ParsedTestCase {
  const text = serializeEditorDoc(doc);
  const parsed = parseTranscriptDocument(text, doc.baseSteps.length > 0 ? { previousSteps: [doc.baseSteps] } : {});
  return parsed.cases[0] ?? emptyParsedCase();
}

// Which parsed step belongs to which row. Rows serialise one line each in order, so the n-th
// non-blank step row is the n-th parsed step and the n-th heading the n-th checkpoint.
export function mapRowsToSteps(
  doc: EditorDoc,
  parsed: ParsedTestCase
): { steps: Map<string, TranscriptStep>; checkpoints: Map<string, string> } {
  const steps = new Map<string, TranscriptStep>();
  const checkpoints = new Map<string, string>();
  let stepIndex = 0;
  let checkpointIndex = 0;
  for (const row of doc.rows) {
    if (row.kind === "heading") {
      const checkpoint = parsed.checkpoints[checkpointIndex];
      checkpointIndex += 1;
      if (checkpoint) checkpoints.set(row.rowId, checkpoint.checkpointId);
      continue;
    }
    if (isBlankRow(row)) continue;
    const step = parsed.steps[stepIndex];
    stepIndex += 1;
    if (step) steps.set(row.rowId, step);
  }
  return { steps, checkpoints };
}

// ---------------------------------------------------------------------------------------------
// Row operations
// ---------------------------------------------------------------------------------------------

export type EditResult = { doc: EditorDoc; focusRowId: string | null };

function indexOfRow(doc: EditorDoc, rowId: string): number {
  return doc.rows.findIndex((row) => row.rowId === rowId);
}

function withRows(doc: EditorDoc, rows: EditorRow[]): EditorDoc {
  return { ...doc, rows };
}

function updateStepRow(doc: EditorDoc, rowId: string, update: (row: StepRow) => StepRow): EditorDoc {
  return withRows(
    doc,
    doc.rows.map((row) => (row.rowId === rowId && row.kind === "step" ? update(row) : row))
  );
}

export function setRowText(doc: EditorDoc, rowId: string, text: string): EditorDoc {
  const clean = text.replace(/\r?\n/g, " ");
  return withRows(
    doc,
    doc.rows.map((row) => {
      if (row.rowId !== rowId) return row;
      return row.kind === "step" ? { ...row, text: clean } : { ...row, title: clean };
    })
  );
}

export function setRowTag(doc: EditorDoc, rowId: string, tag: string | null, args: StepArg[] = []): EditorDoc {
  return updateStepRow(doc, rowId, (row) => ({ ...row, tag, args }));
}

export function setRowArgs(doc: EditorDoc, rowId: string, args: StepArg[]): EditorDoc {
  return updateStepRow(doc, rowId, (row) => ({ ...row, args }));
}

// The tag a new row gets after Enter: the same builtin type; macro and login calls continue as Act.
export function nextRowTag(row: EditorRow): string | null {
  if (row.kind === "heading") return "Assert";
  const type = rowStepType(row);
  if (type === "macro" || type === "login" || type === "open") return row.tag === null ? null : "Act";
  return row.tag;
}

export function insertRowAfter(doc: EditorDoc, rowId: string | null, row?: Partial<StepRow>): EditResult {
  const index = rowId === null ? doc.rows.length - 1 : indexOfRow(doc, rowId);
  const source = doc.rows[index];
  const created: StepRow = {
    kind: "step",
    rowId: newRowId(),
    stepId: null,
    tag: source ? nextRowTag(source) : null,
    args: [],
    text: "",
    disabled: false,
    ...row
  };
  const rows = [...doc.rows];
  rows.splice(index + 1, 0, created);
  return { doc: withRows(doc, rows), focusRowId: created.rowId };
}

export function insertHeadingAfter(doc: EditorDoc, rowId: string | null, title = ""): EditResult {
  const index = rowId === null ? doc.rows.length - 1 : indexOfRow(doc, rowId);
  const created: HeadingRow = { kind: "heading", rowId: newRowId(), checkpointId: null, title, prefixed: true };
  const rows = [...doc.rows];
  rows.splice(index + 1, 0, created);
  return { doc: withRows(doc, rows), focusRowId: created.rowId };
}

// `#` typed on an empty row turns it into a checkpoint heading.
export function convertRowToHeading(doc: EditorDoc, rowId: string): EditResult {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row || row.kind !== "step") return { doc, focusRowId: rowId };
  const heading: HeadingRow = { kind: "heading", rowId: row.rowId, checkpointId: null, title: "", prefixed: true };
  const rows = [...doc.rows];
  rows[index] = heading;
  return { doc: withRows(doc, rows), focusRowId: heading.rowId };
}

export function duplicateRow(doc: EditorDoc, rowId: string): EditResult {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row) return { doc, focusRowId: null };
  const copy: EditorRow =
    row.kind === "step"
      ? { ...row, rowId: newRowId(), stepId: null, args: row.args.map((arg) => ({ ...arg })) }
      : { ...row, rowId: newRowId(), checkpointId: null };
  const rows = [...doc.rows];
  rows.splice(index + 1, 0, copy);
  return { doc: withRows(doc, rows), focusRowId: copy.rowId };
}

export function removeRow(doc: EditorDoc, rowId: string): EditResult {
  const index = indexOfRow(doc, rowId);
  if (index === -1) return { doc, focusRowId: null };
  const rows = doc.rows.filter((row) => row.rowId !== rowId);
  if (rows.length === 0) {
    const blank: StepRow = { kind: "step", rowId: newRowId(), stepId: null, tag: null, args: [], text: "", disabled: false };
    return { doc: withRows(doc, [blank]), focusRowId: blank.rowId };
  }
  const focus = rows[Math.max(0, index - 1)];
  return { doc: withRows(doc, rows), focusRowId: focus?.rowId ?? null };
}

export function moveRowTo(doc: EditorDoc, rowId: string, targetIndex: number): EditResult {
  const index = indexOfRow(doc, rowId);
  const row = doc.rows[index];
  if (!row) return { doc, focusRowId: null };
  const rows = doc.rows.filter((candidate) => candidate.rowId !== rowId);
  const clamped = Math.min(Math.max(0, targetIndex), rows.length);
  rows.splice(clamped, 0, row);
  return { doc: withRows(doc, rows), focusRowId: rowId };
}

export function moveRow(doc: EditorDoc, rowId: string, delta: -1 | 1): EditResult {
  const index = indexOfRow(doc, rowId);
  if (index === -1) return { doc, focusRowId: null };
  return moveRowTo(doc, rowId, index + delta);
}

export function toggleRowDisabled(doc: EditorDoc, rowId: string): EditorDoc {
  return updateStepRow(doc, rowId, (row) => ({ ...row, disabled: !row.disabled }));
}

export function cycleRowType(doc: EditorDoc, rowId: string, direction: 1 | -1): EditorDoc {
  return updateStepRow(doc, rowId, (row) => {
    const current = rowStepType(row);
    const currentTag = current === "macro" ? null : current === "act" ? "Act" : row.tag;
    const index = stepTypeCycle.findIndex((tag) => tag.toLowerCase() === (currentTag ?? "act").toLowerCase());
    const next = stepTypeCycle[(Math.max(0, index) + direction + stepTypeCycle.length) % stepTypeCycle.length] ?? "Act";
    const keepArgs = next === "Login" && current === "login";
    return { ...row, tag: next, args: keepArgs ? row.args : [] };
  });
}

// ---------------------------------------------------------------------------------------------
// Paste: multi-line text becomes rows through the parser
// ---------------------------------------------------------------------------------------------

const listMarkerPattern = /^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+|\[ \]\s+|\[x\]\s+)/i;

export function normalizePastedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(listMarkerPattern, "").replace(/\s+$/, ""))
    .join("\n");
}

export type PasteResult =
  | { kind: "rows"; doc: EditorDoc; focusRowId: string | null; added: number }
  | { kind: "multi-case"; cases: number; document: string }
  | { kind: "none" };

export function pasteIntoRow(doc: EditorDoc, rowId: string, text: string): PasteResult {
  if (!/\n/.test(text.trim())) return { kind: "none" };
  const normalized = normalizePastedText(text);
  const parsed = parseTranscriptDocument(normalized);
  const titled = parsed.cases.filter((testCase) => testCase.title.trim().length > 0);
  if (titled.length > 1) return { kind: "multi-case", cases: parsed.cases.length, document: normalized };

  const pastedRows: EditorRow[] = parsed.cases.flatMap((testCase) =>
    docFromTestCase(testCase, { baseSteps: [] }).rows.map((row) =>
      row.kind === "step" ? { ...row, rowId: newRowId(), stepId: null } : { ...row, rowId: newRowId(), checkpointId: null }
    )
  );
  if (pastedRows.length === 0) return { kind: "none" };

  const index = indexOfRow(doc, rowId);
  const current = doc.rows[index];
  const replace = current !== undefined && isBlankRow(current);
  const rows = [...doc.rows];
  rows.splice(replace ? index : index + 1, replace ? 1 : 0, ...pastedRows);
  return { kind: "rows", doc: withRows(doc, rows), focusRowId: pastedRows[pastedRows.length - 1]?.rowId ?? null, added: pastedRows.length };
}

// ---------------------------------------------------------------------------------------------
// Lint per row and fixes
// ---------------------------------------------------------------------------------------------

export function lintByRow(
  doc: EditorDoc,
  parsed: ParsedTestCase,
  findings: readonly LintFinding[]
): { byRow: Map<string, LintFinding[]>; caseLevel: LintFinding[] } {
  const { steps } = mapRowsToSteps(doc, parsed);
  const rowByStepId = new Map<string, string>();
  for (const [rowId, step] of steps) rowByStepId.set(step.stepId, rowId);
  const byRow = new Map<string, LintFinding[]>();
  const caseLevel: LintFinding[] = [];
  for (const finding of findings) {
    const rowId = finding.stepId === null ? undefined : rowByStepId.get(finding.stepId);
    if (rowId === undefined) {
      caseLevel.push(finding);
      continue;
    }
    byRow.set(rowId, [...(byRow.get(rowId) ?? []), finding]);
  }
  return { byRow, caseLevel };
}

export function applyFixToDoc(doc: EditorDoc, fix: LintFix): EditorDoc {
  const parsed = testCaseFromDoc(doc);
  return docFromTestCase(applyLintFix(parsed, fix), { previous: doc });
}

export function describeLintFix(fix: LintFix): string {
  switch (fix.kind) {
    case "split-step":
      return `Split into ${fix.parts.length} steps`;
    case "declare-param":
      return `Declare {${fix.name}}`;
    case "insert-checkpoint":
      return "Add checkpoint";
    case "change-type":
      return `Make it [${fix.tag}]`;
    case "replace-text":
      return "Replace text";
    case "use-visible-label":
      return fix.suggestions[0] ? `Use "${fix.suggestions[0]}"` : "Use the visible label";
  }
}

// A fix the editor can apply in one click (use-visible-label needs a suggestion).
export function isApplicableFix(fix: LintFix | null): fix is LintFix {
  if (fix === null) return false;
  return fix.kind !== "use-visible-label" || fix.suggestions.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Pickers: triggers, options, application
// ---------------------------------------------------------------------------------------------

export type EditorTrigger = {
  kind: "type" | "variable" | "credential";
  query: string;
  // Text range [start, end) that the pick replaces.
  start: number;
  end: number;
};

export function detectTrigger(text: string, caret: number): EditorTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));

  const typeMatch = /^[/[]([\p{L}\p{N}_ -]*)$/u.exec(before);
  if (typeMatch) return { kind: "type", query: (typeMatch[1] ?? "").trim(), start: 0, end: before.length };

  const brace = before.lastIndexOf("{");
  if (brace !== -1) {
    const query = before.slice(brace + 1);
    if (!query.includes("}") && /^[\w.:-]*$/.test(query)) return { kind: "variable", query, start: brace, end: before.length };
  }

  const at = before.lastIndexOf("@");
  if (at !== -1 && (at === 0 || /\s/.test(before[at - 1] ?? ""))) {
    const query = before.slice(at + 1);
    if (/^[\w.-]*$/.test(query)) return { kind: "credential", query, start: at, end: before.length };
  }
  return null;
}

export type TypeOption = {
  kind: "builtin" | "macro";
  tag: string;
  label: string;
  description: string;
  params: MacroParam[];
};

const builtinDescriptions: Record<(typeof stepTypeCycle)[number], string> = {
  Act: "Agent performs one user intent",
  Assert: "Check the screen; no data changes",
  Open: "Navigate to a URL or path",
  Login: "Run the Login macro with a credential profile",
  Wait: "Poll until a condition holds",
  Screenshot: "Capture a screenshot",
  Extract: "Store a value from the screen in {name}",
  Note: "Shown in reports, not executed"
};

export type EditorMacro = { name: string; params: MacroParam[]; transcript?: string; version?: number };

// The runner ships a built-in Login macro (packages/e2e-runner/macros/login.transcript.md); an
// organisation macro named Login overrides it. Lint must not call [Login: X] an unknown macro.
export const builtinLoginMacro: EditorMacro = { name: "Login", params: [{ name: "profile", required: true, default: null, kind: "credential" }] };

export function withBuiltinMacros(macros: readonly EditorMacro[]): EditorMacro[] {
  return macros.some((macro) => macro.name.toLowerCase() === "login") ? [...macros] : [...macros, builtinLoginMacro];
}

export function typeOptions(query: string, macros: readonly EditorMacro[]): TypeOption[] {
  const needle = query.trim().toLowerCase();
  const loginMacro = macros.find((macro) => macro.name.toLowerCase() === "login");
  const builtins: TypeOption[] = stepTypeCycle.map((tag) => ({
    kind: "builtin",
    tag,
    label: tag,
    description: builtinDescriptions[tag],
    params:
      tag === "Login"
        ? loginMacro?.params ?? [{ name: "profile", required: true, default: null, kind: "credential" }]
        : tag === "Extract"
          ? [{ name: "name", required: true, default: null, kind: "text" }]
          : []
  }));
  const macroOptions: TypeOption[] = macros
    .filter((macro) => macro.name.toLowerCase() !== "login")
    .map((macro) => ({
      kind: "macro",
      tag: macro.name,
      label: macro.name,
      description: macro.params.length > 0 ? `Macro · ${macro.params.map((param) => param.name).join(", ")}` : "Macro",
      params: macro.params
    }));
  const all = [...builtins, ...macroOptions];
  if (needle.length === 0) return all;
  const starts = all.filter((option) => option.tag.toLowerCase().startsWith(needle));
  const contains = all.filter((option) => !option.tag.toLowerCase().startsWith(needle) && option.tag.toLowerCase().includes(needle));
  return [...starts, ...contains];
}

// Arguments for a picked type from its param form values. A single first param is written
// positionally (`[Login: PCF_HQ_ADMIN]`), several as `name=value`.
export function argsFromParamValues(params: readonly MacroParam[], values: Readonly<Record<string, string>>): StepArg[] {
  const filled = params.filter((param) => (values[param.name] ?? "").trim().length > 0);
  if (filled.length === 0) return [];
  const only = filled.length === 1 ? filled[0] : undefined;
  if (only !== undefined && only === params[0]) return [{ name: null, value: (values[only.name] ?? "").trim() }];
  return filled.map((param) => ({ name: param.name, value: (values[param.name] ?? "").trim() }));
}

// Values for a param form from a row's existing args (positional args fill params in order).
export function paramValuesFromArgs(params: readonly MacroParam[], args: readonly StepArg[]): Record<string, string> {
  const values: Record<string, string> = {};
  let positional = 0;
  for (const arg of args) {
    if (arg.name === null) {
      const param = params[positional];
      positional += 1;
      if (param) values[param.name] = arg.value;
      continue;
    }
    const param = params.find((candidate) => candidate.name.toLowerCase() === arg.name?.toLowerCase());
    values[param?.name ?? arg.name] = arg.value;
  }
  return values;
}

export function applyTypePick(text: string, trigger: EditorTrigger): string {
  return (text.slice(0, trigger.start) + text.slice(trigger.end)).replace(/^\s+/, "");
}

export type VariableOption = {
  name: string;
  source: "env" | "param" | "dataset" | "extracted" | "declare";
  detail: string;
};

export type VariableSources = {
  environmentVariables: readonly string[];
  environmentName?: string | null;
  params: readonly ParamDeclaration[];
  datasetColumns: readonly string[];
  extracted: readonly { name: string; ordinal: number }[];
};

export function variableOptions(query: string, sources: VariableSources): VariableOption[] {
  const needle = query.toLowerCase();
  const options: VariableOption[] = [];
  const seen = new Set<string>();
  const push = (option: VariableOption) => {
    if (seen.has(option.name)) return;
    seen.add(option.name);
    options.push(option);
  };
  for (const column of sources.datasetColumns) push({ name: column, source: "dataset", detail: "dataset column" });
  for (const param of sources.params) {
    push({ name: param.name, source: "param", detail: param.default === null ? "param · required" : `param · default "${param.default}"` });
  }
  for (const extracted of sources.extracted) push({ name: extracted.name, source: "extracted", detail: `extracted · step ${extracted.ordinal}` });
  for (const name of sources.environmentVariables) {
    push({ name, source: "env", detail: sources.environmentName ? `env · ${sources.environmentName}` : "environment variable" });
  }
  const filtered = needle.length === 0 ? options : options.filter((option) => option.name.toLowerCase().includes(needle));
  if (/^[A-Za-z_][\w-]*$/.test(query) && !seen.has(query)) {
    filtered.push({ name: query, source: "declare", detail: "declare new param" });
  }
  return filtered;
}

// Names written by [Extract: name] rows above the given row.
export function extractedNamesBefore(doc: EditorDoc, rowId: string): { name: string; ordinal: number }[] {
  const result: { name: string; ordinal: number }[] = [];
  let ordinal = 0;
  for (const row of doc.rows) {
    if (row.rowId === rowId) break;
    if (row.kind !== "step" || isBlankRow(row)) continue;
    ordinal += 1;
    if (rowStepType(row) !== "extract") continue;
    const name = row.args.find((arg) => arg.name === null)?.value;
    if (name) result.push({ name, ordinal });
  }
  return result;
}

export function insertReference(text: string, trigger: EditorTrigger, reference: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + reference + text.slice(trigger.end);
  return { text: next, caret: trigger.start + reference.length };
}

export type EditorCredential = {
  profile: string;
  fields: readonly string[];
  secretFields: readonly string[];
};

export type CredentialOption = {
  profile: string;
  // null selects the profile itself (a [Login] row's argument).
  field: string | null;
  secret: boolean;
  label: string;
};

export function credentialOptions(query: string, credentials: readonly EditorCredential[], forLoginRow: boolean): CredentialOption[] {
  const needle = query.toLowerCase();
  const options: CredentialOption[] = [];
  for (const credential of credentials) {
    if (forLoginRow) {
      options.push({ profile: credential.profile, field: null, secret: false, label: credential.profile });
      continue;
    }
    for (const field of credential.fields) options.push({ profile: credential.profile, field, secret: false, label: `${credential.profile}.${field}` });
    for (const field of credential.secretFields) options.push({ profile: credential.profile, field, secret: true, label: `${credential.profile}.${field}` });
  }
  const matches = needle.length === 0 ? options : options.filter((option) => option.label.toLowerCase().includes(needle));
  if (!forLoginRow && query.length > 0 && /[/.]/.test(query)) {
    matches.push({ profile: "", field: query, secret: false, label: `file:${query}` });
  }
  return matches;
}

export function credentialReference(option: CredentialOption): string {
  if (option.profile === "" && option.field !== null) return `{file:${option.field}}`;
  return option.field === null ? option.profile : `{cred:${option.profile}.${option.field}}`;
}

// ---------------------------------------------------------------------------------------------
// Display: tokens, chips, suggestions
// ---------------------------------------------------------------------------------------------

export type InstructionToken =
  | { kind: "text"; value: string }
  | { kind: "variable"; name: string }
  | { kind: "credential"; profile: string; field: string | null }
  | { kind: "file"; path: string }
  | { kind: "quoted"; value: string };

export function tokenizeInstruction(text: string): InstructionToken[] {
  const tokens: InstructionToken[] = [];
  const pattern = /\{([^{}\s]+)\}|"([^"\n]+)"/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) tokens.push({ kind: "text", value: text.slice(last, index) });
    const reference = match[1];
    if (reference !== undefined) {
      if (reference.startsWith("cred:")) {
        const ref = reference.slice(5);
        const dot = ref.indexOf(".");
        tokens.push({ kind: "credential", profile: dot === -1 ? ref : ref.slice(0, dot), field: dot === -1 ? null : ref.slice(dot + 1) });
      } else if (reference.startsWith("file:")) {
        tokens.push({ kind: "file", path: reference.slice(5) });
      } else {
        tokens.push({ kind: "variable", name: reference });
      }
    } else {
      tokens.push({ kind: "quoted", value: match[2] ?? "" });
    }
    last = index + match[0].length;
  }
  if (last < text.length) tokens.push({ kind: "text", value: text.slice(last) });
  return tokens;
}

// `Login · profile: PCF_HQ_ADMIN` for macro and login rows; the plain tag otherwise.
export function formatStepChip(row: Pick<StepRow, "tag" | "args">, macros: readonly EditorMacro[]): { tag: string; params: string | null } {
  const { type, macro } = resolveStepType(row.tag);
  const tag = row.tag ?? "Act";
  if (row.args.length === 0) return { tag, params: null };
  if (type === "login") {
    const profile = loginProfileArg(row.args);
    const rest = row.args.filter((arg) => arg.name !== null && arg.name.toLowerCase() !== "profile");
    return { tag, params: [profile ? `profile: ${profile}` : null, ...rest.map((arg) => `${arg.name}: ${arg.value}`)].filter(Boolean).join(" · ") };
  }
  if (type === "macro" && macro !== null) {
    const definition = macros.find((candidate) => candidate.name.toLowerCase() === macro.toLowerCase());
    const values = definition ? paramValuesFromArgs(definition.params, row.args) : null;
    if (values) return { tag, params: Object.entries(values).map(([name, value]) => `${name}: ${value}`).join(" · ") };
  }
  return { tag, params: row.args.map((arg) => (arg.name === null ? arg.value : `${arg.name}: ${arg.value}`)).join(" · ") };
}

export const phrasingTemplates: Record<TranscriptStepType, string> = {
  act: "Click …  ·  Enter … into …  ·  Choose … from …",
  assert: "Verify … is visible  ·  … shows …",
  open: "/path or https://…",
  login: "note for the reader, e.g. sign in as HQ admin",
  wait: "until … is visible",
  screenshot: "label, e.g. login form after logout",
  extract: "the value to read, e.g. the order id in the header",
  note: "context for the report",
  macro: "note for the reader"
};

// Element names as "role name" from rendered Playwright (`getByRole('menuitem', { name: 'Đăng xuất' })`).
export function elementNamesFromRenderedCode(code: string): string[] {
  const names: string[] = [];
  const roleCall = /getByRole\(\s*(['"`])([\w-]+)\1\s*(?:,\s*\{[^}]*?\bname\s*:\s*(['"`])((?:\\.|(?!\3).)*)\3[^}]*\})?/g;
  for (const match of code.matchAll(roleCall)) {
    const name = match[4];
    if (name) names.push(`${match[2]} ${name.replace(/\\(.)/g, "$1")}`);
  }
  const simple = /getBy(Label|Text|Placeholder|Title|AltText)\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  const roleFor: Record<string, string> = { Label: "textbox", Text: "text", Placeholder: "textbox", Title: "element", AltText: "img" };
  for (const match of code.matchAll(simple)) {
    const value = match[3];
    if (value) names.push(`${roleFor[match[1] ?? "Text"] ?? "text"} ${value.replace(/\\(.)/g, "$1")}`);
  }
  return names;
}

export type InteractionTargetLike = {
  role?: string | null | undefined;
  name?: string | undefined;
  textPreview?: string | undefined;
  tagName?: string | undefined;
  inputType?: string | undefined;
};

const implicitRoles: Record<string, string> = { a: "link", button: "button", select: "combobox", textarea: "textbox", input: "textbox" };

export function elementNameFromTarget(target: InteractionTargetLike): string | null {
  const label = (target.textPreview ?? target.name ?? "").replace(/\s+/g, " ").trim();
  if (label.length === 0 || label.length > 60) return null;
  const tagName = target.tagName?.toLowerCase();
  const role =
    target.role ??
    (tagName === "input" && (target.inputType === "checkbox" || target.inputType === "radio") ? target.inputType : undefined) ??
    (tagName === "input" && (target.inputType === "submit" || target.inputType === "button") ? "button" : undefined) ??
    (tagName ? implicitRoles[tagName] : undefined) ??
    "text";
  return `${role} ${label}`;
}

export function dedupeElementNames(names: readonly string[], limit = 200): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const key = name.trim();
    if (key.length === 0 || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    result.push(key);
    if (result.length >= limit) break;
  }
  return result;
}

// Element names for the row being typed: names containing the word under the caret first, then by
// trigram similarity with the whole instruction.
export function suggestElementNames(text: string, names: readonly string[], limit = 5): string[] {
  const trimmed = text.trim();
  if (trimmed.length < 2 || names.length === 0) return [];
  const lastWord = (/([\p{L}\p{N}_-]{2,})$/u.exec(trimmed)?.[1] ?? "").toLowerCase();
  return names
    .map((name) => {
      const lower = name.toLowerCase();
      const label = lower.slice(lower.indexOf(" ") + 1);
      const wordHit = lastWord.length >= 2 && label.includes(lastWord) ? 1 : 0;
      return { name, score: wordHit + trigramSimilarity(trimmed, label) };
    })
    .filter((entry) => entry.score > 0.12 && !trimmed.toLowerCase().includes(entry.name.toLowerCase().slice(entry.name.indexOf(" ") + 1)))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.name);
}

// The quoted label inserted for a picked element name: `menuitem Đăng xuất` → `"Đăng xuất"`.
export function insertElementName(text: string, elementName: string): string {
  const label = elementName.slice(elementName.indexOf(" ") + 1);
  const lastWord = /([\p{L}\p{N}_-]{2,})$/u.exec(text);
  const base = lastWord && label.toLowerCase().includes(lastWord[1]?.toLowerCase() ?? "") ? text.slice(0, lastWord.index) : text;
  const spacer = base.length === 0 || /\s$/.test(base) ? "" : " ";
  return `${base}${spacer}"${label}"`;
}

// ---------------------------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------------------------

export function updateMetadata(
  doc: EditorDoc,
  patch: Partial<Omit<TranscriptMetadata, "order">>
): EditorDoc {
  const order = [...doc.metadata.order];
  for (const key of Object.keys(patch) as (keyof typeof patch)[]) {
    if (!order.includes(key)) order.push(key);
  }
  return { ...doc, metadata: { ...doc.metadata, ...patch, order } };
}

export function setTitle(doc: EditorDoc, title: string): EditorDoc {
  return { ...doc, title: title.replace(/\r?\n/g, " ") };
}

export function setDataset(doc: EditorDoc, dataset: TranscriptDataset | null): EditorDoc {
  return { ...doc, dataset };
}

export function declareParam(doc: EditorDoc, name: string): EditorDoc {
  if (doc.metadata.params.some((param) => param.name === name)) return doc;
  return updateMetadata(doc, { params: [...doc.metadata.params, { name, default: null, required: true }] });
}

export function splitTag(tag: string): { namespace: string; name: string } {
  const colon = tag.indexOf(":");
  if (colon <= 0) return { namespace: "", name: tag };
  return { namespace: tag.slice(0, colon), name: tag.slice(colon + 1) };
}

export function groupTagsByNamespace(tags: readonly string[]): { namespace: string; tags: { tag: string; name: string }[] }[] {
  const groups = new Map<string, { tag: string; name: string }[]>();
  for (const tag of tags) {
    const { namespace, name } = splitTag(tag);
    groups.set(namespace, [...(groups.get(namespace) ?? []), { tag, name }]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([namespace, entries]) => ({ namespace, tags: entries }));
}

// Short label for a link chip: the Jira key when the URL is an issue, else the host.
export function linkLabel(url: string): string {
  const jira = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/.exec(url);
  if (jira?.[1]) return jira[1];
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") + (parsed.pathname.length > 1 ? parsed.pathname.slice(0, 24) : "");
  } catch {
    return url.slice(0, 40);
  }
}
