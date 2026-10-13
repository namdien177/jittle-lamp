import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SqlRow } from "@jittle-lamp/shared";

import { resolveRunConfig } from "../src/config/resolve";
import { compileStep, generateProject, renderConfigFile, renderTestFile } from "../src/generate/project";
import { buildRunPlan, loadMacros } from "../src/plan";
import { buildRunReport, queryCacheDetail } from "../src/report/build";
import { buildChildEnv } from "../src/run";
import type { SqlClient } from "../src/runtime/pg-describe";
import { closeQueryConnections, createSqlCacheStore, loadSavedQueries, lookupData, readProfileConfig, runQuery, type GenerateSql, type QueryDeps, type SqlCacheStore, type SqlScript } from "../src/runtime/query";
import type { QueryStepLogEvent, StepLogEvent } from "../src/runtime/step-log";

// [Query] steps (roadmap 2026-10-13 §5): the three tiers against a scripted connection, the
// guard, redaction, bindings, and the password staying out of prompts, events and errors.

const PASSWORD = "fixture-Db-Passw0rd!";
const env = {
  JL_CRED_PCF_DB_HOST: "db.internal.test",
  JL_CRED_PCF_DB_PORT: "5433",
  JL_CRED_PCF_DB_DATABASE: "sv",
  JL_CRED_PCF_DB_USER: "readonly",
  JL_CRED_PCF_DB_PASSWORD: PASSWORD,
  JL_CRED_PCF_DB_SSL: "require",
  JL_CRED_PCF_DB_SCHEMA_ALLOWLIST: "public",
  JL_CACHE_MODE: "read-write"
};

type Call = { sql: string; params: readonly unknown[] };

// A connection that answers information_schema with one table and everything else from `answer`.
function fakeClient(answer: (call: Call) => SqlRow[] | Error): { client: SqlClient; calls: Call[]; ended: boolean[] } {
  const calls: Call[] = [];
  const ended: boolean[] = [];
  const client: SqlClient = {
    async query(sql, params = []) {
      if (sql.includes("information_schema.columns")) {
        return [
          { table_schema: "public", table_name: "students", column_name: "id", data_type: "uuid", is_nullable: "NO", ordinal_position: 1, table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "students", column_name: "name", data_type: "text", is_nullable: "NO", ordinal_position: 2, table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "students", column_name: "email", data_type: "text", is_nullable: "YES", ordinal_position: 3, table_type: "BASE TABLE" },
          { table_schema: "public", table_name: "students", column_name: "centre_id", data_type: "uuid", is_nullable: "YES", ordinal_position: 4, table_type: "BASE TABLE" }
        ];
      }
      if (sql.includes("PRIMARY KEY")) return [{ table_schema: "public", table_name: "students", column_name: "id" }];
      if (sql.includes("FOREIGN KEY")) return [{ table_schema: "public", table_name: "students", column_name: "centre_id", foreign_schema: "public", foreign_table: "centres", foreign_column: "id" }];
      calls.push({ sql, params });
      const result = answer({ sql, params });
      if (result instanceof Error) throw result;
      return result;
    },
    async end() {
      ended.push(true);
    }
  };
  return { client, calls, ended };
}

function memoryCache(initial: Record<string, SqlScript> = {}): SqlCacheStore & { scripts: Map<string, SqlScript>; invalidated: string[] } {
  const scripts = new Map(Object.entries(initial));
  const invalidated: string[] = [];
  return {
    readable: true,
    writable: true,
    scripts,
    invalidated,
    async read(stepId) {
      return scripts.get(stepId) ?? null;
    },
    async write(stepId, script) {
      scripts.set(stepId, script);
    },
    async invalidate(stepId, reason) {
      scripts.delete(stepId);
      invalidated.push(`${stepId}: ${reason}`);
    }
  };
}

function scriptedModel(answers: string[]): { generate: GenerateSql; prompts: Array<{ system: string; user: string }> } {
  const prompts: Array<{ system: string; user: string }> = [];
  return {
    prompts,
    generate: async (prompt) => {
      prompts.push(prompt);
      const text = answers.shift();
      if (text === undefined) throw new Error("no scripted answer left");
      return { text, usage: { inputTokens: 100, outputTokens: 20 }, modelId: "mock/sql" };
    }
  };
}

const student = { id: "stu-1", name: "Ann Lee", email: "ann@example.test", centre_id: "c-1" };

function deps(partial: Partial<QueryDeps> & { client: SqlClient }): QueryDeps & { events: QueryStepLogEvent[]; outputs: Array<{ name: string; value: unknown; redacted: unknown }> } {
  const events: QueryStepLogEvent[] = [];
  const outputs: Array<{ name: string; value: unknown; redacted: unknown }> = [];
  return {
    env,
    connect: () => partial.client,
    cache: memoryCache(),
    now: () => 1000,
    ...partial,
    log: (event) => events.push(event),
    onOutput: (name, value, redacted) => outputs.push({ name, value, redacted }),
    events,
    outputs
  };
}

describe("profile configuration", () => {
  test("reads the connection from JL_CRED_<PROFILE>_* and maps ssl", () => {
    expect(readProfileConfig(env, "PCF_DB")).toEqual({ profile: "PCF_DB", host: "db.internal.test", port: 5433, database: "sv", user: "readonly", password: PASSWORD, ssl: "require", schemaAllowlist: ["public"] });
    expect(readProfileConfig({ ...env, JL_CRED_PCF_DB_SSL: "false", JL_CRED_PCF_DB_PORT: undefined }, "PCF_DB")).toMatchObject({ ssl: false, port: 5432 });
    expect(() => readProfileConfig({ JL_CRED_X_HOST: "h" }, "X")).toThrow(/missing database, user, password/);
    try {
      readProfileConfig({}, "NOPE");
    } catch (error) {
      expect((error as { code: string; blocked: boolean }).code).toBe("MISSING_CREDENTIAL");
      expect((error as { blocked: boolean }).blocked).toBe(true);
    }
  });

  test("the postgres profile reaches the child as JL_CRED_* with the password redacted by env name", () => {
    const config = resolveRunConfig({ env: { ...env, JL_CREDENTIAL_PCF_DB_KIND: "postgres" } });
    expect(config.credentialKinds.get("PCF_DB")).toBe("postgres");
    expect(config.credentials.get("PCF_DB")?.get("schema_allowlist")).toMatchObject({ value: "public", secret: false });
    expect(config.credentials.get("PCF_DB")?.get("password")?.secret).toBe(true);
    // A database profile has no login identifier to resolve.
    expect(config.credentialErrors.has("PCF_DB")).toBe(false);
    const child = buildChildEnv({ config, plan: { baseUrl: null, params: {}, agentInstructions: null }, host: {}, extra: {} });
    expect(child.JL_CRED_PCF_DB_PASSWORD).toBe(PASSWORD);
    expect(child.JL_CRED_PCF_DB_SCHEMA_ALLOWLIST).toBe("public");
  });
});

describe("tier order", () => {
  // Connections live per profile per attempt; each test is its own attempt.
  beforeEach(() => closeQueryConnections());

  test("a cached script runs without the model and binds the first row and the rows", async () => {
    const { client, calls } = fakeClient(() => [student, { ...student, id: "stu-2" }]);
    const model = scriptedModel([]);
    const cache = memoryCache({ st_1: { sqlText: "select * from students where level = $1 LIMIT 50", params: ["level"], binding: "student" } });
    const d = deps({ client, cache, generate: model.generate });
    const result = await runQuery("st_1", { profile: "PCF_DB", instruction: "a {level} student", values: { level: "K1" }, binding: "student", name: null }, d);
    expect(result).toMatchObject({ tier: "cached", rowCount: 2, summary: "2 rows from PCF_DB (cached)" });
    expect(calls).toEqual([{ sql: "select * from students where level = $1 LIMIT 50", params: ["K1"] }]);
    expect(model.prompts).toHaveLength(0);
    expect(d.outputs.map((output) => output.name)).toEqual(["student", "student.rows"]);
    expect(d.outputs[0]?.value).toEqual(student);
    expect(d.outputs[0]?.redacted).toEqual({ ...student, email: "[redacted]" });
    expect((d.outputs[1]?.value as unknown[]).length).toBe(2);
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ type: "query", stepId: "st_1", profile: "PCF_DB", tier: "cached", rowCount: 2, usage: { modelCalls: 0 } });
    expect(d.events[0]?.sample[0]).toMatchObject({ email: "[redacted]", name: "Ann Lee" });
  });

  test("a cached script that returns no rows for a binding is a hand-off to the agent", async () => {
    let first = true;
    const { client } = fakeClient(() => {
      if (first) {
        first = false;
        return [];
      }
      return [student];
    });
    const model = scriptedModel([JSON.stringify({ sql: "select id, name from students where status = 'PENDING'", rationale: "pending students", params: [] })]);
    const cache = memoryCache({ st_1: { sqlText: "select * from students where id = 'gone' LIMIT 1", params: [], binding: "student" } });
    const d = deps({ client, cache, generate: model.generate });
    const result = await runQuery("st_1", { profile: "PCF_DB", instruction: "a pending student", values: {}, binding: "student", name: null }, d);
    expect(result.tier).toBe("agent");
    expect(cache.invalidated).toEqual(["st_1: replay returned no rows"]);
    expect(cache.scripts.get("st_1")).toEqual({ sqlText: "select id, name from students where status = 'PENDING' LIMIT 50", params: [], binding: "student" });
    expect(d.events.map((event) => event.tier)).toEqual(["cached", "agent"]);
  });

  test("a saved query by name runs with its params bound and never asks the model", async () => {
    const { client, calls } = fakeClient(() => [student]);
    const model = scriptedModel([]);
    const d = deps({ client, generate: model.generate, savedQueries: [{ profile: "PCF_DB", name: "k1-pending", sqlText: "select * from students where level = $1 and centre_id = $2", params: [{ name: "level" }, { name: "centre" }] }] });
    const result = await runQuery("st_2", { profile: "PCF_DB", instruction: "ignored", values: { level: "K1", centre: "c-1" }, binding: "student", name: "K1-Pending" }, d);
    expect(result).toMatchObject({ tier: "saved", rowCount: 1 });
    expect(calls[0]).toEqual({ sql: "select * from students where level = $1 and centre_id = $2 LIMIT 50", params: ["K1", "c-1"] });
    expect(model.prompts).toHaveLength(0);
    await expect(runQuery("st_3", { profile: "PCF_DB", instruction: "x", values: {}, binding: null, name: "missing" }, d)).rejects.toMatchObject({ code: "QUERY_REJECTED", blocked: true });
    const unsafe = deps({ client, savedQueries: [{ profile: "PCF_DB", name: "bad", sqlText: "delete from students", params: [] }] });
    await expect(runQuery("st_4", { profile: "PCF_DB", instruction: "x", values: {}, binding: null, name: "bad" }, unsafe)).rejects.toMatchObject({ code: "QUERY_REJECTED" });
  });

  test("the agent tier gets the schema, retries a rejected statement once, and caches what passed", async () => {
    const { client, calls } = fakeClient(() => [student]);
    const model = scriptedModel([
      JSON.stringify({ sql: "select * from students; drop table students", rationale: "oops", params: [] }),
      "```json\n" + JSON.stringify({ sql: "select id, name, email from students where name ilike $1", rationale: "by name", params: ["who"] }) + "\n```"
    ]);
    const cache = memoryCache();
    const d = deps({ client, cache, generate: model.generate });
    const result = await runQuery("st_5", { profile: "PCF_DB", instruction: "the student named {who}", values: { who: "Ann%" }, binding: "student", name: null, instructionKey: "sha256:abc" }, d);
    expect(result).toMatchObject({ tier: "agent", rowCount: 1, statement: "select id, name, email from students where name ilike $1 LIMIT 50" });
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]?.user).toContain("public.students: id uuid PK, name text, email text, centre_id uuid -> public.centres.id");
    expect(model.prompts[0]?.user).toContain('{who} = "Ann%"');
    expect(model.prompts[1]?.user).toContain("Semicolons are not allowed");
    expect(calls).toEqual([{ sql: "select id, name, email from students where name ilike $1 LIMIT 50", params: ["Ann%"] }]);
    expect(cache.scripts.get("st_5")).toEqual({ sqlText: "select id, name, email from students where name ilike $1 LIMIT 50", params: ["who"], binding: "student" });
    expect(d.events[0]).toMatchObject({ tier: "agent", usage: { modelCalls: 2, inputTokens: 200, outputTokens: 40, modelId: "mock/sql" } });
  });

  test("a second guard rejection blocks the step with QUERY_REJECTED", async () => {
    const { client } = fakeClient(() => [student]);
    const model = scriptedModel([JSON.stringify({ sql: "delete from students", params: [] }), JSON.stringify({ sql: "select * from auth.users", params: [] })]);
    const d = deps({ client, generate: model.generate });
    await expect(runQuery("st_6", { profile: "PCF_DB", instruction: "anything", values: {}, binding: null, name: null }, d)).rejects.toMatchObject({ code: "QUERY_REJECTED", blocked: true });
    expect(d.events).toHaveLength(0);
  });

  test("a statement that errors is rewritten once with the error, then blocked", async () => {
    const { client, calls } = fakeClient((call) => (call.sql.includes("nope") ? Object.assign(new Error('column "nope" does not exist'), { code: "42703" }) : [student]));
    const model = scriptedModel([JSON.stringify({ sql: "select nope from students", params: [] }), JSON.stringify({ sql: "select id from students", params: [] })]);
    const d = deps({ client, generate: model.generate });
    const result = await runQuery("st_7", { profile: "PCF_DB", instruction: "a student", values: {}, binding: "student", name: null }, d);
    expect(result.tier).toBe("agent");
    expect(calls).toHaveLength(2);
    expect(model.prompts[1]?.user).toContain('42703: column "nope" does not exist');
  });

  test("zero rows fail a check and a binding step without the agent being blamed", async () => {
    const { client } = fakeClient(() => []);
    const model = scriptedModel([JSON.stringify({ sql: "select id from students where id = 'x'", params: [] })]);
    const d = deps({ client, generate: model.generate });
    await expect(runQuery("st_8", { profile: "PCF_DB", instruction: "the application is approved", values: {}, binding: null, name: null }, d)).rejects.toMatchObject({ code: "QUERY_NO_ROWS", blocked: false });
    expect(d.events[0]).toMatchObject({ rowCount: 0, tier: "agent" });
    expect(d.outputs).toHaveLength(0);
  });

  test("a connection failure is DATABASE_UNREACHABLE, blocked", async () => {
    const { client } = fakeClient(() => Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }));
    const d = deps({ client, cache: memoryCache({ st_9: { sqlText: "select 1 from students", params: [], binding: null } }) });
    await expect(runQuery("st_9", { profile: "PCF_DB", instruction: "x", values: {}, binding: null, name: null }, d)).rejects.toMatchObject({ code: "DATABASE_UNREACHABLE", blocked: true });
    const auth = fakeClient(() => Object.assign(new Error("password authentication failed"), { code: "28P01" }));
    const d2 = deps({ client: auth.client, generate: scriptedModel([JSON.stringify({ sql: "select 1 from students", params: [] })]).generate });
    await expect(runQuery("st_10", { profile: "PCF_DB", instruction: "x", values: {}, binding: null, name: null }, d2)).rejects.toMatchObject({ code: "DATABASE_UNREACHABLE" });
  });

  test("a secret placeholder is never bound", async () => {
    const { client } = fakeClient(() => [student]);
    const model = scriptedModel([JSON.stringify({ sql: "select id from students where token = $1", params: ["PCF_DB__password"] })]);
    const d = deps({ client, generate: model.generate });
    await expect(runQuery("st_11", { profile: "PCF_DB", instruction: "student with token {PCF_DB__password}", values: { PCF_DB__password: null }, binding: null, name: null }, d)).rejects.toMatchObject({ code: "QUERY_REJECTED" });
    expect(model.prompts[0]?.user).not.toContain(PASSWORD);
    expect(model.prompts[0]?.user).toContain("No placeholder values.");
  });

  test("the password never reaches prompts, events, outputs or errors", async () => {
    const { client } = fakeClient(() => Object.assign(new Error("boom"), { code: "XX000" }));
    const model = scriptedModel([JSON.stringify({ sql: "select id from students", params: [] }), JSON.stringify({ sql: "select name from students", params: [] })]);
    const d = deps({ client, generate: model.generate });
    let message = "";
    try {
      await runQuery("st_12", { profile: "PCF_DB", instruction: "x", values: {}, binding: null, name: null }, d);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SQL failed twice");
    const everything = JSON.stringify({ prompts: model.prompts, events: d.events, outputs: d.outputs, message });
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("readonly");
  });

  test("lookup_data returns at most 20 redacted rows and reports errors as data", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...student, id: `stu-${index}` }));
    const { client, ended } = fakeClient(() => many);
    const model = scriptedModel([JSON.stringify({ sql: "select * from students", params: [] }), JSON.stringify({ sql: "drop table students", params: [] }), JSON.stringify({ sql: "drop table students", params: [] })]);
    const d = deps({ client, generate: model.generate });
    const result = await lookupData("PCF_DB", "all students", d);
    expect(result).toMatchObject({ sql: "select * from students LIMIT 50", rowCount: 30 });
    expect("rows" in result ? result.rows : []).toHaveLength(20);
    expect("rows" in result ? result.rows[0]?.email : null).toBe("[redacted]");
    expect(await lookupData("PCF_DB", "wipe", d)).toMatchObject({ error: expect.stringContaining("SQL rejected") });
    await closeQueryConnections();
    expect(ended).toEqual([true]);
  });
});

describe("local stores", () => {
  test("the file cache store writes, reads and invalidates per step and honours the cache mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-sql-cache-"));
    const store = createSqlCacheStore({ JL_SQL_CACHE_DIR: dir, JL_CACHE_MODE: "read-write" });
    await store.write("st_1", { sqlText: "select 1 from students LIMIT 50", params: [], binding: null }, { instructionKey: "sha256:x" });
    expect(await store.read("st_1")).toEqual({ sqlText: "select 1 from students LIMIT 50", params: [], binding: null });
    await store.invalidate("st_1", "test");
    expect(await store.read("st_1")).toBeNull();
    const readOnly = createSqlCacheStore({ JL_SQL_CACHE_DIR: dir, JL_CACHE_MODE: "read-only" });
    expect(readOnly).toMatchObject({ readable: true, writable: false });
    expect(createSqlCacheStore({ JL_SQL_CACHE_DIR: dir, JL_CACHE_MODE: "off" }).readable).toBe(false);
  });

  test("the backend cache store talks to /test-runs/:id/cache/sql/:stepId with the run token", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ status: "hit", script: { sqlText: "select 1 from students", params: [] } }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const store = createSqlCacheStore({ JL_CACHE_API_URL: "https://api.example.test", JL_RUN_ID: "run_1", JL_RUN_TOKEN: "tok", JL_CACHE_MODE: "read-write" }, fetchImpl);
    expect(await store.read("st_1")).toEqual({ sqlText: "select 1 from students", params: [], binding: null });
    await store.write("st_1", { sqlText: "select 2 from students", params: ["a"], binding: "x" }, { instructionKey: null });
    await store.invalidate("st_1", "no rows");
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.example.test/test-runs/run_1/cache/sql/st_1",
      "PUT https://api.example.test/test-runs/run_1/cache/sql/st_1",
      "DELETE https://api.example.test/test-runs/run_1/cache/sql/st_1"
    ]);
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ sqlText: "select 2 from students", params: ["a"], binding: "x", instructionKey: null });
  });

  test("saved queries load from JL_QUERIES_FILE", () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-queries-"));
    const path = join(dir, "queries.json");
    Bun.write(path, JSON.stringify([{ profile: "PCF_DB", name: "k1", sqlText: "select 1", params: [] }, { bad: true }]));
    expect(loadSavedQueries({ JL_QUERIES_FILE: path })).toEqual([]);
    Bun.write(path, JSON.stringify([{ profile: "PCF_DB", name: "k1", sqlText: "select 1", params: [] }]));
    expect(loadSavedQueries({ JL_QUERIES_FILE: path })).toEqual([{ profile: "PCF_DB", name: "k1", sqlText: "select 1", params: [] }]);
    expect(loadSavedQueries({})).toEqual([]);
  });
});

const transcript = [
  "# K1 student detail",
  "",
  "[Query: PCF_DB] a K1 student with a pending registration -> {student}",
  "[Open] /students/{student.id}",
  "[Assert] the page shows {student.name}",
  "[Query: PCF_DB, name=approved] the application of {student.id} is approved",
  ""
].join("\n");

describe("plan, project and report for [Query] steps", () => {
  const planEnv = { ...env, JL_CREDENTIAL_PCF_DB_KIND: "postgres", JL_ENV_NAME: "pcf-uat", JL_ENV_BASE_URL: "https://uat.example.test" };

  test("the plan defers {student.id} to run time and resolves the query profile", () => {
    const plan = buildRunPlan({ transcript, config: resolveRunConfig({ env: planEnv }), macros: loadMacros([]) });
    expect(plan.blockedReason).toBeNull();
    expect(plan.steps.map((step) => step.type)).toEqual(["query", "open", "assert", "query"]);
    expect(plan.steps[0]?.binding).toBe("student");
    expect(plan.steps[1]?.instruction).toBe("/students/{student.id}");
    const missing = buildRunPlan({ transcript, config: resolveRunConfig({ env: { JL_ENV_BASE_URL: "https://uat.example.test" } }), macros: loadMacros([]) });
    expect(missing.blockedReason).toBe("MISSING_CREDENTIAL");
    expect(missing.missing).toEqual(["credential('PCF_DB')"]);
  });

  test("query steps compile to jl.query with dotted bindings and the config registers lookup_data", () => {
    const config = resolveRunConfig({ env: planEnv });
    const plan = buildRunPlan({ transcript, config, macros: loadMacros([]) });
    const dir = mkdtempSync(join(tmpdir(), "jl-query-project-"));
    const project = generateProject({ dir, plan, config, cacheMode: "read-write", cacheStoreDir: join(dir, "cache"), headed: false, viewport: { width: 1440, height: 900 }, timeoutMs: 60_000 });
    expect(project.queryProfiles).toEqual(["PCF_DB"]);
    const [first, open, assert, named] = project.compiled;
    expect(first?.call).toBe("query");
    expect(open?.bindings).toEqual({ student_id: { kind: "extracted", name: "student.id" } });
    expect(open?.template).toBe("/students/{student_id}");
    expect(assert?.bindings).toEqual({ student_name: { kind: "extracted", name: "student.name" } });
    expect(named?.bindings).toEqual({ student_id: { kind: "extracted", name: "student.id" } });
    const testFile = renderTestFile(project.compiled, "/helpers.ts");
    expect(testFile).toContain('jl.query("');
    expect(testFile).toContain('"profile":"PCF_DB","instruction":"a K1 student with a pending registration","binding":"student","name":null');
    expect(testFile).toContain('"name":"approved"');
    expect(testFile).not.toContain(PASSWORD);
    const configFile = renderConfigFile({ targetName: "pcf-uat", appIdentity: "jl-env:pcf-uat", fallbackUrl: "https://uat.example.test", credentialProfiles: [], secretNames: [], cacheMode: "read-write", cacheStoreDir: "/c", headed: false, viewport: { width: 1, height: 1 }, timeoutMs: 1, queryProfiles: ["PCF_DB"] });
    expect(configFile).toContain('createLookupDataTool({ profiles: ["PCF_DB"] })');
    expect(configFile).toContain("tools } : {}) } },");
    expect(renderConfigFile({ targetName: "t", appIdentity: "a", fallbackUrl: "https://x", credentialProfiles: [], secretNames: [], cacheMode: "off", cacheStoreDir: "/c", headed: false, viewport: { width: 1, height: 1 }, timeoutMs: 1 })).not.toContain("lookup_data");
    // A plain compile of a dotted token whose root was never produced stays a variable.
    const plain = compileStep(plan.steps[1]!, plan, config, new Set());
    expect(plain.bindings).toEqual({ student_id: { kind: "var", name: "student.id" } });
  });

  test("the report marks query steps with mode query, the cache tier, the statement and the outputs", () => {
    const config = resolveRunConfig({ env: planEnv });
    const plan = buildRunPlan({ transcript, config, macros: loadMacros([]) });
    const [first, open] = plan.steps;
    const at = (ms: number) => new Date(Date.parse("2026-10-13T08:00:00.000Z") + ms).toISOString();
    const queryEvent: QueryStepLogEvent = {
      type: "query",
      at: at(500),
      stepId: first!.stepId,
      profile: "PCF_DB",
      tier: "agent",
      statement: "select id, name from students LIMIT 50",
      rowCount: 1,
      sample: [{ id: "stu-1", name: "Ann", email: "[redacted]" }],
      durationMs: 42,
      usage: { inputTokens: 300, outputTokens: 30, modelCalls: 1, modelId: "mock/sql" }
    };
    const stepLog: StepLogEvent[] = [
      { type: "attempt-started", at: at(0), videoStartedAt: at(0) },
      { type: "step-started", at: at(100), stepId: first!.stepId, parentStepId: null, ordinal: 1, kind: "query", label: first!.instruction },
      queryEvent,
      { type: "output", at: at(500), stepId: first!.stepId, name: "student", value: JSON.stringify({ id: "stu-1", name: "Ann", email: "[redacted]" }) },
      { type: "step-finished", at: at(600), stepId: first!.stepId, status: "passed", error: null, screenshot: null, observed: "1 row from PCF_DB (agent)" },
      { type: "step-started", at: at(700), stepId: open!.stepId, parentStepId: null, ordinal: 2, kind: "open", label: open!.instruction },
      { type: "step-finished", at: at(900), stepId: open!.stepId, status: "blocked", error: { code: "DATABASE_UNREACHABLE", message: "x" }, screenshot: null, observed: null }
    ];
    const report = buildRunReport({
      plan,
      runId: "run_1",
      testCaseId: null,
      transcriptVersion: null,
      environmentId: null,
      runner: { runner: "jl-e2e", runnerVersion: "1", engine: "e2e", engineVersion: "0.20.0", browser: "chromium", browserVersion: null, headless: true, viewport: { width: 1, height: 1 }, cacheMode: "read-write", host: "cli" },
      model: { act: "mock/sql", judge: "mock/sql", provider: "mock" },
      e2eReport: { run: { results: [{ attempts: [{ steps: [] }] }] } },
      aiTrace: null,
      stepLog,
      exitCode: 1,
      startedAt: at(0),
      finishedAt: at(1000),
      artifacts: []
    });
    const step = report.steps[0]!;
    expect(step).toMatchObject({ mode: "query", cacheReason: "no-entry", status: "passed", outputs: { student: expect.stringContaining("stu-1") } });
    expect(step.cacheDetail).toBe(queryCacheDetail(queryEvent));
    expect(step.cacheDetail).toContain("select id, name from students LIMIT 50\n-- 1 row · agent · PCF_DB · 42ms");
    expect(step.usage).toMatchObject({ modelCalls: 1, inputTokens: 300, outputTokens: 30, modelId: "mock/sql" });
    expect(report.steps[1]).toMatchObject({ status: "blocked" });
    expect(report.blockedReason).toBe("DATABASE_UNREACHABLE");
    const cached = { ...queryEvent, tier: "cached" as const };
    const replayed = buildRunReport({ plan, runId: null, testCaseId: null, transcriptVersion: null, environmentId: null, runner: report.runner, model: report.model, e2eReport: null, aiTrace: null, stepLog: [stepLog[0]!, stepLog[1]!, cached, stepLog[4]!], exitCode: 0, startedAt: at(0), finishedAt: at(1000), artifacts: [] });
    expect(replayed.steps[0]).toMatchObject({ mode: "query", cacheReason: "hit" });
  });
});
