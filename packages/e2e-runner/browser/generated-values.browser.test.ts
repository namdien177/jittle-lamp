import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTranscript, type RunTranscriptResult } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test: generated values ({person.email}) reach the e2e process through JL_VAR_* and the
// real engine opens a URL built from them. [Open] and [Screenshot] make no model call, so the mock
// model has no turns.

const transcript = [
  "# Generated values reach the browser",
  "",
  "[Open] /people/{person.email}/{person.name}",
  "[Screenshot] person page"
].join("\n");

let app: FixtureApp;
let result: RunTranscriptResult;

beforeAll(async () => {
  app = startFixtureApp({ email: "admin@example.test", password: "unused" });
  const cwd = mkdtempSync(join(tmpdir(), "jl-e2e-generated-"));
  const mock = join(cwd, "no-turns.mock.json");
  writeFileSync(mock, JSON.stringify({ schemaVersion: 1, turns: [] }));
  result = await runTranscript({
    transcript,
    transcriptPath: "generated.transcript.md",
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      JL_ENV_NAME: "fixture",
      JL_ENV_BASE_URL: app.url,
      JL_DATA_LOCALE: "vi",
      JL_MODEL: `mock:${mock}`
    }
  });
}, 240_000);

afterAll(() => app?.stop());

describe("generated values in a real run", () => {
  test("the run opens the URL with this run's generated values and reports them", () => {
    expect(result.report.outcome).toBe("passed");
    const { generated } = result.plan;
    expect(Object.keys(generated).sort()).toEqual(["person.email", "person.name"]);
    expect(generated["person.email"]).toMatch(/@example\.com$/);
    const opened = app.requests.map((line) => decodeURIComponent(line)).find((line) => line.startsWith("GET /people/"));
    expect(opened).toBe(`GET /people/${generated["person.email"]}/${generated["person.name"]}`);
    expect(result.report.params).toMatchObject(generated);
  });
});
