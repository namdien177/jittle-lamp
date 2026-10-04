import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
let goal = "";
let modelFixture = "";
const environmentGuidance = "Only inspect the login form; do not submit.";

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
          exploration: { explorationId: "ex1", goal, maxSteps: 3, timeoutMs: 180_000, leaseExpiresAt: Date.now() + 900_000 }
        });
      }
      if (request.headers.get("authorization") !== "Bearer wkr_explore") return json({ code: "UNAUTHORIZED" }, 401);
      if (url.pathname === "/test-explorations/ex1/config") {
        return json({
          environment: { name: "fixture", baseUrl: app.url, variables: {}, agentInstructions: environmentGuidance, dataLocale: null },
          credentials: [{ profile: "FIXTURE_ADMIN", fields: { nickname: "fixture-nick" }, loginField: "nickname", secretFields: { password: "fixture-password" } }],
          model: { act: `mock:${modelFixture}`, judge: null, apiKeys: {} }
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
  for (const length of [100, 1800, 3000]) test(`explores roughly ${length}-character instructions with full context and posts the original goal`, async () => {
    handedOut = false;
    results.length = 0;
    seen.length = 0;
    goal = `Open the sign in page and check the form shows Email and Password. ${"Keep this flow read-only. ".repeat(Math.ceil(length / 25))}Final instruction: inspect only, then stop.`;
    const fixture = JSON.parse(readFileSync(join(fixtures, "explore.mock.json"), "utf8"));
    for (const turn of fixture.turns) {
      turn.match.promptIncludes = [...(turn.match.promptIncludes ?? []), goal, environmentGuidance, "FIXTURE_ADMIN", "nickname"];
    }
    modelFixture = join(mkdtempSync(join(tmpdir(), "jl-explore-model-")), "mock.json");
    writeFileSync(modelFixture, JSON.stringify(fixture));
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
      goal,
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
