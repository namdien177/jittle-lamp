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

  test("username wins; otherwise email, then login, then user", () => {
    const pick = (fields: Record<string, string>) =>
      resolveRunConfig({ env: {}, org: org(fields) }).credentials.get("ILHAM_ALL_ACCESS_ACCOUNT")?.get("username")?.value;
    expect(pick({ username: "qa-admin", email: "qa.admin@example.test" })).toBe("qa-admin");
    expect(pick({ login: "qa-login", email: "qa.admin@example.test" })).toBe("qa.admin@example.test");
    expect(pick({ login: "qa-login" })).toBe("qa-login");
    expect(pick({ user: "qa-user" })).toBe("qa-user");
    expect(pick({ email: "" })).toBeUndefined();
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
    expect(source).toContain('"ILHAM_ALL_ACCESS_ACCOUNT": { username: process.env["JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_USERNAME"] ?? "", password: () => process.env["JL_CRED_ILHAM_ALL_ACCESS_ACCOUNT_PASSWORD"] ?? "" }');
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
    expect(typed).toContain("enter qa.admin@example.test into the email or username field of the login form");
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
    const noIdentifier = resolveRunConfig({ env: {}, org: org({ tenant: "ilham" }) });
    expect(explorationPreflight(noIdentifier)).toBe("Credential ILHAM_ALL_ACCESS_ACCOUNT has no username, email or login field");
    const noPassword = resolveRunConfig({ env: {}, org: org({ email: "qa.admin@example.test" }, {}) });
    const message = explorationPreflight(noPassword);
    expect(message).toBe("Credential ILHAM_ALL_ACCESS_ACCOUNT has no password");
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
