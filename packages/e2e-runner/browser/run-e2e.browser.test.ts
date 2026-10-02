import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { unzipSync } from "fflate";

import { getStepAnnotations, parseSessionArchiveJson, runReportSchema } from "@jittle-lamp/shared";

import { uploadRunEvidence, writeEvidenceBundle } from "../src/evidence/upload";
import { runTranscript, type RunTranscriptResult } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test: the fixture transcript runs twice through the real e2e engine and Chromium with
// the mock model. Run 1 is agent-driven, run 2 replays every Act with zero act model calls.

const FIXTURE_PASSWORD = "fixture-Pa55word!";
const fixtures = join(import.meta.dir, "../test/fixtures");
const transcript = readFileSync(join(fixtures, "fixture-logout.transcript.md"), "utf8");

let app: FixtureApp;
let cwd: string;
const runs: RunTranscriptResult[] = [];

const env = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  JL_ENV_NAME: "fixture",
  JL_ENV_BASE_URL: app.url,
  JL_CRED_ADMIN_USERNAME: "admin@example.test",
  JL_CRED_ADMIN_PASSWORD: FIXTURE_PASSWORD,
  JL_MODEL: `mock:${join(fixtures, "fixture-logout.mock.json")}`
});

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "node_modules" ? [] : allFiles(path)) : [path];
  });
}

beforeAll(async () => {
  app = startFixtureApp({ email: "admin@example.test", password: FIXTURE_PASSWORD });
  cwd = mkdtempSync(join(tmpdir(), "jl-e2e-run-"));
  for (let index = 0; index < 2; index += 1) {
    runs.push(await runTranscript({ transcript, transcriptPath: "fixture-logout.transcript.md", cwd, env: env() }));
  }
}, 240_000);

afterAll(() => app?.stop());

describe("jl-e2e run against the fixture app (mock model)", () => {
  test("run 1 is agent-driven and passes", () => {
    const report = runs[0]?.report;
    runReportSchema.parse(report);
    expect(report?.outcome).toBe("passed");
    expect(report?.totals.stepsAgent).toBe(4);
    expect(report?.totals.usage.modelCalls).toBe(9);
    expect(report?.totals.judgeUsage.modelCalls).toBe(3);
  });

  test("run 2 replays every Act step with zero act model calls", () => {
    const report = runs[1]?.report;
    expect(report?.outcome).toBe("passed");
    const acts = report?.steps.filter((step) => step.type === "act") ?? [];
    expect(acts).toHaveLength(4);
    expect(acts.every((step) => step.mode === "replayed" && step.usage.modelCalls === 0)).toBe(true);
    expect(report?.totals.stepsReplayed).toBe(4);
    expect(report?.totals.usage.modelCalls).toBe(0);
    expect(report?.steps.find((step) => step.type === "login")?.mode).toBe("replayed");
  });

  test("per-step usage, timing and video offsets are present", () => {
    const report = runs[0]?.report;
    const first = report?.steps.find((step) => step.type === "act");
    // Two calls: (1800 + 1900) uncached input, (400 + 1500) cached, (60 + 30) output, 20 reasoning.
    expect(first?.usage).toMatchObject({ modelCalls: 2, inputTokens: 3700, cachedInputTokens: 1900, outputTokens: 90, reasoningTokens: 20 });
    expect(first?.usage.modelId).toContain("mock-act");
    for (const step of report?.steps ?? []) {
      expect(step.durationMs).not.toBeNull();
      expect(step.videoOffsetMs).not.toBeNull();
    }
    expect(report?.steps.find((step) => step.type === "screenshot")?.screenshot).toContain(".png");
  });

  test("cached step scripts map to transcript steps and render Playwright", () => {
    const cacheDir = join(cwd, ".e2e", "cache");
    const files = readdirSync(cacheDir).map((name) => JSON.parse(readFileSync(join(cacheDir, name), "utf8")) as { stepId: string; renderedCode: string });
    const actIds = runs[0]?.report.steps.filter((step) => step.type === "act").map((step) => step.stepId).sort();
    expect(files.map((file) => file.stepId).sort()).toEqual(actIds ?? []);
    expect(files.map((file) => file.renderedCode).join("\n")).toContain("page.getByRole('button', { name: 'Sign in' }).click()");
  });

  test("evidence: archive v4 with step annotations, step-tagged entries and a valid upload ZIP", async () => {
    const run = runs[1];
    if (!run) throw new Error("missing run");
    const bundle = writeEvidenceBundle(run);
    const archive = parseSessionArchiveJson(readFileSync(bundle.archivePath));
    expect(archive.recorder.kind).toBe("e2e-runner");
    const steps = getStepAnnotations(archive);
    expect(steps).toHaveLength(run.report.steps.length);
    expect(archive.sections.network.some((entry) => entry.payload.url.endsWith("/api/login") && entry.tags?.some((tag) => tag.startsWith("step:")))).toBe(true);
    expect(archive.sections.console.map((entry) => entry.payload.message)).toEqual(expect.arrayContaining(["login ok", "signed out"]));
    expect(archive.sections.actions.filter((entry) => entry.payload.kind === "interaction" && entry.payload.type === "click").length).toBeGreaterThanOrEqual(3);

    let received: Uint8Array | null = null;
    const fakeFetch = (async (_url: URL, init: RequestInit) => {
      received = new Uint8Array(init.body as Buffer);
      return new Response(JSON.stringify({ evidence: { id: "ev_1", orgId: "org_1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const uploaded = await uploadRunEvidence(run, {
      env: { JL_API_TOKEN: "jl_api_fixture", JL_API_ORIGIN: "http://127.0.0.1:1", JL_WEB_ORIGIN: "http://127.0.0.1:2" },
      cwd,
      fetch: fakeFetch
    });
    expect(uploaded.url).toBe("http://127.0.0.1:2/evidence/ev_1");
    expect(Object.keys(unzipSync(received ?? new Uint8Array())).sort()).toEqual(["recording.webm", "session.archive.json"]);
  });

  test("no secret value in any run artifact (handover §6)", () => {
    const leaks: string[] = [];
    for (const file of allFiles(join(cwd, ".e2e"))) {
      const bytes = readFileSync(file);
      const texts = [bytes.toString("utf8")];
      if (file.endsWith(".zip")) {
        for (const [name, content] of Object.entries(unzipSync(new Uint8Array(bytes)))) texts.push(`${name}\n${new TextDecoder().decode(content)}`);
      }
      if (texts.some((text) => text.includes(FIXTURE_PASSWORD))) leaks.push(file);
    }
    expect(leaks).toEqual([]);
  });
});
