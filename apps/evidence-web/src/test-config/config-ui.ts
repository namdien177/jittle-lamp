import {
  findModelProvider,
  lintTestCase,
  modelIdProblem,
  modelProviderOf,
  parseTestCaseTranscript,
  supportedModelPrefixes,
  type LintFinding,
  type MacroDefinition,
  type MacroParam,
  type ModelPrice,
  type ModelPriceRow,
  type ModelSettings,
  resolveModelPrice
} from "@jittle-lamp/shared";

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

// Labels and environment names come from the shared provider list the backend validates against.
const providerNotes: Readonly<Record<string, { tone: ProviderHint["tone"]; note: string | null }>> = {
  openrouter: { tone: "ok", note: "Use an OpenRouter key. OpenRouter reports the cost of each call." },
  "openai-compatible": { tone: "ok", note: "Any OpenAI-compatible endpoint: Groq, Together, DeepSeek, Fireworks, vLLM, Ollama, LiteLLM. Needs its base URL." },
  gateway: { tone: "ok", note: "Use an AI Gateway key; the id after gateway/ is <provider>/<model>." },
  "claude-code": { tone: "warning", note: "Development only. Cloud runs need an organisation key." },
  mock: { tone: "warning", note: "Replays recorded turns. For tests only." }
};

export function providerFromModelId(modelId: string): ProviderHint {
  const id = modelId.trim();
  if (id.length === 0) return { provider: "No model", tone: "unknown", note: null };
  const problem = modelIdProblem(id);
  const provider = findModelProvider(id);
  if (problem || !provider) return { provider: "Unknown provider", tone: "unknown", note: problem ?? `Supported prefixes: ${supportedModelPrefixes()}.` };
  return { provider: provider.label, ...(providerNotes[provider.prefix] ?? { tone: "ok" as const, note: null }) };
}

// Ready-made pairs for the provider picker. The act model drives the browser; the judge decides
// asserts, waits and extracts, so a cheaper model often suffices.
export type ModelPreset = { id: string; label: string; actModel: string; judgeModel: string };

export const modelPresets: readonly ModelPreset[] = [
  { id: "openrouter", label: "OpenRouter", actModel: "openrouter/anthropic/claude-sonnet-5-5", judgeModel: "openrouter/openai/gpt-5" },
  { id: "openai-compatible", label: "OpenAI-compatible endpoint", actModel: "openai-compatible/llama-3.3-70b", judgeModel: "openai-compatible/llama-3.3-70b" },
  { id: "gateway", label: "AI Gateway", actModel: "gateway/alibaba/qwen3.7-flash", judgeModel: "gateway/alibaba/qwen3.7-flash" },
  { id: "openai", label: "OpenAI", actModel: "openai/gpt-5", judgeModel: "openai/gpt-5" },
  { id: "anthropic", label: "Anthropic", actModel: "anthropic/claude-opus-5-5", judgeModel: "anthropic/claude-sonnet-5-5" },
  { id: "google", label: "Google", actModel: "google/gemini-2.5-pro", judgeModel: "google/gemini-2.5-pro" },
  { id: "xai", label: "xAI", actModel: "xai/grok-4", judgeModel: "xai/grok-4" }
];

// The provider picker shows the act model's provider, or "custom" for anything else.
export function presetForModels(actModel: string): string {
  const prefix = modelProviderOf(actModel.trim());
  return modelPresets.some((preset) => preset.id === prefix) ? prefix : "custom";
}

export type ModelFormState = {
  actModel: string;
  judgeModel: string;
  baseUrl: string;
  apiKey: string;
  judgeApiKey: string;
};

export type SavedModelSettings = Pick<ModelSettings, "actModel" | "judgeModel" | "keyConfigured" | "judgeKeyConfigured">;

// What the AI model form must show and what it would lose, for the models currently typed in.
export type ModelFormRequirements = {
  actProvider: string | null;
  judgeProvider: string | null;
  // The act provider takes a key; `keyOptional` for endpoints that may run without one.
  showKey: boolean;
  keyOptional: boolean;
  // The judge uses another provider that takes its own key.
  showJudgeKey: boolean;
  judgeKeyOptional: boolean;
  showBaseUrl: boolean;
  // A saved key that the server drops on save because its provider changed.
  keyDropped: boolean;
  judgeKeyDropped: boolean;
  errors: { actModel?: string; judgeModel?: string; baseUrl?: string; apiKey?: string; judgeApiKey?: string };
  // What runs will still be missing after saving: blocked with MODEL_KEY_MISSING until filled in.
  missing: Array<"key" | "judgeKey">;
};

export function modelFormRequirements(form: ModelFormState, saved: SavedModelSettings | null): ModelFormRequirements {
  const act = modelIdProblem(form.actModel) ? null : findModelProvider(form.actModel);
  const judge = modelIdProblem(form.judgeModel) ? null : findModelProvider(form.judgeModel);
  const showJudgeKey = Boolean(judge?.keyEnv && judge.prefix !== act?.prefix);
  const showBaseUrl = Boolean(act?.baseUrlEnv || judge?.baseUrlEnv);
  const keyDropped = Boolean(saved?.keyConfigured && act && modelProviderOf(saved.actModel) !== act.prefix && form.apiKey.length === 0);
  const judgeKeyDropped = Boolean(
    saved?.judgeKeyConfigured && judge && (!showJudgeKey || modelProviderOf(saved.judgeModel) !== judge.prefix) && form.judgeApiKey.length === 0
  );
  const errors: ModelFormRequirements["errors"] = {};
  const actProblem = modelIdProblem(form.actModel);
  const judgeProblem = modelIdProblem(form.judgeModel);
  if (actProblem) errors.actModel = actProblem;
  if (judgeProblem) errors.judgeModel = judgeProblem;
  const baseUrl = form.baseUrl.trim();
  if (showBaseUrl && !baseUrl) errors.baseUrl = "openai-compatible/ models need the endpoint's base URL.";
  else if (showBaseUrl && !isHttpUrl(baseUrl)) errors.baseUrl = "Use an http or https URL.";
  if (form.apiKey.length > 0 && form.apiKey.length < 8) errors.apiKey = "The key looks too short.";
  if (form.judgeApiKey.length > 0 && form.judgeApiKey.length < 8) errors.judgeApiKey = "The key looks too short.";
  const keyStored = Boolean(saved?.keyConfigured) && !keyDropped;
  const judgeKeyStored = Boolean(saved?.judgeKeyConfigured) && !judgeKeyDropped;
  const missing: ModelFormRequirements["missing"] = [];
  if (act?.keyRequired && !keyStored && form.apiKey.length === 0) missing.push("key");
  if (showJudgeKey && judge?.keyRequired && !judgeKeyStored && form.judgeApiKey.length === 0) missing.push("judgeKey");
  return {
    actProvider: act?.label ?? null,
    judgeProvider: judge?.label ?? null,
    showKey: Boolean(act?.keyEnv),
    keyOptional: Boolean(act?.keyEnv && !act.keyRequired),
    showJudgeKey,
    judgeKeyOptional: Boolean(judge?.keyEnv && !judge.keyRequired),
    showBaseUrl,
    keyDropped,
    judgeKeyDropped,
    errors,
    missing
  };
}

// The PUT body: keys only when typed, the base URL only while a model needs it.
export function modelSettingsRequest(
  form: ModelFormState,
  requirements: Pick<ModelFormRequirements, "showBaseUrl" | "showJudgeKey">
): { actModel: string; judgeModel: string; apiKey?: string; judgeApiKey?: string; baseUrl?: string } {
  const baseUrl = form.baseUrl.trim();
  return {
    actModel: form.actModel.trim(),
    judgeModel: form.judgeModel.trim(),
    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    ...(requirements.showJudgeKey && form.judgeApiKey ? { judgeApiKey: form.judgeApiKey } : {}),
    ...(requirements.showBaseUrl && baseUrl ? { baseUrl } : {})
  };
}

export function maskedKeyLabel(keyConfigured: boolean, keyLast4: string | null): string {
  if (!keyConfigured) return "Not configured";
  return keyLast4 ? `Configured · ••••${keyLast4}` : "Configured";
}

// ---------------------------------------------------------------------------------------------
// Model prices (USD per million tokens; PUT /model-prices replaces the organisation's rows)
// ---------------------------------------------------------------------------------------------

export type ModelPriceStatus =
  | { kind: "priced"; matchedModelId: string; source: ModelPriceRow["source"]; reportsCost: boolean }
  | { kind: "unknown"; reportsCost: boolean };

// How a model's cost is worked out: OpenRouter reports it; otherwise the price row it matches
// (a router id falls back to the vendor's row), or unknown.
export function modelPriceStatus(rows: readonly ModelPriceRow[], modelId: string): ModelPriceStatus {
  const reportsCost = Boolean(findModelProvider(modelId)?.reportsCost);
  const match = resolveModelPrice(rows, modelId.trim());
  if (!match) return { kind: "unknown", reportsCost };
  const row = rows.find((entry) => entry.modelId === match.matchedModelId);
  return { kind: "priced", matchedModelId: match.matchedModelId, source: row?.source ?? "default", reportsCost };
}

export function modelPriceHint(rows: readonly ModelPriceRow[], modelId: string): string {
  const status = modelPriceStatus(rows, modelId);
  const reported = status.reportsCost ? "OpenRouter reports the cost of each call; the price table is only a fallback. " : "";
  if (status.kind === "unknown") return `${reported}No price for ${modelId}: runs show tokens with the cost unknown until you add a price.`;
  const via = status.matchedModelId === modelId ? "" : ` (the price of ${status.matchedModelId})`;
  return `${reported}Priced from the ${status.source === "organization" ? "organisation's" : "default"} table${via}.`;
}

export type PriceForm = { modelId: string; input: string; cachedInput: string; output: string };

export function priceFormFromRow(row: ModelPrice | null, modelId = ""): PriceForm {
  if (!row) return { modelId, input: "", cachedInput: "", output: "" };
  return { modelId: row.modelId, input: String(row.inputUsdPerMtok), cachedInput: String(row.cachedInputUsdPerMtok), output: String(row.outputUsdPerMtok) };
}

export type PriceFormResult = { price: ModelPrice | null; errors: Partial<Record<keyof PriceForm, string>> };

export function priceFromForm(form: PriceForm): PriceFormResult {
  const errors: PriceFormResult["errors"] = {};
  const modelId = form.modelId.trim();
  if (!modelId) errors.modelId = "Enter the model id exactly as runs report it.";
  const amount = (value: string, key: "input" | "cachedInput" | "output", optional = false): number => {
    const text = value.trim();
    if (text === "" && optional) return 0;
    const parsed = Number(text);
    if (text === "" || !Number.isFinite(parsed) || parsed < 0) errors[key] = "Enter a price of 0 or more.";
    return parsed;
  };
  const input = amount(form.input, "input");
  const cachedInput = amount(form.cachedInput, "cachedInput", true);
  const output = amount(form.output, "output");
  if (Object.keys(errors).length > 0) return { price: null, errors };
  return { price: { modelId, inputUsdPerMtok: input, cachedInputUsdPerMtok: cachedInput, outputUsdPerMtok: output }, errors };
}

const organizationRows = (rows: readonly ModelPriceRow[]): ModelPrice[] =>
  rows
    .filter((row) => row.source === "organization")
    .map(({ modelId, inputUsdPerMtok, cachedInputUsdPerMtok, outputUsdPerMtok }) => ({ modelId, inputUsdPerMtok, cachedInputUsdPerMtok, outputUsdPerMtok }));

// The organisation's rows with `price` added or replacing the row it was edited from.
export function upsertOrganizationPrice(rows: readonly ModelPriceRow[], price: ModelPrice, editedModelId: string | null = null): ModelPrice[] {
  const kept = organizationRows(rows).filter((row) => row.modelId !== price.modelId && row.modelId !== editedModelId);
  return [...kept, price].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

// Removing an organisation row restores the default price for that id, if there is one.
export function removeOrganizationPrice(rows: readonly ModelPriceRow[], modelId: string): ModelPrice[] {
  return organizationRows(rows).filter((row) => row.modelId !== modelId);
}

export function formatUsdPerMtok(value: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
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

// Every pool, the organisation's cloud pool included, registers workers with a registration token
// (POST /runner-pools/:id/registration-token, test_config.manage). The token is shown once; a new
// one replaces the old one and registered workers keep working.
export type RegistrationTokenAction = { label: string; ariaLabel: string; title: string; note: string };

export function registrationTokenAction(pool: { kind: "cloud" | "self-hosted"; name: string }, canManage: boolean): RegistrationTokenAction | null {
  if (!canManage) return null;
  return {
    label: "New token",
    ariaLabel: `New token for ${pool.name}`,
    title: `New registration token for ${pool.name}`,
    note:
      pool.kind === "cloud"
        ? "Put it in runner.env of this organisation's cloud runner deployment (deploy/runner/compose.yaml). It replaces the previous token; registered workers keep working."
        : "It replaces the previous token; registered workers keep working."
  };
}

// Environments bind to "cloud" or to a self-hosted pool by name ("self-hosted:devbox"); the backend
// resolves the reference by pool id or name.
export function runnerPoolValue(pool: { kind: "cloud" | "self-hosted"; id: string; name: string }): string {
  return pool.kind === "cloud" ? "cloud" : `self-hosted:${pool.name}`;
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

// ---------------------------------------------------------------------------------------------
// Macros
// ---------------------------------------------------------------------------------------------

// Rules about whole cases do not apply to a macro body.
const caseOnlyRules = new Set(["missing-title", "no-assert", "step-count", "assert-without-checkpoint"]);

export function lintMacroBody(transcript: string, params: readonly Pick<MacroParam, "name">[], macros: readonly Pick<MacroDefinition, "name" | "params">[]): LintFinding[] {
  if (transcript.trim().length === 0) return [];
  try {
    const { testCase } = parseTestCaseTranscript(transcript);
    return lintTestCase(testCase, {
      macros: macros.map((macro) => ({ name: macro.name, params: macro.params })),
      environmentVariables: params.map((param) => param.name)
    }).filter((finding) => !caseOnlyRules.has(finding.ruleId));
  } catch (error) {
    return [{ ruleId: "parse", severity: "error", message: error instanceof Error ? error.message : "Cannot parse the body.", stepId: null, line: null, fix: null }];
  }
}

// ---------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------

export const tagColors = ["#22c55e", "#0ea5e9", "#6366f1", "#a855f7", "#ec4899", "#ef4444", "#f97316", "#eab308", "#64748b"] as const;

export function tagLabel(tag: { namespace: string; name: string }): string {
  return tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name;
}

// Namespaces alphabetically with free tags (empty namespace) last; tags by name within each.
export function groupTagsByNamespace<T extends { namespace: string; name: string }>(tags: readonly T[]): Array<{ namespace: string; tags: T[] }> {
  const groups = new Map<string, T[]>();
  for (const tag of tags) groups.set(tag.namespace, [...(groups.get(tag.namespace) ?? []), tag]);
  return [...groups.entries()]
    .sort(([left], [right]) => (left === "" ? 1 : right === "" ? -1 : left.localeCompare(right)))
    .map(([namespace, items]) => ({ namespace, tags: [...items].sort((left, right) => left.name.localeCompare(right.name)) }));
}
