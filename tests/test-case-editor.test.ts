import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { lintTestCase, parseTranscriptDocument, serializeTestCase } from "@jittle-lamp/shared";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { editorCommandAllowed, editorKeyCommand, type EditorKeyContext } from "../packages/ui/src/step-editor/keyboard";
import { StepEditor } from "../packages/ui/src/step-editor/step-editor";
import {
  applyFixToDoc,
  argsFromParamValues,
  convertRowToHeading,
  credentialOptions,
  credentialReference,
  cycleRowType,
  dedupeElementNames,
  detectTrigger,
  docFromTestCase,
  docFromTranscript,
  duplicateRow,
  elementNameFromTarget,
  elementNamesFromRenderedCode,
  emptyEditorDoc,
  extractedNamesBefore,
  formatStepChip,
  groupTagsByNamespace,
  insertElementName,
  insertHeadingAfter,
  insertReference,
  insertRowAfter,
  lintByRow,
  linkLabel,
  mapRowsToSteps,
  moveRow,
  moveRowTo,
  paramValuesFromArgs,
  pasteIntoRow,
  removeRow,
  serializeEditorDoc,
  setRowText,
  suggestElementNames,
  testCaseFromDoc,
  textModeUpdate,
  tokenizeInstruction,
  toggleRowDisabled,
  typeOptions,
  updateMetadata,
  variableOptions,
  withBuiltinMacros,
  type EditorDoc,
  type StepRow
} from "../packages/ui/src/step-editor/model";

const root = join(import.meta.dir, "..");
const exampleTranscript = readFileSync(join(root, "docs/e2e-test-cases/examples/pcf-logout-clears-email.transcript.md"), "utf8");
const multiCase = readFileSync(join(root, "tests/fixtures/e2e/multi-case.transcript.md"), "utf8");

function exampleDoc(): EditorDoc {
  return docFromTranscript(exampleTranscript);
}

function stepRows(doc: EditorDoc): StepRow[] {
  return doc.rows.filter((row): row is StepRow => row.kind === "step");
}

function rowByText(doc: EditorDoc, needle: string): StepRow {
  const row = stepRows(doc).find((candidate) => candidate.text.includes(needle));
  if (!row) throw new Error(`no row with ${needle}`);
  return row;
}

const loginMacro = {
  name: "Login",
  version: 2,
  params: [{ name: "profile", required: true, default: null, kind: "credential" as const }],
  transcript: "[Open] /login\n[Act] fill Email with {cred:{profile}.username}\n[Act] click \"Đăng nhập\""
};
const selectLevel = {
  name: "Select level",
  version: 1,
  params: [
    { name: "level", required: true, default: null, kind: "text" as const },
    { name: "branch", required: false, default: "HQ", kind: "text" as const }
  ],
  transcript: "[Act] choose {level}"
};

describe("rows are a lossless projection of the transcript", () => {
  test("every fixture case serialises back to exactly serializeTestCase output", () => {
    const cases = [...parseTranscriptDocument(exampleTranscript).cases, ...parseTranscriptDocument(multiCase).cases];
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const testCase of cases) {
      const doc = docFromTestCase(testCase);
      expect(serializeEditorDoc(doc)).toBe(serializeTestCase(testCase));
      const reparsed = testCaseFromDoc(doc);
      expect(reparsed.steps.map((step) => step.stepId)).toEqual(testCase.steps.map((step) => step.stepId));
      expect(reparsed.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual(testCase.checkpoints.map((checkpoint) => checkpoint.checkpointId));
      expect(reparsed.dataset).toEqual(testCase.dataset);
      expect(reparsed.metadata.tags).toEqual(testCase.metadata.tags);
    }
  });

  test("text → rows → text keeps disabled steps, params, description and dataset", () => {
    const enrol = parseTranscriptDocument(multiCase).cases.find((testCase) => testCase.title.startsWith("Enrol"));
    if (!enrol) throw new Error("fixture changed");
    const text = serializeTestCase(enrol);
    const doc = docFromTranscript(text);
    expect(stepRows(doc).some((row) => row.disabled)).toBe(true);
    expect(serializeEditorDoc(doc)).toBe(text);
    expect(serializeEditorDoc(docFromTranscript(serializeEditorDoc(doc), doc.baseSteps, doc))).toBe(text);
  });

  test("blank rows are dropped from the document but stay in the editor", () => {
    const result = insertRowAfter(exampleDoc(), stepRows(exampleDoc())[0]?.rowId ?? null, { tag: null });
    expect(result.doc.rows.length).toBe(exampleDoc().rows.length + 1);
    expect(serializeEditorDoc(result.doc)).toBe(serializeEditorDoc(exampleDoc()));
  });

  test("unchanged steps keep their ids after an edit elsewhere", () => {
    const doc = exampleDoc();
    const before = testCaseFromDoc(doc);
    const edited = setRowText(doc, rowByText(doc, "input text Email").rowId, "ô Email trống sau khi đăng xuất");
    const after = testCaseFromDoc(edited);
    const unchanged = before.steps.filter((step) => !step.text.includes("input text Email"));
    for (const step of unchanged) expect(after.steps.some((candidate) => candidate.stepId === step.stepId)).toBe(true);
    const changed = after.steps.find((step) => step.text.startsWith("ô Email"));
    expect(before.steps.some((step) => step.stepId === changed?.stepId)).toBe(false);
  });
});

describe("row operations", () => {
  test("Enter adds a row of the same type; macros and logins continue as Act; headings as Assert", () => {
    const doc = exampleDoc();
    const assertRow = rowByText(doc, "dashboard hiện tên trường");
    const afterAssert = insertRowAfter(doc, assertRow.rowId);
    const created = afterAssert.doc.rows.find((row) => row.rowId === afterAssert.focusRowId) as StepRow;
    expect(created.tag).toBe("Assert");
    expect(afterAssert.doc.rows.indexOf(created)).toBe(doc.rows.indexOf(assertRow) + 1);

    const loginRow = rowByText(doc, "HQ_ADMIN");
    const afterLogin = insertRowAfter(doc, loginRow.rowId);
    expect((afterLogin.doc.rows.find((row) => row.rowId === afterLogin.focusRowId) as StepRow).tag).toBe("Act");

    const heading = doc.rows.find((row) => row.kind === "heading");
    const afterHeading = insertRowAfter(doc, heading?.rowId ?? null);
    expect((afterHeading.doc.rows.find((row) => row.rowId === afterHeading.focusRowId) as StepRow).tag).toBe("Assert");
  });

  test("duplicate, move and drag reorder change the document order", () => {
    const doc = exampleDoc();
    const open = rowByText(doc, "/login");
    const duplicated = duplicateRow(doc, open.rowId);
    expect(testCaseFromDoc(duplicated.doc).steps.filter((step) => step.text === "/login")).toHaveLength(2);

    const moved = moveRow(doc, open.rowId, 1);
    expect(serializeEditorDoc(moved.doc).split("\n").slice(2, 4)).toEqual(["[Login: PCF] đăng nhập tài khoản HQ_ADMIN PCF", "[Open] /login"]);
    expect(moveRow(doc, open.rowId, -1).doc.rows).toEqual(doc.rows);

    const last = doc.rows.length - 1;
    const dragged = moveRowTo(doc, open.rowId, last);
    expect(dragged.doc.rows[last]?.rowId).toBe(open.rowId);
    // Dropping a step below a heading moves it into that checkpoint.
    const parsed = testCaseFromDoc(dragged.doc);
    const lastCheckpoint = parsed.checkpoints[parsed.checkpoints.length - 1];
    expect(parsed.steps.find((step) => step.text === "/login")?.checkpointId).toBe(lastCheckpoint?.checkpointId ?? "missing");
  });

  test("⌘/ disables a step without deleting it and serialises it as `// `", () => {
    const doc = exampleDoc();
    const row = rowByText(doc, "/dashboard");
    const disabled = toggleRowDisabled(doc, row.rowId);
    expect(serializeEditorDoc(disabled)).toContain("// [Open] /dashboard");
    expect(testCaseFromDoc(disabled).steps.find((step) => step.text === "/dashboard")?.disabled).toBe(true);
    expect(serializeEditorDoc(toggleRowDisabled(disabled, row.rowId))).toBe(serializeEditorDoc(doc));
  });

  test("Tab on the chip cycles builtin types and wraps", () => {
    const doc = exampleDoc();
    const row = rowByText(doc, "mở menu tài khoản");
    const next = cycleRowType(doc, row.rowId, 1);
    expect((next.rows.find((candidate) => candidate.rowId === row.rowId) as StepRow).tag).toBe("Assert");
    const previous = cycleRowType(doc, row.rowId, -1);
    expect((previous.rows.find((candidate) => candidate.rowId === row.rowId) as StepRow).tag).toBe("Note");
    const note = rowByText(doc, "Covers PCF-1234");
    expect((cycleRowType(doc, note.rowId, 1).rows.find((candidate) => candidate.rowId === note.rowId) as StepRow).tag).toBe("Act");
  });

  test("# on an empty row becomes a checkpoint heading that groups the following asserts", () => {
    const empty = emptyEditorDoc("Case");
    const row = empty.rows[0];
    if (!row) throw new Error("no row");
    const heading = convertRowToHeading(empty, row.rowId);
    const titled = setRowText(heading.doc, row.rowId, "Login works");
    const withAssert = insertRowAfter(titled, row.rowId);
    const filled = setRowText(withAssert.doc, withAssert.focusRowId ?? "", "dashboard is visible");
    expect(serializeEditorDoc(filled)).toBe("# Case\n\n## Checkpoint: Login works\n[Assert] dashboard is visible");
    const parsed = testCaseFromDoc(filled);
    expect(parsed.steps[0]?.checkpointId).toBe(parsed.checkpoints[0]?.checkpointId ?? "missing");
  });

  test("removing the last row leaves one blank row", () => {
    const empty = emptyEditorDoc();
    const result = removeRow(empty, empty.rows[0]?.rowId ?? "");
    expect(result.doc.rows).toHaveLength(1);
    expect(result.focusRowId).toBe(result.doc.rows[0]?.rowId ?? "missing");
  });
});

describe("paste", () => {
  test("multi-line text splits into rows through the parser, list markers stripped", () => {
    const empty = emptyEditorDoc("Pasted");
    const result = pasteIntoRow(empty, empty.rows[0]?.rowId ?? "", "1. Open the login page\n- [Assert] the login form is visible\n\n## Checkpoint: Done\n* [Screenshot] form");
    if (result.kind !== "rows") throw new Error(`unexpected ${result.kind}`);
    expect(result.added).toBe(4);
    expect(serializeEditorDoc(result.doc)).toBe(
      "# Pasted\n\nOpen the login page\n[Assert] the login form is visible\n\n## Checkpoint: Done\n[Screenshot] form"
    );
  });

  test("a document with several titled cases is offered as a split, single lines are left to the input", () => {
    const empty = emptyEditorDoc();
    const result = pasteIntoRow(empty, empty.rows[0]?.rowId ?? "", multiCase);
    expect(result.kind).toBe("multi-case");
    if (result.kind === "multi-case") expect(result.cases).toBe(3);
    expect(pasteIntoRow(empty, empty.rows[0]?.rowId ?? "", "just one line").kind).toBe("none");
  });
});

describe("pickers", () => {
  test("triggers: / and [ at row start, { anywhere, @ after a space", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "type", query: "", start: 0, end: 1 });
    expect(detectTrigger("[Ass", 4)).toEqual({ kind: "type", query: "Ass", start: 0, end: 4 });
    expect(detectTrigger("open /login", 6)).toBeNull();
    expect(detectTrigger("enter {stu", 10)).toEqual({ kind: "variable", query: "stu", start: 6, end: 10 });
    expect(detectTrigger("enter {student} now", 19)).toBeNull();
    expect(detectTrigger("log in as @PCF_", 15)).toEqual({ kind: "credential", query: "PCF_", start: 10, end: 15 });
    expect(detectTrigger("mail me@example", 15)).toBeNull();
  });

  test("type picker lists builtins then org macros with their params", () => {
    const options = typeOptions("", [loginMacro, selectLevel]);
    expect(options.slice(0, 8).map((option) => option.tag)).toEqual(["Act", "Assert", "Open", "Login", "Wait", "Screenshot", "Extract", "Note"]);
    expect(options.find((option) => option.tag === "Login")?.params.map((param) => param.name)).toEqual(["profile"]);
    expect(options.find((option) => option.tag === "Select level")?.params).toHaveLength(2);
    expect(typeOptions("as", []).map((option) => option.tag)).toEqual(["Assert"]);
    expect(typeOptions("lev", [selectLevel]).map((option) => option.tag)).toEqual(["Select level"]);
  });

  test("param fields become args: one first param positional, several named; chips render them", () => {
    const loginParams = typeOptions("", [loginMacro]).find((option) => option.tag === "Login")?.params ?? [];
    const loginArgs = argsFromParamValues(loginParams, { profile: "PCF_HQ_ADMIN" });
    expect(loginArgs).toEqual([{ name: null, value: "PCF_HQ_ADMIN" }]);
    expect(formatStepChip({ tag: "Login", args: loginArgs }, [loginMacro])).toEqual({ tag: "Login", params: "profile: PCF_HQ_ADMIN" });

    const levelArgs = argsFromParamValues(selectLevel.params, { level: "K1", branch: "BR-01" });
    expect(levelArgs).toEqual([
      { name: "level", value: "K1" },
      { name: "branch", value: "BR-01" }
    ]);
    expect(paramValuesFromArgs(selectLevel.params, levelArgs)).toEqual({ level: "K1", branch: "BR-01" });
    expect(formatStepChip({ tag: "Select level", args: [{ name: null, value: "K2" }] }, [selectLevel]).params).toBe("level: K2");
    expect(formatStepChip({ tag: "Act", args: [] }, []).params).toBeNull();
  });

  test("variable picker: dataset, params, earlier extracts, env, and declare-new", () => {
    let doc = docFromTranscript("# Case\nParams: role=HQ_ADMIN\n\n[Extract: orderId] the order id\n[Act] open order {orderId}");
    doc = updateMetadata(doc, { params: [...doc.metadata.params, { name: "student", default: null, required: true }] });
    const target = rowByText(doc, "open order");
    const extracted = extractedNamesBefore(doc, target.rowId);
    expect(extracted).toEqual([{ name: "orderId", ordinal: 1 }]);
    const options = variableOptions("", {
      environmentVariables: ["SCHOOL_CODE"],
      environmentName: "pcf-uat",
      params: doc.metadata.params,
      datasetColumns: ["class"],
      extracted
    });
    expect(options.map((option) => `${option.source}:${option.name}`)).toEqual([
      "dataset:class",
      "param:role",
      "param:student",
      "extracted:orderId",
      "env:SCHOOL_CODE",
      // The common generated values come last until the user types.
      "generated:person.name",
      "generated:person.firstName",
      "generated:person.lastName",
      "generated:person.email",
      "generated:person.phone",
      "generated:location.address"
    ]);
    expect(variableOptions("tenant", { environmentVariables: [], params: [], datasetColumns: [], extracted: [] })).toEqual([
      { name: "tenant", source: "declare", detail: "declare new param" }
    ]);
    const typed = variableOptions("mail", { environmentVariables: [], params: [], datasetColumns: [], extracted: [] });
    expect(typed.map((option) => option.name)).toEqual(["person.email", "internet.email", "mail"]);
    expect(typed[0]?.detail).toBe("generated · email built from the person's name, e.g. jordan.lee@example.com");
    expect(insertReference("enter {stu now", { kind: "variable", query: "stu", start: 6, end: 10 }, "{student}")).toEqual({ text: "enter {student} now", caret: 15 });
  });

  test("credential picker: a [Login] row picks the profile, other rows a field reference, never a value", () => {
    const credentials = [{ profile: "PCF_HQ_ADMIN", fields: ["username"], secretFields: ["password"] }];
    const forLogin = credentialOptions("", credentials, true);
    expect(forLogin.map(credentialReference)).toEqual(["PCF_HQ_ADMIN"]);
    const forAct = credentialOptions("pass", credentials, false);
    expect(forAct).toHaveLength(1);
    expect(forAct[0]?.secret).toBe(true);
    expect(credentialReference(forAct[0] ?? { profile: "", field: null, secret: false, label: "" })).toBe("{cred:PCF_HQ_ADMIN.password}");
    expect(credentialOptions("fixtures/a.xlsx", credentials, false).map(credentialReference)).toEqual(["{file:fixtures/a.xlsx}"]);
  });
});

describe("lint and fixes inline", () => {
  test("findings map to their rows; case-level findings stay separate", () => {
    const doc = docFromTranscript("# Case\n\n[Open] /login\n[Act] click #submit-btn then open {missing}");
    const parsed = testCaseFromDoc(doc);
    const findings = lintTestCase(parsed, {});
    const { byRow, caseLevel } = lintByRow(doc, parsed, findings);
    const actRow = rowByText(doc, "click");
    expect((byRow.get(actRow.rowId) ?? []).map((finding) => finding.ruleId).sort()).toEqual(["multiple-intents", "selector-in-instruction", "undeclared-variable"]);
    expect(caseLevel.map((finding) => finding.ruleId)).toContain("no-assert");
  });

  test("applying fixes keeps row identity where the step survives", () => {
    const doc = docFromTranscript("# Case\n\n[Open] /login\n[Assert] click the Save button\n[Act] type {email} into Email");
    const parsed = testCaseFromDoc(doc);
    const findings = lintTestCase(parsed, {});
    const declare = findings.find((finding) => finding.fix?.kind === "declare-param");
    if (!declare?.fix) throw new Error("expected declare fix");
    const declared = applyFixToDoc(doc, declare.fix);
    expect(declared.metadata.params.map((param) => param.name)).toEqual(["email"]);
    expect(declared.rows.map((row) => row.rowId)).toEqual(doc.rows.map((row) => row.rowId));

    const changeType = findings.find((finding) => finding.fix?.kind === "change-type");
    if (!changeType?.fix) throw new Error("expected change-type fix");
    const changed = applyFixToDoc(doc, changeType.fix);
    expect(serializeEditorDoc(changed)).toContain("[Act] click the Save button");
    const openRow = rowByText(doc, "/login");
    expect(changed.rows.some((row) => row.rowId === openRow.rowId)).toBe(true);
  });

  test("split-step fix turns one row into two", () => {
    const doc = docFromTranscript("# Case\n\n[Act] open the menu then choose \"Đăng xuất\"");
    const findings = lintTestCase(testCaseFromDoc(doc), {});
    const split = findings.find((finding) => finding.fix?.kind === "split-step");
    if (!split?.fix) throw new Error("expected split fix");
    const result = applyFixToDoc(doc, split.fix);
    expect(stepRows(result).map((row) => row.text)).toEqual(["open the menu", "choose \"Đăng xuất\""]);
    expect(mapRowsToSteps(result, testCaseFromDoc(result)).steps.size).toBe(2);
  });
});

describe("display and suggestions", () => {
  test("instruction text tokenises references and quoted labels into chips", () => {
    expect(tokenizeInstruction("enter {student} as {cred:PCF.username} from {file:a.csv} and click \"Lưu\"")).toEqual([
      { kind: "text", value: "enter " },
      { kind: "variable", name: "student" },
      { kind: "text", value: " as " },
      { kind: "credential", profile: "PCF", field: "username" },
      { kind: "text", value: " from " },
      { kind: "file", path: "a.csv" },
      { kind: "text", value: " and click " },
      { kind: "quoted", value: "Lưu" }
    ]);
  });

  test("element names come from rendered Playwright and recorded interaction targets", () => {
    const code = `await page.getByRole('menuitem', { name: 'Đăng xuất' }).click();\nawait page.getByLabel("Email").fill(value);\nawait page.getByRole("button", { name: "Save \\"draft\\"" }).click();`;
    expect(elementNamesFromRenderedCode(code)).toEqual(["menuitem Đăng xuất", 'button Save "draft"', "textbox Email"]);
    expect(elementNameFromTarget({ tagName: "BUTTON", textPreview: "  Đăng   nhập " })).toBe("button Đăng nhập");
    expect(elementNameFromTarget({ role: "tab", name: "Students" })).toBe("tab Students");
    expect(elementNameFromTarget({ tagName: "div", textPreview: "x".repeat(80) })).toBeNull();
    expect(dedupeElementNames(["button Save", "Button save", "tab A"])).toEqual(["button Save", "tab A"]);
  });

  test("suggestions rank names matching the word being typed and insert the quoted label", () => {
    const names = ["menuitem Đăng xuất", "textbox Email", "button Đăng nhập", "tab Students"];
    expect(suggestElementNames("chọn Đăng xu", names)[0]).toBe("menuitem Đăng xuất");
    expect(suggestElementNames("x", names)).toEqual([]);
    expect(insertElementName("click Đăng", "button Đăng nhập")).toBe('click "Đăng nhập"');
    expect(insertElementName("fill in", "textbox Email")).toBe('fill in "Email"');
  });

  test("tags group by namespace with free tags last; Jira links show their key", () => {
    expect(groupTagsByNamespace(["regression", "team:qa-pcf", "feature:login", "team:core"])).toEqual([
      { namespace: "feature", tags: [{ tag: "feature:login", name: "login" }] },
      { namespace: "team", tags: [{ tag: "team:qa-pcf", name: "qa-pcf" }, { tag: "team:core", name: "core" }] },
      { namespace: "", tags: [{ tag: "regression", name: "regression" }] }
    ]);
    expect(linkLabel("https://littlelives.atlassian.net/browse/PCF-1234")).toBe("PCF-1234");
    expect(linkLabel("https://docs.google.com/x")).toBe("docs.google.com/x");
  });
});

describe("keyboard map", () => {
  const field: EditorKeyContext = { target: "field", pickerOpen: false, fieldEmpty: false, caretAtStart: false, caretAtEnd: true, isMac: true };

  test("design §7 shortcuts map to commands on macOS and elsewhere", () => {
    expect(editorKeyCommand({ key: "Enter" }, field)).toBe("new-row");
    expect(editorKeyCommand({ key: "Enter", metaKey: true }, field)).toBe("run");
    expect(editorKeyCommand({ key: "Enter", altKey: true }, field)).toBe("run-from-here");
    expect(editorKeyCommand({ key: "d", metaKey: true }, field)).toBe("duplicate-row");
    expect(editorKeyCommand({ key: "ArrowUp", metaKey: true, shiftKey: true }, field)).toBe("move-up");
    expect(editorKeyCommand({ key: "ArrowDown", metaKey: true, shiftKey: true }, field)).toBe("move-down");
    expect(editorKeyCommand({ key: "/", metaKey: true }, field)).toBe("toggle-disabled");
    expect(editorKeyCommand({ key: "d", ctrlKey: true }, field)).toBeNull();
    expect(editorKeyCommand({ key: "d", ctrlKey: true }, { ...field, isMac: false })).toBe("duplicate-row");
  });

  test("Alt+↑/↓ changes the type; Tab always moves focus (no keyboard trap); pickers capture arrows, Enter and Escape", () => {
    expect(editorKeyCommand({ key: "ArrowDown", altKey: true }, { ...field, target: "chip" })).toBe("type-next");
    expect(editorKeyCommand({ key: "ArrowUp", altKey: true }, { ...field, target: "chip" })).toBe("type-prev");
    expect(editorKeyCommand({ key: "ArrowDown", altKey: true }, field)).toBe("type-next");
    expect(editorKeyCommand({ key: "ArrowDown", altKey: true }, { ...field, target: "heading" })).toBeNull();
    expect(editorKeyCommand({ key: "Tab" }, { ...field, target: "chip" })).toBeNull();
    expect(editorKeyCommand({ key: "Tab", shiftKey: true }, { ...field, target: "chip" })).toBeNull();
    expect(editorKeyCommand({ key: "Tab" }, field)).toBeNull();
    expect(editorKeyCommand({ key: "?", metaKey: true }, field)).toBeNull();
    const open = { ...field, pickerOpen: true };
    expect(editorKeyCommand({ key: "ArrowDown" }, open)).toBe("picker-next");
    expect(editorKeyCommand({ key: "Enter" }, open)).toBe("picker-accept");
    expect(editorKeyCommand({ key: "Escape" }, open)).toBe("picker-close");
  });

  test("Backspace deletes only empty rows; arrows leave the row at its edges; IME is ignored", () => {
    expect(editorKeyCommand({ key: "Backspace" }, { ...field, fieldEmpty: true })).toBe("delete-row");
    expect(editorKeyCommand({ key: "Backspace" }, field)).toBeNull();
    expect(editorKeyCommand({ key: "ArrowUp" }, { ...field, caretAtStart: true })).toBe("focus-prev");
    expect(editorKeyCommand({ key: "ArrowUp" }, field)).toBeNull();
    expect(editorKeyCommand({ key: "ArrowDown" }, field)).toBe("focus-next");
    expect(editorKeyCommand({ key: "Enter", isComposing: true }, field)).toBeNull();
  });
});

describe("built-in macros", () => {
  test("[Login: X] is not an unknown macro when the org has no Login macro; an org Login wins", () => {
    const parsed = testCaseFromDoc(docFromTranscript("# Case\n\n[Login: ADMIN] sign in\n[Unknown thing] x"));
    const unknown = lintTestCase(parsed, { macros: withBuiltinMacros([]) }).filter((finding) => finding.ruleId === "unknown-macro");
    expect(unknown.map((finding) => finding.message)).toEqual(['No macro named "Unknown thing".']);
    expect(withBuiltinMacros([loginMacro])).toEqual([loginMacro]);
  });
});

describe("bare rows that look like other syntax survive a save", () => {
  const prefixes = ["# not a title", "## not a checkpoint", "// not disabled", "[x] done reviewing", "| a | b |", "#hashtag first", "//"];

  for (const text of prefixes) {
    test(`a bare row "${text}" stays one Act step with its text`, () => {
      const base = docFromTranscript("# Case\n\n[Open] /login\n\n## Checkpoint: Done\n[Assert] the page is visible");
      const open = stepRows(base)[0];
      if (!open) throw new Error("fixture");
      const inserted = insertRowAfter(base, open.rowId, { tag: null, text });
      const parsed = testCaseFromDoc(inserted.doc);
      expect(parsed.steps).toHaveLength(3);
      const step = parsed.steps[1];
      expect(step?.type).toBe("act");
      expect(step?.text).toBe(text);
      expect(step?.checkpointId).toBeNull();
      expect(step?.disabled).toBe(false);
      expect(parsed.checkpoints).toHaveLength(1);
      // Saving again is stable.
      const again = docFromTranscript(serializeEditorDoc(inserted.doc));
      expect(serializeEditorDoc(again)).toBe(serializeEditorDoc(inserted.doc));
    });
  }

  test("a disabled bare row with such text stays disabled and keeps its text", () => {
    const base = docFromTranscript("# Case\n\n[Open] /login");
    const open = stepRows(base)[0];
    if (!open) throw new Error("fixture");
    const inserted = insertRowAfter(base, open.rowId, { tag: null, text: "[x] skip me", disabled: true });
    const step = testCaseFromDoc(inserted.doc).steps[1];
    expect([step?.type, step?.text, step?.disabled]).toEqual(["act", "[x] skip me", true]);
  });

  test("the explicit [Act] keeps the instruction key of the bare text", () => {
    const bare = testCaseFromDoc(docFromTranscript("# Case\n\nopen the menu")).steps[0];
    const doc = docFromTranscript("# Case\n\nopen the menu");
    const row = stepRows(doc)[0];
    if (!row) throw new Error("fixture");
    const tagged = testCaseFromDoc(setRowText(doc, row.rowId, "open the menu")).steps[0];
    expect(tagged?.instructionKey).toBe(bare?.instructionKey ?? "missing");
  });

  test("plain headings titled like a checkpoint or dataset keep their title", () => {
    const base = docFromTranscript("# Case\n\n[Open] /login");
    const open = stepRows(base)[0];
    if (!open) throw new Error("fixture");
    for (const title of ["Dataset", "Checkpoint: inner"]) {
      const withHeading = insertHeadingAfter(base, open.rowId, title);
      const heading = withHeading.doc.rows.find((row) => row.rowId === withHeading.focusRowId);
      const plain = { ...withHeading.doc, rows: withHeading.doc.rows.map((row) => (row === heading && row.kind === "heading" ? { ...row, prefixed: false } : row)) };
      const parsed = testCaseFromDoc(plain);
      expect(parsed.checkpoints.map((checkpoint) => checkpoint.title)).toEqual([title]);
      expect(parsed.dataset).toBeNull();
    }
  });
});

describe("read-only editor", () => {
  test("only navigation and run commands are allowed when read-only", () => {
    for (const command of ["new-row", "duplicate-row", "move-up", "move-down", "toggle-disabled", "delete-row", "type-next", "picker-accept"] as const) {
      expect(editorCommandAllowed(command, true)).toBe(false);
      expect(editorCommandAllowed(command, false)).toBe(true);
    }
    for (const command of ["focus-prev", "focus-next", "picker-close", "run"] as const) expect(editorCommandAllowed(command, true)).toBe(true);
  });

  test("renders without add, drag, remove or fix controls and with read-only fields", () => {
    const doc = docFromTranscript("# Case\n\n[Open] /login\n[Act] click #save then wait\n\n## Checkpoint: Done\n[Assert] the page is visible");
    const html = renderToStaticMarkup(React.createElement(StepEditor, { doc, onChange: () => undefined, readOnly: true }));
    expect(html).not.toContain("+ Add step");
    expect(html).not.toContain('draggable="true"');
    expect(html).not.toContain("jl-se-fix");
    expect(html).not.toContain("Remove checkpoint heading");
    const inputs = html.match(/<input class="jl-se-input[^>]*>/g) ?? [];
    expect(inputs.length).toBe(4);
    expect(inputs.every((input) => input.includes('readOnly=""'))).toBe(true);
    const editable = renderToStaticMarkup(React.createElement(StepEditor, { doc, onChange: () => undefined }));
    expect(editable).toContain("+ Add step");
    expect(editable).toContain("jl-se-fix");
  });

  test("roving tabindex: only the first row's controls are tabbable before focus", () => {
    const doc = docFromTranscript("# Case\n\n[Open] /login\n[Act] open the menu\n[Assert] the menu is visible");
    const html = renderToStaticMarkup(React.createElement(StepEditor, { doc, onChange: () => undefined }));
    const inputs = [...html.matchAll(/<input[^>]*aria-label="Step \d+ instruction"[^>]*>/g)].map((match) => match[0]);
    expect(inputs).toHaveLength(3);
    expect(inputs.map((input) => /tabindex="0"/i.test(input))).toEqual([true, false, false]);
  });
});

describe("Text mode with several cases", () => {
  test("a second # heading keeps the doc unchanged instead of dropping a case", () => {
    const doc = exampleDoc();
    const single = textModeUpdate(serializeEditorDoc(doc).replace("[Open] /login", "[Open] /signin"), doc);
    expect(single.cases).toBe(1);
    expect(single.doc && serializeEditorDoc(single.doc)).toContain("[Open] /signin");
    const multi = textModeUpdate(`${serializeEditorDoc(doc)}\n\n# Second case\n[Open] /x`, doc);
    expect(multi).toEqual({ doc: null, cases: 2 });
  });
});
