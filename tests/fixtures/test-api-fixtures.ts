// Contract-valid fixtures for the test-case HTTP API (packages/shared/src/test-api.ts). Every
// builder parses its output with the shared schema, so a contract change breaks these fixtures
// instead of silently drifting. Used by the MCP tool tests and the desktop test-run tests.

import {
  emptyModelUsage,
  notificationSchema,
  parseTestCaseTranscript,
  serializeStepLine,
  testCaseDetailSchema,
  testCaseSummarySchema,
  testCredentialSchema,
  testEnvironmentSchema,
  testMacroSchema,
  testRunDetailSchema,
  testRunSummarySchema,
  type Notification,
  type TestCaseDetail,
  type TestCaseSummary,
  type TestCredential,
  type TestEnvironment,
  type TestMacro,
  type TestRunDetail,
  type TestRunStatus,
  type TestRunStep,
  type TestRunSummary
} from "@jittle-lamp/shared";

export const fixtureNow = Date.UTC(2026, 9, 3, 9, 30);

export const fixtureTranscript = `# HQ admin logout returns a clean login form
Key: TC-0412
Tags: team:qa-pcf, feature:auth

[Open] /login
[Login: PCF_HQ_ADMIN]
[Assert] dashboard shows the main navigation
[Act] open the account menu and choose "Log out"

## Checkpoint: Logout returns to the login page
[Assert] the login form shows an empty Email field
[Screenshot] login form after logout
`;

const parsed = parseTestCaseTranscript(fixtureTranscript).testCase;

export function fixtureTestCaseSummary(overrides: Partial<TestCaseSummary> = {}): TestCaseSummary {
  return testCaseSummarySchema.parse({
    id: "case-0412",
    key: "TC-0412",
    title: parsed.title,
    status: "active",
    source: "manual",
    tags: ["team:qa-pcf", "feature:auth"],
    environmentId: "env-pcf-uat",
    transcriptVersion: 3,
    stepCount: parsed.steps.length,
    lintErrors: 0,
    lintWarnings: 1,
    duplicatedFromId: null,
    createdBy: "user-qa",
    createdAt: fixtureNow - 7 * 86_400_000,
    updatedAt: fixtureNow - 3_600_000,
    stats: {
      runs: 12,
      lastOutcome: "passed",
      lastRunAt: fixtureNow - 1_800_000,
      passRate: 0.9,
      flakyRate: 0.1,
      avgDurationMs: 41_000,
      avgCostUsd: 0.07,
      avgModelCalls: 6,
      avgTokens: 48_000,
      cachedSteps: 4,
      staleSteps: 1,
      derivedCases: 0
    },
    ...overrides
  });
}

export function fixtureTestCaseDetail(overrides: Partial<TestCaseDetail> = {}): TestCaseDetail {
  return testCaseDetailSchema.parse({
    ...fixtureTestCaseSummary(),
    description: "Regression for PCF-1234: the email field kept its autofill value after logout.",
    links: [{ url: "https://jira.example.test/browse/PCF-1234", label: "PCF-1234" }],
    transcript: fixtureTranscript,
    steps: parsed.steps,
    params: [],
    dataset: null,
    lint: [
      {
        ruleId: "assert-specific",
        severity: "warning",
        message: "Name the element the assert checks.",
        stepId: parsed.steps[2]?.stepId ?? null,
        line: 7,
        fix: null
      }
    ],
    externalId: null,
    sourceRef: null,
    fingerprint: "fp-0412",
    retries: 0,
    requiredConfig: { variables: ["PARENT_PORTAL_URL"], credentials: ["PCF_HQ_ADMIN"], unresolved: [] },
    ...overrides
  });
}

const stepLabels = parsed.steps.map((step) => step.text || serializeStepLine(step).replace(/^\[|\]$/g, ""));

export function fixtureRunSteps(statuses: ReadonlyArray<TestRunStep["status"]>): TestRunStep[] {
  return parsed.steps.map((step, index) => {
    const status = statuses[index] ?? "pending";
    const finished = status !== "pending" && status !== "running";
    return {
      stepId: step.stepId,
      parentStepId: null,
      ordinal: step.ordinal,
      type: step.type,
      label: stepLabels[index] ?? step.type,
      checkpointId: step.checkpointId,
      status,
      mode: !finished ? null : step.type === "act" || step.type === "login" ? (index === 1 ? "agent" : "replayed") : "deterministic",
      cacheReason: null,
      startedAt: status === "pending" ? null : fixtureNow + index * 4_000,
      finishedAt: finished ? fixtureNow + index * 4_000 + 3_200 : null,
      durationMs: finished ? 3_200 + index * 150 : null,
      videoOffsetMs: status === "pending" ? null : index * 4_000,
      observed: status === "failed" ? "The Email field still shows qa.hq@example.test." : null,
      error: status === "failed" ? { code: "ASSERTION_FAILED", message: "Email field is not empty" } : null,
      screenshotUrl: null,
      usage: { ...emptyModelUsage("anthropic/claude-sonnet-5-5"), modelCalls: index === 1 ? 3 : 0, costUsd: index === 1 ? 0.031 : 0 }
    };
  });
}

const terminal = new Set<TestRunStatus>(["completed", "failed", "cancelled"]);

export function fixtureRunSummary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  const status = overrides.status ?? "completed";
  return testRunSummarySchema.parse({
    id: "run-7f3c2a10-0000-4000-8000-000000000001",
    testCaseId: "case-0412",
    testCaseKey: "TC-0412",
    testCaseTitle: parsed.title,
    transcriptVersion: 3,
    environmentId: "env-pcf-uat",
    environmentName: "pcf-uat",
    status,
    outcome: terminal.has(status) ? "passed" : null,
    blockedReason: null,
    flaky: false,
    trigger: "manual",
    runnerPool: "self-hosted:devbox",
    createdBy: "user-qa",
    createdByName: "Quinn QA",
    queuedAt: fixtureNow - 60_000,
    startedAt: status === "queued" ? null : fixtureNow,
    finishedAt: terminal.has(status) ? fixtureNow + 39_000 : null,
    evidenceId: terminal.has(status) ? "evidence-run-1" : null,
    batchId: null,
    queuePosition: status === "queued" ? 2 : null,
    estimatedStartAt: status === "queued" ? fixtureNow + 90_000 : null,
    subscribers: [{ userId: "user-qa", name: "Quinn QA" }],
    metrics: {
      modelId: "anthropic/claude-opus-5-5",
      judgeModelId: "anthropic/claude-sonnet-5-5",
      provider: "anthropic",
      modelCalls: 6,
      inputTokens: 41_200,
      cachedInputTokens: 30_100,
      outputTokens: 1_900,
      reasoningTokens: 400,
      costUsd: 0.064,
      priceTableVersion: "2026-10-01",
      durationMs: terminal.has(status) ? 39_000 : null,
      stepsTotal: parsed.steps.length,
      stepsReplayed: 1,
      stepsAgent: 1,
      stepsHandoff: 0
    },
    ...overrides
  });
}

export function fixtureRunDetail(overrides: Partial<TestRunDetail> = {}): TestRunDetail {
  const status = overrides.status ?? "completed";
  const steps =
    status === "queued"
      ? fixtureRunSteps([])
      : terminal.has(status)
        ? fixtureRunSteps(parsed.steps.map(() => "passed" as const))
        : fixtureRunSteps(["passed", "passed", "passed", "running"]);
  return testRunDetailSchema.parse({
    ...fixtureRunSummary({ status }),
    params: {},
    cacheMode: "read-write",
    runnerInfo: null,
    error: null,
    steps,
    transcript: fixtureTranscript,
    currentStepId: status === "running" ? (steps[3]?.stepId ?? null) : null,
    live: null,
    ...overrides
  });
}

export function fixtureEnvironment(overrides: Partial<TestEnvironment> = {}): TestEnvironment {
  return testEnvironmentSchema.parse({
    id: "env-pcf-uat",
    name: "pcf-uat",
    baseUrl: "https://pcf.uat.example.test",
    variables: { PARENT_PORTAL_URL: "https://parent.pcf.uat.example.test" },
    runnerPool: "self-hosted:devbox",
    agentInstructions: "Use only the test tenant. Never delete records.",
    notes: null,
    usedByCases: 12,
    createdAt: fixtureNow - 30 * 86_400_000,
    updatedAt: fixtureNow - 86_400_000,
    ...overrides
  });
}

// The password value below is a fixture sentinel: tests assert it never leaves a tool.
export const fixtureCredentialPassword = "fixture-password-must-not-leak";

export function fixtureCredential(overrides: Partial<TestCredential> = {}): TestCredential {
  return testCredentialSchema.parse({
    id: "cred-pcf-hq",
    profile: "PCF_HQ_ADMIN",
    kind: "login",
    environmentId: "env-pcf-uat",
    fields: { username: "qa.hq@example.test" },
    secretFieldNames: ["password"],
    keyVersion: 1,
    lastUsedAt: fixtureNow - 3_600_000,
    loginMacroId: "macro-login",
    createdAt: fixtureNow - 30 * 86_400_000,
    updatedAt: fixtureNow - 86_400_000,
    ...overrides
  });
}

export function fixtureMacro(overrides: Partial<TestMacro> = {}): TestMacro {
  return testMacroSchema.parse({
    id: "macro-login",
    name: "Login",
    params: [{ name: "profile", required: true, default: null, kind: "credential" }],
    transcript: "[Open] /login\n[Act] fill email with @{profile}.username and password with @{profile}.password, then submit",
    version: 2,
    status: "active",
    createdBy: "user-qa",
    createdAt: fixtureNow - 30 * 86_400_000,
    updatedAt: fixtureNow - 86_400_000,
    ...overrides
  });
}

export function fixtureNotification(overrides: Partial<Notification> = {}): Notification {
  return notificationSchema.parse({
    id: "notif-1",
    kind: "run.finished",
    subjectType: "test_run",
    subjectId: "run-7f3c2a10-0000-4000-8000-000000000001",
    title: "TC-0412 passed on pcf-uat",
    body: "HQ admin logout returns a clean login form · 39 s · $0.06",
    url: "/test-runs/run-7f3c2a10-0000-4000-8000-000000000001",
    createdAt: fixtureNow - 300_000,
    readAt: null,
    ...overrides
  });
}
