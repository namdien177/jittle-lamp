import { describe, expect, test } from "bun:test";

import {
  createTestRunRequestSchema,
  testRunConfigSchema,
  testRunProgressRequestSchema,
  upsertTestCredentialRequestSchema,
  upsertTestEnvironmentRequestSchema
} from "@jittle-lamp/shared";

describe("test-case API contract", () => {
  test("run requests default to a manual read-write run without force", () => {
    expect(createTestRunRequestSchema.parse({})).toEqual({ params: {}, cacheMode: "read-write", force: false, trigger: "manual", dataset: false });
  });

  test("credential writes accept secrets but environment names and profiles are constrained", () => {
    expect(upsertTestCredentialRequestSchema.safeParse({ profile: "PCF_HQ_ADMIN", fields: { username: "a" }, secretFields: { password: "x" } }).success).toBe(true);
    expect(upsertTestCredentialRequestSchema.safeParse({ profile: "pcf admin" }).success).toBe(false);
    expect(upsertTestEnvironmentRequestSchema.safeParse({ name: "PCF UAT", baseUrl: "https://x.test" }).success).toBe(false);
  });

  test("run config matches the runner's OrgRunConfig shape", () => {
    const config = testRunConfigSchema.parse({
      environment: { name: "pcf-uat", baseUrl: "https://x.test", variables: {}, agentInstructions: null },
      credentials: [{ profile: "PCF_HQ_ADMIN", fields: { username: "a" }, secretFields: { password: "b" } }],
      model: null
    });
    expect(config.prices).toEqual([]);
  });

  test("progress screenshots are bounded", () => {
    expect(
      testRunProgressRequestSchema.safeParse({ screenshot: { stepId: "s", mimeType: "image/jpeg", base64: "a".repeat(500_000) } }).success
    ).toBe(false);
  });
});
