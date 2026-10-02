import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { unzipSync } from "fflate";

import type {
  CreateTestRunResponse,
  ImportBatch,
  Notification,
  TestCaseDetail,
  TestRunDetail
} from "@jittle-lamp/shared";

import { evidenceArtifacts } from "../../../apps/backend/src/db/schema";
import { createTestCaseFixture, type TestCaseFixture } from "../../../apps/backend/test/test-case-fixtures";
import { startWorker } from "../src/daemon/worker";
import { remoteContext, runRemote } from "../src/remote/commands";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Beta definition of done (handover §6), exercised over real HTTP: the backend app served on a port,
// the jl-e2e-runner daemon with Chromium, the fixture web app, a fake Jira and the mock model.
// The one item that needs a real network and model (a self-hosted runner against PCF UAT) is
// recorded evidence, see docs/e2e-test-cases/STATUS.md.

const FIXTURE_PASSWORD = "fixture-Pa55word!";
const JIRA_TOKEN = "jira-fake-Tok3n-0001";
const fixtures = join(import.meta.dir, "../test/fixtures");
const transcript = readFileSync(join(fixtures, "fixture-logout.transcript.md"), "utf8");

let app: FixtureApp;
let fx: TestCaseFixture;
let server: ReturnType<typeof Bun.serve>;
let jira: ReturnType<typeof Bun.serve>;
let origin: string;
let workDir: string;
let statePath: string;
let registrationToken: string;
let environmentId: string;
let caseId: string;
const modelFixture = join(mkdtempSync(join(tmpdir(), "jl-beta-model-")), "model.mock.json");

const hostEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH });

async function api<T>(path: string, token: string, body?: unknown, method?: string): Promise<{ status: number; body: T }> {
  const result = await fx.call<T>(path, { token, ...(body !== undefined ? { body } : {}), ...(method ? { method } : {}) });
  return result;
}

async function runWorkerOnce(): Promise<void> {
  await startWorker({ apiOrigin: origin, registrationToken, statePath, workDir, once: true, pollMs: 100, hostEnv: hostEnv(), log: () => undefined });
}

async function runDetail(runId: string): Promise<TestRunDetail> {
  return (await api<TestRunDetail>(`/test-runs/${runId}`, fx.qa.token)).body;
}

beforeAll(async () => {
  app = startFixtureApp({ email: "admin@example.test", password: FIXTURE_PASSWORD });
  // The runner fixture's turns plus one turn that writes a transcript for the Jira issue.
  const runnerTurns = JSON.parse(readFileSync(join(fixtures, "fixture-logout.mock.json"), "utf8")) as { turns: unknown[] };
  writeFileSync(
    modelFixture,
    JSON.stringify({
      ...runnerTurns,
      turns: [
        ...runnerTurns.turns,
        {
          repeat: true,
          match: { noTools: true, promptIncludes: ["Write one end-to-end test case for this Jira issue", "QA-77"] },
          content: [{ type: "text", text: "# Parent sees the invoice total\n\n[Open] /login\n[Login: ADMIN]\n[Act] open the invoices page\n\n## Checkpoint: Totals\n[Assert] the invoice list shows a total for March" }]
        }
      ]
    })
  );
  jira = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Basic ${Buffer.from(`qa@example.test:${JIRA_TOKEN}`).toString("base64")}`) return new Response("no", { status: 401 });
      if (url.pathname !== "/rest/api/3/search/jql") return new Response("not found", { status: 404 });
      return Response.json({ issues: [{ key: "QA-77", fields: { summary: "Parents see invoice totals", description: "Given a parent with invoices, the list shows the total per month.", labels: ["billing"] } }] });
    }
  });

  fx = await createTestCaseFixture({ env: { JITTLE_LAMP_DEV_AUTH_ENABLED: "false" } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fx.app.handle(request) });
  origin = `http://127.0.0.1:${server.port}`;
  workDir = mkdtempSync(join(tmpdir(), "jl-beta-work-"));
  statePath = join(mkdtempSync(join(tmpdir(), "jl-beta-state-")), "state.json");

  const admin = fx.admin.token;
  const environment = await api<{ id: string }>("/test-environments", admin, { name: "fixture", baseUrl: app.url, runnerPool: "cloud", agentInstructions: "Never delete records." });
  expect(environment.status).toBe(201);
  environmentId = environment.body.id;
  const credential = await api("/test-credentials", admin, { profile: "ADMIN", environmentId, fields: { username: "admin@example.test" }, secretFields: { password: FIXTURE_PASSWORD } });
  expect(credential.status).toBe(201);
  expect(JSON.stringify(credential.body)).not.toContain(FIXTURE_PASSWORD);
  const jiraCredential = await api("/test-credentials", admin, { profile: "JIRA", kind: "jira", fields: { base_url: `http://127.0.0.1:${jira.port}`, email: "qa@example.test" }, secretFields: { api_token: JIRA_TOKEN } });
  expect(jiraCredential.status).toBe(201);
  const model = await api("/test-model-settings", admin, { actModel: `mock:${modelFixture}`, judgeModel: `mock:${modelFixture}`, apiKey: "unused-fake-key-0000" }, "PUT");
  expect(model.status).toBe(200);
  const prices = await api("/model-prices", admin, [{ modelId: "mock:mock-act", inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 }], "PUT");
  expect(prices.status).toBe(200);

  const pools = await api<Array<{ id: string; kind: string }> | { items: Array<{ id: string; kind: string }> }>("/runner-pools", admin);
  const list = Array.isArray(pools.body) ? pools.body : pools.body.items;
  const cloud = list.find((pool) => pool.kind === "cloud");
  if (!cloud) throw new Error("no cloud pool");
  const token = await api<{ registrationToken: string }>(`/runner-pools/${cloud.id}/registration-token`, admin, {});
  registrationToken = token.body.registrationToken;
}, 120_000);

afterAll(() => {
  app?.stop();
  server?.stop(true);
  jira?.stop(true);
});

describe("beta definition of done (handover §6)", () => {
  test("a QA engineer creates and tags a case, runs it, re-runs it and the second run replays every act; dedupe attaches", async () => {
    const created = await api<TestCaseDetail>("/test-cases", fx.qa.token, { transcript, environmentId });
    expect(created.status).toBe(201);
    caseId = created.body.id;
    expect(created.body.tags).toEqual(["feature:login", "module:admin"]);
    const tagged = await api("/test-cases/bulk", fx.qa.token, { action: "tag", ids: [caseId], tags: ["team:qa-pcf"] });
    expect(tagged.status).toBe(200);

    // Two people ask for the same run: one run, two subscribers.
    const first = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.qa.token, { environmentId });
    const second = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.developer.token, { environmentId });
    expect(first.body.attached).toBe(false);
    expect(second.body).toMatchObject({ attached: true, runId: first.body.runId });

    await runWorkerOnce();
    const run1 = await runDetail(first.body.runId);
    expect(run1).toMatchObject({ status: "completed", outcome: "passed" });
    expect(run1.subscribers.length).toBeGreaterThanOrEqual(2);
    expect(run1.metrics.stepsAgent).toBe(4);
    expect(run1.evidenceId).not.toBeNull();

    // A third request within the dedupe window attaches to the finished run unless forced.
    const third = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.qa.token, { environmentId });
    expect(third.body).toMatchObject({ attached: true, runId: first.body.runId, status: "completed" });
    const forced = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.qa.token, { environmentId, force: true });
    expect(forced.body.attached).toBe(false);

    await runWorkerOnce();
    const run2 = await runDetail(forced.body.runId);
    expect(run2.outcome).toBe("passed");
    expect(run2.metrics.stepsReplayed).toBe(4);
    const acts = run2.steps.filter((step) => step.type === "act");
    expect(acts.every((step) => step.mode === "replayed" && step.usage.modelCalls === 0)).toBe(true);
  }, 240_000);

  test("each run shows model ids, tokens, cost and duration; the case shows ten-run averages", async () => {
    const runs = await api<{ items: Array<{ id: string; metrics: TestRunDetail["metrics"] }> }>(`/test-cases/${caseId}/runs`, fx.qa.token);
    const agentRun = runs.body.items.find((run) => run.metrics.stepsAgent === 4);
    expect(agentRun?.metrics).toMatchObject({ modelId: expect.stringContaining("mock"), stepsTotal: 10 });
    expect(agentRun?.metrics.inputTokens).toBeGreaterThan(0);
    expect(agentRun?.metrics.costUsd).toBeGreaterThan(0);
    expect(agentRun?.metrics.durationMs).toBeGreaterThan(0);
    const detail = await api<TestCaseDetail>(`/test-cases/${caseId}`, fx.qa.token);
    expect(detail.body.stats.runs).toBeGreaterThanOrEqual(2);
    expect(detail.body.stats.passRate).toBe(1);
    expect(detail.body.stats.avgDurationMs).toBeGreaterThan(0);
    expect(detail.body.stats.avgCostUsd).toBeGreaterThan(0);
    expect(detail.body.stats.cachedSteps).toBe(4);
  });

  test("duplicating a case with find/replace replays unchanged steps on its first run", async () => {
    const duplicated = await api<{ testCase: TestCaseDetail; inheritedScripts: number }>(`/test-cases/${caseId}/duplicate`, fx.qa.token, {
      replacements: [{ find: "Admin logout", replace: "Admin sign-out" }]
    });
    expect(duplicated.status).toBe(201);
    expect(duplicated.body.testCase.title).toBe("Admin sign-out returns a clean login form");
    expect(duplicated.body.inheritedScripts).toBe(4);
    const run = await api<CreateTestRunResponse>(`/test-cases/${duplicated.body.testCase.id}/runs`, fx.qa.token, { environmentId });
    await runWorkerOnce();
    const detail = await runDetail(run.body.runId);
    expect(detail.outcome).toBe("passed");
    expect(detail.metrics.stepsReplayed).toBe(4);
    expect(detail.metrics.stepsAgent).toBe(0);
  }, 180_000);

  test("importing a .feature file and a Jira JQL produces review items with lint and similarity; approving makes them runnable", async () => {
    const feature = [
      "Feature: Admin logout",
      "  Scenario: Admin logout returns a clean login form",
      "    Given I open /login",
      "    When I sign in as the fixture admin",
      "    And I open the account menu and choose Sign out",
      "    Then the sign in form with Email and Password fields is visible"
    ].join("\n");
    const gherkin = await api<ImportBatch>("/test-cases/import", fx.qa.token, { sourceKind: "gherkin", content: feature, fileName: "logout.feature", environmentId });
    expect(gherkin.status).toBe(201);
    const item = gherkin.body.items[0];
    expect(item?.transcript).toContain("[Assert]");
    expect(item?.lint.length).toBeGreaterThan(0);
    expect(item?.similar.some((similar) => similar.id === caseId)).toBe(true);

    const credentials = await api<Array<{ id: string; profile: string }> | { items: Array<{ id: string; profile: string }> }>("/test-credentials", fx.admin.token);
    const jiraId = (Array.isArray(credentials.body) ? credentials.body : credentials.body.items).find((credential) => credential.profile === "JIRA")?.id;
    const fromJira = await api<ImportBatch>("/test-cases/import", fx.qa.token, { sourceKind: "jira", jql: "project = QA", jiraCredentialId: jiraId, environmentId });
    expect(fromJira.status).toBe(201);
    expect(fromJira.body.items[0]).toMatchObject({ externalId: "QA-77", title: "Parent sees the invoice total" });
    expect(Array.isArray(fromJira.body.items[0]?.lint)).toBe(true);
    expect(Array.isArray(fromJira.body.items[0]?.similar)).toBe(true);

    const ids: string[] = [];
    for (const batch of [gherkin.body, fromJira.body]) {
      const committed = await api<ImportBatch>(`/test-cases/import/${batch.id}`, fx.qa.token, { commit: true }, "PATCH");
      expect(committed.status).toBe(200);
      for (const committedItem of committed.body.items) if (committedItem.resultTestCaseId) ids.push(committedItem.resultTestCaseId);
    }
    expect(ids).toHaveLength(2);
    for (const id of ids) expect((await api<TestCaseDetail>(`/test-cases/${id}`, fx.qa.token)).body.status).toBe("review");
    const approved = await api("/test-cases/bulk", fx.qa.token, { action: "approve", ids });
    expect(approved.status).toBe(200);
    for (const id of ids) {
      expect((await api<TestCaseDetail>(`/test-cases/${id}`, fx.qa.token)).body.status).toBe("active");
      const run = await api<CreateTestRunResponse>(`/test-cases/${id}/runs`, fx.qa.token, { environmentId });
      expect(run.status).toBe(201);
      await api(`/test-runs/${run.body.runId}/cancel`, fx.qa.token, {});
    }
  }, 120_000);

  test("an automation token runs a suite from CI through the CLI and gets JUnit output", async () => {
    const suite = await api<{ id: string }>("/test-suites", fx.qa.token, { name: "smoke", memberIds: [caseId] });
    expect(suite.status).toBe(201);
    const token = await fx.automationToken(fx.qa);
    const junit = join(workDir, "junit.xml");
    const context = remoteContext({ JL_API_ORIGIN: origin, JL_API_TOKEN: token }, () => undefined);
    const [result] = await Promise.all([
      runRemote(context, { suiteId: suite.body.id, environmentId, wait: true, junit, force: true, pollMs: 250, webOrigin: "https://web.example" }),
      runWorkerOnce()
    ]);
    expect(result.exitCode).toBe(0);
    const xml = readFileSync(junit, "utf8");
    expect(xml).toContain('tests="1" failures="0" errors="0" skipped="0"');
    expect(xml).toContain("Admin logout returns a clean login form");
    expect(xml).toContain("https://web.example/evidence/");
  }, 180_000);

  test("the requester gets an in-app notification for a finished run", async () => {
    const notifications = await api<{ items: Notification[]; unread: number }>("/notifications", fx.qa.token);
    expect(notifications.body.items.some((item) => item.kind === "run.finished")).toBe(true);
    expect(notifications.body.unread).toBeGreaterThan(0);
  });

  test("no secret value appears in any run artifact, stored evidence, database row or API response", async () => {
    const secrets = [FIXTURE_PASSWORD, JIRA_TOKEN];
    const leaks: string[] = [];
    const check = (label: string, text: string) => {
      for (const secret of secrets) if (text.includes(secret)) leaks.push(`${label} contains a secret`);
    };
    // Runner work dirs (run dirs are removed after finalisation; whatever is left must be clean).
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path];
      });
    for (const file of walk(workDir)) {
      const bytes = readFileSync(file);
      check(file, bytes.toString("utf8"));
      if (file.endsWith(".zip")) for (const [name, content] of Object.entries(unzipSync(new Uint8Array(bytes)))) check(`${file}:${name}`, new TextDecoder().decode(content));
    }
    // Stored evidence objects (archive, run report, video bytes).
    const artifacts = await fx.db.select().from(evidenceArtifacts);
    expect(artifacts.length).toBeGreaterThan(0);
    for (const artifact of artifacts) {
      const bytes = await fx.artifactStorage.getObject({ key: artifact.s3Key });
      check(`artifact ${artifact.kind}`, new TextDecoder().decode(bytes));
    }
    // Database file (secrets are encrypted at rest).
    check("database", readFileSync(fx.databaseUrl.replace(/^file:/, "")).toString("latin1"));
    // API responses a browser or MCP client can read.
    for (const path of ["/test-credentials", "/test-environments", `/test-cases/${caseId}`, `/test-cases/${caseId}/runs`, `/test-cases/${caseId}/scripts`, "/notifications"]) {
      check(path, JSON.stringify((await api(path, fx.admin.token)).body));
    }
    expect(leaks).toEqual([]);
    expect(artifacts.some((artifact) => artifact.kind === "attachment")).toBe(true);
  });
});
