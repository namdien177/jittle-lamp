// Guardrails for SQL a [Query] step runs against a postgres profile (roadmap 2026-10-13 §5.2,
// §5.3). One module for the runner (before it runs agent-written or cached SQL) and the backend
// (before it saves a named query), so both refuse the same statements. The rules mirror the
// postgres MCP server conventions the team already uses: SELECT/WITH only, one statement, a row
// cap, and tables inside the profile's schema allowlist. The tokenizer is conservative: anything
// it cannot classify is a rejection, never a pass.

export const sqlRowCap = 50;
export const sqlResultBytesCap = 256 * 1024;
export const sqlStatementTimeoutMs = 10_000;
// How many rows the act model (or the lookup_data tool) may see.
export const sqlModelRowCap = 20;

export type SqlToken =
  | { kind: "word"; value: string; upper: string; quoted: boolean }
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "punct"; value: string }
  | { kind: "param"; value: string };

export type SqlGuardOptions = {
  // Schemas the profile may read. Unqualified table names resolve inside this list (the
  // connection's search_path is confined to it); qualified names must name one of them.
  schemaAllowlist: readonly string[];
  rowCap?: number;
};

export type SqlGuardResult =
  | { ok: true; sql: string; tables: string[]; limitAdded: boolean }
  | { ok: false; errors: string[] };

// Statements and clauses that change state, escape the row cap or read outside the database.
const forbiddenWords = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "DROP",
  "ALTER",
  "CREATE",
  "GRANT",
  "REVOKE",
  "COPY",
  "VACUUM",
  "ANALYZE",
  "ANALYSE",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "CALL",
  "DO",
  "LOCK",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "SET",
  "RESET",
  "SHOW",
  "REFRESH",
  "REINDEX",
  "CLUSTER",
  "COMMENT",
  "SECURITY",
  "INTO",
  "RETURNING",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "DECLARE",
  "FETCH",
  "MOVE",
  "CLOSE",
  "IMPORT",
  "LOAD",
  "DISCARD",
  "CHECKPOINT",
  "EXPLAIN"
]);

// Functions that read files, sleep, open connections or reach server settings.
const forbiddenFunctionPrefixes = ["pg_", "lo_", "dblink", "set_config", "current_setting", "query_to_xml", "database_to_xml", "schema_to_xml", "table_to_xml", "cursor_to_xml", "xpath", "txid_", "brin_", "gin_", "inet_", "pgp_", "postgres_fdw", "file_fdw", "adminpack"];

// Set-returning functions a FROM clause may use without naming a table.
const safeTableFunctions = new Set([
  "unnest",
  "generate_series",
  "generate_subscripts",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_to_recordset",
  "jsonb_object_keys",
  "json_array_elements",
  "json_array_elements_text",
  "json_each",
  "json_each_text",
  "json_to_recordset",
  "json_object_keys",
  "string_to_table",
  "regexp_split_to_table",
  "regexp_matches"
]);

// Words that end a FROM list: the next token is not a table any more.
const fromListTerminators = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "WINDOW",
  "FETCH",
  "FOR",
  "ON",
  "USING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "NATURAL",
  "LATERAL",
  "AS",
  "SELECT",
  "WITH",
  "RETURNING",
  "INTO"
]);

const identifierStart = /[A-Za-z_]/;
const identifierPart = /[A-Za-z0-9_$]/;

// Splits SQL into tokens, or returns the reason it could not (comments, dollar quotes, unbalanced
// quotes). Strings and quoted identifiers keep their text so nothing inside them is mistaken for a
// keyword.
export function tokenizeSql(sql: string): { tokens: SqlToken[] } | { error: string } {
  const tokens: SqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? "";
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") return { error: "Comments are not allowed." };
    if (char === "/" && sql[index + 1] === "*") return { error: "Comments are not allowed." };
    if (char === "$") {
      // $1 parameters are fine; $$ or $tag$ quoting hides statements from the parser.
      const param = /^\$(\d+)/.exec(sql.slice(index));
      if (!param) return { error: "Dollar-quoted strings are not allowed." };
      tokens.push({ kind: "param", value: param[0] });
      index += param[0].length;
      continue;
    }
    if (char === "'" || (char === "E" && sql[index + 1] === "'") || (char === "e" && sql[index + 1] === "'")) {
      if (char !== "'") {
        // E'...' escape strings can smuggle quotes; plain literals suffice for a lookup.
        return { error: "Escape string literals (E'...') are not allowed." };
      }
      let end = index + 1;
      let closed = false;
      while (end < sql.length) {
        if (sql[end] === "'" && sql[end + 1] === "'") {
          end += 2;
          continue;
        }
        if (sql[end] === "'") {
          closed = true;
          break;
        }
        end += 1;
      }
      if (!closed) return { error: "Unterminated string literal." };
      tokens.push({ kind: "string", value: sql.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let closed = false;
      while (end < sql.length) {
        if (sql[end] === '"' && sql[end + 1] === '"') {
          end += 2;
          continue;
        }
        if (sql[end] === '"') {
          closed = true;
          break;
        }
        end += 1;
      }
      if (!closed) return { error: "Unterminated quoted identifier." };
      const value = sql.slice(index + 1, end).replace(/""/g, '"');
      tokens.push({ kind: "word", value, upper: value.toUpperCase(), quoted: true });
      index = end + 1;
      continue;
    }
    if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(sql[index + 1] ?? ""))) {
      const match = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(sql.slice(index));
      const value = match?.[0] ?? char;
      tokens.push({ kind: "number", value });
      index += value.length;
      continue;
    }
    if (identifierStart.test(char)) {
      let end = index + 1;
      while (end < sql.length && identifierPart.test(sql[end] ?? "")) end += 1;
      const value = sql.slice(index, end);
      tokens.push({ kind: "word", value, upper: value.toUpperCase(), quoted: false });
      index = end;
      continue;
    }
    if (char === ";") return { error: "Semicolons are not allowed: one statement only." };
    if (char === "\\") return { error: "Backslash commands are not allowed." };
    // Operators and punctuation: one character at a time is enough for the checks below.
    tokens.push({ kind: "punct", value: char });
    index += 1;
  }
  return { tokens };
}

type TableRef = { schema: string | null; name: string };

// Reads `schema.table` or `table` at `index`; null when the tokens there are not a name.
function readQualifiedName(tokens: readonly SqlToken[], index: number): { ref: TableRef; next: number } | null {
  const first = tokens[index];
  if (!first || first.kind !== "word") return null;
  const second = tokens[index + 1];
  const third = tokens[index + 2];
  if (second?.kind === "punct" && second.value === "." && third?.kind === "word") {
    return { ref: { schema: first.value, name: third.value }, next: index + 3 };
  }
  return { ref: { schema: null, name: first.value }, next: index + 1 };
}

// Table names referenced after FROM and JOIN, with the CTE names that are not tables.
function collectTables(tokens: readonly SqlToken[]): { tables: TableRef[]; cteNames: Set<string>; errors: string[] } {
  const tables: TableRef[] = [];
  const errors: string[] = [];
  const cteNames = new Set<string>();

  // WITH name [(cols)] AS (...), name2 AS (...): every name before AS at depth 0 is a CTE.
  if (tokens[0]?.kind === "word" && tokens[0].upper === "WITH") {
    let index = 1;
    if (tokens[index]?.kind === "word" && (tokens[index] as Extract<SqlToken, { kind: "word" }>).upper === "RECURSIVE") index += 1;
    let depth = 0;
    let expectName = true;
    for (; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token) break;
      if (token.kind === "punct" && token.value === "(") depth += 1;
      else if (token.kind === "punct" && token.value === ")") depth -= 1;
      else if (depth === 0 && expectName && token.kind === "word") {
        cteNames.add(token.value.toLowerCase());
        expectName = false;
      } else if (depth === 0 && token.kind === "punct" && token.value === ",") expectName = true;
      else if (depth === 0 && token.kind === "word" && token.upper === "SELECT") break;
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.kind !== "word" || token.quoted) continue;
    if (token.upper !== "FROM" && token.upper !== "JOIN") continue;
    let cursor = index + 1;
    // FROM a, b c, schema.d AS e: names separated by commas until a terminator.
    while (cursor < tokens.length) {
      const next = tokens[cursor];
      if (!next) break;
      if (next.kind === "punct" && next.value === "(") {
        // A subquery: its own FROM is visited by the outer loop; skip to the matching paren.
        let depth = 0;
        while (cursor < tokens.length) {
          const inner = tokens[cursor];
          if (inner?.kind === "punct" && inner.value === "(") depth += 1;
          if (inner?.kind === "punct" && inner.value === ")") depth -= 1;
          cursor += 1;
          if (depth === 0) break;
        }
      } else if (next.kind === "word" && !next.quoted && next.upper === "LATERAL") {
        cursor += 1;
        continue;
      } else if (next.kind === "word") {
        const read = readQualifiedName(tokens, cursor);
        if (!read) break;
        const after = tokens[read.next];
        if (after?.kind === "punct" && after.value === "(") {
          // A table-valued function: only the safe set-returning ones.
          if (read.ref.schema !== null || !safeTableFunctions.has(read.ref.name.toLowerCase())) {
            errors.push(`Function "${read.ref.schema ? `${read.ref.schema}.` : ""}${read.ref.name}" is not allowed in FROM.`);
          }
          let depth = 0;
          cursor = read.next;
          while (cursor < tokens.length) {
            const inner = tokens[cursor];
            if (inner?.kind === "punct" && inner.value === "(") depth += 1;
            if (inner?.kind === "punct" && inner.value === ")") depth -= 1;
            cursor += 1;
            if (depth === 0) break;
          }
        } else {
          if (!(read.ref.schema === null && cteNames.has(read.ref.name.toLowerCase()))) tables.push(read.ref);
          cursor = read.next;
        }
      } else {
        break;
      }
      // Optional alias: [AS] name, then either a comma (another table) or the end of the list.
      let alias = tokens[cursor];
      if (alias?.kind === "word" && !alias.quoted && alias.upper === "AS") {
        cursor += 1;
        alias = tokens[cursor];
      }
      if (alias?.kind === "word" && !(alias.quoted === false && fromListTerminators.has(alias.upper))) cursor += 1;
      const separator = tokens[cursor];
      if (separator?.kind === "punct" && separator.value === ",") {
        cursor += 1;
        continue;
      }
      break;
    }
  }
  return { tables, cteNames, errors };
}

// Checks one statement and returns the SQL to run (with `LIMIT <cap>` added when it has none).
export function guardSql(sql: string, options: SqlGuardOptions): SqlGuardResult {
  const trimmed = sql.trim();
  const errors: string[] = [];
  if (trimmed.length === 0) return { ok: false, errors: ["Empty statement."] };
  const tokenized = tokenizeSql(trimmed);
  if ("error" in tokenized) return { ok: false, errors: [tokenized.error] };
  const { tokens } = tokenized;
  const first = tokens[0];
  if (!first || first.kind !== "word" || first.quoted || (first.upper !== "SELECT" && first.upper !== "WITH")) {
    errors.push("Only SELECT or WITH statements are allowed.");
  }

  let parenDepth = 0;
  let topLevelLimit: number | null = null;
  let hasTopLevelLimit = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === "punct") {
      if (token.value === "(") parenDepth += 1;
      if (token.value === ")") parenDepth -= 1;
      continue;
    }
    if (token.kind !== "word" || token.quoted) continue;
    if (forbiddenWords.has(token.upper)) {
      // `SET` inside a statement is only legal in UPDATE, and ANALYZE only as a statement, so the
      // word itself is enough to refuse (a column named like one must be quoted).
      errors.push(`"${token.value}" is not allowed in a query.`);
      continue;
    }
    if (token.upper === "FOR") {
      const next = tokens[index + 1];
      if (next?.kind === "word" && ["UPDATE", "SHARE", "NO", "KEY"].includes(next.upper)) errors.push("Row locks (FOR UPDATE/SHARE) are not allowed.");
    }
    const lower = token.value.toLowerCase();
    if (forbiddenFunctionPrefixes.some((prefix) => lower.startsWith(prefix))) {
      errors.push(`"${token.value}" is not allowed in a query.`);
      continue;
    }
    if (token.upper === "LIMIT" && parenDepth === 0) {
      hasTopLevelLimit = true;
      const next = tokens[index + 1];
      if (next?.kind === "number") topLevelLimit = Number(next.value);
      else if (next?.kind === "word" && next.upper === "ALL") errors.push("LIMIT ALL is not allowed.");
      else if (next?.kind !== "param") errors.push("LIMIT must be a number.");
    }
  }
  if (parenDepth !== 0) errors.push("Unbalanced parentheses.");

  const rowCap = options.rowCap ?? sqlRowCap;
  if (topLevelLimit !== null && topLevelLimit > rowCap) errors.push(`LIMIT must be ${rowCap} or less.`);

  const allowlist = options.schemaAllowlist.map((schema) => schema.trim().toLowerCase()).filter((schema) => schema.length > 0);
  if (allowlist.length === 0) errors.push("The profile has no schema allowlist; nothing may be read.");
  const collected = collectTables(tokens);
  errors.push(...collected.errors);
  const tables: string[] = [];
  for (const ref of collected.tables) {
    if (ref.schema !== null && !allowlist.includes(ref.schema.toLowerCase())) {
      errors.push(`Schema "${ref.schema}" is not in the profile's allowlist.`);
      continue;
    }
    tables.push(ref.schema ? `${ref.schema}.${ref.name}` : ref.name);
  }
  // `FROM information_schema.x` is caught above; a bare `information_schema` schema-less call
  // cannot happen, but the catalog's unqualified views can when search_path includes pg_catalog.
  for (const ref of collected.tables) {
    if (ref.schema === null && /^pg_/i.test(ref.name)) errors.push(`"${ref.name}" is not allowed in a query.`);
  }
  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)] };
  const limited = hasTopLevelLimit ? trimmed : `${trimmed} LIMIT ${rowCap}`;
  return { ok: true, sql: limited, tables: [...new Set(tables)], limitAdded: !hasTopLevelLimit };
}

// Column names whose values never reach the model or the evidence (roadmap §5.2).
export const redactedColumnPattern = /email|phone|password|passwd|token|secret|nric|ic_number|mobile/i;

export function isRedactedColumn(name: string): boolean {
  return redactedColumnPattern.test(name);
}

export type SqlRow = Record<string, unknown>;

// Replaces the values of sensitive columns; nulls stay null so "no value" is still visible.
export function redactRow(row: SqlRow): SqlRow {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, value !== null && value !== undefined && isRedactedColumn(column) ? "[redacted]" : value]));
}

export function redactRows(rows: readonly SqlRow[]): SqlRow[] {
  return rows.map(redactRow);
}

// Keeps the result under the byte cap by dropping rows from the end.
export function capRows(rows: readonly SqlRow[], maxBytes = sqlResultBytesCap): { rows: SqlRow[]; truncated: boolean } {
  const kept: SqlRow[] = [];
  let bytes = 2;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (bytes + size > maxBytes) return { rows: kept, truncated: true };
    bytes += size;
    kept.push(row);
  }
  return { rows: kept, truncated: false };
}

// Schema allowlists are stored as one comma-separated public credential field.
export function parseSchemaAllowlist(value: string | undefined | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(/[,\s]+/).map((schema) => schema.trim().toLowerCase()).filter((schema) => /^[a-z_][a-z0-9_]*$/.test(schema)))];
}
