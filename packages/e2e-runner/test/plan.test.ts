import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRunConfig } from "../src/config/resolve";
import { buildRunPlan, loadMacros } from "../src/plan";

const FIXTURE_PASSWORD = "fixture-Pa55word!";
const example = readFileSync(join(import.meta.dir, "../../../docs/e2e-test-cases/examples/pcf-logout-clears-email.transcript.md"), "utf8");

const pcfEnv = {
  JL_ENV_NAME: "pcf-uat",
  JL_ENV_BASE_URL: "https://uat.pcf.example.test",
  JL_CRED_PCF_HQ_ADMIN_USERNAME: "adminmanager@example.test",
  JL_CRED_PCF_HQ_ADMIN_PASSWORD: FIXTURE_PASSWORD
};

describe("run plan", () => {
  test("expands [Login: PCF] through the built-in Login macro and keeps the password out of the text", () => {
    const plan = buildRunPlan({ transcript: example, config: resolveRunConfig({ env: pcfEnv }), macros: loadMacros([]) });
    expect(plan.blockedReason).toBeNull();
    expect(plan.credentialAliases).toEqual({ PCF: "PCF_HQ_ADMIN" });

    const loginChildren = plan.steps.filter((step) => step.parentStepId !== null);
    expect(loginChildren.map((step) => step.type)).toEqual(["open", "act", "act", "act", "wait"]);
    expect(loginChildren[1]?.instruction).toContain("adminmanager@example.test");
    expect(loginChildren[2]?.instruction).toBe("enter {{secret:PCF_HQ_ADMIN.password}} into the password field");
    expect(loginChildren[2]?.secrets.map((secret) => secret.name)).toEqual(["PCF_HQ_ADMIN.password"]);
    expect(JSON.stringify(plan.steps.map(({ secrets: _secrets, ...step }) => step))).not.toContain(FIXTURE_PASSWORD);
    expect(plan.steps.find((step) => step.type === "login")?.executes).toBe(false);
  });

  test("missing credentials and variables block the run with names only", () => {
    const plan = buildRunPlan({
      transcript: "# T\nParams: role\n\n[Open] /login\n[Login: {role}]\nType {SCHOOL} into School\n## Checkpoint: c\n[Assert] the school dashboard is visible",
      config: resolveRunConfig({ env: {} }),
      macros: loadMacros([]),
      params: { role: "NOPE" }
    });
    expect(plan.blockedReason).toBe("MISSING_CREDENTIAL");
    expect(plan.missing).toEqual(["credential('NOPE')", "credential('NOPE').password", "credential('NOPE').username", "env.baseUrl", "vars.SCHOOL"]);
  });

  test("lint errors block the run as TRANSCRIPT_INVALID", () => {
    const plan = buildRunPlan({
      transcript: "# T\n\n[Login]\n## Checkpoint: c\n[Assert] the dashboard is visible",
      config: resolveRunConfig({ env: pcfEnv }),
      macros: loadMacros([])
    });
    expect(plan.blockedReason).toBe("TRANSCRIPT_INVALID");
  });

  test("secret variables become placeholders, public ones are substituted", () => {
    const plan = buildRunPlan({
      transcript: "# T\n\n[Open] /otp\nEnter {OTP_CODE} into the code field for {SCHOOL}\n## Checkpoint: c\n[Assert] the dashboard is visible",
      config: resolveRunConfig({ env: { ...pcfEnv, JL_VAR_OTP_CODE: "246810", JL_VAR_SCHOOL: "HQ" } }),
      macros: loadMacros([])
    });
    expect(plan.steps[1]?.instruction).toBe("Enter {{secret:vars.OTP_CODE}} into the code field for HQ");
  });
});

describe("review regressions: params", () => {
  test("a secret run param is never substituted into instruction text", () => {
    const plan = buildRunPlan({
      transcript: "# T\nParams: password\n\n[Open] /login\nType {password} into the field\n## Checkpoint: c\n[Assert] the dashboard is visible",
      config: resolveRunConfig({ env: pcfEnv, params: { password: "hunter2-SECRET" } }),
      macros: loadMacros([]),
      params: { password: "hunter2-SECRET" }
    });
    expect(JSON.stringify(plan.steps.map(({ secrets: _secrets, ...step }) => step))).not.toContain("hunter2-SECRET");
    expect(JSON.stringify(plan.params)).not.toContain("hunter2-SECRET");
    expect(plan.steps[1]?.instruction).toBe("Type {{secret:vars.password}} into the field");
  });

  test("case defaults come after the config chain (design.md §9.2)", () => {
    const plan = buildRunPlan({
      transcript: "# T\nParams: role=HQ_ADMIN\n\n[Open] /login\nType {role} into Role\n## Checkpoint: c\n[Assert] the dashboard is visible",
      config: resolveRunConfig({ env: { ...pcfEnv, JL_VAR_role: "BRANCH_ADMIN" } }),
      macros: loadMacros([])
    });
    expect(plan.params.role).toBe("BRANCH_ADMIN");
  });
});
