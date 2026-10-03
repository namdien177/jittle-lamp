// The model providers a test run can use (design.md §5.1, ADR 0002 decisions 5 and 14). One list
// for the runner's resolver, the backend's settings validation and the web settings page, so a
// prefix the organisation can save is always one the runner can instantiate.
//
// A model id is `<prefix>/<model>`; `mock:<fixture.json>` is the one exception.

export type ModelProvider = {
  // Id prefix before the first `/` (`mock` for `mock:<fixture>`).
  prefix: string;
  label: string;
  // Environment name the runner reads the provider key from; null when the provider takes none.
  keyEnv: string | null;
  // False when the key is optional (a self-hosted OpenAI-compatible server may have none).
  keyRequired: boolean;
  // Environment name for the endpoint the runner calls; the organisation stores it as a base URL.
  baseUrlEnv: string | null;
  example: string;
  // Development and test providers: accepted, but never on a cloud pool with real keys.
  development: boolean;
};

export const modelProviders: readonly ModelProvider[] = [
  { prefix: "openrouter", label: "OpenRouter", keyEnv: "OPENROUTER_API_KEY", keyRequired: true, baseUrlEnv: null, example: "openrouter/anthropic/claude-sonnet-5-5", development: false },
  { prefix: "openai-compatible", label: "OpenAI-compatible", keyEnv: "OPENAI_COMPATIBLE_API_KEY", keyRequired: false, baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL", example: "openai-compatible/llama-3.3-70b", development: false },
  { prefix: "gateway", label: "AI Gateway", keyEnv: "AI_GATEWAY_API_KEY", keyRequired: true, baseUrlEnv: null, example: "gateway/openai/gpt-5", development: false },
  { prefix: "openai", label: "OpenAI", keyEnv: "OPENAI_API_KEY", keyRequired: true, baseUrlEnv: null, example: "openai/gpt-5", development: false },
  { prefix: "anthropic", label: "Anthropic", keyEnv: "ANTHROPIC_API_KEY", keyRequired: true, baseUrlEnv: null, example: "anthropic/claude-sonnet-5-5", development: false },
  { prefix: "google", label: "Google", keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY", keyRequired: true, baseUrlEnv: null, example: "google/gemini-2.5-pro", development: false },
  { prefix: "xai", label: "xAI", keyEnv: "XAI_API_KEY", keyRequired: true, baseUrlEnv: null, example: "xai/grok-4", development: false },
  { prefix: "claude-code", label: "Claude Code", keyEnv: null, keyRequired: false, baseUrlEnv: null, example: "claude-code/sonnet", development: true },
  { prefix: "mock", label: "Mock replay", keyEnv: null, keyRequired: false, baseUrlEnv: null, example: "mock:fixture.json", development: true }
];

// Every provider environment name the runner reads (keys and base URLs).
export const modelProviderEnvNames: readonly string[] = modelProviders.flatMap((provider) =>
  [provider.keyEnv, provider.baseUrlEnv].filter((name): name is string => name !== null)
);

// Environment names that hold an endpoint, not a secret.
export const modelProviderUrlEnvNames: readonly string[] = modelProviders.flatMap((provider) => (provider.baseUrlEnv ? [provider.baseUrlEnv] : []));

export function modelProviderOf(modelId: string): string {
  if (modelId.startsWith("mock:")) return "mock";
  return modelId.split("/")[0] ?? modelId;
}

export function findModelProvider(modelId: string): ModelProvider | null {
  const prefix = modelProviderOf(modelId.trim());
  return modelProviders.find((provider) => provider.prefix === prefix) ?? null;
}

export const supportedModelPrefixes = (): string => modelProviders.map((provider) => (provider.prefix === "mock" ? "mock:" : `${provider.prefix}/`)).join(", ");

// Why a model id cannot be saved or resolved, or null when its shape and provider are known.
export function modelIdProblem(modelId: string): string | null {
  const id = modelId.trim();
  if (id.length === 0) return "Enter a model id.";
  if (id.startsWith("mock:")) return id.length > "mock:".length ? null : "mock: needs a fixture path.";
  const [prefix, ...rest] = id.split("/");
  if (!prefix || rest.join("/").length === 0) return `"${id}" must look like <provider>/<model>. Supported prefixes: ${supportedModelPrefixes()}.`;
  if (!findModelProvider(id)) return `Unknown model provider "${prefix}". Supported prefixes: ${supportedModelPrefixes()}.`;
  return null;
}
