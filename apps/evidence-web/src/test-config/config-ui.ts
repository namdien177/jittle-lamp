// Pure helpers for Settings → Test cases (design.md §9.3, §10.4, §14). No React, no DOM.

// ---------------------------------------------------------------------------------------------
// Key/value tables (environment variables, credential public fields)
// ---------------------------------------------------------------------------------------------

export type KeyValueRow = { key: string; value: string };

export const environmentVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const credentialFieldPattern = /^[a-z][a-z0-9_]*$/;

export function recordToRows(record: Readonly<Record<string, string>>): KeyValueRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

export type RowsResult = { record: Record<string, string>; errors: string[] };

// Blank rows are dropped; invalid and repeated names are reported, not silently merged.
export function rowsToRecord(rows: readonly KeyValueRow[], pattern: RegExp, label: string): RowsResult {
  const record: Record<string, string> = {};
  const errors: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.length === 0) continue;
    if (!pattern.test(key)) {
      errors.push(`${label} "${key || "(empty)"}" is not a valid name.`);
      continue;
    }
    if (key in record) {
      errors.push(`${label} "${key}" appears twice.`);
      continue;
    }
    record[key] = row.value;
  }
  return { record, errors };
}

// ---------------------------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------------------------

export const agentInstructionsLimit = 16_384;
export const environmentNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function agentInstructionsCounter(text: string): { used: number; limit: number; over: boolean; label: string } {
  const used = text.length;
  return {
    used,
    limit: agentInstructionsLimit,
    over: used > agentInstructionsLimit,
    label: `${used.toLocaleString("en-US")} / ${agentInstructionsLimit.toLocaleString("en-US")}`
  };
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// AI model (BYOK)
// ---------------------------------------------------------------------------------------------

export type ProviderHint = { provider: string; tone: "ok" | "warning" | "unknown"; note: string | null };

const providerPrefixes: ReadonlyArray<{ prefix: string; provider: string; tone: ProviderHint["tone"]; note: string | null }> = [
  { prefix: "openrouter/", provider: "OpenRouter", tone: "ok", note: "Use an OpenRouter key." },
  { prefix: "openai-compatible/", provider: "OpenAI-compatible", tone: "ok", note: "Self-hosted endpoint; the runner needs its base URL." },
  { prefix: "anthropic/", provider: "Anthropic", tone: "ok", note: null },
  { prefix: "openai/", provider: "OpenAI", tone: "ok", note: null },
  { prefix: "google/", provider: "Google", tone: "ok", note: null },
  { prefix: "gateway/", provider: "AI Gateway", tone: "ok", note: null },
  { prefix: "claude-code/", provider: "Claude Code", tone: "warning", note: "Development only. Cloud runs need an organisation key." },
  { prefix: "mock:", provider: "Mock replay", tone: "warning", note: "Replays recorded turns. For tests only." }
];

export function providerFromModelId(modelId: string): ProviderHint {
  const id = modelId.trim();
  if (id.length === 0) return { provider: "No model", tone: "unknown", note: null };
  const match = providerPrefixes.find((entry) => id.startsWith(entry.prefix));
  if (match) return { provider: match.provider, tone: match.tone, note: match.note };
  return { provider: "Unknown provider", tone: "unknown", note: "Prefix the id with the provider, e.g. anthropic/claude-sonnet-5-5." };
}

export function maskedKeyLabel(keyConfigured: boolean, keyLast4: string | null): string {
  if (!keyConfigured) return "Not configured";
  return keyLast4 ? `Configured · ••••${keyLast4}` : "Configured";
}

// ---------------------------------------------------------------------------------------------
// Runner pools
// ---------------------------------------------------------------------------------------------

export type RunnerCommands = { start: string; docker: string; envFile: string };

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function runnerCommands(input: { apiOrigin: string; token: string }): RunnerCommands {
  const api = shellQuote(input.apiOrigin);
  const token = shellQuote(input.token);
  return {
    start: `jl-e2e-runner start --api ${api} --token ${token}`,
    envFile: `JL_API_ORIGIN=${input.apiOrigin}\nJL_RUNNER_TOKEN=${input.token}\nJL_RUNNER_CONCURRENCY=1`,
    docker: [
      "cat > deploy/runner/runner.env <<'ENV'",
      `JL_API_ORIGIN=${input.apiOrigin}`,
      `JL_RUNNER_TOKEN=${input.token}`,
      "JL_RUNNER_CONCURRENCY=1",
      "ENV",
      "docker compose -f deploy/runner/compose.yaml up -d --build"
    ].join("\n")
  };
}

// Environments bind to "cloud" or to a self-hosted pool ("self-hosted:<pool>").
export function runnerPoolValue(pool: { kind: "cloud" | "self-hosted"; id: string; name: string }): string {
  return pool.kind === "cloud" ? "cloud" : `self-hosted:${pool.id}`;
}

// ---------------------------------------------------------------------------------------------
// Test run settings (design.md §10)
// ---------------------------------------------------------------------------------------------

export type RunSettingsForm = Record<
  | "maxConcurrentRuns"
  | "dedupeWindowSeconds"
  | "maxQueuedRuns"
  | "maxQueuedPerCase"
  | "tokenBucketSize"
  | "tokenBucketWindowSeconds"
  | "dailyBudgetUsd"
  | "failedDays"
  | "passedDays",
  string
>;

export type RunSettingsValue = {
  maxConcurrentRuns: number;
  dedupeWindowSeconds: number;
  maxQueuedRuns: number;
  maxQueuedPerCase: number;
  tokenBucketSize: number;
  tokenBucketWindowSeconds: number;
  dailyBudgetUsd: number | null;
  retention: { failedDays: number; passedDays: number };
};

export function runSettingsToForm(settings: RunSettingsValue): RunSettingsForm {
  return {
    maxConcurrentRuns: String(settings.maxConcurrentRuns),
    dedupeWindowSeconds: String(settings.dedupeWindowSeconds),
    maxQueuedRuns: String(settings.maxQueuedRuns),
    maxQueuedPerCase: String(settings.maxQueuedPerCase),
    tokenBucketSize: String(settings.tokenBucketSize),
    tokenBucketWindowSeconds: String(settings.tokenBucketWindowSeconds),
    dailyBudgetUsd: settings.dailyBudgetUsd === null ? "" : String(settings.dailyBudgetUsd),
    failedDays: String(settings.retention.failedDays),
    passedDays: String(settings.retention.passedDays)
  };
}

const integerLimits: Record<Exclude<keyof RunSettingsForm, "dailyBudgetUsd">, [number, number, string]> = {
  maxConcurrentRuns: [1, 50, "Concurrent runs"],
  dedupeWindowSeconds: [0, 86_400, "Dedupe window"],
  maxQueuedRuns: [1, 10_000, "Queued runs"],
  maxQueuedPerCase: [1, 100, "Queued runs per case"],
  tokenBucketSize: [1, 10_000, "Requests per window"],
  tokenBucketWindowSeconds: [1, 86_400, "Rate window"],
  failedDays: [1, 3650, "Keep failed runs"],
  passedDays: [1, 3650, "Keep passed runs"]
};

export function runSettingsFromForm(form: RunSettingsForm): { value: RunSettingsValue | null; errors: Partial<Record<keyof RunSettingsForm, string>> } {
  const errors: Partial<Record<keyof RunSettingsForm, string>> = {};
  const numbers: Partial<Record<keyof RunSettingsForm, number>> = {};
  for (const [field, [min, max, label]] of Object.entries(integerLimits) as Array<[keyof typeof integerLimits, [number, number, string]]>) {
    const raw = form[field].trim();
    const value = Number(raw);
    if (raw.length === 0 || !Number.isInteger(value) || value < min || value > max) {
      errors[field] = `${label} must be a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`;
    } else {
      numbers[field] = value;
    }
  }
  const budgetRaw = form.dailyBudgetUsd.trim();
  let dailyBudgetUsd: number | null = null;
  if (budgetRaw.length > 0) {
    const value = Number(budgetRaw);
    if (!Number.isFinite(value) || value < 0) errors.dailyBudgetUsd = "Daily budget must be zero or more, or empty for no limit.";
    else dailyBudgetUsd = Math.round(value * 100) / 100;
  }
  if (Object.keys(errors).length > 0) return { value: null, errors };
  return {
    value: {
      maxConcurrentRuns: numbers.maxConcurrentRuns as number,
      dedupeWindowSeconds: numbers.dedupeWindowSeconds as number,
      maxQueuedRuns: numbers.maxQueuedRuns as number,
      maxQueuedPerCase: numbers.maxQueuedPerCase as number,
      tokenBucketSize: numbers.tokenBucketSize as number,
      tokenBucketWindowSeconds: numbers.tokenBucketWindowSeconds as number,
      dailyBudgetUsd,
      retention: { failedDays: numbers.failedDays as number, passedDays: numbers.passedDays as number }
    },
    errors
  };
}
