import { describe, expect, test } from "bun:test";

import { parseTranscriptDocument, testRunDetailSchema, type TestRunDetail, type TestRunStep } from "@jittle-lamp/shared";

import {
  canCancelRun,
  cacheHitRatio,
  explainBlockedReason,
  failedAsserts,
  formatModelId,
  formatQueuePill,
  isRunActive,
  liveScreenshot,
  runPollInterval,
  runProgress,
  toRunStepListSteps
} from "../apps/evidence-web/src/test-cases/run-model";

function runStep(overrides: Partial<TestRunStep> & Pick<TestRunStep, "stepId" | "ordinal">): TestRunStep {
  return {
    parentStepId: null,
    type: "act",
    label: `step ${overrides.ordinal}`,
    checkpointId: null,
    status: "passed",
    mode: "replayed",
    cacheReason: "hit",
    startedAt: null,
    finishedAt: null,
    durationMs: 1200,
    videoOffsetMs: 1000 * overrides.ordinal,
    observed: null,
    error: null,
    screenshotUrl: null,
    usage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
    ...overrides
  };
}

function runDetail(overrides: Partial<TestRunDetail> = {}): TestRunDetail {
  return testRunDetailSchema.parse({
    id: "run_1",
    testCaseId: "tc_1",
    testCaseKey: "TC-0001",
    testCaseTitle: "Logout clears email",
    transcriptVersion: 3,
    environmentId: "env_1",
    environmentName: "pcf-uat",
    status: "running",
    outcome: null,
    blockedReason: null,
    flaky: false,
    trigger: "manual",
    runnerPool: "cloud",
    createdBy: "user_1",
    createdByName: "QA",
    queuedAt: 1,
    startedAt: 2,
    finishedAt: null,
    evidenceId: null,
    batchId: null,
    queuePosition: null,
    estimatedStartAt: null,
    subscribers: [],
    metrics: {
      modelId: "anthropic/claude-opus-5-5",
      judgeModelId: "anthropic/claude-sonnet-5-5",
      provider: "anthropic",
      modelCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      priceTableVersion: null,
      durationMs: null,
      stepsTotal: 4,
      stepsReplayed: 3,
      stepsAgent: 1,
      stepsHandoff: 0
    },
    params: {},
    cacheMode: "read-write",
    runnerInfo: null,
    error: null,
    steps: [],
    transcript: "# Logout clears email",
    currentStepId: null,
    live: null,
    ...overrides
  });
}

describe("run detail model", () => {
  test("polls every 2 s while queued, claimed, running or paused, then stops", () => {
    for (const status of ["queued", "claimed", "running", "paused"] as const) {
      expect(isRunActive(status)).toBe(true);
      expect(runPollInterval({ status })).toBe(2_000);
    }
    for (const status of ["completed", "failed", "cancelled"] as const) expect(runPollInterval({ status })).toBe(false);
    expect(runPollInterval(undefined)).toBe(false);
  });

  test("queue pill shows position, depth when known, and the estimated start", () => {
    const now = 1_000_000;
    expect(formatQueuePill({ status: "queued", queuePosition: 1, queueDepth: 3, estimatedStartAt: now + 90_000 }, now)).toBe("queued · #2 of 3 · starts in ~2 min");
    expect(formatQueuePill({ status: "queued", queuePosition: 0, estimatedStartAt: now + 20_000 }, now)).toBe("queued · #1 · starts in ~20s");
    expect(formatQueuePill({ status: "queued", queuePosition: 0, queueDepth: 1, estimatedStartAt: now - 4_000 }, now)).toBe("queued · #1 of 1 · starts soon");
    expect(formatQueuePill({ status: "queued", queuePosition: null, estimatedStartAt: null }, now)).toBe("queued");
    expect(formatQueuePill({ status: "running", queuePosition: null, estimatedStartAt: null }, now)).toBeNull();
  });

  test("blocked reasons read as a human explanation", () => {
    expect(explainBlockedReason("MISSING_CREDENTIAL")).toContain("Credentials");
    expect(explainBlockedReason("APP_UNREACHABLE")).toContain("VPN");
    expect(explainBlockedReason(null)).toBeNull();
  });

  test("failed asserts pair the instruction with what the judge observed", () => {
    const steps = [
      runStep({ stepId: "s1", ordinal: 1 }),
      runStep({ stepId: "s2", ordinal: 2, type: "assert", label: "input text Email phải trống", status: "failed", mode: "agent", observed: "Email prefilled with hq.admin@example.test", screenshotUrl: "https://example.test/s2.png" }),
      runStep({ stepId: "s3", ordinal: 3, type: "act", status: "failed", error: { code: "ACTION_FAILED", message: "no target" } })
    ];
    expect(failedAsserts(steps)).toEqual([
      { stepId: "s2", expected: "input text Email phải trống", observed: "Email prefilled with hq.admin@example.test", screenshotUrl: "https://example.test/s2.png", error: null }
    ]);
  });

  test("live view shows the running step's screenshot, else the last finished one", () => {
    const steps = [
      runStep({ stepId: "s1", ordinal: 1, screenshotUrl: "https://example.test/1.png" }),
      runStep({ stepId: "s2", ordinal: 2, status: "running", screenshotUrl: null }),
      runStep({ stepId: "s3", ordinal: 3, status: "pending", screenshotUrl: null })
    ];
    expect(liveScreenshot(runDetail({ steps, currentStepId: "s2" }))).toEqual({ stepId: "s1", url: "https://example.test/1.png", label: "step 1" });
    expect(runProgress(steps)).toEqual({ done: 1, total: 3 });
    expect(liveScreenshot(runDetail({ steps: [], currentStepId: null }))).toBeNull();
  });

  test("step list rows come out in ordinal order with usage reduced to calls and cost", () => {
    const rows = toRunStepListSteps([runStep({ stepId: "b", ordinal: 2 }), runStep({ stepId: "a", ordinal: 1, mode: "agent", usage: { modelId: "m", modelCalls: 3, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, costUsd: 0.02 } })]);
    expect(rows.map((row) => row.stepId)).toEqual(["a", "b"]);
    expect(rows[0]?.usage).toEqual({ modelCalls: 3, costUsd: 0.02 });
    expect(rows[0]?.videoOffsetMs).toBe(1000);
  });

  test("only the requester (or cancel_any) may cancel, and only while active", () => {
    expect(canCancelRun({ status: "running", createdBy: "user_1" }, "user_1")).toBe(true);
    expect(canCancelRun({ status: "running", createdBy: "user_1" }, "user_2")).toBe(false);
    expect(canCancelRun({ status: "running", createdBy: "user_1" }, "user_2", true)).toBe(true);
    expect(canCancelRun({ status: "completed", createdBy: "user_1" }, "user_1")).toBe(false);
    expect(cacheHitRatio({ stepsTotal: 4, stepsReplayed: 3 })).toBe(0.75);
    expect(cacheHitRatio({ stepsTotal: 0, stepsReplayed: 0 })).toBeNull();
  });

  test("mock model ids show the fixture file name, real ids stay as they are", () => {
    expect(formatModelId("mock:/home/qa/fixtures/fixture-logout.mock.json")).toBe("mock:fixture-logout.mock.json");
    expect(formatModelId("anthropic/claude-opus-5-5")).toBe("anthropic/claude-opus-5-5");
    expect(formatModelId(null)).toBe("—");
  });
});

describe("live progress of expanded macro steps", () => {
  test("rows `<parent>.<n>` without parent, ordinal or label are re-attached under their parent", () => {
    const steps = [
      runStep({ stepId: "st_login", ordinal: 2, type: "login", label: "sign in as the fixture admin", status: "running" }),
      runStep({ stepId: "st_login.2", ordinal: 1, label: "", status: "running" }),
      runStep({ stepId: "st_open", ordinal: 1, type: "open", label: "/login" }),
      runStep({ stepId: "st_login.1", ordinal: 1, label: "", status: "passed" }),
      runStep({ stepId: "st_assert", ordinal: 3, type: "assert", label: "dashboard", status: "pending" })
    ];
    const rows = toRunStepListSteps(steps);
    expect(rows.map((row) => [row.stepId, row.parentStepId, row.ordinal])).toEqual([
      ["st_open", null, 1],
      ["st_login", null, 2],
      ["st_login.1", "st_login", 2],
      ["st_login.2", "st_login", 2],
      ["st_assert", null, 3]
    ]);
    expect(rows[2]?.label).toBe("sign in as the fixture admin · step 1");
    expect(runProgress(steps)).toEqual({ done: 1, total: 3 });
  });
});

describe("live progress rows created before finalisation", () => {
  test("rows with default ordinal, type and empty label take them from the run transcript", () => {
    const transcript = "# Case\n\n[Open] /login\n[Login: ADMIN] sign in as the fixture admin\n[Assert] the dashboard shows the welcome heading";
    const parsed = parseTranscriptDocument(transcript).cases[0]?.steps ?? [];
    const [open, login, assert] = parsed;
    if (!open || !login || !assert) throw new Error("fixture");
    const steps = [
      runStep({ stepId: login.stepId, ordinal: 1, type: "act", label: "", status: "running" }),
      runStep({ stepId: `${login.stepId}.1`, ordinal: 1, type: "act", label: "", status: "passed" }),
      runStep({ stepId: open.stepId, ordinal: 1, type: "act", label: "", status: "passed" }),
      runStep({ stepId: assert.stepId, ordinal: 3, type: "assert", label: "the dashboard shows the welcome heading", status: "pending" })
    ];
    const rows = toRunStepListSteps(steps, transcript);
    expect(rows.map((row) => [row.ordinal, row.type, row.label, row.parentStepId === null])).toEqual([
      [1, "open", "/login", true],
      [2, "login", "sign in as the fixture admin", true],
      [2, "act", "sign in as the fixture admin · step 1", false],
      [3, "assert", "the dashboard shows the welcome heading", true]
    ]);
    expect(runProgress(steps, transcript)).toEqual({ done: 1, total: 3 });
  });
});
