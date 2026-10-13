import type { SqlRow } from "@jittle-lamp/shared";

// Schema context for agent-written SQL (roadmap 2026-10-13 §5.2 tier 2): the tables, columns,
// types, primary and foreign keys of the allow-listed schemas, read from information_schema the
// way the team's postgres MCP server describes tables. Cached per profile per attempt by the
// caller (runtime/query.ts); this module only reads and renders.

export type SqlClient = {
  // Runs one statement with positional `$n` parameters and returns its rows.
  query(sql: string, params?: readonly unknown[]): Promise<SqlRow[]>;
  end(): Promise<void>;
};

export type DescribedColumn = { name: string; type: string; nullable: boolean; primaryKey: boolean; references: string | null };
export type DescribedTable = { schema: string; name: string; kind: "table" | "view"; columns: DescribedColumn[] };
export type SchemaDescription = { schemas: string[]; tables: DescribedTable[] };

const columnsSql = `select c.table_schema as table_schema, c.table_name as table_name, c.column_name as column_name, c.data_type as data_type, c.is_nullable as is_nullable, c.ordinal_position as ordinal_position, t.table_type as table_type
from information_schema.columns c
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
where c.table_schema = any($1::text[]) and t.table_type in ('BASE TABLE', 'VIEW')
order by c.table_schema, c.table_name, c.ordinal_position`;

const primaryKeysSql = `select tc.table_schema as table_schema, tc.table_name as table_name, kcu.column_name as column_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = any($1::text[])`;

const foreignKeysSql = `select tc.table_schema as table_schema, tc.table_name as table_name, kcu.column_name as column_name, ccu.table_schema as foreign_schema, ccu.table_name as foreign_table, ccu.column_name as foreign_column
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.constraint_schema = tc.constraint_schema
join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.constraint_schema = tc.constraint_schema
where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = any($1::text[])`;

const text = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));

export async function describeSchemas(client: SqlClient, schemas: readonly string[]): Promise<SchemaDescription> {
  const allow = [...schemas];
  const [columns, primaryKeys, foreignKeys] = await Promise.all([client.query(columnsSql, [allow]), client.query(primaryKeysSql, [allow]), client.query(foreignKeysSql, [allow])]);
  const pk = new Set(primaryKeys.map((row) => `${text(row.table_schema)}.${text(row.table_name)}.${text(row.column_name)}`));
  const fk = new Map(
    foreignKeys.map((row) => [
      `${text(row.table_schema)}.${text(row.table_name)}.${text(row.column_name)}`,
      `${text(row.foreign_schema)}.${text(row.foreign_table)}.${text(row.foreign_column)}`
    ])
  );
  const tables = new Map<string, DescribedTable>();
  for (const row of columns) {
    const schema = text(row.table_schema);
    const name = text(row.table_name);
    const key = `${schema}.${name}`;
    const table = tables.get(key) ?? { schema, name, kind: text(row.table_type) === "VIEW" ? "view" : "table", columns: [] };
    const column = text(row.column_name);
    table.columns.push({
      name: column,
      type: text(row.data_type),
      nullable: text(row.is_nullable) === "YES",
      primaryKey: pk.has(`${key}.${column}`),
      references: fk.get(`${key}.${column}`) ?? null
    });
    tables.set(key, table);
  }
  return { schemas: allow, tables: [...tables.values()] };
}

function renderTable(table: DescribedTable, withTypes: boolean): string {
  const columns = table.columns.map((column) => {
    const parts = [column.name];
    if (withTypes) parts.push(column.type);
    if (column.primaryKey) parts.push("PK");
    if (column.references) parts.push(`-> ${column.references}`);
    return parts.join(" ");
  });
  return `${table.schema}.${table.name}${table.kind === "view" ? " (view)" : ""}: ${columns.join(", ")}`;
}

// One line per table, within a character budget: types go first when the schema is large, then
// the tail of the table list.
export function renderSchemaContext(description: SchemaDescription, maxChars = 40_000): string {
  if (description.tables.length === 0) return `No tables in schema(s) ${description.schemas.join(", ")}.`;
  const header = `Tables in schema(s) ${description.schemas.join(", ")} (unqualified names resolve in that order):`;
  const attempt = (withTypes: boolean) => [header, ...description.tables.map((table) => renderTable(table, withTypes))].join("\n");
  const full = attempt(true);
  if (full.length <= maxChars) return full;
  const compact = attempt(false);
  if (compact.length <= maxChars) return compact;
  const lines = [header];
  let used = header.length;
  let shown = 0;
  for (const table of description.tables) {
    const line = renderTable(table, false);
    if (used + line.length + 1 > maxChars - 64) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  lines.push(`… ${description.tables.length - shown} more tables not listed.`);
  return lines.join("\n");
}
