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
import {
  cacheDetailOf,
  queryStepView,
  queuedStripMeta,
  readDetailsOpen,
  runInfoRows,
  shownStepId,
  mediaHeightFor,
  stepOutcomeLine,
  stepRowMeta,
  stepStripMeta,
  writeDetailsOpen
} from "../apps/evidence-web/src/test-runs/run-view-model";

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
    expect(formatQueuePill({ status: "queued", queuePosition: 0, queueDepth: 2, estimatedStartAt: null, blockedReason: "BUDGET_EXCEEDED" }, now)).toBe("queued · waiting for the daily model budget");
    expect(formatQueuePill({ status: "queued", queuePosition: 0, estimatedStartAt: now + 20_000, blockedReason: "NO_RUNNER" }, now)).toBe("queued · #1 · starts in ~20s");
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

describe("run polling backs off on errors", () => {
  test("2 s while active, doubling per consecutive failure up to 30 s, back to 2 s after a success", () => {
    const active = { status: "running" as const };
    expect([0, 1, 2, 3, 4, 5, 9].map((failures) => runPollInterval(active, failures))).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
    expect(runPollInterval(undefined, 2)).toBe(8_000);
    expect(runPollInterval({ status: "completed" }, 3)).toBe(false);
    expect(runPollInterval(active, 0)).toBe(2_000);
  });
});

describe("run view strip", () => {
  const steps = [
    runStep({ stepId: "s1", ordinal: 1 }),
    runStep({ stepId: "s2", ordinal: 2, type: "login", status: "running", mode: "agent", durationMs: null }),
    runStep({ stepId: "s2.1", ordinal: 2, parentStepId: "s2", status: "running" }),
    runStep({ stepId: "s3", ordinal: 3, type: "assert", status: "failed", mode: "agent", durationMs: 21_000, observed: "A red banner says the contact is in use", error: { code: "ASSERTION_FAILED", message: "No reference number" } }),
    runStep({ stepId: "s4", ordinal: 4, status: "pending", durationMs: null })
  ];

  test("the shown step is the selection, else the playhead, else the running step's top-level parent, else the first failure", () => {
    expect(shownStepId({ steps, activeStepId: "s1", playingStepId: "s3", currentStepId: "s2" })).toBe("s1");
    expect(shownStepId({ steps, activeStepId: null, playingStepId: "s3", currentStepId: "s2" })).toBe("s3");
    expect(shownStepId({ steps, activeStepId: null, playingStepId: null, currentStepId: "s2.1" })).toBe("s2");
    expect(shownStepId({ steps, activeStepId: null, playingStepId: null, currentStepId: null })).toBe("s3");
    expect(shownStepId({ steps: [steps[0]!], activeStepId: null, playingStepId: null, currentStepId: null })).toBe("s1");
    // A child id never becomes the shown step.
    expect(shownStepId({ steps, activeStepId: "s2.1", playingStepId: null, currentStepId: null })).toBe("s3");
  });

  test("the meta line reads step, type, mode, duration and the error code of a failure", () => {
    expect(stepStripMeta(steps[0]!, 4)).toBe("Step 1 of 4 · Act · replayed · 1.2 s");
    expect(stepStripMeta(steps[3]!, 4)).toBe("Step 3 of 4 · Assert · agent · 21.0 s · ASSERTION_FAILED");
    expect(stepStripMeta(steps[4]!, 4)).toBe("Step 4 of 4 · Act · replayed");
    expect(stepOutcomeLine(steps[3]!)).toBe("A red banner says the contact is in use");
    expect(stepOutcomeLine(runStep({ stepId: "x", ordinal: 9, status: "failed", error: { code: "E", message: "boom" } }))).toBe("boom");
    expect(stepOutcomeLine(steps[0]!)).toBeNull();
    expect(queuedStripMeta({ status: "queued", queuePosition: 1, queueDepth: 3, estimatedStartAt: 1_000_000 + 20_000 }, 1_000_000)).toBe("Queued · #2 of 3 · starts in ~20s");
  });

  test("the step column's meta says how a step ran and what it produced; the media box takes the width at 16:9 under a cap", () => {
    expect(stepRowMeta(steps[0]!, 0)).toBe("replayed");
    expect(stepRowMeta(steps[1]!, 2)).toBe("2 steps · agent");
    expect(stepRowMeta(runStep({ stepId: "a", ordinal: 1, mode: "api-replayed", requests: { count: 2, mutations: 1, items: [] } }), 0)).toBe("API · 2 requests");
    expect(stepRowMeta(runStep({ stepId: "b", ordinal: 1, mode: "api-handoff", requests: { count: 1, mutations: 0, items: [] } }), 0)).toBe("API hand-off · 1 request");
    expect(stepRowMeta(runStep({ stepId: "c", ordinal: 1, type: "query", mode: "query", cacheDetail: "select 1\n-- 1 row · agent · DB · 4ms" } as Partial<TestRunStep> & Pick<TestRunStep, "stepId" | "ordinal">), 0)).toBe("query · 1 row");
    expect(stepRowMeta(runStep({ stepId: "d", ordinal: 1, type: "query", mode: "query" }), 0)).toBe("query");
    expect(stepRowMeta(runStep({ stepId: "e", ordinal: 1, mode: null, status: "skipped" }), 0)).toBe("skipped");
    expect(stepRowMeta(runStep({ stepId: "f", ordinal: 1, mode: null, status: "pending" }), 0)).toBe("");
    expect(mediaHeightFor({ width: 800, height: 1000 })).toBe(534);
    expect(mediaHeightFor({ width: 1600, height: 700 })).toBe(420);
    expect(mediaHeightFor({ width: 200, height: 200 })).toBe(180);
  });

  test("cache detail is read defensively until the schema carries it", () => {
    expect(cacheDetailOf(steps[0]!)).toBeNull();
    expect(cacheDetailOf({ ...steps[0]!, cacheDetail: "selector drifted" } as TestRunStep)).toBe("selector drifted");
    expect(cacheDetailOf({ ...steps[0]!, cacheDetail: { reason: "x" } } as TestRunStep)).toBe('{\n  "reason": "x"\n}');
  });

  test("the Details drawer is closed by default and remembered per device", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readDetailsOpen(storage)).toBe(false);
    writeDetailsOpen(storage, true);
    expect(readDetailsOpen(storage)).toBe(true);
    expect(readDetailsOpen(null)).toBe(false);
    expect(readDetailsOpen({ getItem: () => { throw new Error("private mode"); } })).toBe(false);
  });

  test("info rows merge the model row when act and judge share a model", () => {
    const format = { tokens: String, cost: (usd: number | null) => `$${usd}`, duration: (ms: number | null) => (ms === null ? "" : `${ms}ms`) };
    const rows = runInfoRows(runDetail({ metrics: { ...runDetail().metrics, modelId: "m", judgeModelId: "m", costUsd: 0.02, durationMs: 1500 } }), "QA", format);
    expect(rows.map(([label]) => label)).toEqual(["Version", "Trigger", "Environment", "Runner", "Model", "Tokens", "Cost", "Duration", "Steps"]);
    expect(rows.find(([label]) => label === "Cost")?.[1]).toBe("$0.02");
    expect(rows.find(([label]) => label === "Duration")?.[1]).toBe("1500ms");
    expect(runInfoRows(runDetail(), "QA", format).map(([label]) => label)).toContain("Judge model");
  });
});

// Roadmap 2026-10-13 §2.4, §2.6: API steps show their requests instead of a video segment, and
// the Info tab names the runs whose outputs stood in for [Use] blocks.
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { apiRequestItemsOf, formatRequestStatus, isApiStep } from "../apps/evidence-web/src/test-cases/api-mode-model";
import { reuseRows } from "../apps/evidence-web/src/test-runs/run-view-model";
import { ApiRequestPanel } from "../apps/evidence-web/src/test-runs/run-view";

describe("API steps and reuse on the run page", () => {
  const items = [
    { seq: 2, method: "GET", path: "/api/records/abc", status: 200, durationMs: 12, mutation: false, error: null },
    { seq: 1, method: "POST", path: "/api/records", status: 500, durationMs: 40, mutation: true, error: "status 500, recorded 2xx" }
  ];

  test("request items come back in sequence order and only for API modes", () => {
    const step = runStep({ stepId: "s1", ordinal: 1, mode: "api-handoff", requests: { count: 2, mutations: 1, items } });
    expect(isApiStep(step)).toBe(true);
    expect(isApiStep(runStep({ stepId: "s2", ordinal: 2, mode: "replayed" }))).toBe(false);
    expect(apiRequestItemsOf(step).map((item) => item.seq)).toEqual([1, 2]);
    expect(apiRequestItemsOf(runStep({ stepId: "s3", ordinal: 3, mode: "api-replayed" }))).toEqual([]);
    expect(formatRequestStatus({ status: null, error: "boom" })).toBe("failed");
    expect(formatRequestStatus({ status: null, error: null })).toBe("—");
    expect(formatRequestStatus({ status: 201, error: null })).toBe("201");
  });

  test("the request panel lists method, path, status, duration, the mutation badge and the error", () => {
    const html = renderToStaticMarkup(React.createElement(ApiRequestPanel, { step: { mode: "api-handoff", ordinal: 4 }, items: apiRequestItemsOf({ requests: { count: 2, mutations: 1, items } }) }));
    expect(html).toContain("2 requests · API replay handed off to the UI");
    expect(html.indexOf("/api/records</span>")).toBeLessThan(html.indexOf("/api/records/abc"));
    expect(html).toContain("500");
    expect(html).toContain("40 ms");
    expect(html).toContain("mutation");
    expect(html).toContain("status 500, recorded 2xx");
    expect(html).toContain('aria-label="Requests of step 4"');
  });

  test("the Info tab adds one Preconditions row when runs were reused", () => {
    expect(reuseRows({ reusedFromRunIds: [] })).toEqual([]);
    expect(reuseRows({})).toEqual([]);
    expect(reuseRows({ reusedFromRunIds: ["run_a", "run_b"] })).toEqual([["Preconditions", "reused from run run_a, run_b"]]);
    const format = { tokens: String, cost: (usd: number | null) => `$${usd}`, duration: (ms: number | null) => (ms === null ? "" : `${ms}ms`) };
    const labels = runInfoRows(runDetail({ reusedFromRunIds: ["run_a"] }), "QA", format).map(([label]) => label);
    expect(labels.at(-1)).toBe("Preconditions");
    expect(runInfoRows(runDetail(), "QA", format).map(([label]) => label)).not.toContain("Preconditions");
  });
});

// A [Query] step shows its statement and the row it bound instead of a video segment (roadmap §5.4).
describe("query step view", () => {
  test("reads the statement and meta from cacheDetail and the bound row from outputs", () => {
    const step = {
      ...runStep({ stepId: "q1", ordinal: 1, type: "query", mode: "query", cacheReason: "no-entry" }),
      outputs: { student: JSON.stringify({ id: "stu-1", name: "Ann", email: "[redacted]" }), "student.rows": "[]" },
      cacheDetail: "select id, name from students where level = $1 LIMIT 50\n-- 1 row · agent · PCF_UAT_DB · 42ms"
    } as TestRunStep;
    expect(queryStepView(step)).toEqual({
      statement: "select id, name from students where level = $1 LIMIT 50",
      meta: "1 row · agent · PCF_UAT_DB · 42ms",
      binding: "student",
      row: { id: "stu-1", name: "Ann", email: "[redacted]" },
      rowCount: 1
    });
    // A check without a binding and a blocked query without a statement.
    const check = { ...runStep({ stepId: "q2", ordinal: 2, type: "query", mode: "query" }), cacheDetail: "select 1 from applications where status = 'APPROVED' LIMIT 50\n-- 3 rows · cached · PCF_UAT_DB · 5ms" } as TestRunStep;
    expect(queryStepView(check)).toMatchObject({ binding: null, row: null, rowCount: 3 });
    expect(queryStepView(runStep({ stepId: "q3", ordinal: 3, type: "query", status: "blocked", mode: null }))).toEqual({ statement: "", meta: null, binding: null, row: null, rowCount: null });
    expect(queryStepView(runStep({ stepId: "a1", ordinal: 4, type: "act" }))).toBeNull();
    expect(stepStripMeta({ ordinal: 1, type: "query", mode: "query", durationMs: 42, status: "passed", error: null }, 4)).toBe("Step 1 of 4 · Query · query · 42 ms");
  });
});
