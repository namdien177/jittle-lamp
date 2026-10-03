import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq } from "drizzle-orm";

import type { CreateTestRunResponse, LiveState, StepScript, TestCaseDetail, TestRunDetail } from "@jittle-lamp/shared";

import { evidenceArtifacts, organizations } from "../../../apps/backend/src/db/schema";
import { ensureDefaultOrganizationRoles } from "../../../apps/backend/src/services/organization-permissions";
import { createTestCaseFixture, type Member, type TestCaseFixture } from "../../../apps/backend/test/test-case-fixtures";
import { startWorker } from "../src/daemon/worker";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Live view and take-over through the real backend (design.md §5.4, phase 2 unit 2.3): the backend
// app served on a port, the jl-e2e-runner daemon on the cloud pool with Chromium, the fixture web
// app and the mock model. A QA engineer queues the run; an admin watches it, takes over the
// browser while the logout act runs, sends input and releases; the run still passes, the input
// is tagged user:takeover in the stored evidence and the taken-over act is not cached.

const FIXTURE_PASSWORD = "fixture-Pa55word!";
// The logout act's first model turn takes this long, so the take-over reaches the runner before
// the act's first action and the agent pauses there. The person's input is harmless (a mouse move,
// a click on blank page area, Shift) so the mock model's scripted turns still match afterwards.
const ACT_DELAY_MS = 5_000;
const fixtures = join(import.meta.dir, "../test/fixtures");
const transcript = readFileSync(join(fixtures, "fixture-logout.transcript.md"), "utf8");

let app: FixtureApp;
let fx: TestCaseFixture;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let workDir: string;
let statePath: string;
let registrationToken: string;
let environmentId: string;
let outsider: Member;
const previousLivePollMs = process.env.JL_LIVE_POLL_MS;
const modelFixture = join(mkdtempSync(join(tmpdir(), "jl-live-model-")), "model.mock.json");

const hostEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH });

async function api<T>(path: string, token: string, body?: unknown, method?: string): Promise<{ status: number; body: T }> {
  return fx.call<T>(path, { token, ...(body !== undefined ? { body } : {}), ...(method ? { method } : {}) });
}

async function runWorkerOnce(): Promise<void> {
  await startWorker({ apiOrigin: origin, registrationToken, statePath, workDir, once: true, pollMs: 100, hostEnv: hostEnv(), log: () => undefined });
}

async function runDetail(runId: string): Promise<TestRunDetail> {
  return (await api<TestRunDetail>(`/test-runs/${runId}`, fx.qa.token)).body;
}

async function until<T>(label: string, probe: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const scriptStepIds = async (caseId: string) =>
  (await api<{ items: StepScript[] }>(`/test-cases/${caseId}/scripts`, fx.qa.token)).body.items.map((script) => script.stepId);

beforeAll(async () => {
  process.env.JL_LIVE_POLL_MS = "100";
  app = startFixtureApp({ email: "admin@example.test", password: FIXTURE_PASSWORD });
  const base = JSON.parse(readFileSync(join(fixtures, "fixture-logout.mock.json"), "utf8")) as { turns: Array<Record<string, unknown>> };
  const index = base.turns.findIndex((turn) => JSON.stringify(turn).includes("Account menu"));
  base.turns[index] = { ...base.turns[index], delayMs: ACT_DELAY_MS };
  writeFileSync(modelFixture, JSON.stringify(base));

  fx = await createTestCaseFixture({ env: { JITTLE_LAMP_DEV_AUTH_ENABLED: "false" } });
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => fx.app.handle(request) });
  origin = `http://127.0.0.1:${server.port}`;
  workDir = mkdtempSync(join(tmpdir(), "jl-live-work-"));
  statePath = join(mkdtempSync(join(tmpdir(), "jl-live-state-")), "state.json");

  const admin = fx.admin.token;
  const environment = await api<{ id: string }>("/test-environments", admin, { name: "fixture", baseUrl: app.url, runnerPool: "cloud" });
  expect(environment.status).toBe(201);
  environmentId = environment.body.id;
  const credential = await api("/test-credentials", admin, { profile: "ADMIN", environmentId, fields: { username: "admin@example.test" }, secretFields: { password: FIXTURE_PASSWORD } });
  expect(credential.status).toBe(201);
  const model = await api("/test-model-settings", admin, { actModel: `mock:${modelFixture}`, judgeModel: `mock:${modelFixture}`, apiKey: "unused-fake-key-0000" }, "PUT");
  expect(model.status).toBe(200);

  const pools = await api<Array<{ id: string; kind: string }> | { items: Array<{ id: string; kind: string }> }>("/runner-pools", admin);
  const cloud = (Array.isArray(pools.body) ? pools.body : pools.body.items).find((pool) => pool.kind === "cloud");
  if (!cloud) throw new Error("no cloud pool");
  registrationToken = (await api<{ registrationToken: string }>(`/runner-pools/${cloud.id}/registration-token`, admin, {})).body.registrationToken;

  // An admin of another organisation.
  const [elsewhere] = await fx.db.insert(organizations).values({ name: "Elsewhere", isPersonal: false }).returning({ id: organizations.id });
  if (!elsewhere) throw new Error("Expected organisation");
  await ensureDefaultOrganizationRoles(fx.db, elsewhere.id);
  outsider = await fx.member("admin", elsewhere.id);
}, 120_000);

afterAll(() => {
  if (previousLivePollMs === undefined) delete process.env.JL_LIVE_POLL_MS;
  else process.env.JL_LIVE_POLL_MS = previousLivePollMs;
  app?.stop();
  server?.stop(true);
});

describe("live view and take-over through the real backend (design.md §5.4)", () => {
  test("an admin watches a cloud run, takes over, sends input and releases; the run passes, input is tagged user:takeover and the act is not cached", async () => {
    const created = await api<TestCaseDetail>("/test-cases", fx.qa.token, { transcript, environmentId });
    expect(created.status).toBe(201);
    const caseId = created.body.id;
    const queued = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.qa.token, { environmentId });
    expect(queued.status).toBe(201);
    const runId = queued.body.runId;
    const logout = (await runDetail(runId)).steps.find((step) => step.type === "act" && step.label.includes("account menu"));
    if (!logout) throw new Error("no logout act step");

    const worker = runWorkerOnce();
    const viewer = fx.admin;

    // Watching: the runner reports live view, then frames arrive as JPEG.
    const watched = await until("live view to become available", async () => {
      const state = await api<LiveState>(`/test-runs/${runId}/live/watch`, viewer.token, {});
      expect(state.status).toBe(200);
      return state.body.available ? state.body : null;
    });
    expect(watched.takeoverBy).toBeNull();
    const frame = await until("a live frame", async () => {
      const response = await fetch(`${origin}/test-runs/${runId}/live/frame`, { headers: { authorization: `Bearer ${viewer.token}` } });
      if (response.status !== 200) return null;
      return { type: response.headers.get("content-type"), bytes: new Uint8Array(await response.arrayBuffer()) };
    });
    expect(frame.type).toBe("image/jpeg");
    expect([...frame.bytes.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(frame.bytes.byteLength).toBeGreaterThan(1000);

    // A developer may watch but not take over someone else's run.
    expect((await api(`/test-runs/${runId}/live/watch`, fx.developer.token, {})).status).toBe(200);
    expect((await api(`/test-runs/${runId}/live/takeover`, fx.developer.token, { action: "start" })).status).toBe(403);

    // Take over once the logout act has started (its first model turn is still pending).
    await until("the logout act to start", async () => (await runDetail(runId)).currentStepId === logout.stepId, 120_000);
    const actStartedAt = Date.now();
    const started = await api<LiveState>(`/test-runs/${runId}/live/takeover`, viewer.token, { action: "start" });
    expect(started.status).toBe(200);
    expect(started.body.takeoverBy).toBe(viewer.userId);

    // The runner pauses the agent before its next action and reports it.
    const paused = await until("the run to report paused", async () => {
      const detail = await runDetail(runId);
      return detail.status === "paused" && detail.live?.paused ? detail : null;
    }, 60_000);
    expect(paused.live?.takeoverBy).toBe(viewer.userId);
    // Held past the point where the model's turn has returned: the act does not move on.
    await Bun.sleep(Math.max(0, actStartedAt + ACT_DELAY_MS + 1_500 - Date.now()));
    const held = await runDetail(runId);
    expect(held.status).toBe("paused");
    expect(held.currentStepId).toBe(logout.stepId);
    expect(held.steps.find((step) => step.stepId === logout.stepId)?.status).toBe("running");

    // Another organisation cannot see, take over or drive the run.
    for (const [path, body] of [
      ["watch", {}],
      ["takeover", { action: "start" }],
      ["takeover", { action: "stop" }],
      ["input", { events: [{ kind: "move", x: 1, y: 1 }] }]
    ] as const) {
      expect([403, 404]).toContain((await api(`/test-runs/${runId}/live/${path}`, outsider.token, body)).status);
    }
    const outsiderFrame = await fetch(`${origin}/test-runs/${runId}/live/frame`, { headers: { authorization: `Bearer ${outsider.token}` } });
    expect([403, 404]).toContain(outsiderFrame.status);
    // Only the holder sends input, not even the requester.
    expect((await api(`/test-runs/${runId}/live/input`, fx.qa.token, { events: [{ kind: "move", x: 1, y: 1 }] })).status).toBe(403);

    // Harmless input: a move and a click on blank page area below the dashboard content, then Shift.
    const input = await api<{ accepted: number; lastSeq: number | null }>(`/test-runs/${runId}/live/input`, viewer.token, {
      events: [
        { kind: "move", x: 640, y: 600 },
        { kind: "click", x: 640, y: 600 },
        { kind: "press", key: "Shift" }
      ]
    });
    expect(input.status).toBe(200);
    expect(input.body).toEqual({ accepted: 3, lastSeq: 2 });
    // Several relay and replay cycles, so the input is replayed while the take-over is held.
    await Bun.sleep(1_500);
    expect((await runDetail(runId)).status).toBe("paused");
    // One more move sent right before the release: it still belongs to the take-over.
    expect((await api(`/test-runs/${runId}/live/input`, viewer.token, { events: [{ kind: "move", x: 600, y: 620 }] })).status).toBe(200);

    const released = await api<LiveState>(`/test-runs/${runId}/live/takeover`, viewer.token, { action: "stop" });
    expect(released.status).toBe(200);
    expect(released.body.takeoverBy).toBeNull();

    await worker;
    const run = await runDetail(runId);
    expect(run).toMatchObject({ status: "completed", outcome: "passed" });
    expect(run.live).toBeNull();
    expect(run.evidenceId).not.toBeNull();
    const act = run.steps.find((step) => step.stepId === logout.stepId);
    expect(act).toMatchObject({ status: "passed", mode: "agent" });

    // The stored evidence archive tags the person's input user:takeover on the logout act.
    const [archiveArtifact] = await fx.db
      .select()
      .from(evidenceArtifacts)
      .where(and(eq(evidenceArtifacts.evidenceId, run.evidenceId ?? ""), eq(evidenceArtifacts.kind, "network-log")));
    if (!archiveArtifact) throw new Error("no session archive stored for the run");
    const archive = JSON.parse(new TextDecoder().decode(await fx.artifactStorage.getObject({ key: archiveArtifact.s3Key }))) as {
      sections: { actions: Array<{ tags: string[]; payload: { kind: string; detail?: string } }> };
    };
    const takeover = archive.sections.actions.filter((action) => action.tags.includes("user:takeover"));
    expect(takeover.some((action) => action.payload.kind === "lifecycle" && action.payload.detail?.startsWith("Take-over started"))).toBe(true);
    expect(takeover.some((action) => action.payload.kind === "lifecycle" && action.payload.detail?.startsWith("Take-over ended"))).toBe(true);
    expect(takeover.filter((action) => action.payload.kind === "interaction")).toHaveLength(4);
    expect(takeover.every((action) => action.tags.includes(`step:${logout.stepId}`))).toBe(true);

    // The other acts were cached in the backend; the taken-over act was not.
    const cached = await scriptStepIds(caseId);
    expect(cached).toHaveLength(3);
    expect(cached).not.toContain(logout.stepId);

    // A forced re-run (nobody watching) still passes: three acts replay, the logout act runs the agent
    // again and is cached this time. The mock picks the first unused turn whose prompt matches, and
    // the logout act's prompt quotes the login steps, so the re-run's fixture keeps only the turns
    // the agent still needs (the logout act and the repeating judge turns).
    const turns = (JSON.parse(readFileSync(modelFixture, "utf8")) as { turns: Array<{ repeat?: boolean; match?: { promptIncludes?: string[] } }> }).turns;
    writeFileSync(
      modelFixture,
      JSON.stringify({
        ...JSON.parse(readFileSync(modelFixture, "utf8")),
        turns: turns.filter((turn) => turn.repeat === true || turn.match?.promptIncludes?.includes("open the account menu"))
      })
    );
    const forced = await api<CreateTestRunResponse>(`/test-cases/${caseId}/runs`, fx.qa.token, { environmentId, force: true });
    expect(forced.body.attached).toBe(false);
    await runWorkerOnce();
    const rerun = await runDetail(forced.body.runId);
    expect(rerun).toMatchObject({ status: "completed", outcome: "passed" });
    expect(rerun.metrics.stepsReplayed).toBe(3);
    expect(rerun.metrics.stepsAgent).toBe(1);
    expect(rerun.steps.find((step) => step.stepId === logout.stepId)?.mode).toBe("agent");
    const cachedAfter = await scriptStepIds(caseId);
    expect(cachedAfter).toHaveLength(4);
    expect(cachedAfter).toContain(logout.stepId);
  }, 300_000);
});
