import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRunConfig } from "../src/config/resolve";
import { compileStep, renderTestFile } from "../src/generate/project";
import { buildRunPlan, loadMacros } from "../src/plan";
import { buildRunReport } from "../src/report/build";
import {
  assertWithCheck,
  checkFromAnswer,
  extractInstruction,
  renderCheck,
  resetExtractBudget,
  type AssertCheckFixtures,
  type CheckAnswer
} from "../src/runtime/assert-check";
import { createBackendCheckStore, createFileCheckStore, createJlCheckStore, isAssertCheck, type AssertCheck, type CheckStore } from "../src/runtime/cache-store";
import { hadRecentNetwork, lastRequestFinishedAt } from "../src/runtime/network-activity";
import type { StepLogEvent } from "../src/runtime/step-log";

// Deterministic assert cache (roadmap 2026-10-13 §4.1) and the settle gate (§4.5), without a
// browser: a fake screen says how many nodes a locator matches and whether they are visible.

type FakeNode = { count: number; visible: boolean; text: string };
type FakeLocator = { key: string; node: FakeNode; count(): Promise<number> };

const at = "2026-10-13T10:00:00.000Z";
const visibleCheck: AssertCheck = { schemaVersion: "jl-assert-check-1", locator: { role: "heading", name: "Welcome" }, matcher: "visible", expected: null, recordedAt: at };

function fakeFixtures(nodes: Record<string, Partial<FakeNode>>, answers: CheckAnswer[] = [], url = "https://app.test/dashboard") {
  const extractCalls: string[] = [];
  const assertCalls: string[] = [];
  const locator = (key: string): FakeLocator => {
    const node = { count: 0, visible: false, text: "", ...nodes[key] };
    return { key, node, count: async () => node.count };
  };
  const browser = { url };
  const fixtures: AssertCheckFixtures = {
    agent: {
      extract: async (instruction) => {
        extractCalls.push(instruction);
        const answer = answers.shift();
        if (!answer) throw Object.assign(new Error("no answer"), { code: "ASSERTION_INCONCLUSIVE" });
        return answer;
      }
    },
    screen: {
      getByRole: (role, name) => locator(`role:${String(role)}:${name}`) as never,
      getByLabel: (text) => locator(`label:${text}`) as never,
      getByText: (text) => locator(`text:${text}`) as never,
      getByTestId: (id) => locator(`testId:${id}`) as never
    },
    expect: (actual) => {
      if (actual === browser) {
        return {
          toHaveURL: async (expected: string) => {
            if (!browser.url.includes(expected)) throw new Error(`url ${browser.url} is not ${expected}`);
          }
        };
      }
      const target = actual as FakeLocator;
      return {
        toBeVisible: async () => {
          if (target.node.count !== 1 || !target.node.visible) throw new Error(`${target.key} is not visible`);
        },
        toContainText: async (expected: string) => {
          if (target.node.count !== 1 || !target.node.text.includes(expected)) throw new Error(`${target.key} lacks ${expected}`);
        }
      };
    },
    browser
  };
  const judge = async (text: string) => {
    assertCalls.push(text);
    return { summary: `judged ${text}` };
  };
  return { fixtures, judge, extractCalls, assertCalls };
}

function memoryStore(initial: AssertCheck | null, writable = true) {
  const writes: Array<{ stepId: string; check: AssertCheck; renderedCode: string; instructionKey: string | null }> = [];
  const stales: Array<{ stepId: string; reason: string }> = [];
  let current = initial;
  const store: CheckStore = {
    writable,
    read: async () => current,
    write: async (stepId, check, meta) => {
      writes.push({ stepId, check, renderedCode: meta.renderedCode, instructionKey: meta.instructionKey });
      current = check;
    },
    stale: async (stepId, reason) => {
      stales.push({ stepId, reason });
      current = null;
    }
  };
  return { store, writes, stales };
}

beforeEach(() => resetExtractBudget());
afterEach(() => {
  delete process.env.JL_CACHE_MODE;
  delete process.env.JL_CACHE_DIR;
  delete process.env.JL_CAPTURE_DIR;
});

describe("check answers", () => {
  test("a role, label, text or testId answer becomes a check; none and incomplete answers become nothing", () => {
    const base: CheckAnswer = { kind: "role", role: "heading", name: "Welcome", value: null, matcher: "visible", expected: null };
    expect(checkFromAnswer(base)?.locator).toEqual({ role: "heading", name: "Welcome" });
    expect(checkFromAnswer({ ...base, kind: "label", value: "Email" })?.locator).toEqual({ label: "Email" });
    expect(checkFromAnswer({ ...base, kind: "text", value: "Saved" })?.locator).toEqual({ text: "Saved" });
    expect(checkFromAnswer({ ...base, kind: "testId", value: "total" })?.locator).toEqual({ testId: "total" });
    expect(checkFromAnswer({ ...base, kind: "none" })).toBeNull();
    expect(checkFromAnswer({ ...base, name: null })).toBeNull();
    expect(checkFromAnswer({ ...base, kind: "label", value: null })).toBeNull();
    // text needs the expected text; url needs the URL and no control.
    expect(checkFromAnswer({ ...base, matcher: "text" })).toBeNull();
    expect(checkFromAnswer({ ...base, matcher: "text", expected: "Welcome back" })).toMatchObject({ matcher: "text", expected: "Welcome back" });
    expect(checkFromAnswer({ ...base, kind: "none", matcher: "url", expected: "/dashboard" })).toMatchObject({ locator: null, matcher: "url", expected: "/dashboard" });
    expect(checkFromAnswer({ ...base, kind: "none", matcher: "url" })).toBeNull();
  });

  test("checks render as the e2e call the Scripts drawer shows", () => {
    expect(renderCheck(visibleCheck)).toBe("expect(screen.getByRole('heading', 'Welcome')).toBeVisible()");
    expect(renderCheck({ ...visibleCheck, locator: { label: "Email" } })).toBe("expect(screen.getByLabel('Email')).toBeVisible()");
    expect(renderCheck({ ...visibleCheck, locator: { text: "it's" }, matcher: "text", expected: "it's" })).toBe("expect(screen.getByText('it\\'s')).toContainText('it\\'s')");
    expect(renderCheck({ ...visibleCheck, locator: { testId: "total" } })).toBe("expect(screen.getByTestId('total')).toBeVisible()");
    expect(renderCheck({ ...visibleCheck, locator: null, matcher: "url", expected: "/dashboard" })).toBe("expect(browser).toHaveURL('/dashboard')");
    expect(extractInstruction("the dashboard is shown")).toContain("the single on-screen control that proves: the dashboard is shown");
  });

  test("isAssertCheck accepts the stored shape only", () => {
    expect(isAssertCheck(visibleCheck)).toBe(true);
    expect(isAssertCheck({ ...visibleCheck, locator: null, matcher: "url", expected: "/x" })).toBe(true);
    expect(isAssertCheck({ ...visibleCheck, locator: null })).toBe(false);
    expect(isAssertCheck({ ...visibleCheck, matcher: "count" })).toBe(false);
    expect(isAssertCheck({ ...visibleCheck, locator: { role: "heading" } })).toBe(false);
    expect(isAssertCheck(null)).toBe(false);
  });
});

describe("assertWithCheck", () => {
  test("a stored check that holds replays with no model call", async () => {
    const { fixtures, judge, extractCalls, assertCalls } = fakeFixtures({ "role:heading:Welcome": { count: 1, visible: true } });
    const { store, writes } = memoryStore(visibleCheck);
    const result = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "read-write" });
    expect(result.check).toEqual({ status: "hit", locator: "expect(screen.getByRole('heading', 'Welcome')).toBeVisible()" });
    expect(result.summary).toContain("replayed");
    expect(assertCalls).toEqual([]);
    expect(extractCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("a check that no longer holds goes stale and the judge takes the step over; no new question that run", async () => {
    const { fixtures, judge, extractCalls, assertCalls } = fakeFixtures({ "role:heading:Welcome": { count: 0 } });
    const { store, stales, writes } = memoryStore(visibleCheck);
    const result = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "read-write" });
    expect(result.check).toMatchObject({ status: "stale", reason: "role:heading:Welcome is not visible" });
    expect(stales).toEqual([{ stepId: "s1", reason: "role:heading:Welcome is not visible" }]);
    expect(assertCalls).toEqual(["the dashboard is shown"]);
    expect(extractCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("under strict a stale check fails the step with REPLAY_STALE (blocked) and never judges", async () => {
    const { fixtures, judge, assertCalls } = fakeFixtures({ "role:heading:Welcome": { count: 1, visible: false } });
    const { store, stales } = memoryStore(visibleCheck);
    const error = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "strict" }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "REPLAY_STALE", blocked: true });
    expect((error as Error).message).toContain("cache.strict hands no step to the agent");
    expect(stales).toHaveLength(1);
    expect(assertCalls).toEqual([]);
  });

  test("the url matcher replays through the browser fixture", async () => {
    const { fixtures, judge, assertCalls } = fakeFixtures({}, [], "https://app.test/dashboard?tab=1");
    const { store } = memoryStore({ ...visibleCheck, locator: null, matcher: "url", expected: "/dashboard" });
    const result = await assertWithCheck("s1", "the dashboard opened", fixtures, { judge, store, cacheMode: "read-only" });
    expect(result.check?.status).toBe("hit");
    expect(assertCalls).toEqual([]);
  });

  test("without a check a recording run judges, asks once, validates against the screen and writes", async () => {
    const answer: CheckAnswer = { kind: "role", role: "heading", name: "Welcome", value: null, matcher: "visible", expected: null };
    const { fixtures, judge, extractCalls, assertCalls } = fakeFixtures({ "role:heading:Welcome": { count: 1, visible: true } }, [answer]);
    const { store, writes } = memoryStore(null);
    const result = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "read-write", instructionKey: "k1" });
    expect(assertCalls).toEqual(["the dashboard is shown"]);
    expect(extractCalls).toHaveLength(1);
    expect(extractCalls[0]).toContain("the single on-screen control that proves: the dashboard is shown");
    expect(writes).toEqual([
      {
        stepId: "s1",
        instructionKey: "k1",
        renderedCode: "expect(screen.getByRole('heading', 'Welcome')).toBeVisible()",
        check: expect.objectContaining({ locator: { role: "heading", name: "Welcome" }, matcher: "visible" })
      }
    ]);
    expect(result.check).toEqual({ status: "recorded", locator: "expect(screen.getByRole('heading', 'Welcome')).toBeVisible()" });
    expect(result.summary).toBe("judged the dashboard is shown");
  });

  test("the question is asked at most once per assert per run, even after a failed validation", async () => {
    const answer: CheckAnswer = { kind: "role", role: "heading", name: "Welcome", value: null, matcher: "visible", expected: null };
    // Two matches: ambiguous, not stored.
    const { fixtures, judge, extractCalls } = fakeFixtures({ "role:heading:Welcome": { count: 2, visible: true } }, [answer, answer]);
    const { store, writes } = memoryStore(null);
    const first = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "read-write" });
    const second = await assertWithCheck("s1", "the dashboard is shown", fixtures, { judge, store, cacheMode: "read-write" });
    expect(first.check).toBeNull();
    expect(second.check).toBeNull();
    expect(extractCalls).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  test("none, a matcher that does not hold now, an invalid answer or an inconclusive model write nothing", async () => {
    const cases: Array<{ answers: CheckAnswer[]; nodes: Record<string, Partial<FakeNode>> }> = [
      { answers: [{ kind: "none", role: null, name: null, value: null, matcher: "visible", expected: null }], nodes: {} },
      { answers: [{ kind: "label", role: null, name: null, value: "Email", matcher: "text", expected: "x" }], nodes: { "label:Email": { count: 1, visible: true, text: "Email" } } },
      { answers: [{ kind: "wat" } as unknown as CheckAnswer], nodes: {} },
      { answers: [], nodes: {} }
    ];
    for (const [index, item] of cases.entries()) {
      const { fixtures, judge, assertCalls } = fakeFixtures(item.nodes, item.answers);
      const { store, writes } = memoryStore(null);
      const result = await assertWithCheck(`s${index}`, "something holds", fixtures, { judge, store, cacheMode: "read-write" });
      expect({ index, check: result.check, writes, judged: assertCalls }).toEqual({ index, check: null, writes: [], judged: ["something holds"] });
    }
  });

  test("read-only and strict runs judge a step without a check and never ask; off reads nothing", async () => {
    for (const mode of ["read-only", "strict"] as const) {
      const { fixtures, judge, extractCalls, assertCalls } = fakeFixtures({}, [{ kind: "role", role: "heading", name: "Welcome", value: null, matcher: "visible", expected: null }]);
      const { store, writes } = memoryStore(null, false);
      const result = await assertWithCheck("s1", "x", fixtures, { judge, store, cacheMode: mode });
      expect({ mode, check: result.check, extract: extractCalls, writes, judged: assertCalls }).toEqual({ mode, check: null, extract: [], writes: [], judged: ["x"] });
    }
    const { fixtures, judge } = fakeFixtures({ "role:heading:Welcome": { count: 1, visible: true } });
    let reads = 0;
    const store: CheckStore = { writable: false, read: async () => ((reads += 1), visibleCheck), write: async () => undefined, stale: async () => undefined };
    const result = await assertWithCheck("s1", "x", fixtures, { judge, store, cacheMode: "off" });
    expect(result.check).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("check stores", () => {
  test("the file store keeps one file per step under checks/, and a stale file reads as nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-checks-"));
    const store = createFileCheckStore({ dir, writable: true, environment: "fixture" });
    await store.write("st.1", visibleCheck, { instructionKey: "k", renderedCode: "expect(...)" });
    expect(await store.read("st.1")).toEqual(visibleCheck);
    const file = JSON.parse(readFileSync(join(dir, "st.1.json"), "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ schemaVersion: "jl-step-check-1", stepId: "st.1", environment: "fixture", status: "active", renderedCode: "expect(...)" });
    await store.stale("st.1", "gone");
    expect(await store.read("st.1")).toBeNull();
    expect(JSON.parse(readFileSync(join(dir, "st.1.json"), "utf8"))).toMatchObject({ status: "stale", staleReason: "gone" });
    // A read-only store writes nothing.
    const readOnly = createFileCheckStore({ dir, writable: false });
    await readOnly.write("st.2", visibleCheck, { instructionKey: null, renderedCode: "" });
    expect(await readOnly.read("st.2")).toBeNull();
  });

  test("createJlCheckStore follows JL_CACHE_DIR and JL_CACHE_MODE without a run token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-cache-"));
    process.env.JL_CACHE_DIR = dir;
    process.env.JL_CACHE_MODE = "read-write";
    const store = createJlCheckStore();
    expect(store.writable).toBe(true);
    await store.write("s1", visibleCheck, { instructionKey: null, renderedCode: "" });
    expect(await createFileCheckStore({ dir: join(dir, "checks"), writable: false }).read("s1")).toEqual(visibleCheck);
    process.env.JL_CACHE_MODE = "strict";
    expect(createJlCheckStore().writable).toBe(false);
  });

  test("the backend store reads, writes and stales through the run token; a 404 is no check", async () => {
    const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
    let status = 200;
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, auth: headers.authorization ?? null });
      if (status !== 200) return new Response("{}", { status });
      return Response.json(init?.method === "PUT" ? { ok: true } : { status: "hit", check: visibleCheck });
    }) as unknown as typeof fetch;
    const store = createBackendCheckStore({ apiUrl: "http://backend.test", runId: "run_1", runToken: "jl_run_t", writable: true, fetch: fetchImpl });
    expect(await store.read("st 1")).toEqual(visibleCheck);
    await store.write("st 1", visibleCheck, { instructionKey: "k", renderedCode: "code" });
    await store.stale("st 1", "gone");
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "http://backend.test/test-runs/run_1/cache/check/st%201"],
      ["PUT", "http://backend.test/test-runs/run_1/cache/check/st%201"],
      ["PUT", "http://backend.test/test-runs/run_1/cache/check/st%201"]
    ]);
    expect(calls.every((call) => call.auth === "Bearer jl_run_t")).toBe(true);
    expect(calls[1]?.body).toEqual({ check: visibleCheck, instructionKey: "k", renderedCode: "code" });
    expect(calls[2]?.body).toEqual({ stale: true, reason: "gone" });
    status = 404;
    expect(await store.read("st 1")).toBeNull();
  });
});

describe("settle gate (JL_SETTLE_MS, roadmap §4.5)", () => {
  test("recent network is read from the tail of requests.jsonl", () => {
    const now = Date.parse(at);
    const line = (finishedAt: string | null) => JSON.stringify({ kind: "request", method: "GET", url: "https://x", finishedAt });
    expect(lastRequestFinishedAt(`${line("2026-10-13T09:59:58.000Z")}\n${line("2026-10-13T09:59:59.500Z")}\n${line(null)}\n`)).toBe(now - 500);
    expect(lastRequestFinishedAt("")).toBeNull();
    expect(lastRequestFinishedAt('{"cut":\n{"kind":"console"}\n')).toBeNull();

    const dir = mkdtempSync(join(tmpdir(), "jl-capture-"));
    // No capture at all: the retry stays, nothing says the page is quiet.
    expect(hadRecentNetwork({ captureDir: undefined, now })).toBe(true);
    // A capture with no finished request: the page is quiet.
    expect(hadRecentNetwork({ captureDir: dir, now })).toBe(false);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "requests.jsonl"), `${line("2026-10-13T09:59:57.000Z")}\n`);
    expect(hadRecentNetwork({ captureDir: dir, now })).toBe(false);
    writeFileSync(join(dir, "requests.jsonl"), `${line("2026-10-13T09:59:57.000Z")}\n${line("2026-10-13T09:59:59.200Z")}\n`);
    expect(hadRecentNetwork({ captureDir: dir, now })).toBe(true);
    expect(hadRecentNetwork({ captureDir: dir, now, windowMs: 500 })).toBe(false);
    // A long log: only the tail is read, and the newest line is at the end.
    writeFileSync(join(dir, "requests.jsonl"), `${Array.from({ length: 2000 }, () => line("2026-10-13T09:00:00.000Z")).join("\n")}\n${line("2026-10-13T09:59:59.900Z")}\n`);
    expect(hadRecentNetwork({ captureDir: dir, now })).toBe(true);
  });
});

describe("generated project and report", () => {
  const transcript = "# Checks\nKey: TC-0042\n\n[Open] /dashboard\n## Checkpoint: c\n[Assert] the dashboard shows {SCHOOL}\n[Act] open the menu";
  const plan = () =>
    buildRunPlan({ transcript, config: resolveRunConfig({ env: { JL_ENV_BASE_URL: "https://app.test", JL_VAR_SCHOOL: "HQ" } }), macros: loadMacros([]) });

  test("an Assert compiles to jl.assertWithCheck with the step id and instruction key, and the test takes screen and browser", () => {
    const runPlan = plan();
    const config = resolveRunConfig({ env: { JL_ENV_BASE_URL: "https://app.test", JL_VAR_SCHOOL: "HQ" } });
    const compiled = runPlan.steps.map((step) => compileStep(step, runPlan, config, new Set()));
    const code = renderTestFile(compiled, "/runtime/test-helpers.ts");
    const assertStep = runPlan.steps.find((step) => step.type === "assert");
    expect(code).toContain('import { test } from "@e2e-dev/web";');
    expect(code).toContain("async ({ app, agent, screen, browser }) =>");
    expect(code).toContain(
      `jl.assertWithCheck(${JSON.stringify(assertStep?.stepId)}, ${JSON.stringify(assertStep?.instructionKey)}, "the dashboard shows {SCHOOL}", {"SCHOOL":{"kind":"var","name":"SCHOOL"}}, { agent, screen, browser })`
    );
  });

  test("the report marks a replayed check deterministic/hit, a stale one agent/action-failed, a recorded one agent/no-entry", () => {
    const runPlan = plan();
    const ids = runPlan.steps.map((step) => step.stepId);
    const assertId = runPlan.steps.find((step) => step.type === "assert")?.stepId ?? "";
    const report = (check: Extract<StepLogEvent, { type: "step-finished" }>["check"]) => {
      const stepLog: StepLogEvent[] = [{ type: "attempt-started", at, videoStartedAt: at }];
      ids.forEach((stepId, index) => {
        const step = runPlan.steps[index];
        if (!step) return;
        const started = new Date(Date.parse(at) + index * 1000).toISOString();
        stepLog.push({ type: "step-started", at: started, stepId, parentStepId: step.parentStepId, ordinal: step.ordinal, kind: step.type, label: step.instruction });
        stepLog.push({
          type: "step-finished",
          at: new Date(Date.parse(at) + index * 1000 + 500).toISOString(),
          stepId,
          status: "passed",
          error: null,
          screenshot: null,
          observed: null,
          ...(stepId === assertId && check ? { check } : {})
        });
      });
      return buildRunReport({
        plan: runPlan,
        runId: "run_1",
        testCaseId: null,
        transcriptVersion: null,
        environmentId: null,
        runner: { runner: "jl-e2e", runnerVersion: "1", engine: "e2e", engineVersion: "0.20.0", browser: "chromium", browserVersion: null, headless: true, viewport: { width: 1, height: 1 }, cacheMode: "read-write", host: "cli" },
        model: { act: null, judge: null, provider: null },
        e2eReport: { run: { status: "passed", results: [{ attempts: [{ steps: [] }] }] } },
        aiTrace: null,
        stepLog,
        exitCode: 0,
        startedAt: at,
        finishedAt: at,
        artifacts: []
      }).steps.find((step) => step.stepId === assertId);
    };
    expect(report({ status: "hit", locator: "expect(screen.getByRole('heading', 'HQ')).toBeVisible()" })).toMatchObject({
      mode: "deterministic",
      cacheReason: "hit",
      cacheDetail: "check expect(screen.getByRole('heading', 'HQ')).toBeVisible()"
    });
    expect(report({ status: "stale", locator: "expect(screen.getByLabel('Email')).toBeVisible()", reason: "not visible" })).toMatchObject({
      mode: "agent",
      cacheReason: "action-failed",
      cacheDetail: "check expect(screen.getByLabel('Email')).toBeVisible() no longer holds: not visible"
    });
    expect(report({ status: "recorded", locator: "expect(screen.getByLabel('Email')).toBeVisible()" })).toMatchObject({ mode: "agent", cacheReason: "no-entry", cacheDetail: "check recorded: expect(screen.getByLabel('Email')).toBeVisible()" });
    expect(report(undefined)).toMatchObject({ mode: "agent", cacheReason: "not-cacheable", cacheDetail: null });
  });
});
