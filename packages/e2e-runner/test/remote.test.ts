import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyModelUsage, type TestRunDetail } from "@jittle-lamp/shared";

import { envPull, pushCases, remoteContext, runRemote, toJUnit } from "../src/remote/commands";

type Call = { method: string; path: string; body: unknown; auth: string | null };

function fakeBackend(routes: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit = {}) => {
    const call = {
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      auth: (init.headers as Record<string, string>)?.authorization ?? null
    };
    calls.push(call);
    const body = routes(call);
    return body instanceof Response ? body : Response.json(body);
  }) as unknown as typeof fetch;
  return { calls, context: remoteContext({ JL_API_ORIGIN: "http://api.test", JL_API_TOKEN: "jl_api_fixture" }, () => undefined, fetchImpl) };
}

const metrics = {
  modelId: null, judgeModelId: null, provider: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  costUsd: 0.12, priceTableVersion: null, durationMs: 4200, stepsTotal: 3, stepsReplayed: 2, stepsAgent: 1, stepsHandoff: 0
};

function run(id: string, outcome: "passed" | "failed" | "blocked"): TestRunDetail {
  return {
    id, testCaseId: "tc", testCaseKey: `TC-${id}`, testCaseTitle: `Case <${id}>`, transcriptVersion: 1, environmentId: null, environmentName: null,
    status: "completed", outcome, blockedReason: outcome === "blocked" ? "APP_UNREACHABLE" : null, flaky: false, trigger: "ci", runnerPool: "cloud",
    createdBy: null, createdByName: null, queuedAt: 1, startedAt: 2, finishedAt: 3, evidenceId: `ev_${id}`, batchId: null, queuePosition: null,
    estimatedStartAt: null, subscribers: [], metrics, params: {}, cacheMode: "read-write", runnerInfo: null, error: null, transcript: "# t", currentStepId: null, live: null,
    steps: outcome === "failed"
      ? [{ stepId: "s1", parentStepId: null, ordinal: 2, type: "assert", label: "the saved banner is visible", checkpointId: null, status: "failed", mode: "agent", cacheReason: null, startedAt: 1, finishedAt: 2, durationMs: 1, videoOffsetMs: 0, observed: "no banner", error: { code: "ASSERTION_FAILED", message: "no banner" }, screenshotUrl: null, usage: emptyModelUsage() }]
      : []
  };
}

describe("remote CLI commands", () => {
  test("JUnit: failures fail, blocked runs are skipped with the reason, evidence links included", () => {
    const xml = toJUnit([run("1", "passed"), run("2", "failed"), run("3", "blocked")], "suite smoke", "https://web.test");
    expect(xml).toContain('tests="3" failures="1" errors="0" skipped="1"');
    expect(xml).toContain('<failure message="ASSERTION_FAILED">step 2 the saved banner is visible: no banner');
    expect(xml).toContain('<skipped message="APP_UNREACHABLE">');
    expect(xml).toContain("https://web.test/evidence/ev_2");
    expect(xml).toContain("Case &lt;1&gt;");
  });

  test("run --suite --wait polls every run and writes JUnit; exit code reflects outcomes", async () => {
    let polls = 0;
    const { calls, context } = fakeBackend((call) => {
      if (call.path === "/test-suites/suite1/runs") return { runId: "r1", attached: false, status: "queued", queuePosition: 0, requestedBy: [], batchId: "b1", runIds: ["r1", "r2"] };
      polls += 1;
      const id = call.path.split("/").pop() ?? "";
      return polls < 3 ? { ...run(id, "passed"), status: "running", outcome: null } : run(id, id === "r2" ? "failed" : "passed");
    });
    const junit = join(mkdtempSync(join(tmpdir(), "jl-junit-")), "out.xml");
    const result = await runRemote(context, { suiteId: "suite1", environmentId: "env1", wait: true, junit, pollMs: 1 });
    expect(result.exitCode).toBe(1);
    expect(calls[0]).toMatchObject({ method: "POST", auth: "Bearer jl_api_fixture", body: { environmentId: "env1", trigger: "ci", force: false } });
    expect(readFileSync(junit, "utf8")).toContain('tests="2" failures="1"');
  });

  test("push creates new cases and updates by Key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-push-"));
    const file = join(dir, "cases.transcript.md");
    writeFileSync(file, "# Existing case\nKey: TC-0007\n\n[Open] /x\n## Checkpoint: c\n[Assert] the page is visible\n\n# New case\n\n[Open] /y\n## Checkpoint: c\n[Assert] the page is visible\n");
    const { calls, context } = fakeBackend((call) => {
      if (call.method === "GET") {
        const items = call.path.includes("TC-0007") ? [{ id: "tc7", key: "TC-0007", title: "Old title" }] : [];
        return { items: items.map((item) => ({ ...item, status: "active", source: "manual", tags: [], environmentId: null, transcriptVersion: 1, stepCount: 1, lintErrors: 0, lintWarnings: 0, duplicatedFromId: null, createdBy: null, createdAt: 1, updatedAt: 1, stats: { runs: 0, lastOutcome: null, lastRunAt: null, passRate: null, flakyRate: null, avgDurationMs: null, avgCostUsd: null, avgModelCalls: null, avgTokens: null, cachedSteps: 0, staleSteps: 0, derivedCases: 0 } })), total: items.length, nextCursor: null, tagCounts: {} };
      }
      return new Response(JSON.stringify({ code: "STOP" }), { status: 418 });
    });
    await expect(pushCases(context, { file })).rejects.toThrow("418");
    expect(calls.map((call) => `${call.method} ${call.path.split("?")[0]}`)).toEqual(["GET /test-cases", "PATCH /test-cases/tc7"]);
    expect((calls[1]?.body as { transcript: string }).transcript).toContain("Key: TC-0007");
  });

  test("env pull writes the env file with mode 600", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "jl-envpull-")), ".env.e2e");
    const { calls, context } = fakeBackend((call) =>
      call.path === "/test-environments"
        ? [{ id: "e1", name: "pcf-uat", baseUrl: "https://x.test", variables: {}, runnerPool: "cloud", agentInstructions: null, notes: null, usedByCases: 0, createdAt: 1, updatedAt: 1 }]
        : { content: "JL_ENV_NAME=pcf-uat\nJL_CRED_PCF_HQ_ADMIN_PASSWORD=" }
    );
    await envPull(context, { environment: "pcf-uat", withSecrets: false, out });
    expect(calls[1]?.path).toBe("/test-environments/e1/env-file?withSecrets=false");
    expect(readFileSync(out, "utf8")).toBe("JL_ENV_NAME=pcf-uat\nJL_CRED_PCF_HQ_ADMIN_PASSWORD=\n");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe("remote CLI review regressions", () => {
  test("a run without an outcome is a JUnit error and fails the job; blocked runs do not unless asked", async () => {
    const lost = { ...run("4", "passed"), status: "failed" as const, outcome: null, blockedReason: "RUNNER_LOST" as const };
    expect(toJUnit([lost], "s")).toContain('<error message="RUNNER_LOST">');
    const respond = (outcome: "blocked" | "passed") =>
      fakeBackend((call) =>
        call.method === "POST"
          ? { runId: "r1", attached: false, status: "queued", queuePosition: 0, requestedBy: [], batchId: null, runIds: [] }
          : run("r1", outcome)
      ).context;
    expect((await runRemote(respond("blocked"), { caseId: "c", wait: true, pollMs: 1 })).exitCode).toBe(0);
    expect((await runRemote(respond("blocked"), { caseId: "c", wait: true, pollMs: 1, failOnBlocked: true })).exitCode).toBe(3);
  });

  test("push never falls back to a title match when the document names a Key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-push-key-"));
    const file = join(dir, "c.transcript.md");
    writeFileSync(file, "# Same title\nKey: TC-0099\n\n[Open] /x\n## Checkpoint: c\n[Assert] the page is visible\n");
    const { calls, context } = fakeBackend((call) =>
      call.method === "GET"
        ? { items: [], total: 0, nextCursor: null, tagCounts: {} }
        : new Response(JSON.stringify({ code: "STOP" }), { status: 418 })
    );
    await expect(pushCases(context, { file })).rejects.toThrow("418");
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });
});
