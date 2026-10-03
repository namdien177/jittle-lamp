import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTranscript, type RunTranscriptResult } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test: [Use: TC-0100] runs the case in the sibling transcript inline, in the same
// browser, with an argument for its param. [Open] and [Screenshot] make no model call.

const linked = ["# Open a person page", "Key: TC-0100", "Params: who=Ada", "", "[Open] /people/{who}", "[Screenshot] person page"].join("\n");
const outer = ["# Uses another case", "Key: TC-0101", "", "[Use: TC-0100, who={person.firstName}] open the page first", "[Open] /after"].join("\n");

let app: FixtureApp;
let result: RunTranscriptResult;

beforeAll(async () => {
  app = startFixtureApp({ email: "admin@example.test", password: "unused" });
  const cwd = mkdtempSync(join(tmpdir(), "jl-e2e-use-"));
  writeFileSync(join(cwd, "open-person.transcript.md"), linked);
  writeFileSync(join(cwd, "uses-case.transcript.md"), outer);
  const mock = join(cwd, "no-turns.mock.json");
  writeFileSync(mock, JSON.stringify({ schemaVersion: 1, turns: [] }));
  result = await runTranscript({
    transcript: outer,
    transcriptPath: "uses-case.transcript.md",
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      JL_ENV_NAME: "fixture",
      JL_ENV_BASE_URL: app.url,
      JL_MODEL: `mock:${mock}`
    }
  });
}, 240_000);

afterAll(() => app?.stop());

describe("[Use: KEY] in a real run", () => {
  test("the linked case's steps run first, in the same browser, with the argument filled in", () => {
    expect(result.report.outcome).toBe("passed");
    expect(result.plan.cases.map((linked) => linked.key)).toEqual(["TC-0100"]);
    const firstName = result.plan.generated["person.firstName"];
    expect(firstName).toBeString();
    const pages = app.requests.map((line) => decodeURIComponent(line)).filter((line) => line.startsWith("GET /people/") || line === "GET /after");
    expect(pages).toEqual([`GET /people/${firstName}`, "GET /after"]);

    const use = result.report.steps.find((step) => step.type === "use");
    expect(use?.status).toBe("passed");
    const children = result.report.steps.filter((step) => step.parentStepId === use?.stepId);
    expect(children.map((step) => [step.type, step.status])).toEqual([
      ["open", "passed"],
      ["screenshot", "passed"]
    ]);
  });
});
