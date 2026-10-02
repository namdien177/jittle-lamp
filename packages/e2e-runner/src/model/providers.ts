import type { LanguageModelV4 } from "@ai-sdk/provider";

import { MockReplayModel, recordingModel } from "./mock";
import { promptedToolCalling } from "./prompted-tools";

// The organisation's act and judge models are AI SDK ids; the prefix picks the provider package
// (design.md §5.1, ADR 0002 decisions 5 and 14).
//
//   anthropic/<model>                 @ai-sdk/anthropic          ANTHROPIC_API_KEY
//   openai/<model>                    @ai-sdk/openai             OPENAI_API_KEY
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
  fetch?: typeof fetch;
  // Allow the development-only claude-code provider (never on the cloud pool).
  allowClaudeCode?: boolean;
};

const requireKey = (keys: ProviderKeys, name: string, id: string): string => {
  const value = keys[name];
  if (!value) throw new ModelResolutionError("MODEL_KEY_MISSING", `${id} needs ${name}.`);
  return value;
};

export function providerOf(id: string): string {
  if (id.startsWith("mock:")) return "mock";
  return id.split("/")[0] ?? id;
}

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

  switch (prefix) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: requireKey(options.keys, "ANTHROPIC_API_KEY", id) })(modelId) as LanguageModelV4;
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: requireKey(options.keys, "OPENAI_API_KEY", id) })(modelId) as LanguageModelV4;
    }
    case "openrouter": {
      const apiKey = requireKey(options.keys, "OPENROUTER_API_KEY", id);
      await assertOpenRouterModel(modelId, options.fetch ?? fetch);
      const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
      return createOpenRouter({ apiKey })(modelId) as unknown as LanguageModelV4;
    }
    case "openai-compatible": {
      const baseURL = requireKey(options.keys, "OPENAI_COMPATIBLE_BASE_URL", id);
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const apiKey = options.keys.OPENAI_COMPATIBLE_API_KEY;
      return createOpenAICompatible({ name: "openai-compatible", baseURL, ...(apiKey ? { apiKey } : {}) })(modelId) as LanguageModelV4;
    }
    case "gateway": {
      const { createGateway } = await import("ai");
      return createGateway({ apiKey: requireKey(options.keys, "AI_GATEWAY_API_KEY", id) })(modelId) as LanguageModelV4;
    }
    case "claude-code": {
      if (!options.allowClaudeCode) {
        throw new ModelResolutionError("MODEL_UNAVAILABLE", "claude-code/ models are for local development only.");
      }
      try {
        const { createClaudeCode } = await import("ai-sdk-provider-claude-code");
        // No CLI tools, no project settings, prompts sent verbatim: the CLI is only a model here.
        const provider = createClaudeCode({
          defaultSettings: { allowedTools: [], settingSources: [], permissionPrompts: "none", verbatimPrompts: true }
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
      throw new ModelResolutionError("MODEL_UNAVAILABLE", `Unknown model provider "${prefix}" in "${id}".`);
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
