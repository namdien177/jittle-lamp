import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  applyLintFix,
  computeInstructionKey,
  computeTestCaseFingerprint,
  expandMacros,
  lintTestCase,
  macroDefinitionSchema,
  parsedTestCaseSchema,
  parsedTranscriptDocumentSchema,
  parseStepArgs,
  parseTestCaseTranscript,
  parseTranscriptDocument,
  serializeStepArgs,
  serializeTestCase,
  serializeTranscriptDocument,
  sha256Hex,
  transcriptLintRules,
  trigramSimilarity,
  type ParsedTestCase
} from "@jittle-lamp/shared";

const root = join(import.meta.dir, "..");
const exampleTranscript = readFileSync(
  join(root, "docs/e2e-test-cases/examples/pcf-logout-clears-email.transcript.md"),
  "utf8"
);
const multiCaseDocument = readFileSync(join(import.meta.dir, "fixtures/e2e/multi-case.transcript.md"), "utf8");

const withoutLines = (testCase: ParsedTestCase) => ({
  ...testCase,
  line: 0,
  checkpoints: testCase.checkpoints.map((checkpoint) => ({ ...checkpoint, line: 0 })),
  steps: testCase.steps.map((step) => ({ ...step, line: 0 }))
});

describe("sha256", () => {
  test("matches node:crypto for ASCII, unicode and block-boundary inputs", () => {
    for (const input of ["", "abc", "đăng xuất", "a".repeat(55), "b".repeat(56), "c".repeat(64), "d".repeat(1000)]) {
      expect(sha256Hex(input)).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });
});

describe("transcript parser", () => {
  test("parses the example transcript", () => {
    const { testCase, diagnostics } = parseTestCaseTranscript(exampleTranscript);
    parsedTestCaseSchema.parse(testCase);

    expect(diagnostics).toEqual([]);
    expect(testCase.title).toBe("HQ admin logout returns a clean login form");
    expect(testCase.steps.map((step) => step.type)).toEqual([
      "open",
      "login",
      "assert",
      "act",
      "assert",
      "assert",
      "screenshot",
      "open",
      "assert",
      "note"
    ]);
    expect(testCase.checkpoints.map((checkpoint) => checkpoint.title)).toEqual([
      "Logout returns to the login page",
      "Session is really gone"
    ]);

    const login = testCase.steps[1];
    expect(login?.macro).toBe("Login");
    expect(login?.args).toEqual([{ name: null, value: "PCF" }]);
    expect(login?.credentialRefs).toEqual(["PCF"]);
    expect(login?.checkpointId).toBeNull();
    expect(testCase.steps[4]?.checkpointId).toBe(testCase.checkpoints[0]?.checkpointId ?? "missing");
    expect(testCase.steps[9]?.checkpointId).toBe(testCase.checkpoints[1]?.checkpointId ?? "missing");
    expect(testCase.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(testCase.steps.map((step) => step.stepId)).size).toBe(10);
  });

  test("bare text is an Act and unknown tags are macros", () => {
    const { testCase } = parseTestCaseTranscript("# T\n\nclick Save\n[Create student: name=Ann, level=K1] note\n[act] lower-case tag");
    expect(testCase.steps.map((step) => [step.type, step.tag, step.macro])).toEqual([
      ["act", null, null],
      ["macro", "Create student", "Create student"],
      ["act", "act", null]
    ]);
    expect(testCase.steps[1]?.args).toEqual([
      { name: "name", value: "Ann" },
      { name: "level", value: "K1" }
    ]);
    // [Act] and bare text with the same instruction are the same step.
    const bare = parseTestCaseTranscript("# T\n\nclick Save").testCase.steps[0];
    const tagged = parseTestCaseTranscript("# T\n\n[Act]   Click  save").testCase.steps[0];
    expect(bare?.instructionKey).toBe(tagged?.instructionKey ?? "missing");
  });

  test("parses tag arguments, quoting and positional values", () => {
    expect(parseStepArgs("PCF")).toEqual([{ name: null, value: "PCF" }]);
    expect(parseStepArgs("a=1, b=2")).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "2" }
    ]);
    expect(parseStepArgs("Smith, John")).toEqual([{ name: null, value: "Smith, John" }]);
    expect(parseStepArgs('note="a, b", x="say \\"hi\\""')).toEqual([
      { name: "note", value: "a, b" },
      { name: "x", value: 'say "hi"' }
    ]);
    expect(parseStepArgs('"a=b"')).toEqual([{ name: null, value: "a=b" }]);

    for (const args of [
      [{ name: null, value: "a=b" }],
      [{ name: null, value: "x]y" }],
      [{ name: "note", value: "a, b" }, { name: "q", value: 'say "hi"' }],
      [{ name: null, value: "PCF" }, { name: "tenant", value: "HQ" }]
    ]) {
      expect(parseStepArgs(serializeStepArgs(args))).toEqual(args);
    }
  });

  test("extracts variables, credential and file references", () => {
    const { testCase } = parseTestCaseTranscript(
      "# T\n\nEnter {cred:PCF_HQ_ADMIN.password} into Password\nUpload {file:fixtures/a.pdf} as {docName}\n[Login: {role}] as {role}"
    );
    expect(testCase.steps[0]?.credentialRefs).toEqual(["PCF_HQ_ADMIN.password"]);
    expect(testCase.steps[0]?.variables).toEqual([]);
    expect(testCase.steps[1]?.fileRefs).toEqual(["fixtures/a.pdf"]);
    expect(testCase.steps[1]?.variables).toEqual(["docName"]);
    expect(testCase.steps[2]?.variables).toEqual(["role"]);
    expect(testCase.steps[2]?.credentialRefs).toEqual([]);
  });

  test("parses a multi-case document with metadata lines and a dataset", () => {
    const document = parseTranscriptDocument(multiCaseDocument);
    parsedTranscriptDocumentSchema.parse(document);
    expect(document.diagnostics).toEqual([]);
    expect(document.cases.map((testCase) => testCase.title)).toEqual([
      "HQ admin logout returns a clean login form",
      "Branch admin logout returns a clean login form",
      "Enrol a student for each level"
    ]);

    const [first, variant, enrol] = document.cases;
    expect(first?.metadata).toMatchObject({
      key: "TC-0412",
      tags: ["team:qa-pcf", "module:admin", "feature:login", "regression"],
      env: "pcf-uat",
      links: ["https://littlelives.atlassian.net/browse/PCF-1234"],
      params: [{ name: "role", default: "HQ_ADMIN", required: false }],
      order: ["key", "tags", "env", "links", "params"]
    });
    expect(variant?.metadata.duplicateOf).toBe("TC-0412");
    expect(variant?.steps).toEqual([]);
    expect(enrol?.metadata.description).toBe("Creates one enrolment per dataset row.\nRows come from the admissions sheet.");
    expect(enrol?.metadata.retries).toBe(1);
    expect(enrol?.dataset).toEqual({
      name: null,
      columns: ["studentName", "level"],
      rows: [
        { studentName: "E2E Ann", level: "K1" },
        { studentName: "E2E Bob", level: "K2" }
      ]
    });
    expect(enrol?.steps.find((step) => step.tag === "Select level")?.type).toBe("macro");
    expect(enrol?.steps.filter((step) => step.disabled).map((step) => step.text)).toEqual(['click "Save draft"']);
  });

  test("reports malformed datasets as diagnostics", () => {
    const { diagnostics } = parseTranscriptDocument("# T\n\n[Act] x\n\n## Dataset\n| a | b |\n| 1 | 2 |\n| 3 |\n");
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["malformed-dataset", "dataset-row-width"]);
  });

  test("rejects a multi-case document where one case is expected", () => {
    expect(() => parseTestCaseTranscript(multiCaseDocument)).toThrow("Expected one test case, found 3");
  });
});

describe("round trip", () => {
  test("document → model → document is byte-identical for canonical documents", () => {
    expect(serializeTestCase(parseTestCaseTranscript(exampleTranscript).testCase) + "\n").toBe(exampleTranscript);
    expect(serializeTranscriptDocument(parseTranscriptDocument(multiCaseDocument))).toBe(multiCaseDocument);
  });

  test("model → document → model is lossless for non-canonical input", () => {
    const messy = [
      "#   Messy title  ",
      "environment: pcf-uat",
      "tags:a,  b",
      "",
      "",
      "[act]    click   Save  ",
      "## Plain heading",
      "[Login:profile = PCF ,tenant=HQ]",
      "### Deep heading",
      '[Note: "x]y"] keep'
    ].join("\r\n");
    const first = parseTranscriptDocument(messy);
    const second = parseTranscriptDocument(serializeTranscriptDocument(first));
    expect(second.cases.map(withoutLines)).toEqual(first.cases.map(withoutLines));
  });

  test("model edits survive serialisation", () => {
    const { testCase } = parseTestCaseTranscript(exampleTranscript);
    const edited: ParsedTestCase = {
      ...testCase,
      metadata: { ...testCase.metadata, tags: ["feature:login"], order: ["tags"] },
      steps: testCase.steps.map((step, index) => (index === 3 ? { ...step, disabled: true } : step))
    };
    const reparsed = parseTestCaseTranscript(serializeTestCase(edited), { previousSteps: edited.steps }).testCase;
    expect(withoutLines(reparsed)).toEqual(withoutLines(edited));
  });
});

describe("stable step ids", () => {
  test("unchanged instructions keep their stepId across edits; changed lines get a new one", () => {
    const original = parseTestCaseTranscript(exampleTranscript).testCase;
    const editedText = exampleTranscript
      .replace("[Open] /login\n", "[Note] setup\n[Open] /login\n")
      .replace("[Assert] input text Email phải trống", "[Assert] input Email trống sau khi đăng xuất");
    const edited = parseTestCaseTranscript(editedText, { previousSteps: original.steps }).testCase;

    const idsByText = (testCase: ParsedTestCase) => new Map(testCase.steps.map((step) => [step.text, step.stepId]));
    const before = idsByText(original);
    const after = idsByText(edited);

    for (const [text, id] of before) {
      if (text === "input text Email phải trống") {
        expect(after.has(text)).toBe(false);
        continue;
      }
      expect(after.get(text)).toBe(id);
    }
    const newStep = edited.steps.find((step) => step.text === "input Email trống sau khi đăng xuất");
    expect(newStep).toBeDefined();
    expect(original.steps.some((step) => step.stepId === newStep?.stepId)).toBe(false);
    expect(new Set(edited.steps.map((step) => step.stepId)).size).toBe(edited.steps.length);
  });

  test("ids are deterministic without a previous version, and repeated lines get distinct ids", () => {
    const text = "# T\n\n[Act] click Next\n[Act] click Next\n[Assert] the summary page is visible";
    const a = parseTestCaseTranscript(text).testCase.steps.map((step) => step.stepId);
    const b = parseTestCaseTranscript(text).testCase.steps.map((step) => step.stepId);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(3);
  });

  test("reconciles against ids that were not derived from the key", () => {
    const original = parseTestCaseTranscript("# T\n\n[Act] click Next\n[Assert] the summary page is visible").testCase;
    const imported = original.steps.map((step, index) => ({ ...step, stepId: `st_imported_${index}` }));
    const edited = parseTestCaseTranscript("# T\n\n[Open] /start\n[Act] click Next\n[Assert] the summary page is visible", {
      previousSteps: imported
    }).testCase;
    expect(edited.steps.map((step) => step.stepId).slice(1)).toEqual(["st_imported_0", "st_imported_1"]);
  });

  test("instruction keys follow sha256(type, arg, normalised text)", () => {
    const key = computeInstructionKey({ type: "act", macro: null, args: [], text: "  Click   SAVE " });
    expect(key).toBe(computeInstructionKey({ type: "act", macro: null, args: [], text: "click save" }));
    expect(key).not.toBe(computeInstructionKey({ type: "assert", macro: null, args: [], text: "click save" }));
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("fingerprint ignores formatting and metadata but not steps", () => {
    const a = parseTestCaseTranscript("# A\nTags: x\n\n[Act] click Save\n## Checkpoint: Done\n[Assert] the saved banner is visible").testCase;
    const b = parseTestCaseTranscript("# B\n\nclick   save\n\n## checkpoint:  done\n[assert] The saved banner is visible").testCase;
    const c = parseTestCaseTranscript("# A\n\n[Act] click Cancel\n## Checkpoint: Done\n[Assert] the saved banner is visible").testCase;
    expect(computeTestCaseFingerprint(a)).toBe(computeTestCaseFingerprint(b));
    expect(computeTestCaseFingerprint(a)).not.toBe(computeTestCaseFingerprint(c));
    expect(trigramSimilarity("HQ admin logout", "HQ admin log out")).toBeGreaterThan(0.5);
    expect(trigramSimilarity("HQ admin logout", "enrol a student")).toBeLessThan(0.2);
  });
});

describe("macros", () => {
  const login = macroDefinitionSchema.parse({
    name: "Login",
    version: 3,
    params: [
      { name: "profile", required: true, kind: "credential" },
      { name: "tenant", required: false, default: "HQ" }
    ],
    transcript: [
      "[Open] /login",
      "Enter {cred:{profile}.username} into the Email field",
      "Enter {cred:{profile}.password} into the Password field",
      "[Act] click Sign in",
      "[Assert] the {tenant} dashboard is visible"
    ].join("\n")
  });

  test("expands [Login: PCF] with positional and default parameters", () => {
    const { testCase } = parseTestCaseTranscript(exampleTranscript);
    const { steps, errors } = expandMacros(testCase.steps, [login]);
    expect(errors).toEqual([]);

    const call = steps.find((step) => step.type === "login");
    const children = steps.filter((step) => step.parentStepId === call?.stepId);
    expect(call?.macroVersion).toBe(3);
    expect(children.map((child) => child.text)).toEqual([
      "/login",
      "Enter {cred:PCF.username} into the Email field",
      "Enter {cred:PCF.password} into the Password field",
      "click Sign in",
      "the HQ dashboard is visible"
    ]);
    expect(children[2]?.credentialRefs).toEqual(["PCF.password"]);
    expect(children.every((child) => child.depth === 1)).toBe(true);
  });

  test("macro version is part of the expanded steps' instruction key", () => {
    const { testCase } = parseTestCaseTranscript("# T\n\n[Login: PCF]\n[Assert] the dashboard is visible");
    const v3 = expandMacros(testCase.steps, [login]).steps;
    const v4 = expandMacros(testCase.steps, [{ ...login, version: 4 }]).steps;
    expect(v3.filter((step) => step.depth === 1).map((step) => step.instructionKey)).not.toEqual(
      v4.filter((step) => step.depth === 1).map((step) => step.instructionKey)
    );
    expect(v3.filter((step) => step.depth === 0).map((step) => step.instructionKey)).toEqual(
      v4.filter((step) => step.depth === 0).map((step) => step.instructionKey)
    );
  });

  test("reports unknown macros, missing and unknown arguments, and recursion", () => {
    const loop = macroDefinitionSchema.parse({ name: "Loop", version: 1, params: [], transcript: "[Loop]" });
    const { testCase } = parseTestCaseTranscript("# T\n\n[Nope]\n[Login]\n[Login: profile=A, colour=red]\n[Loop]");
    const { errors } = expandMacros(testCase.steps, [login, loop]);
    expect(errors.map((error) => error.code)).toEqual([
      "unknown-macro",
      "missing-argument",
      "unknown-argument",
      "recursive-macro"
    ]);
  });
});

describe("lint", () => {
  const ruleIds = (text: string, context = {}) =>
    lintTestCase(parseTestCaseTranscript(text).testCase, context).map((finding) => finding.ruleId);

  test("rules are data with ids, severities and descriptions", () => {
    const ids = transcriptLintRules.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of transcriptLintRules) {
      expect(rule.description.length).toBeGreaterThan(10);
      expect(["error", "warning", "info"]).toContain(rule.severity);
    }
  });

  test("the example transcript only gets the assert-without-checkpoint hint", () => {
    expect(ruleIds(exampleTranscript)).toEqual(["assert-without-checkpoint"]);
  });

  test("flags each rule", () => {
    expect(ruleIds("[Act] click Save\n[Assert] saved banner shows")).toContain("missing-title");
    expect(ruleIds("# T\n\n[Act] click #submit-btn\n## Checkpoint: c\n[Assert] the saved banner is visible")).toContain(
      "selector-in-instruction"
    );
    expect(ruleIds("# T\n\n[Act] click Save then open the list\n## Checkpoint: c\n[Assert] the saved banner is visible")).toContain(
      "multiple-intents"
    );
    expect(ruleIds("# T\n\n[Act] x\n## Checkpoint: c\n[Assert] click the Save button now")).toContain("action-in-assert");
    expect(ruleIds("# T\n\n[Act] x\n## Checkpoint: c\n[Assert] works")).toContain("vague-assert");
    expect(ruleIds("# T\n\n[Login]\n## Checkpoint: c\n[Assert] the dashboard is visible")).toContain("login-needs-profile");
    expect(ruleIds("# T\n\n[Open]\n[Extract] id\n## Checkpoint: c\n[Assert] the dashboard is visible")).toEqual(
      expect.arrayContaining(["missing-argument"])
    );
    expect(ruleIds("# T\n\nEnter password Secret123 into the field\n## Checkpoint: c\n[Assert] the dashboard is visible")).toContain(
      "possible-secret"
    );
    expect(ruleIds("# T\n\nEnter {cred:PCF.password} into the Password field\n## Checkpoint: c\n[Assert] the dashboard is visible")).not.toContain(
      "possible-secret"
    );
    expect(ruleIds("# T\n\n[Teleport]\n## Checkpoint: c\n[Assert] the dashboard is visible", { macros: [] })).toContain(
      "unknown-macro"
    );
    expect(ruleIds("# T\n\n[Teleport]\n## Checkpoint: c\n[Assert] the dashboard is visible")).not.toContain("unknown-macro");
    expect(ruleIds("# T\n\nType {email} into Email\n## Checkpoint: c\n[Assert] the dashboard is visible")).toContain(
      "undeclared-variable"
    );
    expect(
      ruleIds("# T\n\nType {email} into Email\n## Checkpoint: c\n[Assert] the dashboard is visible", { environmentVariables: ["email"] })
    ).not.toContain("undeclared-variable");
    expect(ruleIds("# T\n\n[Act] a\n[Act] b\n[Act] c")).toContain("no-assert");
    expect(ruleIds("# T\n\n[Act] a")).toContain("step-count");
  });

  test("extracted values and dataset columns count as declared", () => {
    expect(ruleIds(multiCaseDocument.split("\n# ").slice(-1).map((text) => `# ${text}`)[0] ?? "")).not.toContain(
      "undeclared-variable"
    );
    expect(
      ruleIds("# T\n\n[Extract: orderId] the order number\nOpen order {orderId}\n## Checkpoint: c\n[Assert] the order page is visible")
    ).not.toContain("undeclared-variable");
  });

  test("fixes apply to the model and keep unrelated step ids", () => {
    const text = "# T\n\n[Open] /orders\n[Act] click Save then open the list\nType {email} into Email\n[Assert] the saved banner is visible";
    const testCase = parseTestCaseTranscript(text).testCase;
    const findings = lintTestCase(testCase);

    const split = findings.find((finding) => finding.ruleId === "multiple-intents")?.fix;
    const declare = findings.find((finding) => finding.ruleId === "undeclared-variable")?.fix;
    const checkpoint = findings.find((finding) => finding.ruleId === "assert-without-checkpoint")?.fix;
    if (!split || !declare || !checkpoint) throw new Error("expected fixes");

    let fixed = applyLintFix(testCase, split);
    expect(fixed.steps.map((step) => step.text)).toEqual([
      "/orders",
      "click Save",
      "open the list",
      "Type {email} into Email",
      "the saved banner is visible"
    ]);
    expect(fixed.steps[0]?.stepId).toBe(testCase.steps[0]?.stepId ?? "missing");
    expect(fixed.steps[4]?.stepId).toBe(testCase.steps[3]?.stepId ?? "missing");

    fixed = applyLintFix(fixed, declare);
    expect(fixed.metadata.params).toEqual([{ name: "email", default: null, required: true }]);

    fixed = applyLintFix(fixed, checkpoint);
    expect(fixed.checkpoints.map((c) => c.title)).toEqual(["the saved banner is visible"]);
    expect(fixed.steps.at(-1)?.checkpointId).toBe(fixed.checkpoints[0]?.checkpointId ?? "missing");
    expect(lintTestCase(fixed).map((finding) => finding.ruleId)).toEqual([]);
  });

  test("selector fix suggests element names from the last run's snapshots", () => {
    const testCase = parseTestCaseTranscript("# T\n\n[Act] click .logout-menu-item\n## Checkpoint: c\n[Assert] the login form is visible").testCase;
    const finding = lintTestCase(testCase, { elementNames: ["menuitem Đăng xuất", "menuitem Logout", "textbox Email"] }).find(
      (item) => item.ruleId === "selector-in-instruction"
    );
    expect(finding?.fix).toMatchObject({ kind: "use-visible-label" });
    if (finding?.fix?.kind !== "use-visible-label") throw new Error("expected label fix");
    expect(finding.fix.suggestions[0]).toBe("menuitem Logout");
    expect(applyLintFix(testCase, finding.fix).steps[0]?.text).toBe("menuitem Logout");
  });
});
