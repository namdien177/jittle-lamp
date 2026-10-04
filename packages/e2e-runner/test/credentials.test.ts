import { describe, expect, test } from "bun:test";

import { resolveRunConfig, type OrgRunConfig } from "../src/config/resolve";
import { explorationPreflight, toExplorationRecord } from "../src/explore";
import { renderConfigFile } from "../src/generate/project";
import { buildRunPlan, loadMacros } from "../src/plan";
import { buildChildEnv } from "../src/run";

// Production 2026-10-04: the ILHAM_ALL_ACCESS_ACCOUNT and PCF_ALL_ACCESS_ACCOUNT profiles store a
// public `email` and a secret `password`. The generated e2e config read JL_CRED_<P>_USERNAME only,
// so the explorer saw username "" and stopped with AUTH_CREDENTIAL_UNAVAILABLE.

const PASSWORD = "fixture-Pa55word!";
const org = (fields: Record<string, string>, secretFields: Record<string, string> = { password: PASSWORD }): OrgRunConfig => ({
  environment: { name: "ilham-uat", baseUrl: "https://uat.ilham.example.test", variables: {} },
  credentials: [{ profile: "ILHAM_ALL_ACCESS_ACCOUNT", fields, secretFields }],
  model: null
});

describe("login identifier", () => {
  test("an email-only profile signs in with its email as username, password stays secret", () => {
    const config = resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }) });
    const fields = config.credentials.get("ILHAM_ALL_ACCESS_ACCOUNT");
    expect(fields?.get("username")).toEqual({ value: "qa.admin@example.test", source: "org:ilham-uat", secret: false });
    expect(fields?.get("email")?.value).toBe("qa.admin@example.test");
    expect(fields?.get("password")?.secret).toBe(true);
  });

  test("any sole public field works; multiple fields need a role, preserving existing username", () => {
    const pick = (fields: Record<string, string>, loginField?: string) => {
      const input = org(fields); input.credentials[0]!.loginField = loginField ?? null;
      return resolveRunConfig({ env: {}, org: input });
    };
    expect(pick({ username: "old", email: "qa@example.test" }).loginFields.get("ILHAM_ALL_ACCESS_ACCOUNT")).toBe("username");
    expect(pick({ nickname: "qa-nick" }).credentials.get("ILHAM_ALL_ACCESS_ACCOUNT")?.get("username")?.value).toBe("qa-nick");
    expect(pick({ employee_code: "E123" }).loginFields.get("ILHAM_ALL_ACCESS_ACCOUNT")).toBe("employee_code");
    expect(pick({ nickname: "qa-nick", email: "qa@example.test" }).credentialErrors.get("ILHAM_ALL_ACCESS_ACCOUNT")).toContain("email, nickname");
    const selected = pick({ username: "original", nickname: "qa-nick", email: "qa@example.test" }, "nickname");
    expect(selected.loginFields.get("ILHAM_ALL_ACCESS_ACCOUNT")).toBe("nickname");
    expect(selected.credentials.get("ILHAM_ALL_ACCESS_ACCOUNT")?.get("username")?.value).toBe("original");
    expect(pick({ email: "" }).credentialErrors.get("ILHAM_ALL_ACCESS_ACCOUNT")).toContain("empty");
  });

  test("an email given as JL_CRED_<P>_EMAIL in a local .env counts too", () => {
    const config = resolveRunConfig({ env: { JL_CRED_LOCAL_ADMIN_EMAIL: "local@example.test", JL_CRED_LOCAL_ADMIN_PASSWORD: PASSWORD } });
    expect(config.credentials.get("LOCAL_ADMIN")?.get("username")?.value).toBe("local@example.test");
  });

  test("the generated e2e config and child env agree on the name, and the password stays a handle", () => {
    const config = resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }) });
    const source = renderConfigFile({
      targetName: "ilham-uat",
      appIdentity: "jl-env:ilham-uat",
      fallbackUrl: "https://uat.ilham.example.test",
      credentialProfiles: [...config.credentials.keys()],
      secretNames: [],
      cacheMode: "off",
      cacheStoreDir: "/tmp/cache",
      headed: false,
      viewport: { width: 1280, height: 800 },
      timeoutMs: 60_000
    });
    expect(source).toContain('"ILHAM_ALL_ACCESS_ACCOUNT": { username: process.env["JL_LOGIN_ILHAM_ALL_ACCESS_ACCOUNT_IDENTIFIER"] ?? process.env["JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_USERNAME"] ?? "", password: () => process.env["JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_PASSWORD"] ?? "" }');
    expect(source).not.toContain(PASSWORD);
    expect(source).not.toContain("qa.admin@example.test");
    const env = buildChildEnv({ config, plan: { baseUrl: "https://uat.ilham.example.test", params: {}, agentInstructions: null }, host: {}, extra: {} });
    expect(env.JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_USERNAME).toBe("qa.admin@example.test");
    expect(env.JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_PASSWORD).toBe(PASSWORD);
  });

  test("[Login: ILHAM_ALL_ACCESS_ACCOUNT] with an email-only profile is not blocked and types the email", () => {
    const plan = buildRunPlan({
      transcript: "# ILHAM sign in\n\n[Login: ILHAM_ALL_ACCESS_ACCOUNT] sign in\n## Checkpoint: Signed in\n[Assert] the navigation menu is visible",
      config: resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }) }),
      macros: loadMacros([])
    });
    expect(plan.blockedReason).toBeNull();
    expect(plan.missing).toEqual([]);
    const typed = plan.steps.filter((step) => step.parentStepId !== null).map((step) => step.instruction);
    expect(typed).toContain("enter qa.admin@example.test into the login identifier field of the login form");
    expect(typed).toContain("enter {{secret:ILHAM_ALL_ACCESS_ACCOUNT.password}} into the password field");
  });
});

describe("exploration preflight", () => {
  test("a profile the instructions name but the organisation lacks stops the exploration", () => {
    const config = resolveRunConfig({ env: {}, org: { ...org({ email: "qa.admin@example.test" }), credentials: [] } });
    expect(explorationPreflight(config, ["PCF_ALL_ACCESS_ACCOUNT"])).toBe(
      "No login credential named PCF_ALL_ACCESS_ACCOUNT for this environment; add it in Testing settings → Credentials"
    );
  });

  test("a profile without an identifier or password stops it, without showing any value", () => {
    const noIdentifier = resolveRunConfig({ env: {}, org: org({}) });
    expect(explorationPreflight(noIdentifier)).toBe("Credential ILHAM_ALL_ACCESS_ACCOUNT: Add a public field to use for login");
    const noPassword = resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }, {}) });
    const message = explorationPreflight(noPassword);
    expect(message).toBe("Credential ILHAM_ALL_ACCESS_ACCOUNT needs a secret password field; exploration does not support PIN or accessKey login");
    expect(message).not.toContain("qa.admin@example.test");
  });

  test("an email-only profile with a password is ready", () => {
    expect(explorationPreflight(resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }) }))).toBeNull();
  });

  test("e2e's step error code is kept in the record", () => {
    const record = toExplorationRecord({
      goal: "g",
      ended: "finished",
      steps: [{ index: 1, title: "Sign in", instruction: "Sign in", status: "blocked", errorCode: "AUTH_CREDENTIAL_UNAVAILABLE", startedAt: "x", durationMs: 1 }],
      findings: []
    });
    expect(record?.steps[0]).toMatchObject({ status: "blocked", errorCode: "AUTH_CREDENTIAL_UNAVAILABLE" });
  });
});

describe("configured login roles and field secrecy", () => {
  test("explicit nickname drives Login and engine while original username and email remain accessible", async () => {
    const input = org({ username: "original", nickname: "qa-nick", email: "qa@example.test" });
    input.credentials[0]!.loginField = "nickname";
    const config = resolveRunConfig({ env: {}, org: input });
    const plan = buildRunPlan({ transcript: "# Nickname\n[Login: ILHAM_ALL_ACCESS_ACCOUNT]", config, macros: loadMacros([]) });
    expect(plan.blockedReason).toBeNull();
    expect(plan.steps.map((step) => step.instruction)).toContain("enter qa-nick into the login identifier field of the login form");
    const env = buildChildEnv({ config, plan, host: {}, extra: {} });
    expect(env.JL_LOGIN_ILHAM_ALL_ACCESS_ACCOUNT_IDENTIFIER).toBe("qa-nick");
    expect(env.JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_USERNAME).toBe("original");
    expect(env.JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_EMAIL).toBe("qa@example.test");
    const { compileStep } = await import("../src/generate/project");
    const compiled = compileStep(plan.steps.find((step) => step.text.includes("{cred:ILHAM_ALL_ACCESS_ACCOUNT}"))!, plan, config, new Set());
    expect(Object.values(compiled.bindings)).toContainEqual({ kind: "cred", profile: "ILHAM_ALL_ACCESS_ACCOUNT", field: "nickname" });
  });

  test("ambiguous, missing and secret login selections stop before browser; PIN is not a password", () => {
    const input = org({ nickname: "nick-value", email: "email-value" });
    expect(explorationPreflight(resolveRunConfig({ env: {}, org: input }))).toContain("email, nickname");
    input.credentials[0]!.loginField = "missing";
    expect(explorationPreflight(resolveRunConfig({ env: {}, org: input }))).toContain("existing public field");
    input.credentials[0]!.loginField = "password";
    expect(explorationPreflight(resolveRunConfig({ env: {}, org: input }))).toContain("existing public field");
    const pin = resolveRunConfig({ env: {}, org: org({ nickname: "nick" }, { pin: "fixture-pin" }) });
    expect(explorationPreflight(pin)).toContain("does not support PIN");
  });

  test("org metadata classifies arbitrary fields, even with env overrides; compiler and context agree", async () => {
    const { compileStep } = await import("../src/generate/project");
    const { credentialLoginContext, collectSecretValues } = await import("../src/config/resolve");
    const input = org({ nickname: "nick" }, { email: "fixture-private-email", password: PASSWORD, pin: "fixture-pin" });
    const config = resolveRunConfig({ env: { JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_EMAIL: "fixture-env-email", JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_NICKNAME: "env-nick" }, org: input });
    expect(config.credentials.get("ILHAM_ALL_ACCESS_ACCOUNT")?.get("nickname")?.secret).toBe(false);
    expect(config.credentials.get("ILHAM_ALL_ACCESS_ACCOUNT")?.get("email")?.secret).toBe(true);
    const plan = buildRunPlan({ transcript: "# Public and secret\n[Act] enter {cred:ILHAM_ALL_ACCESS_ACCOUNT.nickname}\n[Act] enter {cred:ILHAM_ALL_ACCESS_ACCOUNT.email}\n[Act] enter {cred:ILHAM_ALL_ACCESS_ACCOUNT.pin}", config, macros: [] });
    const bindings = plan.steps.flatMap((step) => Object.values(compileStep(step, plan, config, new Set()).bindings));
    expect(bindings).toContainEqual({ kind: "cred", profile: "ILHAM_ALL_ACCESS_ACCOUNT", field: "nickname" });
    expect(bindings).toContainEqual({ kind: "secret", name: "ILHAM_ALL_ACCESS_ACCOUNT.email" });
    expect(bindings).toContainEqual({ kind: "secret", name: "ILHAM_ALL_ACCESS_ACCOUNT.pin" });
    expect(credentialLoginContext(config)).toContain("env-nick");
    for (const value of collectSecretValues(config)) expect(credentialLoginContext(config)).not.toContain(value);
  });

  test("a configured public nickname works even when the original username is empty or secret", () => {
    for (const input of [org({ username: "", nickname: "nick" }), org({ nickname: "nick" }, { username: "private-name", password: PASSWORD })]) {
      input.credentials[0]!.loginField = "nickname";
      expect(explorationPreflight(resolveRunConfig({ env: {}, org: input }))).toBeNull();
    }
  });

  test("env metadata does not collide with public fields named login_field", () => {
    const config = resolveRunConfig({ env: { JL_CREDENTIAL_LOCAL_PUBLIC_FIELDS: "login_field", JL_CRED_LOCAL_LOGIN_FIELD: "nick", JL_CRED_LOCAL_PASSWORD: PASSWORD } });
    expect(config.loginFields.get("LOCAL")).toBe("login_field");
    expect(explorationPreflight(config)).toBeNull();
  });

  test("env-file metadata supports arbitrary names including underscores", () => {
    const config = resolveRunConfig({ env: {
      JL_CREDENTIAL_LOCAL_PUBLIC_FIELDS: "nickname,employee_code",
      JL_CREDENTIAL_LOCAL_SECRET_FIELDS: "password",
      JL_CREDENTIAL_LOCAL_LOGIN_FIELD: "employee_code",
      JL_CRED_LOCAL_EMPLOYEE_CODE: "E123",
      JL_CRED_LOCAL_NICKNAME: "nick",
      JL_CRED_LOCAL_PASSWORD: PASSWORD
    } });
    expect(config.loginFields.get("LOCAL")).toBe("employee_code");
    expect(config.credentials.get("LOCAL")?.get("employee_code")?.secret).toBe(false);
    expect(explorationPreflight(config)).toBeNull();
  });
});
