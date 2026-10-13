import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  applyLintFix,
  caseOutputsOf,
  computeInstructionKey,
  computeTestCaseFingerprint,
  expandedStepSchema,
  expandMacros,
  linkedCaseSchema,
  lintTestCase,
  macroDefinitionSchema,
  parsedTestCaseSchema,
  parsedTranscriptDocumentSchema,
  parseReusePolicy,
  parseStepArgs,
  parseTestCaseTranscript,
  parseTranscriptDocument,
  producedNamesOf,
  queryNameArg,
  queryProfileArg,
  serializeReusePolicy,
  serializeStepArgs,
  serializeTestCase,
  serializeTranscriptDocument,
  sha256Hex,
  splitStepBinding,
  transcriptLintRules,
  transcriptStepSchema,
  trigramSimilarity,
  useAliasArg,
  useCaseKeyArg,
  useModeArg,
  variableRoot,
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

describe("review regressions", () => {
  const roundTrip = (text: string) => {
    const first = parseTranscriptDocument(text);
    const second = parseTranscriptDocument(serializeTranscriptDocument(first));
    parsedTranscriptDocumentSchema.parse(first);
    parsedTranscriptDocumentSchema.parse(second);
    expect(second.cases.map(withoutLines)).toEqual(first.cases.map(withoutLines));
    return first;
  };

  test("empty titles, escaped pipes, commas in lists and invalid metadata round-trip", () => {
    expect(roundTrip("# A\n[Act] x\n\n#\n[Act] y").cases).toHaveLength(2);
    expect(roundTrip("#\nKey: K1\n[Act] y").cases[0]?.metadata.key).toBe("K1");
    expect(roundTrip("# T\n\n[Act] x\n\n## Dataset\n| a | b |\n| --- | --- |\n| x\\|y | 2 |").cases[0]?.dataset?.rows).toEqual([
      { a: "x|y", b: "2" }
    ]);
    expect(roundTrip('# T\nParams: list="a,b", role\nTags: "odd, tag", x\n\n[Act] x').cases[0]?.metadata).toMatchObject({
      params: [
        { name: "list", default: "a,b", required: false },
        { name: "role", default: null, required: true }
      ],
      tags: ["odd, tag", "x"]
    });
    const invalid = roundTrip("# T\nKey:\nRetries: 1.5\nParams: =x, ok\n\n[Act] x");
    expect(invalid.cases[0]?.metadata.order).toEqual(["params"]);
    expect(invalid.cases[0]?.metadata.params.map((param) => param.name)).toEqual(["ok"]);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid-metadata", "invalid-metadata"]);
  });

  test("a hash without a space is step text, not a heading", () => {
    const { testCase } = parseTestCaseTranscript("# T\n\n#123 mở đơn hàng\n[Assert] đơn hàng #123 hiển thị");
    expect(testCase.steps.map((step) => step.text)).toEqual(["#123 mở đơn hàng", "đơn hàng #123 hiển thị"]);
  });

  test("identity keeps case in [Open] targets and {var} names, and [Login: X] equals [Login: profile=X]", () => {
    const key = (text: string) => parseTestCaseTranscript(`# T\n\n${text}`).testCase.steps[0]?.instructionKey;
    expect(key("[Open] /Admin/Users")).not.toBe(key("[Open] /admin/users"));
    expect(key("Type {Email} into Email")).not.toBe(key("Type {email} into Email"));
    expect(key("Type {email} into EMAIL")).toBe(key("type {email} into email"));
    expect(key("[Login: PCF]")).toBe(key("[Login: profile=PCF]"));
    expect(key("[Login: PCF]")).toBe(key("[Login: Profile=PCF]"));
    expect(ruleIdsOf("# T\n\n[Login: Profile=PCF]\n## Checkpoint: c\n[Assert] the dashboard is visible")).not.toContain(
      "login-needs-profile"
    );
  });

  test("previous cases are matched by Key, then title, not by position", () => {
    const before = parseTranscriptDocument("# A\nKey: TC-1\n\n[Act] click Save\n\n# B\n\n[Act] click Save");
    const ids = before.cases.map((testCase) => testCase.steps[0]?.stepId);
    const imported = before.cases.map((testCase, index) => ({
      key: testCase.metadata.key,
      title: testCase.title,
      steps: testCase.steps.map((step) => ({ ...step, stepId: `st_case${index}` }))
    }));
    const after = parseTranscriptDocument("# B\n\n[Act] click Save\n\n# A renamed\nKey: TC-1\n\n[Act] click Save", {
      previousCases: imported
    });
    expect(after.cases.map((testCase) => testCase.steps[0]?.stepId)).toEqual(["st_case1", "st_case0"]);
    expect(ids[0]).toBe(ids[1] ?? "missing");
  });

  const ruleIdsOf = (text: string) => lintTestCase(parseTestCaseTranscript(text).testCase).map((finding) => finding.ruleId);
  const withCheckpoint = (step: string) => `# T\n\n${step}\n## Checkpoint: c\n[Assert] trang chủ hiển thị tên trường`;

  test("Vietnamese instructions trigger the same rules as English ones", () => {
    expect(ruleIdsOf(withCheckpoint("mở trang hồ sơ sau đó nhấn Sửa"))).toContain("multiple-intents");
    expect(ruleIdsOf(withCheckpoint("nhập tên và email và số điện thoại"))).toContain("multiple-intents");
    expect(ruleIdsOf("# T\n\n[Act] x\n## Checkpoint: c\n[Assert] Mở popup xác nhận")).toContain("action-in-assert");
    expect(ruleIdsOf(withCheckpoint("nhập mật khẩu mới Abc12345"))).toContain("possible-secret");
  });

  test("secret detection covers more phrasings, params, descriptions and dataset columns", () => {
    for (const step of ["type Abc@12345 into the password field", "type hunter2 as the password", "nhập mã OTP 123456"]) {
      expect(ruleIdsOf(withCheckpoint(step))).toContain("possible-secret");
    }
    expect(ruleIdsOf("# T\nParams: password=Abc@12345\n\n[Act] x\n## Checkpoint: c\n[Assert] the dashboard is visible")).toContain(
      "possible-secret"
    );
    expect(
      ruleIdsOf("# T\nDescription: log in with password Secret@2024\n\n[Act] x\n## Checkpoint: c\n[Assert] the dashboard is visible")
    ).toContain("possible-secret");
    expect(
      ruleIdsOf(
        "# T\n\n[Act] x\n## Checkpoint: c\n[Assert] the dashboard is visible\n\n## Dataset\n| user | password |\n| --- | --- |\n| a | Secret@2024 |"
      )
    ).toContain("possible-secret");
    expect(ruleIdsOf(withCheckpoint("Enter {cred:PCF.password} into the Password field"))).not.toContain("possible-secret");
    expect(ruleIdsOf(withCheckpoint("nhập {OTP_CODE} vào ô mã OTP"))).not.toContain("possible-secret");
  });

  test("realistic instructions do not trigger false positives", () => {
    const clean = [
      withCheckpoint("mở Settings > Users"),
      withCheckpoint("mở Cài đặt > Người dùng"),
      withCheckpoint("tải file báo cáo .xlsx về máy"),
      withCheckpoint('nhấn nút "Lưu rồi đóng"'),
      withCheckpoint("chọn lớp đã tạo rồi trong danh sách"),
      "# T\n\n[Act] x\n## Checkpoint: c\n[Assert] Open orders count is 3",
      "# T\n\n[Act] x\n## Checkpoint: c\n[Assert] Select box shows three options",
      "# T\n\n[Act] x\n## Checkpoint: c\n[Assert] vào được trang chủ thành công",
      "# T\n\n[Act] x\n## Checkpoint: c\n[Assert] Email trống"
    ];
    for (const text of clean) {
      expect({ text, rules: ruleIdsOf(text).filter((id) => id !== "step-count") }).toEqual({ text, rules: [] });
    }
  });

  test("lint stays fast on very long lines", () => {
    const started = performance.now();
    ruleIdsOf(withCheckpoint(`password ${"a".repeat(20_000)}`));
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("credential profile aliases", () => {
  test("an exact profile wins; otherwise the only NAME_ profile; ambiguity resolves to nothing", async () => {
    const { resolveCredentialAlias } = await import("@jittle-lamp/shared");
    expect(resolveCredentialAlias("PCF", ["PCF", "PCF_HQ_ADMIN"])).toBe("PCF");
    expect(resolveCredentialAlias("PCF", ["PCF_HQ_ADMIN", "ILHAM_A"])).toBe("PCF_HQ_ADMIN");
    expect(resolveCredentialAlias("ILHAM", ["ILHAM_A", "ILHAM_B"])).toBeNull();
    expect(resolveCredentialAlias("PC", ["PCF_HQ_ADMIN"])).toBeNull();
  });
});

// Roadmap 2026-10-13 §2.5, §2.6 and §5.1: [Use ... as alias, mode=], Outputs:/Reuse:, [Query]/[API].
describe("chaining grammar (roadmap 2026-10-13)", () => {
  const ruleIds = (text: string, context = {}) =>
    lintTestCase(parseTestCaseTranscript(text).testCase, context).map((finding) => finding.ruleId);

  test("[Use: KEY as alias, mode=api] parses the alias and mode; [Use: KEY, p=v] is unchanged", () => {
    const { testCase } = parseTestCaseTranscript(
      [
        "# T",
        "",
        "[Use: TC-0012 as registration, mode=api, level=K1]",
        "[Use: TC-0012, level=K1]",
        "[Use: case=TC-0013 as approval]",
        "[Use: TC-0014, mode=UI]",
        "[Assert] the dashboard is visible"
      ].join("\n")
    );
    const [aliased, plain, named, upper] = testCase.steps;
    expect(aliased).toMatchObject({ type: "use", alias: "registration", mode: "api", binding: null });
    expect(useCaseKeyArg(aliased?.args ?? [])).toBe("TC-0012");
    expect(aliased?.args).toEqual([
      { name: null, value: "TC-0012 as registration" },
      { name: "mode", value: "api" },
      { name: "level", value: "K1" }
    ]);
    expect(plain).toMatchObject({ type: "use", alias: null, mode: "auto" });
    expect(useCaseKeyArg(plain?.args ?? [])).toBe("TC-0012");
    expect(named).toMatchObject({ alias: "approval" });
    expect(useCaseKeyArg(named?.args ?? [])).toBe("TC-0013");
    expect(upper?.mode).toBe("ui");
    expect(useAliasArg(parseStepArgs("TC-0012 as registration"))).toBe("registration");
    expect(useAliasArg(parseStepArgs("TC-0012"))).toBeNull();
    expect(useModeArg(parseStepArgs("TC-0012, mode=fast"))).toEqual({ mode: null, invalid: "fast" });
    // Every other step type carries the new fields as null.
    expect(testCase.steps[4]).toMatchObject({ type: "assert", alias: null, mode: null, binding: null });
    // Round trip keeps the lines as written.
    expect(serializeTestCase(testCase)).toBe(
      [
        "# T",
        "",
        "[Use: TC-0012 as registration, mode=api, level=K1]",
        "[Use: TC-0012, level=K1]",
        "[Use: case=TC-0013 as approval]",
        "[Use: TC-0014, mode=UI]",
        "[Assert] the dashboard is visible"
      ].join("\n")
    );
  });

  test("Outputs: and Reuse: metadata parse, serialise and round-trip", () => {
    const text = [
      "# Submit a registration",
      "Key: TC-0012",
      "Outputs: applicationId, studentId",
      "Reuse: within 30m",
      "",
      "[Open] /registrations/new",
      "[Act] submit the form",
      "[Extract: applicationId] the application number in the banner",
      "[Extract: studentId] the student id in the URL",
      "[Assert] the application is listed"
    ].join("\n");
    const { testCase, diagnostics } = parseTestCaseTranscript(text);
    expect(diagnostics).toEqual([]);
    expect(testCase.metadata.outputs).toEqual(["applicationId", "studentId"]);
    expect(testCase.metadata.reuse).toEqual({ kind: "within", ms: 30 * 60_000 });
    expect(testCase.metadata.order).toEqual(["key", "outputs", "reuse"]);
    expect(caseOutputsOf(testCase)).toEqual(["applicationId", "studentId"]);
    expect(producedNamesOf(testCase)).toEqual(["applicationId", "studentId"]);
    expect(serializeTestCase(testCase)).toBe(text);
    parsedTestCaseSchema.parse(testCase);

    for (const [input, policy, canonical] of [
      ["never", { kind: "never" }, "never"],
      ["within 30m", { kind: "within", ms: 1_800_000 }, "within 30m"],
      ["within 2h", { kind: "within", ms: 7_200_000 }, "within 2h"],
      ["within 1d", { kind: "within", ms: 86_400_000 }, "within 1d"],
      ["within 90 minutes", { kind: "within", ms: 5_400_000 }, "within 90m"],
      ["Within 2 hours", { kind: "within", ms: 7_200_000 }, "within 2h"]
    ] as const) {
      expect(parseReusePolicy(input)).toEqual(policy);
      expect(serializeReusePolicy(policy)).toBe(canonical);
    }
    expect(parseReusePolicy("while rows exist")).toBeNull();
    expect(parseReusePolicy("30m")).toBeNull();

    // An explicit `Reuse: never` keeps its line; a case without one has none.
    const explicit = parseTestCaseTranscript("# T\nReuse: never\n\n[Act] go").testCase;
    expect(explicit.metadata.reuse).toEqual({ kind: "never" });
    expect(serializeTestCase(explicit)).toBe("# T\nReuse: never\n\n[Act] go");
    expect(serializeTestCase(parseTestCaseTranscript("# T\n\n[Act] go").testCase)).toBe("# T\n\n[Act] go");

    // Invalid values are diagnostics; the policy stays never, the bad output name is dropped.
    const bad = parseTestCaseTranscript("# T\nOutputs: ok, student.id\nReuse: while rows exist\n\n[Act] go");
    expect(bad.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["invalid-metadata", "invalid-metadata"]);
    expect(bad.testCase.metadata.outputs).toEqual(["ok"]);
    expect(bad.testCase.metadata.reuse).toEqual({ kind: "never" });
    // Pre-roadmap transcripts still parse with empty outputs and never.
    const legacy = parseTestCaseTranscript(exampleTranscript).testCase;
    expect(legacy.metadata.outputs).toEqual([]);
    expect(legacy.metadata.reuse).toEqual({ kind: "never" });
  });

  test("[Query] and [API] bind their result with -> {name} and name a profile", () => {
    const { testCase } = parseTestCaseTranscript(
      [
        "# T",
        "",
        "[Query: PCF_UAT_DB] a K1 student with a pending registration and no holds -> {student}",
        "[Query: PCF_UAT_DB, name=k1-pending] the same students ->{rows}",
        "[API: SV_BACKEND] POST /registrations for {student.id}   ->   {registration}",
        "[Query: PCF_UAT_DB] the application {registration.applicationId} has status APPROVED",
        "[api: profile=SV_BACKEND] GET /health"
      ].join("\n")
    );
    const [first, second, third, check, lower] = testCase.steps;
    expect(first).toMatchObject({
      type: "query",
      tag: "Query",
      text: "a K1 student with a pending registration and no holds",
      binding: "student",
      credentialRefs: ["PCF_UAT_DB"],
      variables: []
    });
    expect(second).toMatchObject({ binding: "rows", text: "the same students" });
    expect(queryNameArg(second?.args ?? [])).toBe("k1-pending");
    expect(queryProfileArg(second?.args ?? [])).toBe("PCF_UAT_DB");
    expect(third).toMatchObject({ type: "api", binding: "registration", credentialRefs: ["SV_BACKEND"], variables: ["student.id"] });
    // No arrow: a check. The reference it reads is still a variable of the step.
    expect(check).toMatchObject({ binding: null, variables: ["registration.applicationId"] });
    expect(lower).toMatchObject({ type: "api", binding: null, credentialRefs: ["SV_BACKEND"] });
    expect(splitStepBinding("x -> {a.b}")).toEqual({ text: "x -> {a.b}", binding: null });
    expect(splitStepBinding("x")).toEqual({ text: "x", binding: null });

    // Serialisation writes the canonical ` -> {name}`; the model round-trips losslessly.
    const serialized = serializeTestCase(testCase);
    expect(serialized).toContain("[Query: PCF_UAT_DB] a K1 student with a pending registration and no holds -> {student}");
    expect(serialized).toContain("[Query: PCF_UAT_DB, name=k1-pending] the same students -> {rows}");
    expect(serialized).toContain("[API: SV_BACKEND] POST /registrations for {student.id} -> {registration}");
    expect(withoutLines(parseTestCaseTranscript(serialized).testCase)).toEqual(withoutLines(testCase));

    // The binding is part of the step identity; the arrow spacing is not.
    const key = (text: string) => parseTestCaseTranscript(`# T\n\n${text}`).testCase.steps[0]?.instructionKey;
    expect(key("[Query: DB] a student -> {student}")).toBe(key("[Query: DB] a student   ->{student}"));
    expect(key("[Query: DB] a student -> {student}")).not.toBe(key("[Query: DB] a student -> {rows}"));
    expect(key("[Query: DB] a student -> {student}")).not.toBe(key("[Query: DB] a student"));
    // Steps without a binding keep the key they had before bindings existed.
    expect(computeInstructionKey({ type: "act", macro: null, args: [], text: "click Save" })).toBe(
      computeInstructionKey({ type: "act", macro: null, args: [], text: "click Save", binding: null })
    );
  });

  test("dotted references resolve through aliases, bindings, params, columns and generated values", () => {
    expect(variableRoot("student.id")).toBe("student");
    expect(variableRoot("student")).toBe("student");
    const text = [
      "# T",
      "Params: child",
      "",
      "[Use: TC-0012 as registration, mode=api]",
      "[Query: PCF_UAT_DB] a K1 student named {child.name} -> {student}",
      "[Open] /student-detail/{student.id}",
      "[Assert] the page shows {student.name} and {registration.applicationId} and {person.name}",
      "[Extract: invoice] the invoice number",
      "[Assert] {invoice.total} is shown"
    ].join("\n");
    expect(ruleIds(text).filter((id) => id === "undeclared-variable")).toEqual([]);
    // Alias and bindings only count from the line after the one that produces them.
    const early = ruleIds("# T\n\n[Assert] {student.id} is shown\n[Query: DB] a student -> {student}\n[Assert] {nobody.id}");
    expect(early.filter((id) => id === "undeclared-variable")).toHaveLength(2);
    // Dataset columns as roots.
    expect(
      ruleIds("# T\n\n[Assert] {row.id} is shown\n\n## Dataset\n| row |\n| --- |\n| 1 |").filter((id) => id === "undeclared-variable")
    ).toEqual([]);

    // With the used case's outputs known, the field must be one of them; otherwise no warning.
    const withOutputs = { cases: [{ key: "TC-0012", outputs: ["applicationId"] }] };
    expect(ruleIds(text, withOutputs).filter((id) => id === "use-output-unknown")).toEqual([]);
    const wrongField = text.replace("{registration.applicationId}", "{registration.studentId}");
    const findings = lintTestCase(parseTestCaseTranscript(wrongField).testCase, withOutputs).filter(
      (finding) => finding.ruleId === "use-output-unknown"
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.message).toContain("applicationId");
    expect(ruleIds(wrongField, { cases: [{ key: "TC-0012" }] }).filter((id) => id === "use-output-unknown")).toEqual([]);
    expect(ruleIds(wrongField).filter((id) => id === "undeclared-variable")).toEqual([]);
  });

  test("lint rules for profiles, modes, reuse windows, shadowed bindings and outputs", () => {
    expect(ruleIds("# T\n\n[Query] a student -> {student}\n[API] GET /health")).toEqual(
      expect.arrayContaining(["query-needs-profile", "query-needs-profile"])
    );
    expect(ruleIds("# T\n\n[Query: DB] a student -> {student}\n[Assert] {student.id} is shown")).not.toContain("query-needs-profile");
    // A [Query] check counts as a verifying step.
    expect(ruleIds("# T\n\n[Act] submit\n[Query: DB] the row exists")).not.toContain("no-assert");
    expect(ruleIds("# T\n\n[Act] submit\n[Query: DB] the row -> {row}")).toContain("no-assert");
    expect(ruleIds("# T\n\n[Query: DB] a student -> {a.b}")).toContain("missing-argument");
    expect(ruleIds("# T\n\n[Query: DB]")).toContain("missing-argument");

    expect(ruleIds("# T\n\n[Use: TC-0001, mode=fast]\n[Assert] ok fine", { cases: [{ key: "TC-0001" }] })).toContain("use-mode-invalid");
    expect(ruleIds("# T\n\n[Use: TC-0001, mode=hybrid]", { cases: [{ key: "TC-0001" }] })).toContain("use-mode-invalid");
    expect(ruleIds("# T\n\n[Use: TC-0001, mode=Auto]", { cases: [{ key: "TC-0001" }] })).not.toContain("use-mode-invalid");

    expect(ruleIds("# T\nReuse: within 0m\n\n[Assert] the page loads")).toContain("reuse-invalid");
    expect(ruleIds("# T\nReuse: within 40d\n\n[Assert] the page loads")).toContain("reuse-invalid");
    expect(ruleIds("# T\nReuse: within 30m\n\n[Assert] the page loads")).not.toContain("reuse-invalid");

    expect(ruleIds("# T\nParams: student\n\n[Query: DB] a student -> {student}\n[Assert] {student.id} is shown")).toContain("binding-shadows-param");
    expect(ruleIds("# T\nParams: student\n\n[Extract: student] the id\n[Assert] {student} is shown")).toContain("binding-shadows-param");
    expect(ruleIds("# T\n\n[Query: DB] a student -> {student}\n[Assert] {student.id} is shown")).not.toContain("binding-shadows-param");

    expect(ruleIds("# T\nOutputs: applicationId\n\n[Assert] the page loads")).toContain("outputs-undeclared-binding");
    expect(ruleIds("# T\nOutputs: applicationId\n\n[Extract: applicationId] the id\n[Assert] {applicationId} is shown")).not.toContain("outputs-undeclared-binding");
    expect(ruleIds("# T\nOutputs: student\n\n[Query: DB] a student -> {student}\n[Assert] {student.id} is shown")).not.toContain("outputs-undeclared-binding");
    expect(
      ruleIds("# T\nOutputs: registration\n\n[Use: TC-0001 as registration]\n[Assert] {registration.applicationId} is shown", { cases: [{ key: "TC-0001" }] })
    ).not.toContain("outputs-undeclared-binding");

    for (const id of ["query-needs-profile", "use-mode-invalid", "reuse-invalid", "binding-shadows-param", "outputs-undeclared-binding", "use-output-unknown"]) {
      expect(transcriptLintRules.some((rule) => rule.id === id)).toBe(true);
    }
  });

  test("expansion tags [Use] children with the block's alias and effective mode and keeps bindings", () => {
    const inner = linkedCaseSchema.parse({
      key: "TC-0011",
      title: "Find a student",
      version: 2,
      params: [],
      transcript: "# Find a student\nOutputs: student\n\n[Query: PCF_UAT_DB] a K1 student -> {student}",
      outputs: ["student"]
    });
    const registration = linkedCaseSchema.parse({
      key: "TC-0012",
      title: "Submit a registration",
      version: 5,
      params: [{ name: "level", default: "K1", required: false }],
      transcript: [
        "# Submit a registration",
        "Outputs: applicationId",
        "",
        "[Use: TC-0011 as found]",
        "[Open] /registrations/new?student={found.student}&level={level}",
        "[Extract: applicationId] the application number",
        "[Assert] the application is listed"
      ].join("\n"),
      outputs: ["applicationId"]
    });
    const { testCase } = parseTestCaseTranscript(
      "# T\n\n[Use: TC-0012 as registration, mode=api, level=K2]\n[Query: PCF_UAT_DB] the application {registration.applicationId} has status APPROVED -> {row}\n[Assert] {row.status} is APPROVED"
    );
    const { steps, errors } = expandMacros(testCase.steps, [], [inner, registration]);
    expect(errors).toEqual([]);
    for (const step of steps) expandedStepSchema.parse(step);

    const use = steps.find((step) => step.depth === 0 && step.type === "use");
    expect(use).toMatchObject({ alias: "registration", mode: "api", useAlias: null, useMode: null, macroVersion: 5 });
    const children = steps.filter((step) => step.parentStepId === use?.stepId);
    expect(children.map((step) => step.type)).toEqual(["use", "open", "extract", "assert"]);
    expect(children.every((step) => step.useAlias === "registration" && step.useMode === "api")).toBe(true);
    expect(children[1]?.text).toBe("/registrations/new?student={found.student}&level=K2");
    // The nested block has its own alias and no mode of its own: it inherits `api`.
    const nested = children[0];
    expect(nested).toMatchObject({ alias: "found", mode: "auto", useAlias: "registration", useMode: "api" });
    const grandchildren = steps.filter((step) => step.parentStepId === nested?.stepId);
    expect(grandchildren).toHaveLength(1);
    expect(grandchildren[0]).toMatchObject({ type: "query", binding: "student", useAlias: "found", useMode: "api", depth: 2, credentialRefs: ["PCF_UAT_DB"] });
    // Steps of the case itself are outside any block.
    const own = steps.filter((step) => step.depth === 0 && step.type !== "use");
    expect(own.map((step) => [step.binding, step.useAlias, step.useMode])).toEqual([
      ["row", null, null],
      [null, null, null]
    ]);
  });

  test("step ids stay stable for unchanged lines when a binding or alias changes", () => {
    const original = parseTestCaseTranscript(
      "# T\n\n[Use: TC-0012 as registration, mode=api]\n[Query: DB] a student -> {student}\n[Open] /student-detail/{student.id}\n[Assert] the page shows {student.name}"
    ).testCase;
    const edited = parseTestCaseTranscript(
      "# T\n\n[Use: TC-0012 as reg, mode=api]\n[Query: DB] a student -> {learner}\n[Open] /student-detail/{student.id}\n[Assert] the page shows {student.name}",
      { previousSteps: original.steps }
    ).testCase;
    expect(edited.steps[0]?.stepId).not.toBe(original.steps[0]?.stepId);
    expect(edited.steps[1]?.stepId).not.toBe(original.steps[1]?.stepId);
    expect(edited.steps[2]?.stepId).toBe(original.steps[2]?.stepId ?? "missing");
    expect(edited.steps[3]?.stepId).toBe(original.steps[3]?.stepId ?? "missing");
    // Only arrow spacing changed: same instruction, same id.
    const spaced = parseTestCaseTranscript(
      "# T\n\n[Use: TC-0012 as registration, mode=api]\n[Query: DB] a student   ->{student}\n[Open] /student-detail/{student.id}\n[Assert] the page shows {student.name}",
      { previousSteps: original.steps }
    ).testCase;
    expect(spaced.steps.map((step) => step.stepId)).toEqual(original.steps.map((step) => step.stepId));
  });

  test("steps stored before alias, mode and binding existed still validate", () => {
    const legacy = {
      stepId: "st_0000000000000000",
      instructionKey: `sha256:${"0".repeat(64)}`,
      ordinal: 1,
      line: 3,
      type: "act",
      tag: null,
      macro: null,
      args: [],
      text: "click Save",
      checkpointId: null,
      variables: [],
      credentialRefs: [],
      fileRefs: [],
      disabled: false
    };
    expect(transcriptStepSchema.parse(legacy)).toMatchObject({ alias: null, mode: null, binding: null });
    expect(expandedStepSchema.parse({ ...legacy, parentStepId: null, depth: 0, macroVersion: null })).toMatchObject({ useAlias: null, useMode: null });
    expect(linkedCaseSchema.parse({ key: "TC-1", title: "", version: 1, params: [], transcript: "" }).outputs).toBeUndefined();
  });
});
