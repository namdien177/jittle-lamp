import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { importBatchSchema, parseTranscriptDocument, type ImportBatch, type ImportItem } from "@jittle-lamp/shared";

import {
  applyDecisionToSimilar,
  batchOverview,
  decisionOptions,
  importErrorsCsv,
  lintCounts,
  similarityClass
} from "../apps/evidence-web/src/test-cases/import/batch-state";
import { detectCsvDelimiter, parseCsv, rowsToRecords, toCsv } from "../apps/evidence-web/src/test-cases/import/csv";
import { gherkinToTranscript } from "../apps/evidence-web/src/test-cases/import/gherkin";
import {
  guessImportMapping,
  mappingIsUsable,
  previewMappedRows,
  rowToTranscript,
  splitCellLines,
  toImportMapping
} from "../apps/evidence-web/src/test-cases/import/mapping";
import { bytesToBase64, columnIndexFromRef, readXlsxRows } from "../apps/evidence-web/src/test-cases/import/xlsx";

import {
  activeReplacements,
  applyReplacements,
  countReplacements,
  defaultDuplicateTitle,
  estimateInheritedSteps,
  parseDuplicateParam,
  parseTagInput,
  replacementSegments
} from "../apps/evidence-web/src/test-cases/duplicate/find-replace";
import {
  caseEditorHref,
  cleanCaseIds,
  initialReviewQueueState,
  reviewKeyCommand,
  reviewQueueReducer,
  type ReviewKeyInput
} from "../apps/evidence-web/src/test-cases/review/review-queue-state";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "e2e", name), "utf8");

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","line 1\nline 2"\r\n\r\n1,2,3');
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["x, y", 'he said "hi"', "line 1\nline 2"],
      ["1", "2", "3"]
    ]);
  });

  it("detects semicolon and tab delimiters from the header line", () => {
    expect(detectCsvDelimiter("Title;Steps;Expected\nA;B;C")).toBe(";");
    expect(detectCsvDelimiter("Title\tSteps\nA\tB")).toBe("\t");
    expect(detectCsvDelimiter('"a;b",c,d\n1,2,3')).toBe(",");
  });

  it("names blank and repeated headers and drops blank rows", () => {
    const data = rowsToRecords([
      ["Title", "", "Title"],
      ["A", "x", "B"],
      ["", " ", ""]
    ]);
    expect(data.headers).toEqual(["Title", "Column 2", "Title (2)"]);
    expect(data.records).toEqual([{ Title: "A", "Column 2": "x", "Title (2)": "B" }]);
  });

  it("writes CSV that parses back and neutralises formulas", () => {
    const csv = toCsv([
      ["row", "error"],
      ["1", 'bad "quote", and\nnewline'],
      ["2", "=HYPERLINK(1)"]
    ]);
    expect(parseCsv(csv)).toEqual([
      ["row", "error"],
      ["1", 'bad "quote", and\nnewline'],
      ["2", "'=HYPERLINK(1)"]
    ]);
  });
});

describe("column mapping", () => {
  const sheet = rowsToRecords(parseCsv(fixture("regression-sheet.csv")));

  it("guesses the mapping from common header names", () => {
    expect(guessImportMapping(sheet.headers)).toEqual({
      title: "Title",
      preconditions: "Precondition",
      steps: "Steps",
      expected: "Expected",
      id: "ID",
      tags: "Module"
    });
    expect(guessImportMapping(["Test Case Name", "Test Steps", "Expected Results", "Issue key", "Labels"])).toEqual({
      title: "Test Case Name",
      steps: "Test Steps",
      expected: "Expected Results",
      id: "Issue key",
      tags: "Labels"
    });
  });

  it("splits cells by newline and inline numbering and strips markers", () => {
    expect(splitCellLines("1. Open the menu 2. Click logout")).toEqual(["Open the menu", "Click logout"]);
    expect(splitCellLines("- first\n* second\n\n• third")).toEqual(["first", "second", "third"]);
    expect(splitCellLines("Step 1: open\nStep 2: close")).toEqual(["open", "close"]);
    expect(splitCellLines("Click the 2. button once")).toEqual(["Click the 2. button once"]);
  });

  it("turns a row into a parseable case with external id, tags, acts and a checkpoint", () => {
    const mapping = guessImportMapping(sheet.headers);
    const transcript = rowToTranscript(sheet.records[0] as Record<string, string>, mapping, { defaultTags: ["import:sheet"] });
    expect(transcript).toBe(
      [
        "# Login as HQ admin",
        "External-id: PCF-101",
        "Tags: import:sheet, admin",
        "",
        "[Open] /login",
        "[Login: PCF_HQ_ADMIN] sign in as HQ admin",
        "[Act] Open the account menu",
        '[Act] Click "Đăng xuất"',
        "",
        "## Checkpoint: Expected result",
        "[Assert] The login form is shown with an empty Email field",
        ""
      ].join("\n")
    );
    const parsed = parseTranscriptDocument(transcript);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0]?.metadata.externalId).toBe("PCF-101");
    expect(parsed.cases[0]?.steps.map((step) => step.type)).toEqual(["open", "login", "act", "act", "assert"]);
  });

  it("previews rows with lint and flags rows that cannot import", () => {
    const mapping = guessImportMapping(sheet.headers);
    const preview = previewMappedRows(sheet.records, mapping);
    expect(preview.map((row) => row.title)).toEqual([
      "Login as HQ admin",
      "Reset password with expired link",
      "Export fee report",
      ""
    ]);
    expect(preview[0]?.problem).toBeNull();
    expect(preview[1]?.stepCount).toBe(5);
    expect(preview[2]?.lint.some((finding) => finding.ruleId === "selector-in-instruction")).toBe(true);
    expect(preview[3]?.problem).toBe("Empty title");
    expect(previewMappedRows(sheet.records, { steps: "Steps" }, { limit: 1 })[0]?.problem).toBe("No title column mapped");
  });

  it("requires a title and a step column, and drops unmapped fields", () => {
    expect(mappingIsUsable({ title: "Title" })).toBe(false);
    expect(mappingIsUsable({ title: "Title", expected: "Expected" })).toBe(true);
    expect(toImportMapping({ title: "Title", steps: "", tags: "Module" })).toEqual({ title: "Title", tags: "Module" });
  });
});

describe("XLSX reading", () => {
  const workbook = (sheetXml: string, shared: string[]) =>
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Cases" sheetId="1" r:id="rId7"/></sheets></workbook>'),
      "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/cases.xml"/></Relationships>'),
      "xl/sharedStrings.xml": strToU8(`<sst>${shared.map((text) => `<si>${text}</si>`).join("")}</sst>`),
      "xl/worksheets/cases.xml": strToU8(sheetXml)
    });

  it("reads shared, rich and inline strings, numbers and sparse cells from the first sheet", () => {
    const bytes = workbook(
      [
        "<worksheet><sheetData>",
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Tags</t></is></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="s"><v>3</v></c></row>',
        '<row r="3"/>',
        "</sheetData></worksheet>"
      ].join(""),
      ["<t>Title</t>", "<t>Count</t>", "<r><t>Login &amp; </t></r><r><t xml:space=\"preserve\">logout</t></r>", "<t>a, b</t>"]
    );
    expect(readXlsxRows(bytes)).toEqual([
      ["Title", "Count", "", "Tags"],
      ["Login & logout", "42", "TRUE", "a, b"]
    ]);
  });

  it("maps column letters and rejects non-zip input", () => {
    expect(columnIndexFromRef("A1")).toBe(0);
    expect(columnIndexFromRef("Z9")).toBe(25);
    expect(columnIndexFromRef("AA10")).toBe(26);
    expect(() => readXlsxRows(strToU8("not a zip"))).toThrow("not a valid .xlsx");
  });

  it("base64-encodes bytes for the import request", () => {
    expect(bytesToBase64(strToU8("hello"))).toBe("aGVsbG8=");
  });
});

describe("Gherkin preview", () => {
  it("maps Given/When to Act, Then to Assert, Background first and outlines to datasets", () => {
    const preview = gherkinToTranscript(fixture("parent-portal.feature"));
    expect(preview.feature).toBe("Parent portal login");
    expect(preview.scenarios).toBe(2);
    const parsed = parseTranscriptDocument(preview.document);
    expect(parsed.diagnostics).toEqual([]);
    const [first, second] = parsed.cases;
    expect(first?.title).toBe("Parent signs in with email and OTP");
    expect(first?.metadata.tags).toEqual(["team:qa-pcf", "feature:parent-portal"]);
    expect(first?.steps.map((step) => `${step.type}:${step.text}`)).toEqual([
      "act:I open the parent portal login page",
      "act:I enter the primary applicant email",
      "act:I submit the one-time code {OTP_CODE}",
      "assert:the dashboard shows the child's name",
      'assert:the menu shows "Đăng xuất"'
    ]);
    expect(first?.checkpoints.map((checkpoint) => checkpoint.title)).toEqual(["the dashboard shows the child's name"]);
    expect(second?.metadata.tags).toEqual(["team:qa-pcf", "feature:parent-portal", "prio:p1"]);
    expect(second?.metadata.params.map((param) => param.name)).toEqual(["role", "otp"]);
    expect(second?.steps[1]?.text).toBe('I sign in as {role} with OTP "{otp}"');
    expect(second?.dataset?.rows).toEqual([
      { role: "parent", otp: "000000" },
      { role: "guardian", otp: "111111" }
    ]);
  });

  it("returns an empty document for a file without scenarios", () => {
    expect(gherkinToTranscript("Feature: nothing yet\n")).toEqual({ feature: "nothing yet", scenarios: 0, document: "" });
  });
});

describe("import batch page logic", () => {
  const item = (overrides: Partial<ImportItem> & Pick<ImportItem, "id" | "ordinal">): ImportItem => ({
    externalId: null,
    title: `Row ${overrides.ordinal}`,
    transcript: "# Row\n[Act] a\n",
    lint: [],
    similar: [],
    decision: "create",
    resultTestCaseId: null,
    error: null,
    state: "ready",
    ...overrides
  });
  const exact = { id: "c1", key: "TC-0412", title: "Login", score: 1, exact: true };
  const near = { id: "c2", key: "TC-0988", title: "Enrol", score: 0.71, exact: false };
  const items: ImportItem[] = [
    item({ id: "i1", ordinal: 0, similar: [near, exact] }),
    item({ id: "i2", ordinal: 1, similar: [exact] }),
    item({ id: "i3", ordinal: 2, similar: [near] }),
    item({ id: "i4", ordinal: 3 }),
    item({ id: "i5", ordinal: 4, similar: [exact], state: "committed" }),
    item({
      id: "i6",
      ordinal: 5,
      state: "error",
      error: "Title is empty",
      lint: [{ ruleId: "missing-title", severity: "error", message: "A case needs a title.", stepId: null, line: 1, fix: null }]
    })
  ];

  it("classifies exact and near duplicates and offers update/merge only with a match", () => {
    expect(items.map(similarityClass)).toEqual(["exact", "exact", "near", "none", "exact", "none"]);
    expect(decisionOptions(items[0] as ImportItem).map((option) => option.label)).toEqual(["Create new", "Update TC-0412", "Merge into TC-0412", "Skip"]);
    expect(decisionOptions(items[3] as ImportItem).map((option) => option.value)).toEqual(["create", "skip"]);
  });

  it("applies a decision to every editable row in the same similarity class", () => {
    expect(applyDecisionToSimilar(items, items[0] as ImportItem, "skip")).toEqual([{ itemId: "i2", decision: "skip" }]);
    expect(applyDecisionToSimilar(items, items[3] as ImportItem, "update")).toEqual([]);
    expect(applyDecisionToSimilar(items, items[2] as ImportItem, "merge")).toEqual([]);
  });

  it("summarises progress, duplicates and pending decisions", () => {
    const batch: ImportBatch = importBatchSchema.parse({
      id: "b1",
      sourceKind: "csv",
      status: "committing",
      counts: { total: 6, created: 2, updated: 0, skipped: 1, errors: 0 },
      createdBy: "u1",
      createdAt: 1,
      items
    });
    const overview = batchOverview(batch);
    expect(overview).toMatchObject({ percent: 50, active: true, exact: 3, near: 1, lintErrors: 1, toCreate: 4, toSkip: 0 });
    expect(batchOverview({ ...batch, status: "done" }).percent).toBe(100);
    expect(lintCounts(items[5]?.lint ?? [])).toEqual({ errors: 1, warnings: 0, infos: 0 });
  });

  it("writes an error CSV with failed rows and lint errors", () => {
    const csv = importErrorsCsv(items);
    expect(parseCsv(csv)).toEqual([
      ["row", "external_id", "title", "state", "error", "lint_errors"],
      ["6", "", "Row 5", "error", "Title is empty", "line 1: A case needs a title."]
    ]);
  });
});

const key = (input: Partial<ReviewKeyInput> & Pick<ReviewKeyInput, "key">): ReviewKeyInput => ({
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  editableTarget: false,
  ...input
});

describe("review queue state", () => {
  it("moves within bounds and keeps the selection on sync", () => {
    let state = initialReviewQueueState(["a", "b", "c"]);
    expect(state.selectedId).toBe("a");
    state = reviewQueueReducer(state, { type: "move", delta: -1 });
    expect(state.selectedId).toBe("a");
    state = reviewQueueReducer(state, { type: "move", delta: 1 });
    state = reviewQueueReducer(state, { type: "move", delta: 1 });
    state = reviewQueueReducer(state, { type: "move", delta: 1 });
    expect(state.selectedId).toBe("c");
    state = reviewQueueReducer(state, { type: "sync", ids: ["c", "d"] });
    expect(state).toEqual({ ids: ["c", "d"], selectedId: "c", rejecting: false });
  });

  it("selects the next case after approving, the previous when it was last", () => {
    let state = reviewQueueReducer(initialReviewQueueState(["a", "b", "c"]), { type: "select", id: "b" });
    state = reviewQueueReducer(state, { type: "removed", ids: ["b"] });
    expect(state.selectedId).toBe("c");
    state = reviewQueueReducer(state, { type: "removed", ids: ["c"] });
    expect(state.selectedId).toBe("a");
    state = reviewQueueReducer(state, { type: "removed", ids: ["a"] });
    expect(state).toEqual({ ids: [], selectedId: null, rejecting: false });
  });

  it("keeps the position when the selected case disappears on refresh", () => {
    const state = reviewQueueReducer(reviewQueueReducer(initialReviewQueueState(["a", "b", "c"]), { type: "select", id: "b" }), {
      type: "sync",
      ids: ["a", "c"]
    });
    expect(state.selectedId).toBe("c");
  });

  it("opens and cancels the reject reason, which also blocks other keys", () => {
    let state = reviewQueueReducer(initialReviewQueueState(["a"]), { type: "start-reject" });
    expect(state.rejecting).toBe(true);
    expect(reviewKeyCommand(key({ key: "a" }), { canApprove: true, rejecting: true })).toBeNull();
    expect(reviewKeyCommand(key({ key: "Escape" }), { canApprove: true, rejecting: true })).toBe("cancel");
    state = reviewQueueReducer(state, { type: "cancel-reject" });
    expect(state.rejecting).toBe(false);
    expect(reviewQueueReducer(initialReviewQueueState([]), { type: "start-reject" }).rejecting).toBe(false);
  });

  it("maps a, x, e, shift+a and navigation keys, respecting permission and focus", () => {
    const can = { canApprove: true, rejecting: false };
    expect(reviewKeyCommand(key({ key: "a" }), can)).toBe("approve");
    expect(reviewKeyCommand(key({ key: "A", shiftKey: true }), can)).toBe("approve-clean");
    expect(reviewKeyCommand(key({ key: "x" }), can)).toBe("reject");
    expect(reviewKeyCommand(key({ key: "e" }), can)).toBe("edit");
    expect(reviewKeyCommand(key({ key: "j" }), can)).toBe("next");
    expect(reviewKeyCommand(key({ key: "ArrowUp" }), can)).toBe("previous");
    expect(reviewKeyCommand(key({ key: "a", metaKey: true }), can)).toBeNull();
    expect(reviewKeyCommand(key({ key: "a", editableTarget: true }), can)).toBeNull();
    const viewer = { canApprove: false, rejecting: false };
    expect(reviewKeyCommand(key({ key: "a" }), viewer)).toBeNull();
    expect(reviewKeyCommand(key({ key: "x" }), viewer)).toBeNull();
    expect(reviewKeyCommand(key({ key: "e" }), viewer)).toBe("edit");
  });

  it("approves only cases without lint warnings or errors with shift+a, and links to the editor", () => {
    expect(
      cleanCaseIds([
        { id: "a", lintErrors: 0, lintWarnings: 0 },
        { id: "b", lintErrors: 0, lintWarnings: 2 },
        { id: "c", lintErrors: 1, lintWarnings: 0 }
      ])
    ).toEqual(["a"]);
    expect(caseEditorHref("tc 1")).toBe("/test-cases?case=tc%201");
  });
});

describe("duplicate find/replace", () => {
  const source = [
    "# HQ admin logout returns a clean login form",
    "",
    "[Open] /login",
    "[Login: PCF_HQ_ADMIN] sign in as HQ_ADMIN",
    "[Act] open the account menu and choose Đăng xuất",
    "",
    "## Checkpoint: Logout returns a clean login form",
    "[Assert] the Email input is empty",
    ""
  ].join("\n");

  it("replaces literally in one pass without chaining and highlights each change", () => {
    const rows = [
      { find: "A", replace: "B" },
      { find: "B", replace: "C" }
    ];
    expect(applyReplacements("AB", rows)).toBe("BC");
    expect(replacementSegments("xAy", rows)).toEqual([
      { text: "x", replaced: false },
      { text: "B", replaced: true, original: "A" },
      { text: "y", replaced: false }
    ]);
    expect(applyReplacements("HQ_ADMIN and HQ", [{ find: "HQ", replace: "BR" }, { find: "HQ_ADMIN", replace: "BRANCH_ADMIN" }])).toBe("BRANCH_ADMIN and BR");
    expect(countReplacements(source, [{ find: "HQ_ADMIN", replace: "BRANCH_ADMIN" }])).toBe(2);
    expect(applyReplacements("a.b", [{ find: ".", replace: "-" }])).toBe("a-b");
  });

  it("ignores empty and repeated find rows", () => {
    expect(activeReplacements([{ find: "", replace: "x" }, { find: "a", replace: "1" }, { find: "a", replace: "2" }])).toEqual([{ find: "a", replace: "1" }]);
    expect(applyReplacements("abc", [])).toBe("abc");
  });

  it("estimates how many steps keep their instruction key and inherit scripts", () => {
    const next = applyReplacements(source, [{ find: "HQ_ADMIN", replace: "BRANCH_ADMIN" }]);
    expect(estimateInheritedSteps(source, next)).toEqual({ unchanged: 3, total: 4 });
    expect(estimateInheritedSteps(source, applyReplacements(source, [{ find: "HQ admin", replace: "Branch admin" }]))).toEqual({ unchanged: 4, total: 4 });
  });

  it("defaults the title, parses tags and the duplicate search param", () => {
    expect(defaultDuplicateTitle("Login")).toBe("Login (copy)");
    expect(parseTagInput(" team:qa-pcf, ,feature:login,team:qa-pcf")).toEqual(["team:qa-pcf", "feature:login"]);
    expect(parseDuplicateParam("a, b,a,,c")).toEqual(["a", "b", "c"]);
    expect(parseDuplicateParam(null)).toEqual([]);
  });
});

