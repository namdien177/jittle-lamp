import type { LanguageModelV4 } from "@ai-sdk/provider";
import { modelProviderOf, modelProviders, supportedModelPrefixes } from "@jittle-lamp/shared";

import { MockReplayModel, recordingModel } from "./mock";
import { promptedToolCalling } from "./prompted-tools";

// The organisation's act and judge models are AI SDK ids; the prefix picks the provider package
// (design.md §5.1, ADR 0002 decisions 5 and 14). The prefixes and environment names come from
// `modelProviders` in @jittle-lamp/shared, which the backend and web settings validate against.
//
//   anthropic/<model>                 @ai-sdk/anthropic          ANTHROPIC_API_KEY
//   openai/<model>                    @ai-sdk/openai             OPENAI_API_KEY
//   google/<model>                    @ai-sdk/google             GOOGLE_GENERATIVE_AI_API_KEY
//   xai/<model>                       @ai-sdk/xai                XAI_API_KEY
//   openrouter/<vendor>/<model>       @openrouter/ai-sdk-provider OPENROUTER_API_KEY (id checked against /api/v1/models)
//   openai-compatible/<model>         @ai-sdk/openai-compatible  OPENAI_COMPATIBLE_BASE_URL (+ _API_KEY)
//   gateway/<provider>/<model>        AI Gateway                 AI_GATEWAY_API_KEY
//   claude-code/<model>               ai-sdk-provider-claude-code, the `claude` CLI login (development only)
//   mock:<fixture.json>               recorded turns, no network

export class ModelResolutionError extends Error {
  constructor(
    readonly code: "MODEL_UNAVAILABLE" | "MODEL_KEY_MISSING",
    message: string
  ) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

export type ProviderKeys = Readonly<Record<string, string | undefined>>;

export type ResolvedModel = {
  id: string;
  provider: string;
  model: LanguageModelV4;
};

export type ModelResolveOptions = {
  keys: ProviderKeys;
  // Append every turn of the real model to this fixture, for later `mock:` replays.
  recordFixture?: string;
  // Used for every provider request and the OpenRouter model list (the backend passes an
  // SSRF-guarded fetch; tests pass a fake).
  fetch?: typeof fetch;
  // Allow the development-only claude-code provider (never on the cloud pool).
  allowClaudeCode?: boolean;
};

const requireKey = (keys: ProviderKeys, name: string, id: string): string => {
  const value = keys[name];
  if (!value) throw new ModelResolutionError("MODEL_KEY_MISSING", `${id} needs ${name}.`);
  return value;
};

// The environment name of a provider's key or endpoint, from the shared provider list.
const envName = (prefix: string, field: "keyEnv" | "baseUrlEnv"): string => {
  const name = modelProviders.find((provider) => provider.prefix === prefix)?.[field];
  if (!name) throw new Error(`No ${field} for model provider ${prefix}`);
  return name;
};

export const providerOf = modelProviderOf;

export async function resolveModel(id: string, options: ModelResolveOptions): Promise<ResolvedModel> {
  const model = await instantiate(id, options);
  return {
    id,
    provider: providerOf(id),
    model: options.recordFixture ? recordingModel(model, options.recordFixture) : model
  };
}

async function instantiate(id: string, options: ModelResolveOptions): Promise<LanguageModelV4> {
  if (id.startsWith("mock:")) return MockReplayModel.fromFile(id.slice("mock:".length));

  const [prefix, ...rest] = id.split("/");
  const modelId = rest.join("/");
  if (!prefix || modelId.length === 0) {
    throw new ModelResolutionError("MODEL_UNAVAILABLE", `Model id "${id}" must look like <provider>/<model>.`);
  }

  const custom = options.fetch ? { fetch: options.fetch } : {};
  const key = (provider: string) => requireKey(options.keys, envName(provider, "keyEnv"), id);
  switch (prefix) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: key(prefix), ...custom })(modelId) as LanguageModelV4;
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: key(prefix), ...custom })(modelId) as LanguageModelV4;
    }
    case "google": {
      const { createGoogle } = await import("@ai-sdk/google");
      return createGoogle({ apiKey: key(prefix), ...custom })(modelId) as LanguageModelV4;
    }
    case "xai": {
      const { createXai } = await import("@ai-sdk/xai");
      return createXai({ apiKey: key(prefix), ...custom })(modelId) as LanguageModelV4;
    }
    case "openrouter": {
      const apiKey = key(prefix);
      await assertOpenRouterModel(modelId, options.fetch ?? fetch);
      const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
      return createOpenRouter({ apiKey, ...custom })(modelId) as unknown as LanguageModelV4;
    }
    case "openai-compatible": {
      const baseURL = requireKey(options.keys, envName(prefix, "baseUrlEnv"), id);
      if (!/^https?:\/\//i.test(baseURL)) {
        throw new ModelResolutionError("MODEL_UNAVAILABLE", `${envName(prefix, "baseUrlEnv")} must be an http(s) URL.`);
      }
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const apiKey = options.keys[envName(prefix, "keyEnv")];
      return createOpenAICompatible({ name: "openai-compatible", baseURL, ...(apiKey ? { apiKey } : {}), ...custom })(modelId) as LanguageModelV4;
    }
    case "gateway": {
      const { createGateway } = await import("ai");
      return createGateway({ apiKey: key(prefix), ...custom })(modelId) as LanguageModelV4;
    }
    case "claude-code": {
      if (!options.allowClaudeCode) {
        throw new ModelResolutionError("MODEL_UNAVAILABLE", "claude-code/ models are for local development only.");
      }
      try {
        const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        // The CLI is only a model here: no built-in tools, no project settings, an empty working
        // directory and an environment holding nothing but its own login, so page text in the
        // prompt cannot steer it into reading files or the run's JL_* values.
        const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
        for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"]) {
          if (process.env[name]) env[name] = process.env[name];
        }
        const provider = createClaudeCode({
          defaultSettings: {
            tools: [],
            allowedTools: [],
            disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "NotebookEdit", "TodoWrite"],
            settingSources: [],
            permissionPrompts: "none",
            verbatimPrompts: true,
            cwd: mkdtempSync(join(tmpdir(), "jl-claude-code-")),
            env
          }
        } as Parameters<typeof createClaudeCode>[0]);
        return promptedToolCalling(provider(modelId) as unknown as LanguageModelV4);
      } catch (error) {
        throw new ModelResolutionError(
          "MODEL_UNAVAILABLE",
          `claude-code provider unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    default:
      throw new ModelResolutionError("MODEL_UNAVAILABLE", `Unknown model provider "${prefix}" in "${id}". Supported prefixes: ${supportedModelPrefixes()}.`);
  }
}

// OpenRouter ids are resolved from its model list at startup, never guessed (handover §4b).
export async function assertOpenRouterModel(modelId: string, fetchImpl: typeof fetch): Promise<void> {
  let ids: string[];
  try {
    const response = await fetchImpl("https://openrouter.ai/api/v1/models");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    ids = (body.data ?? []).flatMap((entry) => (entry.id ? [entry.id] : []));
  } catch (error) {
    throw new ModelResolutionError(
      "MODEL_UNAVAILABLE",
      `Could not read the OpenRouter model list: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!ids.includes(modelId)) {
    const vendor = modelId.split("/")[0] ?? "";
    const suggestions = ids.filter((candidate) => candidate.startsWith(`${vendor}/`)).slice(0, 5);
    throw new ModelResolutionError(
      "MODEL_UNAVAILABLE",
      `OpenRouter has no model "${modelId}".${suggestions.length > 0 ? ` Available: ${suggestions.join(", ")}` : ""}`
    );
  }
}
