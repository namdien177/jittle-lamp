import { describe, expect, test } from "bun:test";

import { allFakers } from "@faker-js/faker";
import { fakeDataFields, fakeDataLocales, lintTestCase, parseTestCaseTranscript } from "@jittle-lamp/shared";

import { buildChildEnv } from "../src/run";
import { isSecretVariable, resolveRunConfig } from "../src/config/resolve";
import { generateFakeData } from "../src/fake-data";
import { compileStep } from "../src/generate/project";
import { buildRunPlan, loadMacros } from "../src/plan";

const env = { JL_ENV_NAME: "pcf-uat", JL_ENV_BASE_URL: "https://uat.example.test" };
const allTokens = fakeDataFields.map((field) => `${field.group}.${field.field}`);

describe("generated values", () => {
  test("every catalog field generates a non-empty value in every offered locale", () => {
    for (const locale of fakeDataLocales) {
      expect(Object.keys(allFakers)).toContain(locale);
      const values = generateFakeData(allTokens, { locale, seed: 1 });
      for (const token of allTokens) expect(values[token]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test("no generated name reads as a secret, so values are typed in clear and shown in reports", () => {
    expect(allTokens.filter((token) => isSecretVariable(token))).toEqual([]);
  });

  test("fields of one person agree, aliases share a value and personN is someone else", () => {
    const values = generateFakeData(
      ["person.name", "person.fullName", "person.firstName", "person.lastName", "person.email", "internet.email", "person2.name", "person2.email"],
      { seed: 3 }
    );
    expect(values["person.name"]).toBe(`${values["person.firstName"]} ${values["person.lastName"]}`);
    expect(values["person.fullName"]).toBe(values["person.name"]);
    expect(values["internet.email"]).toBe(values["person.email"]);
    expect(values["person.email"]).toContain(values["person.firstName"]!.toLowerCase());
    expect(values["person.email"]).toEndWith("@example.com");
    expect(values["person2.name"]).not.toBe(values["person.name"]);
    expect(values["person2.email"]).not.toBe(values["person.email"]);
  });

  test("full names follow the locale's order without titles; Vietnamese emails drop accents", () => {
    for (let seed = 0; seed < 40; seed += 1) {
      const en = generateFakeData(["person.name", "person.firstName", "person.lastName"], { seed });
      expect(en["person.name"]).toBe(`${en["person.firstName"]} ${en["person.lastName"]}`);
    }
    const ja = generateFakeData(["person.name", "person.firstName", "person.lastName"], { locale: "ja", seed: 2 });
    expect(ja["person.name"]).toBe(`${ja["person.lastName"]} ${ja["person.firstName"]}`);
    const values = generateFakeData(["person.name", "person.firstName", "person.lastName", "person.email"], { locale: "vi", seed: 7 });
    expect(values["person.name"]).toBe(`${values["person.lastName"]} ${values["person.firstName"]}`);
    expect(values["person.name"]).toMatch(/[^\u0000-\u007f]/);
    expect(values["person.email"]).toMatch(/^[a-z0-9._-]+@example\.com$/);
  });

  test("an unknown locale falls back to English and unknown fields generate nothing", () => {
    expect(generateFakeData(["person.name"], { locale: "xx", seed: 1 })).toEqual(generateFakeData(["person.name"], { locale: "en", seed: 1 }));
    expect(generateFakeData(["person.nmae", "SCHOOL"], { seed: 1 })).toEqual({});
  });

  test("lint accepts generated values and names the fields of a mistyped one", () => {
    const { testCase } = parseTestCaseTranscript("# T\n\n[Open] /signup\nType {person.name} into Name\nType {person.nmae} into Nickname\n## Checkpoint: c\n[Assert] the form is filled");
    const findings = lintTestCase(testCase, {}).filter((finding) => finding.ruleId === "undeclared-variable");
    expect(findings.map((finding) => finding.message)).toEqual([
      "{person.nmae} is not a generated value. person has: name, fullName, firstName, lastName, email, username, phone, sex, birthdate, jobTitle."
    ]);
    expect(findings[0]?.fix).toBeNull();
  });
});

describe("run plan: generated values", () => {
  const transcript = [
    "# Sign up",
    "",
    "[Open] /signup",
    "Type {person.name} into Full name",
    "Type {person.email} into Email",
    "Type {location.address} into Address",
    "## Checkpoint: c",
    "[Assert] the welcome page greets {person.firstName}"
  ].join("\n");

  test("fills each token once, in the environment's locale, and passes it to the e2e process", () => {
    const config = resolveRunConfig({ env: { ...env, JL_DATA_LOCALE: "vi" } });
    expect(config.dataLocale).toBe("vi");
    const plan = buildRunPlan({ transcript, config, macros: loadMacros([]) });
    expect(plan.blockedReason).toBeNull();
    expect(Object.keys(plan.generated).sort()).toEqual(["location.address", "person.email", "person.firstName", "person.name"]);
    expect(plan.params).toMatchObject(plan.generated);
    expect(plan.steps[1]?.instruction).toBe(`Type ${plan.generated["person.name"]} into Full name`);
    expect(plan.steps.at(-1)?.instruction).toBe(`the welcome page greets ${plan.generated["person.firstName"]}`);

    // The generated test reads the value from JL_VAR_person.name at run time.
    const compiled = compileStep(plan.steps[1]!, plan, config, new Set());
    expect(compiled.template).toBe("Type {person_name} into Full name");
    expect(compiled.bindings).toEqual({ person_name: { kind: "var", name: "person.name" } });
    const childEnv = buildChildEnv({ config, plan, host: {}, extra: {} });
    expect(childEnv["JL_VAR_person.name"]).toBe(plan.generated["person.name"]);
  });

  test("a run param or dataset column of the same name wins over generation", () => {
    const plan = buildRunPlan({ transcript, config: resolveRunConfig({ env }), macros: loadMacros([]), params: { "person.name": "Ada Lovelace" } });
    expect(plan.generated["person.name"]).toBeUndefined();
    expect(plan.steps[1]?.instruction).toBe("Type Ada Lovelace into Full name");
  });

  test("each run draws new values", () => {
    const first = buildRunPlan({ transcript, config: resolveRunConfig({ env }), macros: loadMacros([]) });
    const second = buildRunPlan({ transcript, config: resolveRunConfig({ env }), macros: loadMacros([]) });
    expect(second.generated["person.email"]).not.toBe(first.generated["person.email"]);
  });
});

describe("run plan: extracted values", () => {
  test("{x} after [Extract: x] is filled while the run executes, not reported missing", () => {
    const plan = buildRunPlan({
      transcript: "# T\n\n[Open] /orders\n[Extract: orderId] the newest order number\nOpen order {orderId}\n## Checkpoint: c\n[Assert] order {orderId} is shown",
      config: resolveRunConfig({ env }),
      macros: loadMacros([])
    });
    expect(plan.blockedReason).toBeNull();
    expect(plan.missing).toEqual([]);
    expect(plan.steps[2]?.instruction).toBe("Open order {orderId}");
  });

  test("{x} before its [Extract: x] is still missing", () => {
    const plan = buildRunPlan({
      transcript: "# T\n\n[Open] /orders\nOpen order {orderId}\n[Extract: orderId] the newest order number\n## Checkpoint: c\n[Assert] the order is shown",
      config: resolveRunConfig({ env }),
      macros: loadMacros([])
    });
    expect(plan.blockedReason).toBe("MISSING_VARIABLE");
    expect(plan.missing).toEqual(["vars.orderId"]);
  });
});
