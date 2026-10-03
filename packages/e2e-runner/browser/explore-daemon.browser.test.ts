import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explorationFallbackTranscript, explorationResultRequestSchema, parseTestCaseTranscript, type ExplorationResultRequest } from "@jittle-lamp/shared";

import { startWorker } from "../src/daemon/worker";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// The daemon explores an import item: a stand-in backend hands out one exploration, the worker
// runs `e2e explore` against the fixture app with a recorded model and posts the record.

const fixtures = join(import.meta.dir, "../test/fixtures");
let app: FixtureApp;
let backend: ReturnType<typeof Bun.serve>;
let handedOut = false;
const results: ExplorationResultRequest[] = [];
const seen: string[] = [];

beforeAll(() => {
  app = startFixtureApp({ email: "admin@example.test", password: "unused" });
  backend = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const json = (body: unknown, status = 200) => Response.json(body, { status });
      seen.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/runner-pools/register") return json({ workerId: "w1", poolId: "p1", workerToken: "wkr_explore", heartbeatMs: 1000, leaseMs: 30000 });
      if (url.pathname === "/runner-pools/heartbeat") return json({ ok: true });
      if (url.pathname === "/runner-pools/claim") {
        if (handedOut) return json({ run: null, exploration: null });
        handedOut = true;
        return json({
          run: null,
          exploration: { explorationId: "ex1", goal: "Open the sign in page and check the form shows Email and Password", maxSteps: 3, timeoutMs: 180_000, leaseExpiresAt: Date.now() + 900_000 }
        });
      }
      if (request.headers.get("authorization") !== "Bearer wkr_explore") return json({ code: "UNAUTHORIZED" }, 401);
      if (url.pathname === "/test-explorations/ex1/config") {
        return json({
          environment: { name: "fixture", baseUrl: app.url, variables: {}, agentInstructions: null, dataLocale: null },
          credentials: [],
          model: { act: `mock:${join(fixtures, "explore.mock.json")}`, judge: null, apiKeys: {} }
        });
      }
      if (url.pathname === "/test-explorations/ex1/result") {
        results.push(explorationResultRequestSchema.parse(await request.json()));
        return json({ ok: true });
      }
      return json({ code: "NOT_FOUND" }, 404);
    }
  });
});

afterAll(() => {
  app?.stop();
  backend?.stop(true);
});

describe("jl-e2e-runner explores import items", () => {
  test("claims the exploration, explores the app and posts what the agent did", async () => {
    await startWorker({
      apiOrigin: `http://127.0.0.1:${backend.port}`,
      registrationToken: "reg_explore",
      workDir: mkdtempSync(join(tmpdir(), "jl-explore-worker-")),
      statePath: join(mkdtempSync(join(tmpdir(), "jl-explore-state-")), "state.json"),
      once: true,
      pollMs: 100,
      hostEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
      log: () => undefined
    });
    expect(seen).toContain("GET /test-explorations/ex1/config");
    expect(results).toHaveLength(1);
    const [result] = results;
    expect(result?.status).toBe("done");
    expect(result?.explore).toMatchObject({
      ended: "finished",
      summary: "The sign in form is shown with Email and Password fields.",
      steps: [{ index: 1, title: "Check the sign in form", status: "passed", summary: "The sign in form shows Email and Password." }]
    });
    expect(app.requests).toContain("GET /login");

    // Without a model the backend writes one Act per explored step and the assessment as an Assert.
    const transcript = explorationFallbackTranscript({ title: "Sign in form", record: result!.explore!, environmentName: "fixture" });
    const { testCase, diagnostics } = parseTestCaseTranscript(transcript);
    expect(diagnostics).toEqual([]);
    expect(testCase.steps.map((step) => `${step.type} ${step.text}`)).toEqual([
      "act Look at the sign in form and confirm the Email field is visible",
      "assert The sign in form is shown with Email and Password fields."
    ]);
  }, 240_000);
});
