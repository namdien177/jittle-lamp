import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";

import { writeEvidenceBundle } from "../src/evidence/upload";
import { runTranscript, type RunTranscriptResult } from "../src/run";
import { startFixtureApp, type FixtureApp } from "../test/fixtures/app/server";

// Browser test for [Query] steps (roadmap 2026-10-13 §5) against a real Postgres: the agent tier
// (mock model) writes the SQL on run 1 and the browser opens a URL built from the bound row; run 2
// replays the cached SQL script with no model call. Needs JL_TEST_PG_URL (a connection string with
// rights to create a schema); without it the suite reports why it skipped.

const pgUrl = process.env.JL_TEST_PG_URL;
const schema = `jl_q_${Date.now().toString(36)}`;
const PASSWORD_MARK = "<db-password>";

const transcript = [
  "# A K1 student opens her page",
  "",
  "[Query: TEST_DB] a {LEVEL} student -> {student}",
  "[Open] /people/{student.id}/{student.name}",
  "[Screenshot] student page"
].join("\n");

let app: FixtureApp;
let cwd: string;
let env: Record<string, string | undefined>;
let first: RunTranscriptResult;
let second: RunTranscriptResult;
let sql: ReturnType<typeof postgres> | null = null;

const connection = (url: string) => {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    database: parsed.pathname.replace(/^\//, "") || "postgres",
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password)
  };
};

beforeAll(async () => {
  if (!pgUrl) return;
  const db = connection(pgUrl);
  sql = postgres(pgUrl, { max: 1 });
  await sql.unsafe(`create schema ${schema}`);
  await sql.unsafe(`create table ${schema}.students (id text primary key, name text not null, email text, level text not null)`);
  await sql.unsafe(`insert into ${schema}.students (id, name, email, level) values ('stu-1', 'Ann Lee', 'ann@example.test', 'K1'), ('stu-2', 'Ben Tan', 'ben@example.test', 'K2')`);

  app = startFixtureApp({ email: "admin@example.test", password: "unused" });
  cwd = mkdtempSync(join(tmpdir(), "jl-e2e-query-"));
  const mock = join(cwd, "sql.mock.json");
  writeFileSync(
    mock,
    JSON.stringify({
      schemaVersion: 1,
      turns: [
        {
          match: { noTools: true, promptIncludes: ["Instruction: a {LEVEL} student"] },
          content: [{ type: "text", text: JSON.stringify({ sql: "select id, name, email from students where level = $1 order by id", rationale: "students of that level", params: ["LEVEL"] }) }],
          usage: { inputTokens: 900, outputTokens: 60 }
        }
      ]
    })
  );
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    JL_ENV_NAME: "fixture",
    JL_ENV_BASE_URL: app.url,
    JL_VAR_LEVEL: "K1",
    JL_CREDENTIAL_TEST_DB_KIND: "postgres",
    JL_CRED_TEST_DB_HOST: db.host,
    JL_CRED_TEST_DB_PORT: db.port,
    JL_CRED_TEST_DB_DATABASE: db.database,
    JL_CRED_TEST_DB_USER: db.user,
    JL_CRED_TEST_DB_PASSWORD: db.password,
    JL_CRED_TEST_DB_SSL: "false",
    JL_CRED_TEST_DB_SCHEMA_ALLOWLIST: schema,
    JL_MODEL: `mock:${mock}`
  };
  first = await runTranscript({ transcript, transcriptPath: "query.transcript.md", cwd, env, cacheMode: "read-write" });
  const noTurns = join(cwd, "no-turns.mock.json");
  writeFileSync(noTurns, JSON.stringify({ schemaVersion: 1, turns: [] }));
  second = await runTranscript({ transcript, transcriptPath: "query.transcript.md", cwd, env: { ...env, JL_MODEL: `mock:${noTurns}` }, cacheMode: "read-write" });
}, 300_000);

afterAll(async () => {
  app?.stop();
  if (!sql) return;
  await sql.unsafe(`drop schema ${schema} cascade`).catch(() => undefined);
  await sql.end({ timeout: 2 });
});

describe("[Query] steps against a real Postgres", () => {
  test.skipIf(!pgUrl)("run 1: the agent tier writes the SQL, binds the row and the browser opens the student's page", () => {
    expect(first.report.outcome).toBe("passed");
    const [query, open] = first.report.steps;
    expect(query).toMatchObject({ type: "query", mode: "query", cacheReason: "no-entry", status: "passed" });
    expect(query?.cacheDetail).toContain("select id, name, email from students where level = $1 order by id LIMIT 50");
    expect(query?.cacheDetail).toContain("1 row · agent · TEST_DB");
    expect(query?.observed).toBe("1 row from TEST_DB (agent)");
    expect(query?.usage.modelCalls).toBe(1);
    expect(JSON.parse(query?.outputs?.student ?? "{}")).toEqual({ id: "stu-1", name: "Ann Lee", email: "[redacted]" });
    expect(open?.status).toBe("passed");
    const opened = app.requests.map((line) => decodeURIComponent(line)).find((line) => line.startsWith("GET /people/"));
    expect(opened).toBe("GET /people/stu-1/Ann Lee");
    const stepLog = readFileSync(join(first.runDir, "steps.jsonl"), "utf8");
    expect(stepLog).toContain('"type":"query"');
    expect(stepLog).toContain('"email":"[redacted]"');
  });

  test.skipIf(!pgUrl)("the evidence archive carries an integration entry and nothing carries the password", () => {
    const password = env.JL_CRED_TEST_DB_PASSWORD ?? PASSWORD_MARK;
    const bundle = writeEvidenceBundle(first);
    const archive = JSON.parse(readFileSync(bundle.archivePath, "utf8")) as { schemaVersion: number; sections: { actions: Array<{ tags: string[]; payload: Record<string, unknown> }> } };
    expect(archive.schemaVersion).toBe(5);
    const entry = archive.sections.actions.find((action) => action.payload.kind === "integration");
    expect(entry?.payload).toMatchObject({ integration: "sql", profile: "TEST_DB", rowCount: 1, sample: [{ id: "stu-1", name: "Ann Lee", email: "[redacted]" }] });
    expect(entry?.tags).toContain(`step:${first.report.steps[0]?.stepId}`);
    for (const path of [first.reportPath, bundle.archivePath, join(first.runDir, "steps.jsonl"), join(first.runDir, "e2e-output.log")]) {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      // The fixture password is too short to redact only if the operator chose one; a real one is.
      if (password.length >= 6) expect(text, path).not.toContain(password);
    }
    expect(readFileSync(join(first.project?.configPath ?? "", ""), "utf8")).toContain("lookup_data");
  });

  test.skipIf(!pgUrl)("run 2: the cached SQL script replays without the model", () => {
    expect(second.report.outcome).toBe("passed");
    const query = second.report.steps[0];
    expect(query).toMatchObject({ type: "query", mode: "query", cacheReason: "hit", status: "passed" });
    expect(query?.usage.modelCalls).toBe(0);
    expect(query?.cacheDetail).toContain("1 row · cached · TEST_DB");
    expect(existsSync(join(cwd, ".e2e", "cache", "sql"))).toBe(true);
  });

  test.skipIf(Boolean(pgUrl))("skipped: set JL_TEST_PG_URL to a Postgres that allows CREATE SCHEMA to run this suite", () => {
    expect(pgUrl).toBeUndefined();
  });
});
