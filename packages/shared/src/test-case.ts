import { z } from "zod/v4";

import { sha256Hex } from "./sha256";

// Transcript model for AI-driven E2E test cases (design.md §4 and §7, ADR 0002 decisions 1, 7, 13).
// The document text is the storage, paste, import and export format; this module parses it into a
// step model with stable ids and serialises the model back without loss.

export const transcriptStepTypeSchema = z.enum([
  "open",
  "act",
  "assert",
  "login",
  "wait",
  "screenshot",
  "extract",
  "note",
  "macro"
]);

export const builtinStepTags = {
  open: "Open",
  act: "Act",
  assert: "Assert",
  login: "Login",
  wait: "Wait",
  screenshot: "Screenshot",
  extract: "Extract",
  note: "Note"
} as const satisfies Record<Exclude<z.infer<typeof transcriptStepTypeSchema>, "macro">, string>;

export const stepArgSchema = z.object({
  name: z.string().min(1).nullable(),
  value: z.string()
});

export const transcriptStepSchema = z.object({
  stepId: z.string().min(1),
  instructionKey: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  ordinal: z.number().int().positive(),
  line: z.number().int().positive(),
  type: transcriptStepTypeSchema,
  // Tag exactly as written (`Act`, `act`, `Login`); null for bare text, which is an Act.
  tag: z.string().min(1).nullable(),
  // Macro the step calls: `Login` for [Login], the tag for any other non-builtin tag.
  macro: z.string().min(1).nullable(),
  args: z.array(stepArgSchema),
  text: z.string(),
  checkpointId: z.string().min(1).nullable(),
  variables: z.array(z.string().min(1)),
  credentialRefs: z.array(z.string().min(1)),
  fileRefs: z.array(z.string().min(1)),
  disabled: z.boolean()
});

export const transcriptCheckpointSchema = z.object({
  checkpointId: z.string().min(1),
  title: z.string(),
  line: z.number().int().positive(),
  // `## Checkpoint: title` (true) or a plain `## title` heading (false).
  prefixed: z.boolean()
});

export const paramDeclarationSchema = z.object({
  name: z.string().min(1),
  default: z.string().nullable(),
  required: z.boolean()
});

export const transcriptDatasetSchema = z.object({
  name: z.string().nullable(),
  columns: z.array(z.string().min(1)),
  rows: z.array(z.record(z.string(), z.string()))
});

export const transcriptMetadataKeySchema = z.enum([
  "key",
  "description",
  "tags",
  "env",
  "links",
  "params",
  "retries",
  "externalId",
  "duplicateOf"
]);

export const transcriptMetadataSchema = z.object({
  key: z.string().min(1).nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string().min(1)),
  env: z.string().min(1).nullable(),
  links: z.array(z.string().min(1)),
  params: z.array(paramDeclarationSchema),
  retries: z.number().int().nonnegative().nullable(),
  externalId: z.string().min(1).nullable(),
  duplicateOf: z.string().min(1).nullable(),
  // Order the metadata lines were written in, so serialisation reproduces the document.
  order: z.array(transcriptMetadataKeySchema)
});

export const parsedTestCaseSchema = z.object({
  title: z.string(),
  line: z.number().int().positive(),
  metadata: transcriptMetadataSchema,
  checkpoints: z.array(transcriptCheckpointSchema),
  steps: z.array(transcriptStepSchema),
  dataset: transcriptDatasetSchema.nullable()
});

export const transcriptDiagnosticSchema = z.object({
  line: z.number().int().positive(),
  code: z.enum(["unsupported-heading", "malformed-dataset", "dataset-row-width", "invalid-metadata"]),
  message: z.string().min(1)
});

export const parsedTranscriptDocumentSchema = z.object({
  cases: z.array(parsedTestCaseSchema),
  diagnostics: z.array(transcriptDiagnosticSchema)
});

export type TranscriptStepType = z.infer<typeof transcriptStepTypeSchema>;
export type StepArg = z.infer<typeof stepArgSchema>;
export type TranscriptStep = z.infer<typeof transcriptStepSchema>;
export type TranscriptCheckpoint = z.infer<typeof transcriptCheckpointSchema>;
export type ParamDeclaration = z.infer<typeof paramDeclarationSchema>;
export type TranscriptDataset = z.infer<typeof transcriptDatasetSchema>;
export type TranscriptMetadataKey = z.infer<typeof transcriptMetadataKeySchema>;
export type TranscriptMetadata = z.infer<typeof transcriptMetadataSchema>;
export type ParsedTestCase = z.infer<typeof parsedTestCaseSchema>;
export type TranscriptDiagnostic = z.infer<typeof transcriptDiagnosticSchema>;
export type ParsedTranscriptDocument = z.infer<typeof parsedTranscriptDocumentSchema>;

const metadataLabels: Record<TranscriptMetadataKey, string> = {
  key: "Key",
  description: "Description",
  tags: "Tags",
  env: "Env",
  links: "Links",
  params: "Params",
  retries: "Retries",
  externalId: "External-id",
  duplicateOf: "Duplicate-of"
};

const metadataKeyByLabel = new Map<string, TranscriptMetadataKey>([
  ["key", "key"],
  ["description", "description"],
  ["tags", "tags"],
  ["env", "env"],
  ["environment", "env"],
  ["links", "links"],
  ["params", "params"],
  ["retries", "retries"],
  ["external-id", "externalId"],
  ["external id", "externalId"],
  ["duplicate-of", "duplicateOf"]
]);

const nullableMetadataKeys = new Set<TranscriptMetadataKey>(["key", "env", "externalId", "duplicateOf"]);

const metadataKeyOrder: readonly TranscriptMetadataKey[] = transcriptMetadataKeySchema.options;

const disabledPrefix = "// ";

export function emptyTranscriptMetadata(): TranscriptMetadata {
  return {
    key: null,
    description: null,
    tags: [],
    env: null,
    links: [],
    params: [],
    retries: null,
    externalId: null,
    duplicateOf: null,
    order: []
  };
}

// ---------------------------------------------------------------------------------------------
// Normalisation and identity
// ---------------------------------------------------------------------------------------------

export function normalizeInstructionText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

// Identity text for a step: whitespace and letter case do not matter, except inside `{…}` references
// and in [Open] targets, where case changes the URL or the variable.
export function normalizeStepIdentityText(type: TranscriptStepType, text: string): string {
  const collapsed = text.normalize("NFC").replace(/\s+/g, " ").trim();
  if (type === "open") return collapsed;
  return collapsed
    .split(/(\{[^{}]*\})/)
    .map((part) => (part.startsWith("{") ? part : part.toLowerCase()))
    .join("");
}

export function computeInstructionKey(input: {
  type: TranscriptStepType;
  macro: string | null;
  args: readonly StepArg[];
  text: string;
}): string {
  // [Login: PCF] and [Login: profile=PCF] are the same call.
  const args =
    input.type === "login"
      ? input.args.map((arg, index) => (arg.name === null && index === 0 ? { name: "profile", value: arg.value } : arg))
      : input.args;
  const canonicalArgs = args.map((arg) => [arg.name === null ? null : arg.name.toLowerCase(), arg.value.trim()]);
  const macro = input.macro === null ? null : input.macro.toLowerCase();
  return `sha256:${sha256Hex(
    JSON.stringify([input.type, macro, canonicalArgs, normalizeStepIdentityText(input.type, input.text)])
  )}`;
}

export function deriveStepId(instructionKey: string, occurrence: number): string {
  return `st_${sha256Hex(`${instructionKey}#${occurrence}`).slice(0, 16)}`;
}

export function deriveCheckpointId(title: string, occurrence: number): string {
  return `cp_${sha256Hex(`${normalizeInstructionText(title)}#${occurrence}`).slice(0, 12)}`;
}

// Re-match step ids against a previous version of the same case: an unchanged instruction keeps its
// id (and with it its cache and run history); a changed line becomes a new step.
export function reconcileStepIds(
  next: readonly TranscriptStep[],
  previous: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[]
): TranscriptStep[] {
  const pool = new Map<string, string[]>();
  for (const step of previous) {
    const ids = pool.get(step.instructionKey) ?? [];
    ids.push(step.stepId);
    pool.set(step.instructionKey, ids);
  }

  const used = new Set<string>();
  const result: TranscriptStep[] = [];

  for (const step of next) {
    const candidates = pool.get(step.instructionKey);
    const reused = candidates?.shift();
    if (reused !== undefined && !used.has(reused)) {
      used.add(reused);
      result.push({ ...step, stepId: reused });
      continue;
    }

    let stepId = step.stepId;
    let salt = 1;
    while (used.has(stepId)) {
      stepId = deriveStepId(step.instructionKey, 1000 + salt);
      salt += 1;
    }
    used.add(stepId);
    result.push({ ...step, stepId });
  }

  return result;
}

// ---------------------------------------------------------------------------------------------
// References inside instruction text: {var}, {cred:PROFILE.field}, {file:path}
// ---------------------------------------------------------------------------------------------

const referencePattern = /\{([^{}\s]+)\}/g;
const variableNamePattern = /^[A-Za-z_][\w.-]*$/;

export type StepReferences = {
  variables: string[];
  credentialRefs: string[];
  fileRefs: string[];
};

export function extractStepReferences(texts: readonly string[]): StepReferences {
  const variables = new Set<string>();
  const credentialRefs = new Set<string>();
  const fileRefs = new Set<string>();

  for (const text of texts) {
    // Nested references such as {cred:{profile}.password} are read inside out.
    let current = text;
    for (let pass = 0; pass < 3; pass += 1) {
      let changed = false;
      current = current.replace(referencePattern, (_match, token: string) => {
        changed = true;
        if (token.startsWith("cred:")) {
          const ref = token.slice("cred:".length);
          if (ref.length > 0 && !ref.includes("\u0000")) credentialRefs.add(ref);
        } else if (token.startsWith("file:")) {
          const ref = token.slice("file:".length);
          if (ref.length > 0) fileRefs.add(ref);
        } else if (variableNamePattern.test(token)) {
          variables.add(token);
        }
        return "\u0000";
      });
      if (!changed) break;
    }
  }

  return {
    variables: [...variables],
    credentialRefs: [...credentialRefs],
    fileRefs: [...fileRefs]
  };
}

export function substituteVariables(text: string, values: Readonly<Record<string, string>>): string {
  let current = text;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = current.replace(referencePattern, (match, token: string) =>
      Object.prototype.hasOwnProperty.call(values, token) ? (values[token] ?? match) : match
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------------------------
// Step line parsing
// ---------------------------------------------------------------------------------------------

const tagNamePattern = /^[\p{L}_][\p{L}\p{N}_ -]*$/u;
const argNamePattern = /^[A-Za-z_][\w-]*$/;

type RawArg = { name: string | null; value: string };

function unquoteArgValue(raw: string): string {
  const value = raw.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) return value.slice(1, -1).replace(/\\(.)/g, "$1");
  return value;
}

// Split on commas and the first `=` of each part, both outside double quotes.
function splitArgList(raw: string): RawArg[] | null {
  const parts: RawArg[] = [];
  let name: string | null = null;
  let current = "";
  let quoted = false;

  const flush = () => {
    parts.push({ name, value: current });
    name = null;
    current = "";
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === undefined) break;
    if (quoted) {
      if (char === "\\" && index + 1 < raw.length) {
        current += char + (raw[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === '"') quoted = false;
      current += char;
      continue;
    }
    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === ",") {
      flush();
      continue;
    }
    if (char === "=" && name === null && argNamePattern.test(current.trim())) {
      name = current.trim();
      current = "";
      continue;
    }
    current += char;
  }

  if (quoted) return null;
  flush();
  return parts;
}

export function parseStepArgs(raw: string): StepArg[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const parts = splitArgList(raw);
  // A single value without `name=` fills the macro's first parameter, commas included.
  if (!parts || parts.every((part) => part.name === null)) return [{ name: null, value: unquoteArgValue(trimmed) }];

  return parts.map((part) => ({ name: part.name, value: unquoteArgValue(part.value) }));
}

function quoteArgValue(value: string, single: boolean): string {
  const needsQuotes =
    value.length === 0 || value.trim() !== value || (single ? /["\]=]/ : /[,"\]=]/).test(value);
  return needsQuotes ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

export function serializeStepArgs(args: readonly StepArg[]): string {
  if (args.length === 1 && args[0]?.name === null) return quoteArgValue(args[0].value, true);
  return args
    .map((arg) => (arg.name === null ? quoteArgValue(arg.value, false) : `${arg.name}=${quoteArgValue(arg.value, false)}`))
    .join(", ");
}

type StepLineParts = {
  tag: string | null;
  args: StepArg[];
  text: string;
};

function readBracketTag(line: string): { inner: string; rest: string } | null {
  if (!line.startsWith("[")) return null;
  let quoted = false;
  for (let index = 1; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "]") return { inner: line.slice(1, index), rest: line.slice(index + 1) };
    else if (char === "[") return null;
  }
  return null;
}

export function parseStepLine(line: string): StepLineParts {
  const bracket = readBracketTag(line);
  if (bracket) {
    const colon = bracket.inner.indexOf(":");
    const rawTag = (colon === -1 ? bracket.inner : bracket.inner.slice(0, colon)).trim();
    if (rawTag.length > 0 && tagNamePattern.test(rawTag)) {
      const rawArgs = colon === -1 ? "" : bracket.inner.slice(colon + 1);
      return {
        tag: rawTag,
        args: parseStepArgs(rawArgs),
        text: bracket.rest.trim()
      };
    }
  }
  return { tag: null, args: [], text: line.trim() };
}

export function resolveStepType(tag: string | null): { type: TranscriptStepType; macro: string | null } {
  if (tag === null) return { type: "act", macro: null };
  const lower = tag.toLowerCase();
  if (lower === "login") return { type: "login", macro: "Login" };
  if (Object.prototype.hasOwnProperty.call(builtinStepTags, lower)) {
    return { type: lower as Exclude<TranscriptStepType, "macro" | "login">, macro: null };
  }
  return { type: "macro", macro: tag };
}

export function serializeStepLine(step: Pick<TranscriptStep, "tag" | "args" | "text" | "disabled">): string {
  const prefix = step.disabled ? disabledPrefix : "";
  if (step.tag === null) return `${prefix}${step.text}`;
  const args = step.args.length > 0 ? `: ${serializeStepArgs(step.args)}` : "";
  const text = step.text.length > 0 ? ` ${step.text}` : "";
  return `${prefix}[${step.tag}${args}]${text}`;
}

function buildStep(input: {
  parts: StepLineParts;
  line: number;
  ordinal: number;
  checkpointId: string | null;
  disabled: boolean;
}): Omit<TranscriptStep, "stepId"> {
  const { type, macro } = resolveStepType(input.parts.tag);
  const references = extractStepReferences([input.parts.text, ...input.parts.args.map((arg) => arg.value)]);
  const credentialRefs = new Set(references.credentialRefs);

  if (type === "login") {
    const profile = loginProfileArg(input.parts.args);
    if (profile !== null && extractStepReferences([profile]).variables.length === 0) credentialRefs.add(profile);
  }

  return {
    instructionKey: computeInstructionKey({ type, macro, args: input.parts.args, text: input.parts.text }),
    ordinal: input.ordinal,
    line: input.line,
    type,
    tag: input.parts.tag,
    macro,
    args: input.parts.args,
    text: input.parts.text,
    checkpointId: input.checkpointId,
    variables: references.variables,
    credentialRefs: [...credentialRefs],
    fileRefs: references.fileRefs,
    disabled: input.disabled
  };
}

export function loginProfileArg(args: readonly StepArg[]): string | null {
  const named = args.find((arg) => arg.name?.toLowerCase() === "profile");
  if (named && named.value.length > 0) return named.value;
  const positional = args.find((arg) => arg.name === null);
  return positional && positional.value.length > 0 ? positional.value : null;
}

// ---------------------------------------------------------------------------------------------
// Document parsing
// ---------------------------------------------------------------------------------------------

// Comma-separated metadata lists; items containing a comma are written in double quotes.
function splitList(value: string): string[] {
  return (splitArgList(value) ?? [{ name: null, value }])
    .map((part) => unquoteArgValue(part.name === null ? part.value : `${part.name}=${part.value}`))
    .filter((item) => item.length > 0);
}

function serializeList(items: readonly string[]): string {
  return items.map((item) => quoteArgValue(item, false)).join(", ");
}

export function parseParamDeclarations(value: string): ParamDeclaration[] {
  const parts = splitArgList(value) ?? [{ name: null, value }];
  return parts
    .map((part) =>
      part.name === null
        ? { name: unquoteArgValue(part.value), default: null, required: true }
        : { name: part.name, default: unquoteArgValue(part.value), required: false }
    )
    .filter((param) => param.name.length > 0 && argNamePattern.test(param.name));
}

function serializeParamDeclarations(params: readonly ParamDeclaration[]): string {
  return params
    .map((param) => (param.default === null ? param.name : `${param.name}=${quoteArgValue(param.default, false)}`))
    .join(", ");
}

function parseTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

const tableSeparatorPattern = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

type CaseBuilder = {
  title: string;
  line: number;
  metadata: TranscriptMetadata;
  metadataOpen: boolean;
  lastMetadataKey: TranscriptMetadataKey | null;
  checkpoints: TranscriptCheckpoint[];
  steps: Omit<TranscriptStep, "stepId">[];
  currentCheckpointId: string | null;
  checkpointOccurrences: Map<string, number>;
  dataset: TranscriptDataset | null;
  datasetState: "none" | "header" | "separator" | "rows";
};

function newCaseBuilder(title: string, line: number): CaseBuilder {
  return {
    title,
    line,
    metadata: emptyTranscriptMetadata(),
    metadataOpen: true,
    lastMetadataKey: null,
    checkpoints: [],
    steps: [],
    currentCheckpointId: null,
    checkpointOccurrences: new Map(),
    dataset: null,
    datasetState: "none"
  };
}

export type ParseTranscriptOptions = {
  // Steps of the previously saved version, per case index, used to keep step ids stable on edit.
  previousSteps?: ReadonlyArray<readonly Pick<TranscriptStep, "stepId" | "instructionKey">[]>;
  // Previously saved cases; each new case is matched by Key, then title, then position.
  previousCases?: ReadonlyArray<{
    key: string | null;
    title: string;
    steps: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[];
  }>;
};

export function parseTranscriptDocument(text: string, options: ParseTranscriptOptions = {}): ParsedTranscriptDocument {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const builders: CaseBuilder[] = [];
  const diagnostics: TranscriptDiagnostic[] = [];
  let current: CaseBuilder | null = null;

  const ensureCase = (lineNumber: number): CaseBuilder => {
    if (!current) {
      current = newCaseBuilder("", lineNumber);
      current.metadataOpen = false;
      builders.push(current);
    }
    return current;
  };

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const trimmed = rawLine.trim();

    if (current?.datasetState !== undefined && current.datasetState !== "none") {
      const builder: CaseBuilder = current;
      if (trimmed.startsWith("|")) {
        const cells = parseTableRow(trimmed);
        if (builder.datasetState === "header") {
          if (cells.some((cell) => cell.length === 0)) {
            diagnostics.push({ line: lineNumber, code: "malformed-dataset", message: "Dataset header has an empty column name." });
          }
          builder.dataset = { name: builder.dataset?.name ?? null, columns: cells.filter((cell) => cell.length > 0), rows: [] };
          builder.datasetState = "separator";
          return;
        }
        if (builder.datasetState === "separator") {
          if (!tableSeparatorPattern.test(trimmed)) {
            diagnostics.push({ line: lineNumber, code: "malformed-dataset", message: "Dataset table needs a `| --- |` separator row under the header." });
          }
          builder.datasetState = "rows";
          if (tableSeparatorPattern.test(trimmed)) return;
        }
        const dataset = builder.dataset;
        if (dataset) {
          if (cells.length !== dataset.columns.length) {
            diagnostics.push({
              line: lineNumber,
              code: "dataset-row-width",
              message: `Dataset row has ${cells.length} cells; the header has ${dataset.columns.length}.`
            });
          }
          const row: Record<string, string> = {};
          dataset.columns.forEach((column, columnIndex) => {
            row[column] = cells[columnIndex] ?? "";
          });
          dataset.rows.push(row);
        }
        return;
      }
      if (trimmed.length === 0) {
        if (builder.datasetState === "rows") builder.datasetState = "none";
        return;
      }
      builder.datasetState = "none";
    }

    if (trimmed.length === 0) {
      if (current) {
        current.metadataOpen = false;
        current.lastMetadataKey = null;
      }
      return;
    }

    const headingMatch = /^(#{1,6})(?:\s+(.*))?$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const headingText = (headingMatch[2] ?? "").trim();

      if (level === 1) {
        current = newCaseBuilder(headingText, lineNumber);
        builders.push(current);
        return;
      }

      const builder = ensureCase(lineNumber);
      builder.metadataOpen = false;

      const datasetMatch = /^dataset(?:\s*:\s*(.*))?$/i.exec(headingText);
      if (level === 2 && datasetMatch) {
        const name = datasetMatch[1]?.trim();
        builder.dataset = { name: name && name.length > 0 ? name : null, columns: [], rows: [] };
        builder.datasetState = "header";
        return;
      }

      if (level > 2) {
        diagnostics.push({
          line: lineNumber,
          code: "unsupported-heading",
          message: `Level-${level} headings are read as checkpoints; use "## Checkpoint: …".`
        });
      }

      const checkpointMatch = /^checkpoint\s*:\s*(.*)$/i.exec(headingText);
      const title = checkpointMatch ? (checkpointMatch[1] ?? "").trim() : headingText;
      const normalized = normalizeInstructionText(title);
      const occurrence = builder.checkpointOccurrences.get(normalized) ?? 0;
      builder.checkpointOccurrences.set(normalized, occurrence + 1);
      const checkpointId = deriveCheckpointId(title, occurrence);
      builder.checkpoints.push({ checkpointId, title, line: lineNumber, prefixed: checkpointMatch !== null });
      builder.currentCheckpointId = checkpointId;
      return;
    }

    const builder = ensureCase(lineNumber);

    if (builder.metadataOpen) {
      if (builder.lastMetadataKey === "description" && /^\s{2,}\S/.test(rawLine)) {
        builder.metadata.description = `${builder.metadata.description ?? ""}\n${rawLine.replace(/^\s{2}/, "")}`;
        return;
      }
      const metaMatch = /^([A-Za-z][A-Za-z -]*?)\s*:\s*(.*)$/.exec(trimmed);
      const key = metaMatch ? metadataKeyByLabel.get((metaMatch[1] ?? "").toLowerCase()) : undefined;
      if (metaMatch && key) {
        const value = (metaMatch[2] ?? "").trim();
        const applied = applyMetadata(builder.metadata, key, value, lineNumber, diagnostics);
        if (applied && !builder.metadata.order.includes(key)) builder.metadata.order.push(key);
        builder.lastMetadataKey = key;
        return;
      }
      builder.metadataOpen = false;
    }

    const disabled = /^\/\/\s/.test(trimmed);
    const stepText = disabled ? trimmed.replace(/^\/\/\s+/, "") : trimmed;
    builder.steps.push(
      buildStep({
        parts: parseStepLine(stepText),
        line: lineNumber,
        ordinal: builder.steps.length + 1,
        checkpointId: builder.currentCheckpointId,
        disabled
      })
    );
  });

  const cases = builders.map((builder, caseIndex) => {
    const occurrences = new Map<string, number>();
    const derived: TranscriptStep[] = builder.steps.map((step) => {
      const occurrence = occurrences.get(step.instructionKey) ?? 0;
      occurrences.set(step.instructionKey, occurrence + 1);
      return { ...step, stepId: deriveStepId(step.instructionKey, occurrence) };
    });
    const previous = options.previousSteps?.[caseIndex] ?? matchPreviousCase(options.previousCases, builder, caseIndex);

    return {
      title: builder.title,
      line: builder.line,
      metadata: builder.metadata,
      checkpoints: builder.checkpoints,
      steps: previous ? reconcileStepIds(derived, previous) : derived,
      dataset: builder.dataset
    } satisfies ParsedTestCase;
  });

  return { cases, diagnostics };
}

// Returns false when the line carried nothing that serialises back (empty or invalid value).
function matchPreviousCase(
  previousCases: ParseTranscriptOptions["previousCases"],
  builder: CaseBuilder,
  caseIndex: number
): readonly Pick<TranscriptStep, "stepId" | "instructionKey">[] | undefined {
  if (!previousCases) return undefined;
  const key = builder.metadata.key;
  const byKey = key === null ? undefined : previousCases.find((candidate) => candidate.key === key);
  if (byKey) return byKey.steps;
  const title = normalizeInstructionText(builder.title);
  const byTitle = previousCases.filter((candidate) => normalizeInstructionText(candidate.title) === title);
  if (byTitle.length === 1) return byTitle[0]?.steps;
  return previousCases[caseIndex]?.steps;
}

function applyMetadata(
  metadata: TranscriptMetadata,
  key: TranscriptMetadataKey,
  value: string,
  line: number,
  diagnostics: TranscriptDiagnostic[]
): boolean {
  if (value.length === 0 && (nullableMetadataKeys.has(key) || key === "tags" || key === "links" || key === "params" || key === "retries")) {
    return false;
  }
  applyMetadataValue(metadata, key, value, line, diagnostics);
  return serializeMetadataValue(metadata, key) !== null;
}

function applyMetadataValue(
  metadata: TranscriptMetadata,
  key: TranscriptMetadataKey,
  value: string,
  line: number,
  diagnostics: TranscriptDiagnostic[]
): void {
  switch (key) {
    case "key":
      metadata.key = value.length > 0 ? value : null;
      return;
    case "description":
      metadata.description = value;
      return;
    case "tags":
      metadata.tags = splitList(value);
      return;
    case "env":
      metadata.env = value.length > 0 ? value : null;
      return;
    case "links":
      metadata.links = splitList(value);
      return;
    case "params": {
      metadata.params = parseParamDeclarations(value);
      const declared = (splitArgList(value) ?? []).length;
      if (metadata.params.length !== declared) {
        diagnostics.push({ line, code: "invalid-metadata", message: "Params has an entry without a valid name; it was ignored." });
      }
      return;
    }
    case "retries": {
      const retries = Number.parseInt(value, 10);
      if (!Number.isInteger(retries) || retries < 0 || String(retries) !== value) {
        diagnostics.push({ line, code: "invalid-metadata", message: `Retries must be a non-negative integer, got "${value}".` });
        return;
      }
      metadata.retries = retries;
      return;
    }
    case "externalId":
      metadata.externalId = value.length > 0 ? value : null;
      return;
    case "duplicateOf":
      metadata.duplicateOf = value.length > 0 ? value : null;
      return;
  }
}

// Parse a single case. A document holding more than one case is rejected so callers that store
// one case per row cannot silently drop the rest.
export function parseTestCaseTranscript(
  text: string,
  options: { previousSteps?: readonly Pick<TranscriptStep, "stepId" | "instructionKey">[] } = {}
): { testCase: ParsedTestCase; diagnostics: TranscriptDiagnostic[] } {
  const document = parseTranscriptDocument(text, options.previousSteps ? { previousSteps: [options.previousSteps] } : {});
  if (document.cases.length > 1) {
    throw new Error(`Expected one test case, found ${document.cases.length}. Import multi-case documents instead.`);
  }
  const testCase = document.cases[0] ?? {
    title: "",
    line: 1,
    metadata: emptyTranscriptMetadata(),
    checkpoints: [],
    steps: [],
    dataset: null
  };
  return { testCase, diagnostics: document.diagnostics };
}

// ---------------------------------------------------------------------------------------------
// Serialisation (model → document)
// ---------------------------------------------------------------------------------------------

function serializeMetadataValue(metadata: TranscriptMetadata, key: TranscriptMetadataKey): string | null {
  switch (key) {
    case "key":
      return metadata.key;
    case "description":
      return metadata.description === null ? null : metadata.description.split("\n").join("\n  ");
    case "tags":
      return metadata.tags.length > 0 ? serializeList(metadata.tags) : null;
    case "env":
      return metadata.env;
    case "links":
      return metadata.links.length > 0 ? serializeList(metadata.links) : null;
    case "params":
      return metadata.params.length > 0 ? serializeParamDeclarations(metadata.params) : null;
    case "retries":
      return metadata.retries === null ? null : String(metadata.retries);
    case "externalId":
      return metadata.externalId;
    case "duplicateOf":
      return metadata.duplicateOf;
  }
}

function serializeDataset(dataset: TranscriptDataset): string[] {
  const escapeCell = (value: string) => value.replace(/\|/g, "\\|");
  const lines = [dataset.name === null ? "## Dataset" : `## Dataset: ${dataset.name}`];
  if (dataset.columns.length === 0) return lines;
  lines.push(`| ${dataset.columns.map(escapeCell).join(" | ")} |`);
  lines.push(`| ${dataset.columns.map(() => "---").join(" | ")} |`);
  for (const row of dataset.rows) {
    lines.push(`| ${dataset.columns.map((column) => escapeCell(row[column] ?? "")).join(" | ")} |`);
  }
  return lines;
}

export function serializeTestCase(testCase: ParsedTestCase, options: { forceHeading?: boolean } = {}): string {
  const lines: string[] = [];
  const hasMetadata = metadataKeyOrder.some((key) => serializeMetadataValue(testCase.metadata, key) !== null);
  if (testCase.title.length > 0) lines.push(`# ${testCase.title}`);
  else if (options.forceHeading || hasMetadata) lines.push("#");

  const metadataKeys = [
    ...testCase.metadata.order,
    ...metadataKeyOrder.filter((key) => !testCase.metadata.order.includes(key))
  ];
  for (const key of metadataKeys) {
    const value = serializeMetadataValue(testCase.metadata, key);
    if (value !== null) lines.push(`${metadataLabels[key]}: ${value}`);
  }

  const pushBlock = (block: string[]) => {
    if (block.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(...block);
  };

  pushBlock(testCase.steps.filter((step) => step.checkpointId === null).map(serializeStepLine));

  for (const checkpoint of testCase.checkpoints) {
    const heading = checkpoint.prefixed ? `## Checkpoint: ${checkpoint.title}` : `## ${checkpoint.title}`;
    pushBlock([
      heading,
      ...testCase.steps.filter((step) => step.checkpointId === checkpoint.checkpointId).map(serializeStepLine)
    ]);
  }

  if (testCase.dataset) pushBlock(serializeDataset(testCase.dataset));

  return lines.join("\n");
}

export function serializeTranscriptDocument(document: Pick<ParsedTranscriptDocument, "cases">): string {
  const body = document.cases
    .map((testCase, index) => serializeTestCase(testCase, { forceHeading: index > 0 }))
    .join("\n\n");
  return body.length > 0 ? `${body}\n` : "";
}

// Re-derive ordinals, lines, keys and references after a model edit, keeping step ids stable.
export function rebuildTestCase(testCase: ParsedTestCase): ParsedTestCase {
  const { testCase: rebuilt } = parseTestCaseTranscript(serializeTestCase(testCase), { previousSteps: testCase.steps });
  return rebuilt;
}

// ---------------------------------------------------------------------------------------------
// Fingerprint and similarity
// ---------------------------------------------------------------------------------------------

// Exact-duplicate detection: same steps in the same checkpoints, ignoring formatting and metadata.
export function computeTestCaseFingerprint(testCase: Pick<ParsedTestCase, "steps" | "checkpoints">): string {
  const checkpointTitles = new Map(
    testCase.checkpoints.map((checkpoint) => [checkpoint.checkpointId, normalizeInstructionText(checkpoint.title)])
  );
  const canonical = testCase.steps
    .filter((step) => !step.disabled)
    .map((step) => [step.checkpointId === null ? null : (checkpointTitles.get(step.checkpointId) ?? null), step.instructionKey]);
  return `sha256:${sha256Hex(JSON.stringify(canonical))}`;
}

export function textTrigrams(text: string): Set<string> {
  const normalized = ` ${normalizeInstructionText(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  const grams = new Set<string>();
  for (let index = 0; index + 3 <= normalized.length; index += 1) grams.add(normalized.slice(index, index + 3));
  return grams;
}

export function trigramSimilarity(left: string, right: string): number {
  const a = textTrigrams(left);
  const b = textTrigrams(right);
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ---------------------------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------------------------

export const macroParamKindSchema = z.enum(["text", "credential", "url"]);

export const macroParamSchema = z.object({
  name: z.string().regex(argNamePattern),
  required: z.boolean(),
  default: z.string().nullable().default(null),
  kind: macroParamKindSchema.default("text")
});

export const macroDefinitionSchema = z.object({
  name: z.string().regex(tagNamePattern),
  version: z.number().int().positive(),
  params: z.array(macroParamSchema),
  // Steps only: no title or metadata. `{param}` placeholders are replaced by the call's arguments.
  transcript: z.string(),
  status: z.enum(["draft", "active"]).default("active")
});

export const expandedStepSchema = transcriptStepSchema.extend({
  parentStepId: z.string().min(1).nullable(),
  depth: z.number().int().nonnegative(),
  macroVersion: z.number().int().positive().nullable()
});

export type MacroParam = z.infer<typeof macroParamSchema>;
export type MacroDefinition = z.infer<typeof macroDefinitionSchema>;
export type ExpandedStep = z.infer<typeof expandedStepSchema>;

export type MacroExpansionError = {
  stepId: string;
  code: "unknown-macro" | "missing-argument" | "unknown-argument" | "recursive-macro" | "macro-too-deep";
  message: string;
};

export function resolveMacroArguments(
  macro: MacroDefinition,
  args: readonly StepArg[]
): { values: Record<string, string>; errors: string[] } {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  let positional = 0;

  for (const arg of args) {
    if (arg.name === null) {
      const param = macro.params[positional];
      positional += 1;
      if (!param) {
        errors.push(`${macro.name} takes ${macro.params.length} positional argument(s).`);
        continue;
      }
      values[param.name] = arg.value;
      continue;
    }
    const argName = arg.name.toLowerCase();
    const param = macro.params.find((candidate) => candidate.name.toLowerCase() === argName);
    if (!param) {
      errors.push(`${macro.name} has no parameter "${arg.name}".`);
      continue;
    }
    values[param.name] = arg.value;
  }

  for (const param of macro.params) {
    if (values[param.name] !== undefined) continue;
    if (param.default !== null) values[param.name] = param.default;
    else if (param.required) errors.push(`${macro.name} needs "${param.name}".`);
  }

  return { values, errors };
}

const maxMacroDepth = 4;

// Expand macro calls into the steps the runner executes. Expanded steps carry the macro version in
// their instructionKey, so editing a macro invalidates only the scripts of its expanded steps.
export function expandMacros(
  steps: readonly TranscriptStep[],
  macros: readonly MacroDefinition[]
): { steps: ExpandedStep[]; errors: MacroExpansionError[] } {
  const byName = new Map(macros.map((macro) => [macro.name.toLowerCase(), macro]));
  const errors: MacroExpansionError[] = [];
  const out: ExpandedStep[] = [];

  const visit = (step: TranscriptStep, parentStepId: string | null, depth: number, stack: readonly string[]) => {
    const isCall = step.type === "macro" || step.type === "login";
    if (!isCall || step.macro === null) {
      out.push({ ...step, parentStepId, depth, macroVersion: null });
      return;
    }

    const macro = byName.get(step.macro.toLowerCase());
    if (!macro) {
      errors.push({ stepId: step.stepId, code: "unknown-macro", message: `No macro named "${step.macro}".` });
      out.push({ ...step, parentStepId, depth, macroVersion: null });
      return;
    }
    if (stack.includes(macro.name.toLowerCase())) {
      errors.push({ stepId: step.stepId, code: "recursive-macro", message: `Macro "${macro.name}" calls itself.` });
      return;
    }
    if (depth >= maxMacroDepth) {
      errors.push({ stepId: step.stepId, code: "macro-too-deep", message: `Macros nest deeper than ${maxMacroDepth} levels.` });
      return;
    }

    const { values, errors: argErrors } = resolveMacroArguments(macro, step.args);
    for (const message of argErrors) {
      errors.push({
        stepId: step.stepId,
        code: message.includes("has no parameter") || message.includes("positional") ? "unknown-argument" : "missing-argument",
        message
      });
    }

    out.push({ ...step, parentStepId, depth, macroVersion: macro.version });

    const body = parseTranscriptDocument(macro.transcript).cases[0]?.steps ?? [];
    for (const child of body) {
      if (child.disabled) continue;
      const text = substituteVariables(child.text, values);
      const args = child.args.map((arg) => ({ ...arg, value: substituteVariables(arg.value, values) }));
      const references = extractStepReferences([text, ...args.map((arg) => arg.value)]);
      const credentialRefs = new Set(references.credentialRefs);
      if (child.type === "login") {
        const profile = loginProfileArg(args);
        if (profile !== null) credentialRefs.add(profile);
      }
      const instructionKey = `sha256:${sha256Hex(
        JSON.stringify([step.instructionKey, macro.name.toLowerCase(), macro.version, child.instructionKey])
      )}`;
      visit(
        {
          ...child,
          stepId: `${step.stepId}.${child.ordinal}`,
          instructionKey,
          ordinal: step.ordinal,
          line: step.line,
          checkpointId: step.checkpointId,
          text,
          args,
          variables: references.variables,
          credentialRefs: [...credentialRefs],
          fileRefs: references.fileRefs
        },
        step.stepId,
        depth + 1,
        [...stack, macro.name.toLowerCase()]
      );
    }
  };

  for (const step of steps) {
    if (step.disabled) continue;
    visit(step, null, 0, []);
  }

  return { steps: out, errors };
}

// ---------------------------------------------------------------------------------------------
// Lint (design.md §4 writing guidance and §7 inline lint). Rules are data; the editor, import
// preview, MCP and CLI all render the same findings.
// ---------------------------------------------------------------------------------------------

export const lintSeveritySchema = z.enum(["error", "warning", "info"]);

export const lintFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("split-step"), stepId: z.string(), parts: z.array(z.string().min(1)).min(2) }),
  z.object({ kind: z.literal("declare-param"), name: z.string().min(1) }),
  z.object({ kind: z.literal("insert-checkpoint"), beforeStepId: z.string(), title: z.string().min(1) }),
  z.object({ kind: z.literal("change-type"), stepId: z.string(), tag: z.string().min(1) }),
  z.object({ kind: z.literal("replace-text"), stepId: z.string(), text: z.string() }),
  z.object({ kind: z.literal("use-visible-label"), stepId: z.string(), suggestions: z.array(z.string()) })
]);

export const lintFindingSchema = z.object({
  ruleId: z.string().min(1),
  severity: lintSeveritySchema,
  message: z.string().min(1),
  stepId: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  fix: lintFixSchema.nullable()
});

export type LintSeverity = z.infer<typeof lintSeveritySchema>;
export type LintFix = z.infer<typeof lintFixSchema>;
export type LintFinding = z.infer<typeof lintFindingSchema>;

export type TranscriptLintContext = {
  // Org macro names; when given, unknown macro tags are errors.
  macros?: readonly Pick<MacroDefinition, "name" | "params">[];
  // Variable names the environment provides (`vars.KEY`); when given, other names must be declared.
  environmentVariables?: readonly string[];
  // Element names observed in the last run's snapshots ("menuitem Đăng xuất"), used for fix suggestions.
  elementNames?: readonly string[];
};

export type TranscriptLintRule = {
  id: string;
  severity: LintSeverity;
  source: "design §4" | "design §7";
  description: string;
  check: (testCase: ParsedTestCase, context: TranscriptLintContext) => Omit<LintFinding, "ruleId" | "severity">[];
};

// `\b` only knows ASCII letters; these boundaries also hold for Vietnamese words.
const words = (alternatives: string, flags = "iu") =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, flags);

const fileExtensions = "xlsx|xls|csv|pdf|png|jpe?g|gif|docx?|pptx?|json|txt|zip|md|html?";
const selectorPattern = new RegExp(
  [
    // #id or .class tokens, but not file extensions such as ".xlsx"
    `(?:^|\\s)#[A-Za-z][\\w-]*`,
    `(?:^|\\s)\\.(?!(?:${fileExtensions})(?![\\w-]))[A-Za-z][\\w-]*(?=$|[\\s>\\[:.,])`,
    // tag.class, tag#id, attribute selectors and combinators between CSS-like tokens
    `\\b(?:div|span|button|input|a|li|ul|form|table|tr|td|select|label)[#.][\\w-]+`,
    `\\[(?:data-[\\w-]+|id|class|name|aria-[\\w-]+|type|role)=`,
    `\\b(?:div|span|button|input|li|ul|form|table|tr|td|[\\w-]*[#.][\\w-]+)\\s*>\\s*(?:div|span|button|input|a|li|ul|form|[#.][\\w-]+)`,
    `\\bxpath\\b`,
    `\\bcss selector\\b`,
    `querySelector`,
    `//[a-z]+\\[`
  ].join("|"),
  "i"
);
const thenSplitPattern = new RegExp(
  `\\s*(?:,\\s*)?${words("and then|then|sau đó|và sau đó|rồi sau đó").source}\\s*|\\s*,\\s*rồi\\s+`,
  "iu"
);
const andPattern = new RegExp(words("and|và").source, "giu");
const imperativeVerbPattern = new RegExp(`^${words("click|press|tap|type|fill in|fill|submit|nhấn|bấm|nhập|điền|gõ").source}`, "iu");
const objectVerbPattern = new RegExp(
  `^${words("open|select|choose|go to|navigate to|mở|chọn|vào").source}\\s+(?:the|a|an|on|to|"|nút|menu|popup|trang|tab|mục|link|dialog|modal|button)(?![\\p{L}\\p{N}])`,
  "iu"
);
const vagueAssertPattern = /^(?:works|ok|okay|correct|fine|đúng|ổn|it works|looks good|đúng rồi|thành công)\.?$/iu;
const secretWordPattern = words("password|passcode|passwd|pwd|pin|mật khẩu|mã pin|otp");
const secretColumnPattern = /pass|pwd|secret|token|otp|pin|mật khẩu/i;

const maxLintTextLength = 2000;

// A token that looks like a credential: mixes letters with digits or symbols, or is a 4+ digit code.
function looksLikeSecretToken(token: string): boolean {
  const value = token.replace(/^["'(]+|["'),.;:]+$/g, "");
  if (value.length < 4 || value.length > 128) return false;
  if (/^\{.*\}$/.test(value) || /^(?:https?:)?\/\//i.test(value) || /^\/[\w/-]*$/.test(value)) return false;
  if (/^\d{4,}$/.test(value)) return true;
  if (value.length < 6) return false;
  const hasLetter = /\p{L}/u.test(value);
  const hasDigit = /\d/.test(value);
  const hasSymbol = /[^\p{L}\p{N}]/u.test(value);
  return hasLetter && (hasDigit || (hasSymbol && /\p{Lu}/u.test(value)));
}

function containsSecretValue(text: string): boolean {
  const capped = text.length > maxLintTextLength ? text.slice(0, maxLintTextLength) : text;
  if (!secretWordPattern.test(capped)) return false;
  const withoutRefs = capped.replace(/\{[^{}]*\}/g, " ");
  return withoutRefs.split(/\s+/).some(looksLikeSecretToken);
}

const stripQuoted = (text: string) => text.replace(/"[^"]*"|“[^”]*”/g, (match) => "_".repeat(match.length));

const stepFinding = (step: TranscriptStep, message: string, fix: LintFix | null = null) => ({
  message,
  stepId: step.stepId,
  line: step.line,
  fix
});

const activeSteps = (testCase: ParsedTestCase) => testCase.steps.filter((step) => !step.disabled);

function suggestLabels(text: string, elementNames: readonly string[] = []): string[] {
  if (elementNames.length === 0) return [];
  return elementNames
    .map((name) => ({ name, score: trigramSimilarity(text, name) }))
    .filter((entry) => entry.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((entry) => entry.name);
}

export const transcriptLintRules: readonly TranscriptLintRule[] = [
  {
    id: "missing-title",
    severity: "error",
    source: "design §7",
    description: "A case starts with a level-1 heading that is its title.",
    check: (testCase) =>
      testCase.title.trim().length === 0
        ? [{ message: "The case has no title. Start it with \"# <title>\".", stepId: null, line: testCase.line, fix: null }]
        : []
  },
  {
    id: "selector-in-instruction",
    severity: "warning",
    source: "design §4",
    description: "Instructions name visible labels, not CSS or XPath selectors.",
    check: (testCase, context) =>
      activeSteps(testCase)
        .filter((step) => ["act", "assert", "wait"].includes(step.type) && selectorPattern.test(step.text))
        .map((step) =>
          stepFinding(step, "Selector in instruction; use the visible label instead.", {
            kind: "use-visible-label",
            stepId: step.stepId,
            suggestions: suggestLabels(step.text, context.elementNames)
          })
        )
  },
  {
    id: "multiple-intents",
    severity: "warning",
    source: "design §4",
    description: "One user intent per step.",
    check: (testCase) =>
      activeSteps(testCase)
        .filter((step) => step.type === "act")
        .flatMap((step) => {
          const text = step.text.slice(0, maxLintTextLength);
          const masked = stripQuoted(text);
          const parts: string[] = [];
          let rest = 0;
          const splitter = new RegExp(thenSplitPattern.source, "giu");
          for (const match of masked.matchAll(splitter)) {
            parts.push(text.slice(rest, match.index));
            rest = match.index + match[0].length;
          }
          parts.push(text.slice(rest));
          const nonEmpty = parts.map((part) => part.trim()).filter((part) => part.length > 0);
          if (nonEmpty.length >= 2) {
            return [
              stepFinding(step, "Two intents in one step; split it.", { kind: "split-step", stepId: step.stepId, parts: nonEmpty })
            ];
          }
          const ands = masked.match(andPattern)?.length ?? 0;
          return ands >= 2 ? [stepFinding(step, "Several intents in one step; split it.")] : [];
        })
  },
  {
    id: "action-in-assert",
    severity: "warning",
    source: "design §4",
    description: "Actions are separate from asserts; an assert only checks the screen.",
    check: (testCase) =>
      activeSteps(testCase)
        .filter((step) => step.type === "assert" && (imperativeVerbPattern.test(step.text) || objectVerbPattern.test(step.text)))
        .map((step) =>
          stepFinding(step, "This assert performs an action; make it an [Act] step.", {
            kind: "change-type",
            stepId: step.stepId,
            tag: "Act"
          })
        )
  },
  {
    id: "vague-assert",
    severity: "warning",
    source: "design §4",
    description: "Asserts state a specific expected result.",
    check: (testCase) =>
      activeSteps(testCase)
        .filter((step) => step.type === "assert")
        .filter((step) => {
          const text = step.text.trim();
          return text.split(/\s+/).filter((word) => word.length > 0).length < 2 || vagueAssertPattern.test(text);
        })
        .map((step) => stepFinding(step, "Assert is too vague; say what must be visible."))
  },
  {
    id: "assert-without-checkpoint",
    severity: "info",
    source: "design §7",
    description: "Asserts belong to a checkpoint heading so reports group them.",
    check: (testCase) =>
      activeSteps(testCase)
        .filter((step) => step.type === "assert" && step.checkpointId === null)
        .map((step) =>
          stepFinding(step, "Assert without a checkpoint.", {
            kind: "insert-checkpoint",
            beforeStepId: step.stepId,
            title: step.text.length > 60 ? `${step.text.slice(0, 57)}...` : step.text || "Checkpoint"
          })
        )
  },
  {
    id: "login-needs-profile",
    severity: "error",
    source: "design §4",
    description: "[Login] names a credential profile, e.g. [Login: PCF_HQ_ADMIN].",
    check: (testCase) =>
      activeSteps(testCase)
        .filter((step) => step.type === "login" && loginProfileArg(step.args) === null)
        .map((step) => stepFinding(step, "[Login] needs a credential profile, e.g. [Login: PCF_HQ_ADMIN]."))
  },
  {
    id: "missing-argument",
    severity: "error",
    source: "design §4",
    description: "[Open] needs a URL or path, [Wait] a condition, [Extract] a variable name.",
    check: (testCase) =>
      activeSteps(testCase).flatMap((step) => {
        if (step.type === "open" && step.text.length === 0) return [stepFinding(step, "[Open] needs a URL or path.")];
        if (step.type === "wait" && step.text.length === 0) return [stepFinding(step, "[Wait] needs a condition.")];
        if (step.type === "extract") {
          const name = step.args.find((arg) => arg.name === null)?.value ?? "";
          if (!variableNamePattern.test(name)) return [stepFinding(step, "[Extract] needs a variable name, e.g. [Extract: orderId].")];
        }
        if (step.type === "act" && step.text.length === 0) return [stepFinding(step, "Empty step.")];
        if (step.type === "assert" && step.text.length === 0) return [stepFinding(step, "Empty assert.")];
        return [];
      })
  },
  {
    id: "possible-secret",
    severity: "error",
    source: "design §4",
    description: "Secrets are never written in transcripts, params, descriptions or datasets; use a credential profile.",
    check: (testCase) => {
      const message = "Looks like a secret value; reference a credential profile with {cred:PROFILE.field}.";
      const findings: Omit<LintFinding, "ruleId" | "severity">[] = activeSteps(testCase)
        .filter((step) => containsSecretValue([step.text, ...step.args.map((arg) => `${arg.name ?? ""} ${arg.value}`)].join(" ")))
        .map((step) => stepFinding(step, message));

      const metadataTexts = [
        testCase.metadata.description ?? "",
        ...testCase.metadata.params.map((param) => `${param.name} ${param.default ?? ""}`)
      ];
      if (metadataTexts.some(containsSecretValue)) {
        findings.push({ message: `${message} (metadata)`, stepId: null, line: testCase.line, fix: null });
      }
      const dataset = testCase.dataset;
      if (dataset) {
        const secretColumns = dataset.columns.filter((column) => secretColumnPattern.test(column));
        const leaks = dataset.rows.some((row) =>
          secretColumns.some((column) => {
            const value = (row[column] ?? "").trim();
            return value.length > 0 && !/^\{.*\}$/.test(value);
          })
        );
        if (leaks) findings.push({ message: `${message} (dataset column ${secretColumns.join(", ")})`, stepId: null, line: testCase.line, fix: null });
      }
      return findings;
    }
  },
  {
    id: "unknown-macro",
    severity: "error",
    source: "design §4",
    description: "Any non-builtin tag must be an organisation macro.",
    check: (testCase, context) => {
      const macros = context.macros;
      if (!macros) return [];
      const known = new Map(macros.map((macro) => [macro.name.toLowerCase(), macro]));
      return activeSteps(testCase).flatMap((step) => {
        if ((step.type !== "macro" && step.type !== "login") || step.macro === null) return [];
        const macro = known.get(step.macro.toLowerCase());
        if (!macro) return [stepFinding(step, `No macro named "${step.macro}".`)];
        const resolved = resolveMacroArguments(
          { name: macro.name, params: macro.params, version: 1, transcript: "", status: "active" },
          step.args
        );
        return resolved.errors.map((message) => stepFinding(step, message));
      });
    }
  },
  {
    id: "undeclared-variable",
    severity: "warning",
    source: "design §7",
    description: "Every {variable} is a case param, dataset column, extracted value or environment variable.",
    check: (testCase, context) => {
      const known = new Set<string>([
        ...testCase.metadata.params.map((param) => param.name),
        ...(testCase.dataset?.columns ?? []),
        ...(context.environmentVariables ?? [])
      ]);
      const reported = new Set<string>();
      const findings: Omit<LintFinding, "ruleId" | "severity">[] = [];
      for (const step of activeSteps(testCase)) {
        for (const name of step.variables) {
          if (known.has(name) || reported.has(name)) continue;
          reported.add(name);
          findings.push(stepFinding(step, `Undeclared variable {${name}}.`, { kind: "declare-param", name }));
        }
        if (step.type === "extract") {
          const name = step.args.find((arg) => arg.name === null)?.value;
          if (name) known.add(name);
        }
      }
      return findings;
    }
  },
  {
    id: "no-assert",
    severity: "warning",
    source: "design §4",
    description: "A case needs at least one [Assert] or [Wait]; without a verified checkpoint no Act step is cached.",
    check: (testCase) =>
      activeSteps(testCase).length > 0 && !activeSteps(testCase).some((step) => step.type === "assert" || step.type === "wait")
        ? [
            {
              message: "No [Assert] step. Without a checkpoint no Act step is ever cached.",
              stepId: null,
              line: testCase.line,
              fix: null
            }
          ]
        : []
  },
  {
    id: "step-count",
    severity: "info",
    source: "design §4",
    description: "Cases read best with 3 to 15 steps.",
    check: (testCase) => {
      const count = activeSteps(testCase).filter((step) => step.type !== "note").length;
      if (count === 0 || (count >= 3 && count <= 15)) return [];
      return [
        {
          message: count < 3 ? `Only ${count} step(s); a case usually has 3 to 15.` : `${count} steps; consider splitting into smaller cases or a macro.`,
          stepId: null,
          line: testCase.line,
          fix: null
        }
      ];
    }
  }
];

export function lintTestCase(testCase: ParsedTestCase, context: TranscriptLintContext = {}): LintFinding[] {
  return transcriptLintRules.flatMap((rule) =>
    rule.check(testCase, context).map((finding) => ({ ruleId: rule.id, severity: rule.severity, ...finding }))
  );
}

export function applyLintFix(testCase: ParsedTestCase, fix: LintFix): ParsedTestCase {
  switch (fix.kind) {
    case "declare-param": {
      if (testCase.metadata.params.some((param) => param.name === fix.name)) return testCase;
      const order: TranscriptMetadataKey[] = testCase.metadata.order.includes("params")
        ? testCase.metadata.order
        : [...testCase.metadata.order, "params"];
      return {
        ...testCase,
        metadata: {
          ...testCase.metadata,
          order,
          params: [...testCase.metadata.params, { name: fix.name, default: null, required: true }]
        }
      };
    }
    case "split-step": {
      const steps = testCase.steps.flatMap((step) =>
        step.stepId === fix.stepId ? fix.parts.map((text) => ({ ...step, text })) : [step]
      );
      return rebuildTestCase({ ...testCase, steps });
    }
    case "change-type":
      return rebuildTestCase({
        ...testCase,
        steps: testCase.steps.map((step) => (step.stepId === fix.stepId ? { ...step, tag: fix.tag, args: [] } : step))
      });
    case "replace-text":
      return rebuildTestCase({
        ...testCase,
        steps: testCase.steps.map((step) => (step.stepId === fix.stepId ? { ...step, text: fix.text } : step))
      });
    case "use-visible-label": {
      const suggestion = fix.suggestions[0];
      if (suggestion === undefined) return testCase;
      return applyLintFix(testCase, { kind: "replace-text", stepId: fix.stepId, text: suggestion });
    }
    case "insert-checkpoint":
      return insertCheckpointBefore(testCase, fix.beforeStepId, fix.title);
  }
}

function insertCheckpointBefore(testCase: ParsedTestCase, stepId: string, title: string): ParsedTestCase {
  const index = testCase.steps.findIndex((step) => step.stepId === stepId);
  const target = testCase.steps[index];
  if (!target) return testCase;

  const occurrence = testCase.checkpoints.filter(
    (checkpoint) => normalizeInstructionText(checkpoint.title) === normalizeInstructionText(title)
  ).length;
  const checkpoint: TranscriptCheckpoint = {
    checkpointId: deriveCheckpointId(title, occurrence),
    title,
    line: target.line,
    prefixed: true
  };

  const steps = testCase.steps.map((step, stepIndex) =>
    stepIndex >= index && step.checkpointId === target.checkpointId ? { ...step, checkpointId: checkpoint.checkpointId } : step
  );
  const after = target.checkpointId === null ? -1 : testCase.checkpoints.findIndex((c) => c.checkpointId === target.checkpointId);
  const checkpoints = [...testCase.checkpoints];
  checkpoints.splice(after + 1, 0, checkpoint);

  return rebuildTestCase({ ...testCase, checkpoints, steps });
}
