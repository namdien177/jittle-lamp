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
    expect(loginChildren.map((step) => step.type)).toEqual(["open", "act", "act", "wait"]);
    expect(loginChildren[1]?.instruction).toContain("adminmanager@example.test");
    expect(loginChildren[2]?.instruction).toBe("enter {{secret:PCF_HQ_ADMIN.password}} into the password field and submit the login form");
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

// Roadmap 2026-10-13 §2.5, §2.6: which steps replay through their API script, how a [Use] block
// with a reuse window is skipped and its outputs injected, and dotted references into bindings.
import { stepPrefersApi, stepMayRecordApi, resolveApiSteps } from "../src/api/modes";
import { applyReuse, paramsHashOf, useBlockParams } from "../src/api/reuse";
import { createFileApiScriptStore } from "../src/api/store";
import { apiRequestScriptSchema, defaultApiPolicy, type LinkedCase } from "@jittle-lamp/shared";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const registration: LinkedCase = {
  key: "TC-0012",
  title: "Submit a registration",
  version: 3,
  params: [{ name: "level", required: false, default: "K1" }],
  outputs: ["applicationId"],
  transcript: ["# Submit a registration", "Key: TC-0012", "Params: level=K1", "Outputs: applicationId", "Reuse: within 30m", "", "[Open] /registrations/new?level={level}", "[Act] submit the form", "[Extract: applicationId] the application number"].join("\n")
};
const consumer = ["# Approve", "", "[Use: TC-0012 as registration, level=K2] create one first", "[Open] /applications/{registration.applicationId}", "[Act] approve it", "## Checkpoint: c", "[Assert] the status reads Approved"].join("\n");
const consumerConfig = resolveRunConfig({ env: { JL_ENV_NAME: "pcf-uat", JL_ENV_BASE_URL: "https://uat.pcf.example.test" } });

describe("execution modes and reuse", () => {
  test("{alias.name} into a [Use] block's outputs is not a missing variable", () => {
    const plan = buildRunPlan({ transcript: consumer, config: consumerConfig, macros: loadMacros([]), cases: [registration] });
    expect(plan.blockedReason).toBeNull();
    expect(plan.steps.find((step) => step.type === "open" && step.parentStepId === null)?.instruction).toBe("/applications/{registration.applicationId}");
  });

  test("mode resolution: the case's own acts replay only under api; [Use] blocks follow their mode, auto follows the run", () => {
    const plan = buildRunPlan({ transcript: consumer, config: consumerConfig, macros: loadMacros([]), cases: [registration] });
    const ownAct = plan.steps.find((step) => step.type === "act" && step.parentStepId === null)!;
    const innerAct = plan.steps.find((step) => step.type === "act" && step.parentStepId !== null)!;
    const innerOpen = plan.steps.find((step) => step.type === "open" && step.parentStepId !== null)!;
    expect(innerAct.useMode).toBe("auto");
    expect(stepPrefersApi(ownAct, "full")).toBe(false);
    expect(stepPrefersApi(ownAct, "hybrid")).toBe(false);
    expect(stepPrefersApi(ownAct, "api")).toBe(true);
    expect(stepPrefersApi(innerAct, "full")).toBe(false);
    expect(stepPrefersApi(innerAct, "hybrid")).toBe(true);
    expect(stepPrefersApi(innerAct, "api")).toBe(true);
    expect(stepPrefersApi({ ...innerAct, useMode: "api" }, "full")).toBe(true);
    expect(stepPrefersApi({ ...innerAct, useMode: "ui" }, "api")).toBe(false);
    // Opens navigate the browser and never replay; a [Use] act records even on a full run.
    expect(stepPrefersApi(innerOpen, "api")).toBe(false);
    expect(stepMayRecordApi(innerAct, "full")).toBe(true);
    expect(stepMayRecordApi(ownAct, "full")).toBe(false);
    expect(stepMayRecordApi(ownAct, "api")).toBe(true);
  });

  test("resolveApiSteps looks up scripts only for steps that prefer API and only with API origins", async () => {
    const plan = buildRunPlan({ transcript: consumer, config: consumerConfig, macros: loadMacros([]), cases: [registration] });
    const store = createFileApiScriptStore({ dir: mkdtempSync(join(tmpdir(), "jl-api-store-")) });
    const innerAct = plan.steps.find((step) => step.type === "act" && step.parentStepId !== null)!;
    const ownAct = plan.steps.find((step) => step.type === "act" && step.parentStepId === null)!;
    const script = (stepId: string) => apiRequestScriptSchema.parse({ schemaVersion: "jl-api-1", stepId, instructionKey: null, recordedAt: "2026-10-13T00:00:00.000Z", requests: [], auth: {}, reviewFlags: [] });
    await store.write(script(innerAct.stepId));
    await store.write(script(ownAct.stepId));
    const hybrid = await resolveApiSteps(plan.steps, { executionMode: "hybrid", apiOrigins: ["https://api.example.test"], apiPolicy: defaultApiPolicy }, store);
    expect(hybrid.preferred).toEqual([innerAct.stepId]);
    expect(Object.keys(hybrid.scripts)).toEqual([innerAct.stepId]);
    const api = await resolveApiSteps(plan.steps, { executionMode: "api", apiOrigins: ["https://api.example.test"], apiPolicy: defaultApiPolicy }, store);
    expect(Object.keys(api.scripts).sort()).toEqual([innerAct.stepId, ownAct.stepId].sort());
    const unconfigured = await resolveApiSteps(plan.steps, { executionMode: "api", apiOrigins: [], apiPolicy: defaultApiPolicy }, store);
    expect(unconfigured.scripts).toEqual({});
    await store.markStale(innerAct.stepId, "test");
    expect(await store.read(innerAct.stepId)).toBeNull();
  });

  test("a reuse hit skips the block's steps and injects the run's outputs under the alias", async () => {
    const plan = buildRunPlan({ transcript: consumer, config: consumerConfig, macros: loadMacros([]), cases: [registration] });
    const use = plan.steps.find((step) => step.type === "use")!;
    expect(useBlockParams(use, registration)).toEqual({ level: "K2" });
    const queries: unknown[] = [];
    const reuse = await applyReuse(plan, [registration], async (query) => {
      queries.push(query);
      return { runId: "run_prev", outputs: { applicationId: "APP-77", student: '{"id":"s-1"}' } };
    });
    expect(queries).toEqual([{ caseKey: "TC-0012", paramsHash: paramsHashOf({ level: "K2" }), withinMs: 30 * 60_000 }]);
    expect([...reuse.skippedStepIds].sort()).toEqual(plan.steps.filter((step) => step.stepId === use.stepId || step.stepId.startsWith(`${use.stepId}.`)).map((step) => step.stepId).sort());
    expect(reuse.outputs).toEqual({ "registration.applicationId": "APP-77", "registration.student": '{"id":"s-1"}' });
    expect(reuse.reusedFromRunIds).toEqual(["run_prev"]);
    expect(reuse.blocks).toEqual([{ stepId: use.stepId, caseKey: "TC-0012", runId: "run_prev" }]);
    // A miss, a lookup failure, or a case without a window runs the block as usual.
    const miss = await applyReuse(plan, [registration], async () => null);
    expect(miss.skippedStepIds.size).toBe(0);
    const failed = await applyReuse(plan, [registration], async () => { throw new Error("offline"); });
    expect(failed.skippedStepIds.size).toBe(0);
    const never = await applyReuse(plan, [{ ...registration, transcript: registration.transcript.replace("Reuse: within 30m\n", "") }], async () => ({ runId: "x", outputs: {} }));
    expect(never.skippedStepIds.size).toBe(0);
    expect(paramsHashOf({ b: "2", a: "1" })).toBe(paramsHashOf({ a: "1", b: "2" }));
  });
});
