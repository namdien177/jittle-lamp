import { describe, expect, test } from "bun:test";

import {
  assertCheckSchema,
  cacheCheckReadResponseSchema,
  cacheCheckWriteRequestSchema,
  claimRunRequestSchema,
  claimRunResponseSchema,
  claimedRunSchema,
  createTestRunRequestSchema,
  defaultApiPolicy,
  testCaseDetailSchema,
  testEnvironmentSchema,
  testRunConfigSchema,
  testRunDetailSchema,
  testRunProgressRequestSchema,
  testRunStepSchema,
  testRunTriggerSchema,
  upsertTestCredentialRequestSchema,
  upsertTestEnvironmentRequestSchema
} from "@jittle-lamp/shared";

describe("test-case API contract", () => {
  test("run requests default to a manual run without force; the cache mode is resolved per request", () => {
    // No cacheMode in the parsed request: the backend picks read-write, or strict for a suite
    // batch (roadmap 2026-10-13 §4.3).
    expect(createTestRunRequestSchema.parse({})).toEqual({
      params: {},
      force: false,
      trigger: "manual",
      dataset: false,
      executionMode: "full"
    });
    expect(createTestRunRequestSchema.parse({ cacheMode: "strict" }).cacheMode).toBe("strict");
  });

  test("assert checks, batch claims and repair runs (roadmap 2026-10-13 §4)", () => {
    const check = { schemaVersion: "jl-assert-check-1" as const, locator: { role: "heading", name: "Welcome" }, matcher: "visible" as const, expected: null, recordedAt: "2026-10-13T00:00:00.000Z" };
    expect(cacheCheckReadResponseSchema.parse({ status: "hit", check })).toEqual({ status: "hit", check });
    expect(cacheCheckWriteRequestSchema.parse({ check, instructionKey: "k", renderedCode: "expect(...)" })).toMatchObject({ check });
    expect(cacheCheckWriteRequestSchema.parse({ stale: true, reason: "not visible" })).toEqual({ stale: true, reason: "not visible" });
    // A url check needs no control; a visible check does.
    expect(assertCheckSchema.safeParse({ ...check, locator: null, matcher: "url", expected: "/dashboard" }).success).toBe(true);
    expect(assertCheckSchema.safeParse({ ...check, locator: { name: "x" } }).success).toBe(false);
    expect(claimRunRequestSchema.parse({})).toEqual({ batchCapacity: 1 });
    expect(claimRunRequestSchema.safeParse({ batchCapacity: 0 }).success).toBe(false);
    expect(claimRunResponseSchema.parse({ run: null })).toEqual({ run: null, exploration: null });
    expect(testRunTriggerSchema.parse("repair")).toBe("repair");
    expect(testRunDetailSchema.pick({ repairRunId: true }).parse({})).toEqual({});
    expect(testRunDetailSchema.pick({ repairRunId: true }).parse({ repairRunId: "run_2" }).repairRunId).toBe("run_2");
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

describe("API replay and Postgres contract (roadmap 2026-10-13)", () => {
  test("run requests take an execution mode", () => {
    expect(createTestRunRequestSchema.parse({ executionMode: "hybrid" }).executionMode).toBe("hybrid");
    expect(createTestRunRequestSchema.safeParse({ executionMode: "fast" }).success).toBe(false);
  });

  test("environments take API origins, an OpenAPI URL and a policy; origins carry no path", () => {
    const base = { name: "pcf-uat", baseUrl: "https://uat.example.test" };
    const ok = upsertTestEnvironmentRequestSchema.parse({
      ...base,
      apiOrigins: ["https://api.example.test", "http://localhost:3010"],
      openapiUrl: "https://api.example.test/openapi.json",
      apiPolicy: { allowedPaths: ["/api/**"], maxRequestsPerStep: 20 }
    });
    expect(ok.apiOrigins).toEqual(["https://api.example.test", "http://localhost:3010"]);
    expect(ok.apiPolicy).toEqual({ allowedPaths: ["/api/**"], maxRequestsPerStep: 20, rateLimitPerSecond: 10 });
    // Omitted means "keep what is stored" on PATCH, not "clear".
    expect(upsertTestEnvironmentRequestSchema.parse(base)).not.toHaveProperty("apiOrigins");
    for (const origin of ["https://api.example.test/v1", "https://api.example.test/?x=1", "ftp://api.example.test", "api.example.test"]) {
      expect(upsertTestEnvironmentRequestSchema.safeParse({ ...base, apiOrigins: [origin] }).success).toBe(false);
    }
    expect(upsertTestEnvironmentRequestSchema.safeParse({ ...base, openapiUrl: "file:///etc/passwd" }).success).toBe(false);
    // Rows saved before the roadmap read as unconfigured.
    const row = testEnvironmentSchema.parse({
      id: "env",
      name: "pcf-uat",
      baseUrl: "https://uat.example.test",
      variables: {},
      runnerPool: "cloud",
      agentInstructions: null,
      notes: null,
      usedByCases: 0,
      createdAt: 1,
      updatedAt: 1
    });
    expect(row).toMatchObject({ apiOrigins: [], openapiUrl: null, apiPolicy: defaultApiPolicy });
  });

  test("postgres credential profiles need host, database, user and a password secret", () => {
    const valid = {
      profile: "PCF_UAT_DB",
      kind: "postgres",
      fields: { host: "db.example.test", port: "5432", database: "sv", user: "qa_reader", ssl: "require", schema_allowlist: "public" },
      secretFields: { password: "fake-db-password" }
    };
    expect(upsertTestCredentialRequestSchema.safeParse(valid).success).toBe(true);
    expect(upsertTestCredentialRequestSchema.safeParse({ ...valid, fields: { database: "sv", user: "qa" } }).success).toBe(false);
    expect(upsertTestCredentialRequestSchema.safeParse({ ...valid, fields: { ...valid.fields, port: "db" } }).success).toBe(false);
    expect(upsertTestCredentialRequestSchema.safeParse({ ...valid, fields: { ...valid.fields, ssl: "maybe" } }).success).toBe(false);
    expect(upsertTestCredentialRequestSchema.safeParse({ ...valid, fields: { ...valid.fields, username: "x" } }).success).toBe(false);
    expect(upsertTestCredentialRequestSchema.safeParse({ ...valid, secretFields: { password: "x", token: "y" } }).success).toBe(false);
    // Login profiles are not restricted to the postgres field set.
    expect(upsertTestCredentialRequestSchema.safeParse({ profile: "PCF", fields: { username: "x" }, secretFields: { otp_seed: "y" } }).success).toBe(true);
    // The run config tells the runner which profiles are databases; older entries mean login.
    const config = testRunConfigSchema.parse({
      environment: { name: "pcf-uat", baseUrl: "https://x.test", variables: {}, agentInstructions: null },
      credentials: [
        { profile: "PCF_HQ_ADMIN", fields: { username: "a" }, secretFields: { password: "b" } },
        { profile: "PCF_UAT_DB", kind: "postgres", fields: { host: "h", database: "d", user: "u" }, secretFields: { password: "p" } }
      ],
      model: null
    });
    expect(config.credentials.map((credential) => credential.kind)).toEqual([undefined, "postgres"]);
  });

  test("claimed runs and run details carry the execution mode and API configuration with defaults", () => {
    const claimed = claimedRunSchema.parse({
      runId: "run",
      testCaseId: "case",
      testCaseKey: "TC-0001",
      transcript: "# T",
      transcriptVersion: 1,
      steps: [],
      macros: [],
      environmentId: null,
      params: {},
      cacheMode: "read-write",
      leaseExpiresAt: 1,
      attempt: 1,
      runToken: "jl_run_x"
    });
    expect(claimed).toMatchObject({ executionMode: "full", apiOrigins: [], openapiUrl: null, apiPolicy: defaultApiPolicy, cases: [] });
    expect(testRunDetailSchema.pick({ executionMode: true }).parse({})).toEqual({});
    expect(testRunDetailSchema.pick({ executionMode: true }).parse({ executionMode: "api" }).executionMode).toBe("api");
    expect(testRunStepSchema.pick({ outputs: true, requests: true }).parse({ outputs: { applicationId: "APP-1" }, requests: { count: 2, mutations: 2 } })).toEqual({
      outputs: { applicationId: "APP-1" },
      requests: { count: 2, mutations: 2 }
    });
    expect(testCaseDetailSchema.pick({ outputs: true, reuse: true }).parse({})).toEqual({ outputs: [], reuse: { kind: "never" } });
    expect(testCaseDetailSchema.pick({ outputs: true, reuse: true }).parse({ outputs: ["a"], reuse: { kind: "within", ms: 60_000 } })).toEqual({
      outputs: ["a"],
      reuse: { kind: "within", ms: 60_000 }
    });
  });
});
