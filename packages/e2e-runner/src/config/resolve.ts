import type { CacheMode } from "@jittle-lamp/shared";

import type { EnvFile } from "./env-files";

// One resolution chain for every name a transcript or generated test refers to (design.md §9.2,
// ADR 0002 decision 9): run params, then process environment (real env over `--env-file` over
// `.env.e2e` over `.env`), then the organisation's configuration fetched from the backend.

export type ConfigSource = "param" | "env" | `file:${string}` | `org:${string}`;

export type ResolvedValue = {
  value: string;
  source: ConfigSource;
  secret: boolean;
};

export type OrgRunConfig = {
  environment: {
    name: string;
    baseUrl: string;
    variables: Record<string, string>;
    agentInstructions?: string | null;
  };
  credentials: Array<{
    profile: string;
    fields: Record<string, string>;
    secretFields: Record<string, string>;
  }>;
  model?: { act: string | null; judge: string | null; apiKeys: Record<string, string> } | null;
};

export type ResolvedRunConfig = {
  environmentName: ResolvedValue | null;
  baseUrl: ResolvedValue | null;
  agentInstructions: string | null;
  vars: Map<string, ResolvedValue>;
  credentials: Map<string, Map<string, ResolvedValue>>;
  actModel: ResolvedValue | null;
  judgeModel: ResolvedValue | null;
  providerKeys: Map<string, ResolvedValue>;
  cacheMode: CacheMode;
  cacheDir: string | null;
  apiToken: ResolvedValue | null;
  apiOrigin: string | null;
};

const publicCredentialFields = new Set(["username", "user", "email", "login", "name", "tenant", "school", "role"]);
// Whole name segments only: OTP_CODE and API_KEY are secret, SCHOOL_CODE and SHIPPING are not
// (design.md §9.1). JL_SECRET_NAMES lists any other names to treat as secret.
const secretSegments = new Set(["PASSWORD", "PASSWD", "PASS", "PWD", "SECRET", "TOKEN", "OTP", "PIN", "KEY", "APIKEY", "PASSCODE"]);
let extraSecretNames = new Set<string>();
const providerKeyNames = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "XAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_COMPATIBLE_BASE_URL"
] as const;

export const defaultActModel = "anthropic/claude-opus-5-5";
export const defaultJudgeModel = "anthropic/claude-sonnet-5-5";

export function isSecretCredentialField(field: string): boolean {
  return !publicCredentialFields.has(field.toLowerCase());
}

export function isSecretVariable(name: string): boolean {
  if (extraSecretNames.has(name)) return true;
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .some((segment) => secretSegments.has(segment));
}

type Layer = { source: ConfigSource; values: Record<string, string | undefined> };

function envLayers(env: Readonly<Record<string, string | undefined>>, files: readonly EnvFile[]): Layer[] {
  // Real environment first, then the most specific file.
  return [{ source: "env", values: env }, ...[...files].reverse().map((file) => ({ source: `file:${file.path}` as const, values: file.values }))];
}

function lookup(layers: readonly Layer[], name: string): { value: string; source: ConfigSource } | null {
  for (const layer of layers) {
    const value = layer.values[name];
    if (value !== undefined && value !== "") return { value, source: layer.source };
  }
  return null;
}

export function parseCredentialEnvName(name: string): { profile: string; field: string } | null {
  const match = /^JL_CRED_([A-Z0-9_]+)_([A-Z0-9]+)$/.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return { profile: match[1], field: match[2].toLowerCase() };
}

export function resolveRunConfig(input: {
  params?: Readonly<Record<string, string>>;
  env: Readonly<Record<string, string | undefined>>;
  envFiles?: readonly EnvFile[];
  org?: OrgRunConfig | null;
}): ResolvedRunConfig {
  const layers = envLayers(input.env, input.envFiles ?? []);
  extraSecretNames = new Set((lookup(layers, "JL_SECRET_NAMES")?.value ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  const orgSource = (name: string): ConfigSource => `org:${name}`;
  const org = input.org ?? null;

  const vars = new Map<string, ResolvedValue>();
  const credentials = new Map<string, Map<string, ResolvedValue>>();
  const setCredential = (profile: string, field: string, value: ResolvedValue) => {
    const fields = credentials.get(profile) ?? new Map<string, ResolvedValue>();
    if (!fields.has(field)) fields.set(field, value);
    credentials.set(profile, fields);
  };

  // 1. Run params.
  for (const [name, value] of Object.entries(input.params ?? {})) {
    vars.set(name, { value, source: "param", secret: isSecretVariable(name) });
  }

  // 2. Process environment and env files.
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer.values)) {
      if (value === undefined || value === "") continue;
      if (name.startsWith("JL_VAR_")) {
        const key = name.slice("JL_VAR_".length);
        if (!vars.has(key)) vars.set(key, { value, source: layer.source, secret: isSecretVariable(key) });
        continue;
      }
      const credential = parseCredentialEnvName(name);
      if (credential) {
        setCredential(credential.profile, credential.field, {
          value,
          source: layer.source,
          secret: isSecretCredentialField(credential.field)
        });
      }
    }
  }

  // 4. Organisation configuration (3. is the desktop secret store, which hosts no runner).
  if (org) {
    for (const [name, value] of Object.entries(org.environment.variables)) {
      if (!vars.has(name)) vars.set(name, { value, source: orgSource(org.environment.name), secret: isSecretVariable(name) });
    }
    for (const credential of org.credentials) {
      for (const [field, value] of Object.entries(credential.fields)) {
        setCredential(credential.profile, field.toLowerCase(), { value, source: orgSource(org.environment.name), secret: false });
      }
      for (const [field, value] of Object.entries(credential.secretFields)) {
        setCredential(credential.profile, field.toLowerCase(), { value, source: orgSource(org.environment.name), secret: true });
      }
    }
  }

  const resolved = (name: string, fallback?: { value: string; source: ConfigSource } | null, secret = false): ResolvedValue | null => {
    const hit = lookup(layers, name) ?? fallback ?? null;
    return hit ? { ...hit, secret } : null;
  };

  const orgEnv = org ? { source: orgSource(org.environment.name) } : null;
  const providerKeys = new Map<string, ResolvedValue>();
  for (const name of providerKeyNames) {
    const orgKey = org?.model?.apiKeys[name];
    const value = resolved(name, orgKey && orgEnv ? { value: orgKey, source: orgEnv.source } : null, name !== "OPENAI_COMPATIBLE_BASE_URL");
    if (value) providerKeys.set(name, value);
  }

  const cacheModeValue = lookup(layers, "JL_CACHE_MODE")?.value ?? "read-write";
  if (!["read-write", "read-only", "off", "strict"].includes(cacheModeValue)) {
    throw new Error(`JL_CACHE_MODE must be read-write, read-only, off or strict; got "${cacheModeValue}".`);
  }

  const actModel = resolved(
    "JL_MODEL",
    org?.model?.act && orgEnv ? { value: org.model.act, source: orgEnv.source } : { value: defaultActModel, source: "env" }
  );

  return {
    environmentName: resolved("JL_ENV_NAME", org && orgEnv ? { value: org.environment.name, source: orgEnv.source } : null),
    baseUrl: resolved("JL_ENV_BASE_URL", org && orgEnv ? { value: org.environment.baseUrl, source: orgEnv.source } : null),
    agentInstructions: lookup(layers, "JL_AGENT_INSTRUCTIONS")?.value ?? org?.environment.agentInstructions ?? null,
    vars,
    credentials,
    actModel,
    // Without an explicit judge the act model judges too, as e2e does; the org default pairs both.
    judgeModel: resolved(
      "JL_JUDGE_MODEL",
      org?.model?.judge && orgEnv
        ? { value: org.model.judge, source: orgEnv.source }
        : actModel && actModel.value !== defaultActModel
          ? { value: actModel.value, source: actModel.source }
          : { value: defaultJudgeModel, source: "env" }
    ),
    providerKeys,
    cacheMode: cacheModeValue as CacheMode,
    cacheDir: lookup(layers, "JL_CACHE_DIR")?.value ?? null,
    apiToken: resolved("JL_API_TOKEN", null, true),
    apiOrigin: lookup(layers, "JL_API_ORIGIN")?.value ?? null
  };
}

// `[Login: PCF]` names a profile; a unique `PCF_…` profile in the environment satisfies it.
export function resolveCredentialProfile(
  config: Pick<ResolvedRunConfig, "credentials">,
  name: string
): { profile: string; aliased: boolean } | null {
  if (config.credentials.has(name)) return { profile: name, aliased: false };
  const prefix = `${name}_`;
  const matches = [...config.credentials.keys()].filter((profile) => profile.startsWith(prefix));
  return matches.length === 1 && matches[0] ? { profile: matches[0], aliased: true } : null;
}

// Every secret value the run knows about, longest first, for redaction.
export function collectSecretValues(config: ResolvedRunConfig): string[] {
  const values = new Set<string>();
  for (const value of config.vars.values()) if (value.secret) values.add(value.value);
  for (const fields of config.credentials.values()) for (const value of fields.values()) if (value.secret) values.add(value.value);
  for (const value of config.providerKeys.values()) if (value.secret) values.add(value.value);
  if (config.apiToken) values.add(config.apiToken.value);
  return [...values].filter((value) => value.length >= 3).sort((a, b) => b.length - a.length);
}

export function maskValue(value: ResolvedValue): string {
  if (!value.secret) return value.value;
  return value.value.length <= 4 ? "••••" : `••••${"•".repeat(Math.min(4, value.value.length - 4))}`;
}

export type ConfigTableRow = { name: string; value: string; source: ConfigSource };

// What `jl-e2e config` prints: every resolved name, secrets masked, with its source.
export function describeResolvedConfig(config: ResolvedRunConfig): ConfigTableRow[] {
  const rows: ConfigTableRow[] = [];
  const push = (name: string, value: ResolvedValue | null) => {
    if (value) rows.push({ name, value: maskValue(value), source: value.source });
  };
  push("env.name", config.environmentName);
  push("env.baseUrl", config.baseUrl);
  for (const [name, value] of [...config.vars].sort(([a], [b]) => a.localeCompare(b))) push(`vars.${name}`, value);
  for (const [profile, fields] of [...config.credentials].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [field, value] of fields) push(`credential('${profile}').${field}`, value);
  }
  push("model.act", config.actModel);
  push("model.judge", config.judgeModel);
  for (const [name, value] of config.providerKeys) push(name, value);
  push("JL_API_TOKEN", config.apiToken);
  rows.push({ name: "cache.mode", value: config.cacheMode, source: "env" });
  return rows;
}

export function formatConfigTable(rows: readonly ConfigTableRow[]): string {
  const width = (pick: (row: ConfigTableRow) => string, header: string) =>
    Math.max(header.length, ...rows.map((row) => pick(row).length));
  const nameWidth = width((row) => row.name, "name");
  const valueWidth = width((row) => row.value, "value");
  const line = (a: string, b: string, c: string) => `${a.padEnd(nameWidth)}  ${b.padEnd(valueWidth)}  ${c}`;
  return [line("name", "value", "source"), ...rows.map((row) => line(row.name, row.value, row.source))].join("\n");
}
