import { guardSql, parseSchemaAllowlist, type TestCredential, type TestQueryParam } from "@jittle-lamp/shared";

// Pure helpers of the Postgres credential form and the Queries page (roadmap 2026-10-13 §5.1,
// §5.2 tier 3). Free of React so tests/test-case-settings-ui.test.ts can cover them.

export const postgresSslOptions = [
  { value: "disable", label: "Off" },
  { value: "require", label: "Require" },
  { value: "verify-full", label: "Verify" },
  { value: "prefer", label: "Prefer" }
] as const;

export type PostgresSsl = (typeof postgresSslOptions)[number]["value"];

export type PostgresForm = {
  host: string;
  port: string;
  database: string;
  user: string;
  ssl: PostgresSsl;
  schemas: string[];
};

const sslValues = new Set<string>(postgresSslOptions.map((option) => option.value));

// Stored `ssl` values predate the select ("true"/"false" from the API); both map onto it.
function sslFromField(value: string | undefined): PostgresSsl {
  if (value === "true") return "require";
  if (value === "false" || value === undefined) return "disable";
  return sslValues.has(value) ? (value as PostgresSsl) : "disable";
}

export function postgresFormFromFields(fields: Readonly<Record<string, string>>): PostgresForm {
  return {
    host: fields.host ?? "",
    port: fields.port ?? "5432",
    database: fields.database ?? "",
    user: fields.user ?? "",
    ssl: sslFromField(fields.ssl),
    schemas: parseSchemaAllowlist(fields.schema_allowlist)
  };
}

export type PostgresFormErrors = Partial<Record<"host" | "port" | "database" | "user" | "schemas", string>>;

// The public fields of a `postgres` credential, or what stops them from being saved.
export function postgresFieldsFromForm(form: PostgresForm): { fields: Record<string, string>; errors: PostgresFormErrors } {
  const errors: PostgresFormErrors = {};
  const host = form.host.trim();
  const database = form.database.trim();
  const user = form.user.trim();
  const port = form.port.trim();
  if (host.length === 0) errors.host = "Required.";
  if (database.length === 0) errors.database = "Required.";
  if (user.length === 0) errors.user = "Required.";
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) errors.port = "1–65535.";
  if (form.schemas.length === 0) errors.schemas = "At least one schema.";
  return {
    fields: { host, port, database, user, ssl: form.ssl, schema_allowlist: form.schemas.join(",") },
    errors
  };
}

// Typed into the chip input: comma or space separated schema names; invalid ones are reported.
export function addSchemaChips(current: readonly string[], input: string): { schemas: string[]; rejected: string[] } {
  const candidates = input
    .split(/[,\s]+/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const rejected = candidates.filter((name) => !/^[a-z_][a-z0-9_]*$/.test(name));
  const accepted = candidates.filter((name) => !rejected.includes(name));
  return { schemas: [...new Set([...current, ...accepted])], rejected };
}

export function removeSchemaChip(current: readonly string[], name: string): string[] {
  return current.filter((schema) => schema !== name);
}

export function isPostgresCredential(credential: Pick<TestCredential, "kind">): boolean {
  return credential.kind === "postgres";
}

// --- Queries page -------------------------------------------------------------------------------

export type QueryForm = { credentialId: string; name: string; sqlText: string; paramsText: string };

export type QueryFormErrors = { credentialId?: string; name?: string; sql: string[]; params?: string };

export const queryNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/;

// "level, centre" → [{ name: "level" }, { name: "centre" }]; blank means no params.
export function parseQueryParams(text: string): { params: TestQueryParam[]; invalid: string[] } {
  const names = text
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const invalid = names.filter((name) => !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name));
  return { params: names.filter((name) => !invalid.includes(name)).map((name) => ({ name, kind: "text" as const })), invalid };
}

export function formatQueryParams(params: readonly TestQueryParam[]): string {
  return params.map((param) => param.name).join(", ");
}

// Everything the editor shows inline: the guard's findings against the chosen profile's allowlist
// and the `$n` placeholders matched against the declared params.
export function queryFormErrors(form: QueryForm, credential: Pick<TestCredential, "fields"> | null): QueryFormErrors {
  const errors: QueryFormErrors = { sql: [] };
  if (!credential) errors.credentialId = "Choose a profile.";
  if (!queryNamePattern.test(form.name.trim())) errors.name = "Letters, digits, _ or -, starting with a letter.";
  const { params, invalid } = parseQueryParams(form.paramsText);
  if (invalid.length > 0) errors.params = `Not a name: ${invalid.join(", ")}.`;
  const sql = form.sqlText.trim();
  if (sql.length === 0) {
    errors.sql.push("Write a SELECT.");
    return errors;
  }
  const guarded = guardSql(sql, { schemaAllowlist: credential ? parseSchemaAllowlist(credential.fields.schema_allowlist) : [] });
  if (!guarded.ok) errors.sql.push(...guarded.errors);
  const placeholders = new Set((sql.match(/\$(\d+)/g) ?? []).map((token) => Number(token.slice(1))));
  const highest = placeholders.size > 0 ? Math.max(...placeholders) : 0;
  if (highest !== params.length) errors.params = `The SQL uses ${highest} placeholder${highest === 1 ? "" : "s"}; ${params.length} param${params.length === 1 ? "" : "s"} declared.`;
  return errors;
}

export function queryFormValid(errors: QueryFormErrors): boolean {
  return !errors.credentialId && !errors.name && !errors.params && errors.sql.length === 0;
}
