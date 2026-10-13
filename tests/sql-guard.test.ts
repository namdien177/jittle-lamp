import { describe, expect, test } from "bun:test";

import { capRows, guardSql, parseSchemaAllowlist, redactRow, redactRows, tokenizeSql } from "@jittle-lamp/shared";

// The one SQL guard the runner (before it runs agent-written or cached SQL) and the backend
// (before it saves a named query) share (roadmap 2026-10-13 §5.2, §5.3).

const allow = { schemaAllowlist: ["public", "reporting"] };

describe("sql guard", () => {
  test("accepts SELECT and WITH statements and adds LIMIT 50 when absent", () => {
    const select = guardSql("select id, name from students where level = 'K1'", allow);
    expect(select).toMatchObject({ ok: true, sql: "select id, name from students where level = 'K1' LIMIT 50", tables: ["students"], limitAdded: true });
    const withCte = guardSql(
      "WITH pending AS (SELECT child_id FROM public.registrations WHERE status = 'PENDING') SELECT s.id FROM students s JOIN pending p ON p.child_id = s.id LIMIT 5",
      allow
    );
    expect(withCte).toMatchObject({ ok: true, limitAdded: false, tables: ["public.registrations", "students"] });
  });

  test("keeps an existing LIMIT and refuses one above the cap", () => {
    expect(guardSql("select 1 from students limit 50", allow)).toMatchObject({ ok: true, limitAdded: false });
    expect(guardSql("select 1 from students limit 500", allow)).toMatchObject({ ok: false, errors: ["LIMIT must be 50 or less."] });
    expect(guardSql("select 1 from students limit all", allow).ok).toBe(false);
    // A LIMIT inside a subquery is not the statement's cap: the outer one still applies.
    expect(guardSql("select * from (select id from students limit 1000) s", allow)).toMatchObject({ ok: true, limitAdded: true, sql: "select * from (select id from students limit 1000) s LIMIT 50" });
  });

  test("rejects multi-statement input, comments and dollar quotes", () => {
    expect(guardSql("select 1 from students; drop table students", allow)).toMatchObject({ ok: false, errors: ["Semicolons are not allowed: one statement only."] });
    expect(guardSql("select 1 from students;", allow).ok).toBe(false);
    expect(guardSql("select 1 from students -- hide", allow)).toMatchObject({ ok: false, errors: ["Comments are not allowed."] });
    expect(guardSql("select /* x */ 1 from students", allow).ok).toBe(false);
    expect(guardSql("select $$drop table x$$ from students", allow)).toMatchObject({ ok: false, errors: ["Dollar-quoted strings are not allowed."] });
    expect(guardSql("select 'unterminated from students", allow)).toMatchObject({ ok: false, errors: ["Unterminated string literal."] });
    expect(guardSql("", allow)).toMatchObject({ ok: false, errors: ["Empty statement."] });
  });

  test("rejects DML, DDL, COPY, locks and SELECT INTO", () => {
    for (const sql of [
      "insert into students values (1)",
      "update students set name = 'x'",
      "delete from students",
      "truncate students",
      "drop table students",
      "create table t (id int)",
      "copy students to '/tmp/x'",
      "select * from students for update",
      "select * into t2 from students",
      "explain select 1 from students",
      "set role admin",
      "with x as (delete from students returning id) select * from x"
    ]) {
      const result = guardSql(sql, allow);
      expect(result.ok, sql).toBe(false);
    }
    // Keywords inside string literals are data, not statements.
    expect(guardSql("select id from students where note = 'delete me later'", allow).ok).toBe(true);
    expect(guardSql('select "update" from students', allow).ok).toBe(true);
  });

  test("rejects pg_ functions and catalog tables wherever they appear", () => {
    expect(guardSql("select pg_sleep(10) from students", allow)).toMatchObject({ ok: false, errors: ['"pg_sleep" is not allowed in a query.'] });
    expect(guardSql("select * from pg_catalog.pg_tables", allow).ok).toBe(false);
    expect(guardSql("select * from pg_tables", allow).ok).toBe(false);
    expect(guardSql("select current_setting('data_directory') from students", allow).ok).toBe(false);
    expect(guardSql("select lo_import('/etc/passwd') from students", allow).ok).toBe(false);
    expect(guardSql("select * from dblink('host=x', 'select 1') as t(a int)", allow).ok).toBe(false);
  });

  test("rejects tables outside the schema allowlist and functions in FROM other than the safe set", () => {
    expect(guardSql("select * from auth.users", allow)).toMatchObject({ ok: false, errors: ['Schema "auth" is not in the profile\'s allowlist.'] });
    expect(guardSql("select * from information_schema.tables", allow).ok).toBe(false);
    expect(guardSql("select s.id from students s join auth.users u on u.id = s.user_id", allow).ok).toBe(false);
    expect(guardSql("select * from reporting.daily_counts", allow)).toMatchObject({ ok: true, tables: ["reporting.daily_counts"] });
    expect(guardSql("select x from unnest(array[1,2]) as x", allow).ok).toBe(true);
    expect(guardSql("select * from generate_series(1, 3) g", allow).ok).toBe(true);
    expect(guardSql("select * from my_function(1)", allow)).toMatchObject({ ok: false, errors: ['Function "my_function" is not allowed in FROM.'] });
    expect(guardSql("select 1 from students", { schemaAllowlist: [] })).toMatchObject({ ok: false, errors: ["The profile has no schema allowlist; nothing may be read."] });
  });

  test("reads comma-separated FROM lists, aliases and subqueries", () => {
    const result = guardSql("select a.id from students a, public.classes as b, (select 1 from reporting.x) c where a.class_id = b.id", allow);
    expect(result).toMatchObject({ ok: true, tables: ["students", "public.classes", "reporting.x"] });
    expect(guardSql("select 1 from students where id = $1 and name = $2", allow).ok).toBe(true);
    expect(tokenizeSql("select 'it''s' from t")).toMatchObject({ tokens: [{ kind: "word", upper: "SELECT" }, { kind: "string", value: "it''s" }, { kind: "word", upper: "FROM" }, { kind: "word", value: "t" }] });
  });
});

describe("row redaction", () => {
  test("redacts by column name and keeps nulls and other columns", () => {
    expect(redactRow({ id: 7, email: "a@b.test", parent_phone: "+65", password_hash: "x", api_token: "t", nric: "S1", ic_number: "1", mobile_no: "9", name: "Ann", note: null, email_verified: null })).toEqual({
      id: 7,
      email: "[redacted]",
      parent_phone: "[redacted]",
      password_hash: "[redacted]",
      api_token: "[redacted]",
      nric: "[redacted]",
      ic_number: "[redacted]",
      mobile_no: "[redacted]",
      name: "Ann",
      note: null,
      email_verified: null
    });
    expect(redactRows([{ Email: "x" }])).toEqual([{ Email: "[redacted]" }]);
  });

  test("caps the result size by dropping rows from the end", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: index, blob: "x".repeat(100) }));
    const capped = capRows(rows, 450);
    expect(capped.truncated).toBe(true);
    expect(capped.rows.length).toBeGreaterThan(0);
    expect(capped.rows.length).toBeLessThan(10);
    expect(capRows(rows)).toEqual({ rows, truncated: false });
  });

  test("parses the schema allowlist field", () => {
    expect(parseSchemaAllowlist("public, Reporting ,public")).toEqual(["public", "reporting"]);
    expect(parseSchemaAllowlist("bad-name public")).toEqual(["public"]);
    expect(parseSchemaAllowlist(undefined)).toEqual([]);
  });
});
