import {
  lintTestCase,
  parseTranscriptDocument,
  type LintFinding,
  type TranscriptLintContext
} from "@jittle-lamp/shared";

// Column mapping for CSV/XLSX imports (design.md §7): which file column feeds which case field, and
// a client-side preview of the transcript each row becomes. The backend does the real conversion
// (and may split free-text steps with the model); the preview uses the same document format so the
// lint shown here matches what the batch page will show for simple rows.

export const importFields = ["title", "preconditions", "steps", "expected", "id", "tags"] as const;
export type ImportField = (typeof importFields)[number];
export type ImportFieldMapping = Partial<Record<ImportField, string>>;

export const importFieldLabels: Record<ImportField, string> = {
  title: "Title",
  preconditions: "Preconditions",
  steps: "Steps",
  expected: "Expected result",
  id: "External id",
  tags: "Tags"
};

export const importFieldHints: Record<ImportField, string> = {
  title: "Case title (required)",
  preconditions: "Setup lines, run first as [Act]",
  steps: "One action per line → [Act]",
  expected: "One expectation per line → [Assert]",
  id: "Makes re-imports idempotent",
  tags: "Comma or semicolon separated"
};

const fieldSynonyms: Record<ImportField, readonly string[]> = {
  title: ["title", "name", "summary", "test case", "testcase", "case", "scenario", "test name", "case title"],
  preconditions: ["precondition", "preconditions", "pre-condition", "pre-conditions", "setup", "given", "prerequisite", "prerequisites"],
  steps: ["steps", "step", "test steps", "actions", "action", "procedure", "when"],
  expected: ["expected", "expected result", "expected results", "expectation", "then", "verification", "acceptance"],
  id: ["id", "key", "case id", "test id", "external id", "external_id", "ref", "reference", "issue key"],
  tags: ["tags", "tag", "labels", "label", "module", "component", "category"]
};

function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\s]+/g, " ").replace(/[:#*]/g, "").trim();
}

// Exact synonym match first, then "header contains synonym"; each column is used once.
export function guessImportMapping(headers: readonly string[]): ImportFieldMapping {
  const mapping: ImportFieldMapping = {};
  const used = new Set<string>();
  const normalised = headers.map((header) => ({ header, key: normaliseHeader(header) }));
  for (const pass of ["exact", "contains"] as const) {
    for (const field of importFields) {
      if (mapping[field]) continue;
      const match = normalised.find(
        ({ header, key }) =>
          !used.has(header) &&
          fieldSynonyms[field].some((synonym) => (pass === "exact" ? key === synonym : key.includes(synonym)))
      );
      if (match) {
        mapping[field] = match.header;
        used.add(match.header);
      }
    }
  }
  return mapping;
}

// Splits a free-text cell into lines: newlines first, then inline numbering ("1. a 2. b"), and strips
// list markers. A cell with one sentence stays one line.
export function splitCellLines(cell: string): string[] {
  const byNewline = cell
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lines = byNewline.length === 1 ? splitInlineNumbering(byNewline[0] as string) : byNewline;
  return lines.map(stripListMarker).filter((line) => line.length > 0);
}

function splitInlineNumbering(line: string): string[] {
  const parts = line.split(/\s+(?=\d{1,2}[.)]\s)/);
  return parts.length > 1 && /^\d{1,2}[.)]\s/.test(line) ? parts : [line];
}

function stripListMarker(line: string): string {
  return line.replace(/^(?:\d{1,3}[.)]|[-*•–]|step\s*\d+\s*[:.)-])\s*/i, "").trim();
}

export function splitTags(cell: string): string[] {
  return cell
    .split(/[,;\n]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

const taggedLine = /^\[[^\]]+\]/;

function toStepLine(line: string, tag: "Act" | "Assert"): string {
  return taggedLine.test(line) ? line : `[${tag}] ${line}`;
}

// One mapped row → one case of the transcript document format (design.md §7).
export function rowToTranscript(
  record: Readonly<Record<string, string>>,
  mapping: ImportFieldMapping,
  options: { defaultTags?: readonly string[] } = {}
): string {
  const cell = (field: ImportField): string => {
    const column = mapping[field];
    return column ? (record[column] ?? "").trim() : "";
  };
  const title = cell("title").replace(/\s+/g, " ");
  const lines = [`# ${title}`];
  const externalId = cell("id");
  if (externalId) lines.push(`External-id: ${externalId}`);
  const tags = [...(options.defaultTags ?? []), ...splitTags(cell("tags"))];
  const uniqueTags = [...new Set(tags)];
  if (uniqueTags.length > 0) lines.push(`Tags: ${uniqueTags.join(", ")}`);
  lines.push("");
  for (const line of splitCellLines(cell("preconditions"))) lines.push(toStepLine(line, "Act"));
  for (const line of splitCellLines(cell("steps"))) lines.push(toStepLine(line, "Act"));
  const expected = splitCellLines(cell("expected"));
  if (expected.length > 0) {
    lines.push("", "## Checkpoint: Expected result");
    for (const line of expected) lines.push(toStepLine(line, "Assert"));
  }
  return `${lines.join("\n")}\n`;
}

export type MappedRowPreview = {
  ordinal: number;
  title: string;
  externalId: string | null;
  transcript: string;
  stepCount: number;
  lint: LintFinding[];
  problem: string | null;
};

export function previewMappedRows(
  records: ReadonlyArray<Readonly<Record<string, string>>>,
  mapping: ImportFieldMapping,
  options: { defaultTags?: readonly string[]; limit?: number; lintContext?: TranscriptLintContext } = {}
): MappedRowPreview[] {
  const limit = options.limit ?? records.length;
  return records.slice(0, limit).map((record, index) => {
    const transcript = rowToTranscript(record, mapping, options.defaultTags ? { defaultTags: options.defaultTags } : {});
    const parsed = parseTranscriptDocument(transcript);
    const testCase = parsed.cases[0];
    const title = testCase?.title ?? "";
    const stepCount = testCase?.steps.length ?? 0;
    const problem = !mapping.title ? "No title column mapped" : title.length === 0 ? "Empty title" : stepCount === 0 ? "No steps" : null;
    return {
      ordinal: index + 1,
      title,
      externalId: testCase?.metadata.externalId ?? null,
      transcript,
      stepCount,
      lint: testCase ? lintTestCase(testCase, options.lintContext ?? {}) : [],
      problem
    };
  });
}

// The wizard can continue once a title and at least one step source are mapped.
export function mappingIsUsable(mapping: ImportFieldMapping): boolean {
  return Boolean(mapping.title && (mapping.steps || mapping.expected || mapping.preconditions));
}

// importMappingSchema shape: only mapped fields, no empty strings.
export function toImportMapping(mapping: ImportFieldMapping): ImportFieldMapping {
  const result: ImportFieldMapping = {};
  for (const field of importFields) {
    const column = mapping[field];
    if (column) result[field] = column;
  }
  return result;
}
