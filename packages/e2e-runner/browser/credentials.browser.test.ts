import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OrgRunConfig } from "../src/config/resolve";
import { runExploration } from "../src/explore";
import { runTranscript } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test: a credential profile that stores `email` (no `username`), as the production
// ILHAM_ALL_ACCESS_ACCOUNT and PCF_ALL_ACCESS_ACCOUNT do, reaches the real e2e engine as the
// login identifier, both in a run and in an exploration's account list.

const EMAIL = "qa.admin@example.test";
const PASSWORD = "fixture-Pa55word!";
const fixtures = join(import.meta.dir, "../test/fixtures");
let app: FixtureApp;

const org = (baseUrl: string, model: string): OrgRunConfig => ({
  environment: { name: "fixture", baseUrl, variables: {} },
  credentials: [{ profile: "ILHAM_ALL_ACCESS_ACCOUNT", fields: { email: EMAIL }, secretFields: { password: PASSWORD } }],
  model: { act: model, judge: null, apiKeys: {} }
});

const hostEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH });

beforeAll(() => {
  app = startFixtureApp({ email: EMAIL, password: PASSWORD });
});

afterAll(() => app?.stop());

describe("email-only credential profiles in a real browser", () => {
  test("a run fills {cred:P.username} with the profile's email", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "jl-cred-run-"));
    const mock = join(cwd, "no-turns.mock.json");
    writeFileSync(mock, JSON.stringify({ schemaVersion: 1, turns: [] }));
    const transcript = "# Email identifier\n\n[Open] /people/{cred:ILHAM_ALL_ACCESS_ACCOUNT.username}\n[Screenshot] identifier";
    const result = await runTranscript({ transcript, transcriptPath: "cred.transcript.md", cwd, env: hostEnv(), org: org(app.url, `mock:${mock}`) });
    expect(result.report.outcome).toBe("passed");
    expect(app.requests.map((line) => decodeURIComponent(line))).toContain(`GET /people/${EMAIL}`);
    expect(JSON.stringify(result.report)).not.toContain(PASSWORD);
  }, 240_000);

  test("an exploration offers the account with its email as username", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "jl-cred-explore-"));
    // The planner's first turn only matches when its prompt lists the account with the email;
    // with an empty username the mock has no turn for the call and the exploration fails.
    const base = JSON.parse(readFileSync(join(fixtures, "explore.mock.json"), "utf8")) as { turns: Array<{ match?: { promptIncludes?: string[] } }> };
    base.turns[0] = { ...base.turns[0], match: { ...base.turns[0]?.match, promptIncludes: ["decision", EMAIL] } };
    const mock = join(cwd, "explore-account.mock.json");
    writeFileSync(mock, JSON.stringify(base));
    const result = await runExploration({
      explorationId: "cred1",
      goal: "Sign in as ILHAM_ALL_ACCESS_ACCOUNT and check the sign in form",
      maxSteps: 3,
      timeoutMs: 180_000,
      cwd,
      env: hostEnv(),
      org: org(app.url, `mock:${mock}`)
    });
    expect(result.error).toBeNull();
    expect(result.status).toBe("done");
    expect(result.explore?.steps[0]).toMatchObject({ title: "Check the sign in form", status: "passed" });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  }, 240_000);
  test("nickname role reaches the engine account inventory and a run without losing the original username", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "jl-cred-nickname-"));
    const nick = "qa-nickname";
    const input = org(app.url, "");
    input.credentials[0] = { profile: "ILHAM_ALL_ACCESS_ACCOUNT", fields: { username: "original-username", nickname: nick, email: EMAIL }, secretFields: { password: PASSWORD }, loginField: "nickname" };
    const base = JSON.parse(readFileSync(join(fixtures, "explore.mock.json"), "utf8"));
    base.turns[0].match.promptIncludes.push("- ILHAM_ALL_ACCESS_ACCOUNT (username: qa-nickname)");
    const mock = join(cwd, "nickname.mock.json");
    writeFileSync(mock, JSON.stringify(base));
    input.model!.act = `mock:${mock}`;
    const exploration = await runExploration({ explorationId: "nickname", goal: "Check the sign in form", maxSteps: 3, timeoutMs: 180_000, cwd, env: hostEnv(), org: input });
    expect(exploration.status).toBe("done");
    expect(exploration.error).toBeNull();
    const noTurns = join(cwd, "no-turns.mock.json");
    writeFileSync(noTurns, JSON.stringify({ schemaVersion: 1, turns: [] }));
    input.model!.act = `mock:${noTurns}`;
    const run = await runTranscript({ transcript: "# Chosen role\n[Open] /people/{cred:ILHAM_ALL_ACCESS_ACCOUNT}\n[Screenshot] chosen field", transcriptPath: "nickname.md", cwd: join(cwd,"run"), env: hostEnv(), org: input });
    expect(run.report.outcome).toBe("passed");
    expect(app.requests).toContain(`GET /people/${nick}`);
    expect(JSON.stringify(run.report)).not.toContain(PASSWORD);
  }, 240_000);

});
