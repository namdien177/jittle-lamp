import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { apiRequestScriptSchema } from "@jittle-lamp/shared";

import type { ApiScriptFile } from "../src/api/store";
import { runTranscript, type RunTranscriptResult } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test (roadmap 2026-10-13 §2.3, §2.4): an API-only run of a form that creates a record
// and reads it back. Run 1 drives the browser with the mock model and records a two-request API
// script with a capture (the new record's id). Run 2 replays the script with `fetch` and reports
// the step `api-replayed`. Run 3 meets a backend that refuses the create: the status check fails,
// the step hands off to the UI and the script goes stale.

const fixtures = join(import.meta.dir, "../test/fixtures");
const transcript = ["# Create a record through the form", "Key: TC-0200", "", "[Open] /records", '[Act] type "Widget" into the Name field and press Create record', "[Assert] the page shows the created record"].join("\n");

let app: FixtureApp;
let cwd: string;
const runs: RunTranscriptResult[] = [];
// The script file as it stood after each run: run 3 re-records it, so it is read in between.
const files: Array<ApiScriptFile | null> = [];

const env = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
  JL_ENV_NAME: "fixture",
  JL_ENV_BASE_URL: app.url,
  JL_MODEL: `mock:${join(fixtures, "fixture-records.mock.json")}`
});

const run = () =>
  runTranscript({
    transcript,
    transcriptPath: "records.transcript.md",
    cwd,
    env: env(),
    executionMode: "api",
    apiOrigins: [app.url],
    apiPolicy: { allowedPaths: ["/api/**"], maxRequestsPerStep: 50, rateLimitPerSecond: 50 }
  });

beforeAll(async () => {
  app = startFixtureApp({ email: "admin@example.test", password: "unused" });
  cwd = mkdtempSync(join(tmpdir(), "jl-e2e-api-"));
  runs.push(await run());
  files.push(scriptFile());
  runs.push(await run());
  files.push(scriptFile());
  app.failCreates = true;
  runs.push(await run());
  files.push(scriptFile());
}, 360_000);

afterAll(() => app?.stop());

const actOf = (index: number) => runs[index]?.report.steps.find((step) => step.type === "act");
const scriptFile = (): ApiScriptFile | null => {
  const dir = join(cwd, ".e2e", "cache", "api");
  const name = existsSync(dir) ? readdirSync(dir)[0] : undefined;
  return name ? (JSON.parse(readFileSync(join(dir, name), "utf8")) as ApiScriptFile) : null;
};

describe("API replay against the fixture app", () => {
  test("run 1 drives the browser and records a two-request script with a capture", () => {
    const report = runs[0]?.report;
    expect(report?.outcome).toBe("passed");
    expect(report?.executionMode).toBe("api");
    expect(actOf(0)?.mode).toBe("agent");
    const file = files[0];
    if (!file) throw new Error("run 1 recorded no API script");
    expect(file.status).toBe("active");
    const script = apiRequestScriptSchema.parse(file.script);
    expect(script.stepId).toBe(actOf(0)?.stepId ?? "");
    expect(script.requests.map((request) => [request.method, request.pathTemplate, request.mutation])).toEqual([
      ["POST", "/api/records", true],
      ["GET", "/api/records/{{v1}}", false]
    ]);
    expect(script.requests[1]?.captures).toEqual([{ as: "v1", fromSeq: 1, path: "id" }]);
    expect(script.requests[0]?.bodyTemplate).toEqual({ name: "Widget" });
    expect(script.requests[0]?.expect).toEqual({ statusClass: "2xx", shape: { id: "string", name: "string", createdAt: "string" } });
    expect(script.reviewFlags).toEqual([]);
  });

  test("run 2 replays the script with fetch: api-replayed, one new record, no browser requests", () => {
    const report = runs[1]?.report;
    expect(report?.outcome).toBe("passed");
    const act = actOf(1);
    expect(act?.mode).toBe("api-replayed");
    expect(act?.usage.modelCalls).toBe(0);
    expect(act?.requests?.count).toBe(2);
    expect(act?.requests?.mutations).toBe(1);
    const items = act?.requests?.items ?? [];
    expect(items.map((item) => [item.method, item.status, item.mutation])).toEqual([
      ["POST", 201, true],
      ["GET", 200, false]
    ]);
    // The GET read the id the replayed POST created, not the one from run 1.
    const ids = [...app.records.keys()];
    expect(ids).toHaveLength(2);
    expect(items[1]?.path).toBe(`/api/records/${ids[1]}`);
    expect(report?.totals.stepsReplayed).toBe(1);
    expect(report?.totals.usage.modelCalls).toBe(0);
    // Only the browser's traffic is captured: the replayed requests left no new script behind.
    expect(files[1]?.recordedAt).toBe(runs[0]?.report.finishedAt ?? "");
    expect(files[1]?.status).toBe("active");
  });

  test("run 3 hands off when the create fails its status check, and the script goes stale", () => {
    const act = actOf(2);
    expect(act?.mode).toBe("api-handoff");
    expect(act?.cacheDetail).toContain("API replay stopped at request 1");
    expect(act?.requests?.items?.[0]).toMatchObject({ method: "POST", status: 500, error: expect.stringContaining("status 500") });
    expect(runs[2]?.report.totals.stepsHandoff).toBe(1);
    // The stale script was replaced by what the UI fallback recorded, as a UI hand-off re-records.
    expect(files[2]?.recordedAt).toBe(runs[2]?.report.finishedAt ?? "");
    expect(files[2]?.status).toBe("active");
    expect(files[2]?.script.requests.map((request) => request.recorded?.status)).toEqual([500]);
  });
});
