import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandMacros, lintTestCase, parseTestCaseTranscript, type LinkedCase } from "@jittle-lamp/shared";

import { resolveRunConfig } from "../src/config/resolve";
import { compileStep } from "../src/generate/project";
import { buildRunPlan, loadCaseDir, loadMacros } from "../src/plan";

const env = {
  JL_ENV_NAME: "pcf-uat",
  JL_ENV_BASE_URL: "https://uat.example.test",
  JL_CRED_PCF_HQ_ADMIN_USERNAME: "admin@example.test",
  JL_CRED_PCF_HQ_ADMIN_PASSWORD: "fixture-Pa55word!"
};

const loginCase: LinkedCase = {
  key: "TC-0001",
  title: "Admin signs in",
  version: 3,
  params: [{ name: "profile", default: "PCF", required: true }],
  transcript: [
    "# Admin signs in",
    "Key: TC-0001",
    "Params: profile=PCF",
    "",
    "[Open] /login",
    "[Login: {profile}] sign in",
    "[Extract: schoolName] the school name in the header",
    "## Checkpoint: Signed in",
    "[Assert] the dashboard is visible"
  ].join("\n")
};

const outer = [
  "# Admin creates an interest",
  "Key: TC-0002",
  "",
  "[Use: TC-0001] sign in first",
  "Open Interests and click New interest",
  "Type {schoolName} into the School field",
  "## Checkpoint: Saved",
  "[Assert] the interest for {schoolName} is listed"
].join("\n");

const parse = (text: string) => parseTestCaseTranscript(text).testCase;

describe("[Use: KEY] expansion", () => {
  test("runs the linked case's steps inline as children of the Use step", () => {
    const { steps, errors } = expandMacros(parse(outer).steps, loadMacros([]), [loginCase]);
    expect(errors).toEqual([]);
    const use = steps[0]!;
    expect(use.type).toBe("use");
    expect(use.macroVersion).toBe(3);
    const children = steps.filter((step) => step.parentStepId === use.stepId);
    expect(children.map((step) => `${step.stepId.slice(use.stepId.length)} ${step.type}`)).toEqual([".1 open", ".2 login", ".3 extract", ".4 assert"]);
    // The Login inside the linked case expands one level further, through the Login macro.
    expect(steps.filter((step) => step.depth === 2).length).toBeGreaterThan(0);
    // Defaults fill the linked case's params.
    expect(children[1]?.args).toEqual([{ name: null, value: "PCF" }]);
  });

  test("named arguments after the key fill params; case= names the key; keys ignore case", () => {
    for (const line of ["[Use: TC-0001, profile=PCF_HQ_ADMIN]", "[Use: case=TC-0001, profile=PCF_HQ_ADMIN]", "[Use: tc-0001, profile=PCF_HQ_ADMIN]"]) {
      const { steps, errors } = expandMacros(parse(`# T\n\n${line}`).steps, loadMacros([]), [loginCase]);
      expect(errors).toEqual([]);
      expect(steps.find((step) => step.type === "login")?.args).toEqual([{ name: null, value: "PCF_HQ_ADMIN" }]);
    }
    const unknown = expandMacros(parse("# T\n\n[Use: TC-0001, role=x]").steps, loadMacros([]), [loginCase]);
    expect(unknown.errors.map((error) => error.message)).toEqual(['TC-0001 has no param "role".']);
  });

  test("an unknown key, a missing key and a cycle are errors", () => {
    expect(expandMacros(parse("# T\n\n[Use: TC-0404]").steps, [], [loginCase]).errors.map((error) => error.code)).toEqual(["unknown-case"]);
    expect(expandMacros(parse("# T\n\n[Use]").steps, [], [loginCase]).errors.map((error) => error.message)).toEqual(["[Use] needs a case key, e.g. [Use: TC-0001]."]);
    const a: LinkedCase = { key: "TC-0010", title: "A", version: 1, params: [], transcript: "# A\n\n[Use: TC-0011]" };
    const b: LinkedCase = { key: "TC-0011", title: "B", version: 1, params: [], transcript: "# B\n\n[Use: TC-0010]" };
    expect(expandMacros(parse("# T\n\n[Use: TC-0010]").steps, [], [a, b]).errors.map((error) => error.message)).toEqual(["TC-0010 uses itself."]);
  });

  test("lint: [Use] needs a key, may not name its own case and, with the catalog, a known one", () => {
    const messages = (text: string, cases?: Array<{ key: string }>) =>
      lintTestCase(parse(text), cases ? { cases } : {})
        .filter((finding) => finding.ruleId === "use-needs-case")
        .map((finding) => finding.message);
    expect(messages("# T\nKey: TC-0002\n\n[Use]")).toEqual(["[Use] needs a case key, e.g. [Use: TC-0001]."]);
    expect(messages("# T\nKey: TC-0002\n\n[Use: tc-0002]")).toEqual(["tc-0002 cannot use itself."]);
    expect(messages("# T\n\n[Use: TC-0404]", [{ key: "TC-0001" }])).toEqual(["No test case TC-0404."]);
    expect(messages("# T\n\n[Use: TC-0404]")).toEqual([]);
    // Saved transcripts carry no Key: line; the editor and backend pass the case's key.
    const self = lintTestCase(parse("# T\n\n[Use: TC-0007]"), { caseKey: "TC-0007" }).filter((finding) => finding.ruleId === "use-needs-case");
    expect(self.map((finding) => finding.message)).toEqual(["TC-0007 cannot use itself."]);
  });
});

describe("run plan with [Use: KEY]", () => {
  test("the linked login runs in the same plan and its extracted value fills later steps", () => {
    const config = resolveRunConfig({ env });
    const plan = buildRunPlan({ transcript: outer, config, macros: loadMacros([]), cases: [loginCase] });
    expect(plan.blockedReason).toBeNull();
    expect(plan.missing).toEqual([]);
    expect(plan.cases).toEqual([{ key: "TC-0001", version: 3 }]);
    expect(plan.credentialAliases).toEqual({ PCF: "PCF_HQ_ADMIN" });
    const use = plan.steps.find((step) => step.type === "use")!;
    expect(use.executes).toBe(false);
    expect(plan.steps.filter((step) => step.parentStepId === use.stepId && step.executes).map((step) => step.type)).toEqual(["open", "extract", "assert"]);

    // {schoolName} comes from the linked case's [Extract] while the run executes.
    const typed = plan.steps.find((step) => step.text.startsWith("Type {schoolName}"))!;
    expect(typed.instruction).toBe("Type {schoolName} into the School field");
    const compiled = compileStep(typed, plan, config, new Set(["schoolName"]));
    expect(compiled.bindings).toEqual({ schoolName: { kind: "extracted", name: "schoolName" } });
  });

  test("a deleted or unknown linked case blocks the run as TRANSCRIPT_INVALID with its key", () => {
    const plan = buildRunPlan({ transcript: outer, config: resolveRunConfig({ env }), macros: loadMacros([]), cases: [] });
    expect(plan.blockedReason).toBe("TRANSCRIPT_INVALID");
    expect(plan.blockedMessage).toContain("No test case TC-0001.");
  });

  test("local runs read the linked case from the transcripts next to the one being run", () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-use-"));
    writeFileSync(join(dir, "admin-signs-in.transcript.md"), loginCase.transcript);
    writeFileSync(join(dir, "no-key.transcript.md"), "# No key\n\n[Open] /");
    const cases = loadCaseDir(dir);
    expect(cases.map((linked) => [linked.key, linked.title, linked.params.map((param) => param.name)])).toEqual([["TC-0001", "Admin signs in", ["profile"]]]);
    expect(cases[0]?.version).toBeGreaterThan(0);
  });
});
