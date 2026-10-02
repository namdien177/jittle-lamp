import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unzipSync } from "fflate";

import {
  cacheEntryWriteRequestSchema,
  finalizeTestRunRequestSchema,
  parseTestCaseTranscript,
  registerRunnerRequestSchema,
  testRunProgressRequestSchema,
  type FinalizeTestRunRequest,
  type TestRunProgressRequest
} from "@jittle-lamp/shared";

import { startWorker } from "../src/daemon/worker";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// The daemon against an in-process stand-in for the backend routes it calls (contract:
// packages/shared/src/test-api.ts). Two runs of the fixture case are claimed in turn; the second
// replays from the backend-backed cache store.

const FIXTURE_PASSWORD = "fixture-Pa55word!";
const fixtures = join(import.meta.dir, "../test/fixtures");
const transcript = readFileSync(join(fixtures, "fixture-logout.transcript.md"), "utf8");
const steps = parseTestCaseTranscript(transcript).testCase.steps;

let app: FixtureApp;
let backend: ReturnType<typeof Bun.serve>;
const queue: string[] = [];
const cache = new Map<string, unknown>();
const progress = new Map<string, TestRunProgressRequest[]>();
const finalized = new Map<string, FinalizeTestRunRequest>();
const evidence = new Map<string, Record<string, Uint8Array>>();
const seenAuth = new Set<string>();

beforeAll(() => {
  app = startFixtureApp({ email: "admin@example.test", password: FIXTURE_PASSWORD });
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const auth = request.headers.get("authorization") ?? "";
      seenAuth.add(`${request.method} ${url.pathname.replace(/run_\d+/, ":id")} ${auth.split(" ")[1]?.split("_")[0]}`);
      const json = (body: unknown, status = 200) => Response.json(body, { status });
      if (url.pathname === "/runner-pools/register") {
        registerRunnerRequestSchema.parse(await request.json());
        return json({ workerId: "w1", poolId: "p1", workerToken: "wkr_secret", heartbeatMs: 1000, leaseMs: 30000 });
      }
      if (url.pathname === "/runner-pools/heartbeat") return json({ ok: true });
      if (url.pathname === "/runner-pools/claim") {
        const runId = queue.shift();
        if (!runId) return json({ run: null });
        return json({
          run: {
            runId,
            testCaseId: "tc1",
            testCaseKey: "TC-0001",
            transcript,
            transcriptVersion: 1,
            steps,
            macros: [],
            environmentId: "env1",
            params: {},
            cacheMode: "read-write",
            leaseExpiresAt: Date.now() + 30000,
            attempt: 1,
            runToken: `run_${runId}`
          }
        });
      }
      const match = /^\/test-runs\/([^/]+)\/(config|progress|evidence|finalize|cache)(?:\/(.+))?$/.exec(url.pathname);
      if (!match) return json({ code: "NOT_FOUND" }, 404);
      const [, runId = "", action, keyHash] = match;
      if (auth !== `Bearer run_${runId}`) return json({ code: "UNAUTHORIZED" }, 401);
      if (action === "config") {
        return json({
          environment: { name: "fixture", baseUrl: app.url, variables: {}, agentInstructions: "Never delete records." },
          credentials: [{ profile: "ADMIN", fields: { username: "admin@example.test" }, secretFields: { password: FIXTURE_PASSWORD } }],
          model: { act: `mock:${join(fixtures, "fixture-logout.mock.json")}`, judge: null, apiKeys: {} },
          agentNotes: "Org note: be careful.",
          prices: [{ modelId: "mock:mock-act", inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 }],
          priceTableVersion: "org-test"
        });
      }
      if (action === "progress") {
        const body = testRunProgressRequestSchema.parse(await request.json());
        progress.set(runId, [...(progress.get(runId) ?? []), body]);
        return json({ cancelRequested: false, leaseExpiresAt: Date.now() + 30000, takeoverRequested: false });
      }
      if (action === "cache") {
        if (request.method === "GET") return cache.has(keyHash ?? "") ? json({ status: "hit", entry: cache.get(keyHash ?? "") }) : json({ status: "miss" });
        const body = cacheEntryWriteRequestSchema.parse(await request.json());
        cache.set(keyHash ?? "", body.entry);
        return json({ ok: true });
      }
      if (action === "evidence") {
        evidence.set(runId, unzipSync(new Uint8Array(await request.arrayBuffer())));
        return json({ evidenceId: `ev_${runId}` });
      }
      const body = finalizeTestRunRequestSchema.parse(await request.json());
      finalized.set(runId, body);
      return json({});
    }
  });
});

afterAll(() => {
  app?.stop();
  backend?.stop(true);
});

describe("jl-e2e-runner daemon", () => {
  test("claims, runs with org config, streams progress, uploads evidence and finalises; run 2 replays from the backend cache", async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "jl-runner-state-")), "state.json");
    const workDir = mkdtempSync(join(tmpdir(), "jl-runner-work-"));
    const hostEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH, JL_ENV_BASE_URL: "https://must-not-win.example" };
    const origin = `http://127.0.0.1:${backend.port}`;

    queue.push("run_1");
    await startWorker({ apiOrigin: origin, registrationToken: "reg_secret", statePath, workDir, once: true, pollMs: 50, hostEnv, log: () => undefined });
    queue.push("run_2");
    // Second start reuses the stored worker credential; no registration token.
    await startWorker({ apiOrigin: origin, statePath, workDir, once: true, pollMs: 50, hostEnv, log: () => undefined });

    const first = finalized.get("run_1");
    const second = finalized.get("run_2");
    expect(first?.report.outcome).toBe("passed");
    expect(first?.evidenceId).toBe("ev_run_1");
    expect(first?.report.totals.stepsAgent).toBe(4);
    expect(first?.report.priceTableVersion).toBe("org-test");
    expect(first?.report.totals.usage.costUsd).toBeGreaterThan(0);
    expect(second?.report.totals.stepsReplayed).toBe(4);
    expect(second?.report.totals.usage.modelCalls).toBe(0);
    expect(cache.size).toBe(4);

    // Step ids are the server's, so progress maps onto test_run_steps.
    const reported = new Set((progress.get("run_1") ?? []).flatMap((body) => body.steps.map((step) => step.stepId)));
    for (const step of steps) expect(reported.has(step.stepId)).toBe(true);
    expect((progress.get("run_1") ?? []).some((body) => body.screenshot?.mimeType === "image/jpeg")).toBe(true);

    const files = evidence.get("run_1") ?? {};
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["session.archive.json", "recording.webm", "run-report.json"]));
    const archive = new TextDecoder().decode(files["session.archive.json"]);
    expect(archive).toContain('"kind": "e2e-runner"');
    for (const [name, bytes] of Object.entries(files)) {
      expect({ name, leaks: new TextDecoder().decode(bytes).includes(FIXTURE_PASSWORD) }).toEqual({ name, leaks: false });
    }
    expect(JSON.stringify([...progress.values()])).not.toContain(FIXTURE_PASSWORD);
    expect(JSON.stringify([...finalized.values()])).not.toContain(FIXTURE_PASSWORD);
  }, 240_000);
});
