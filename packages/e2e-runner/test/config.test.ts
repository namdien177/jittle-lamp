import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnvFiles } from "../src/config/env-files";
import {
  collectSecretValues,
  describeResolvedConfig,
  formatConfigTable,
  parseCredentialEnvName,
  resolveCredentialProfile,
  resolveRunConfig
} from "../src/config/resolve";

const FIXTURE_PASSWORD = "fixture-Pa55word!";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "jl-e2e-config-"));
}

describe("config resolution chain (design.md §9.2)", () => {
  test("params beat the environment, the environment beats env files, files beat org config", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "JL_VAR_SCHOOL=from-dotenv\nJL_VAR_ONLY_DOTENV=dotenv\nDATABASE_URL=libsql://prod\n");
    writeFileSync(join(dir, ".env.e2e"), "JL_VAR_SCHOOL=from-env-e2e\nJL_ENV_BASE_URL=https://e2e.example\n");
    writeFileSync(join(dir, "pcf.env"), `JL_VAR_SCHOOL=from-env-file\nJL_CRED_PCF_HQ_ADMIN_USERNAME=admin@example.test\nJL_CRED_PCF_HQ_ADMIN_PASSWORD=${FIXTURE_PASSWORD}\n`);
    const files = loadEnvFiles(dir, ["pcf.env"]);

    const config = resolveRunConfig({
      params: { role: "HQ_ADMIN" },
      env: { JL_VAR_REAL: "real-env", JL_VAR_SCHOOL: "" },
      envFiles: files,
      org: {
        environment: { name: "pcf-uat", baseUrl: "https://org.example", variables: { SCHOOL: "from-org", ORG_ONLY: "org" } },
        credentials: [{ profile: "PCF_HQ_ADMIN", fields: { username: "org@example.test" }, secretFields: { password: "org-secret" } }]
      }
    });

    expect(config.vars.get("role")).toMatchObject({ value: "HQ_ADMIN", source: "param" });
    expect(config.vars.get("REAL")).toMatchObject({ value: "real-env", source: "env" });
    expect(config.vars.get("SCHOOL")?.value).toBe("from-env-file");
    expect(config.vars.get("ONLY_DOTENV")?.value).toBe("dotenv");
    expect(config.vars.get("ORG_ONLY")).toMatchObject({ value: "org", source: "org:pcf-uat" });
    expect(config.baseUrl?.value).toBe("https://e2e.example");
    expect(config.credentials.get("PCF_HQ_ADMIN")?.get("password")).toMatchObject({ value: FIXTURE_PASSWORD, secret: true });
    expect(config.credentials.get("PCF_HQ_ADMIN")?.get("username")).toMatchObject({ value: "admin@example.test", secret: false });
    expect(config.actModel?.value).toBe("anthropic/claude-opus-5-5");
  });

  test("env files only contribute runner names", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "DATABASE_URL=libsql://prod\nS3_SECRET=x\nJL_VAR_OK=1\n");
    const [file] = loadEnvFiles(dir, []);
    expect(file?.values).toEqual({ JL_VAR_OK: "1" });
  });

  test("a missing --env-file is an error", () => {
    expect(() => loadEnvFiles(tempDir(), ["nope.env"])).toThrow("Env file not found");
  });

  test("credential names split into profile and field", () => {
    expect(parseCredentialEnvName("JL_CRED_PCF_HQ_ADMIN_PASSWORD")).toEqual({ profile: "PCF_HQ_ADMIN", field: "password" });
    expect(parseCredentialEnvName("JL_VAR_X")).toBeNull();
  });

  test("a short profile name resolves to a unique prefixed profile", () => {
    const config = resolveRunConfig({
      env: { JL_CRED_PCF_HQ_ADMIN_USERNAME: "a", JL_CRED_ILHAM_A_USERNAME: "b", JL_CRED_ILHAM_B_USERNAME: "c" }
    });
    expect(resolveCredentialProfile(config, "PCF")).toEqual({ profile: "PCF_HQ_ADMIN", aliased: true });
    expect(resolveCredentialProfile(config, "PCF_HQ_ADMIN")).toEqual({ profile: "PCF_HQ_ADMIN", aliased: false });
    expect(resolveCredentialProfile(config, "ILHAM")).toBeNull();
  });

  test("jl-e2e config masks secrets and lists sources", () => {
    const config = resolveRunConfig({
      env: {
        JL_ENV_BASE_URL: "https://uat.example",
        JL_CRED_PCF_HQ_ADMIN_PASSWORD: FIXTURE_PASSWORD,
        JL_VAR_OTP_CODE: "123456",
        ANTHROPIC_API_KEY: "sk-ant-fixture-key",
        JL_API_TOKEN: "jl_api_fixture"
      }
    });
    const table = formatConfigTable(describeResolvedConfig(config));
    expect(table).toContain("credential('PCF_HQ_ADMIN').password");
    expect(table).toContain("https://uat.example");
    for (const secret of [FIXTURE_PASSWORD, "123456", "sk-ant-fixture-key", "jl_api_fixture"]) {
      expect(table).not.toContain(secret);
    }
    expect(collectSecretValues(config)).toEqual(expect.arrayContaining([FIXTURE_PASSWORD, "123456", "sk-ant-fixture-key"]));
  });

  test("provider keys and the OpenAI-compatible base URL pass through .env.e2e; keys are secret, the URL is not", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, ".env.e2e"),
      [
        "JL_MODEL=openai-compatible/llama-3.3-70b",
        "JL_JUDGE_MODEL=xai/grok-4",
        "OPENAI_COMPATIBLE_BASE_URL=https://llm.internal.example/v1",
        "OPENAI_COMPATIBLE_API_KEY=sk-compatible-fixture",
        "XAI_API_KEY=xai-fixture-key",
        "GOOGLE_GENERATIVE_AI_API_KEY=google-fixture-key",
        "AWS_SECRET_ACCESS_KEY=not-a-runner-name"
      ].join("\n")
    );
    const files = loadEnvFiles(dir, []);
    expect(Object.keys(files[0]?.values ?? {}).sort()).toEqual([
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "JL_JUDGE_MODEL",
      "JL_MODEL",
      "OPENAI_COMPATIBLE_API_KEY",
      "OPENAI_COMPATIBLE_BASE_URL",
      "XAI_API_KEY"
    ]);
    const config = resolveRunConfig({ env: {}, envFiles: files });
    expect(config.actModel?.value).toBe("openai-compatible/llama-3.3-70b");
    expect(config.judgeModel?.value).toBe("xai/grok-4");
    expect(config.providerKeys.get("OPENAI_COMPATIBLE_BASE_URL")).toMatchObject({ value: "https://llm.internal.example/v1", secret: false });
    expect(config.providerKeys.get("XAI_API_KEY")?.secret).toBe(true);
    expect(config.providerKeys.get("GOOGLE_GENERATIVE_AI_API_KEY")?.secret).toBe(true);
    const secrets = collectSecretValues(config);
    expect(secrets).toEqual(expect.arrayContaining(["sk-compatible-fixture", "xai-fixture-key", "google-fixture-key"]));
    expect(secrets).not.toContain("https://llm.internal.example/v1");
    const table = formatConfigTable(describeResolvedConfig(config));
    expect(table).toContain("https://llm.internal.example/v1");
    for (const secret of ["sk-compatible-fixture", "xai-fixture-key", "google-fixture-key"]) expect(table).not.toContain(secret);
  });

  test("the organisation's base URL and keys reach the run as provider environment", () => {
    const config = resolveRunConfig({
      env: {},
      org: {
        environment: { name: "uat", baseUrl: "https://uat.example", variables: {} },
        credentials: [],
        model: {
          act: "openai-compatible/llama-3.3-70b",
          judge: "openrouter/openai/gpt-5",
          apiKeys: { OPENAI_COMPATIBLE_BASE_URL: "https://llm.internal.example/v1", OPENROUTER_API_KEY: "sk-or-fixture-key" }
        }
      }
    });
    expect(config.providerKeys.get("OPENAI_COMPATIBLE_BASE_URL")).toMatchObject({ source: "org:uat", secret: false });
    expect(config.providerKeys.get("OPENROUTER_API_KEY")).toMatchObject({ value: "sk-or-fixture-key", secret: true });
    expect(config.judgeModel?.value).toBe("openrouter/openai/gpt-5");
  });

  test("rejects an unknown cache mode", () => {
    expect(() => resolveRunConfig({ env: { JL_CACHE_MODE: "sometimes" } })).toThrow("JL_CACHE_MODE");
  });
});

describe("review regressions: secrecy and redaction", () => {
  test("secret names are matched by whole segments", async () => {
    const { isSecretVariable } = await import("../src/config/resolve");
    expect(["OTP_CODE", "API_KEY", "ADMIN_PASSWORD", "pin", "accessToken"].map(isSecretVariable)).toEqual([true, true, true, true, true]);
    expect(["SCHOOL_CODE", "SHIPPING", "MAPPING", "PARENT_URL", "role"].map(isSecretVariable)).toEqual([false, false, false, false, false]);
    resolveRunConfig({ env: { JL_SECRET_NAMES: "SCHOOL_CODE" } });
    expect(isSecretVariable("SCHOOL_CODE")).toBe(true);
    resolveRunConfig({ env: {} });
    expect(isSecretVariable("SCHOOL_CODE")).toBe(false);
  });

  test("redaction touches string leaves only and ignores values shorter than e2e's minimum", async () => {
    const { createRedactor, redactJson } = await import("../src/redact");
    const redact = createRedactor(["100", FIXTURE_PASSWORD]);
    const report = { durationMs: 100, at: "2026-10-03T08:00:00.100Z", note: `pw=${encodeURIComponent(FIXTURE_PASSWORD)} b64=${Buffer.from(FIXTURE_PASSWORD).toString("base64")}` };
    const out = redactJson(report, redact);
    expect(out.durationMs).toBe(100);
    expect(out.at).toBe(report.at);
    expect(out.note).toBe("pw=[redacted] b64=[redacted]");
  });
});
