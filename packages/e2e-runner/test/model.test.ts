import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateText, jsonSchema, tool, type ToolSet } from "ai";

import { modelProviders } from "@jittle-lamp/shared";

import { MockReplayModel, mockFixtureSchema, recordingModel, resolveRefPlaceholders } from "../src/model/mock";
import { ModelResolutionError, resolveModel } from "../src/model/providers";

const fixture = mockFixtureSchema.parse({
  schemaVersion: 1,
  turns: [
    {
      match: { tools: ["click"] },
      content: [{ type: "tool-call", toolName: "click", input: { ref: { $refFor: { role: "button", name: "Save" } } } }],
      usage: { inputTokens: 1200, cachedInputTokens: 300, outputTokens: 40, reasoningTokens: 12 }
    },
    { content: [{ type: "text", text: "done" }], usage: { inputTokens: 900, outputTokens: 5 } }
  ]
});

const tools = {
  click: tool({
    description: "click an element",
    inputSchema: jsonSchema<{ ref: string }>({ type: "object", properties: { ref: { type: "string" } }, required: ["ref"] })
  })
} as unknown as ToolSet;

describe("mock: provider", () => {
  test("replays turns, resolves element refs from the snapshot and reports usage", async () => {
    const model = new MockReplayModel(fixture);
    const snapshot = '- banner\n  - button "Account menu" [ref=e3]\n- main\n  - button "Save" [ref=e17]';
    const first = await generateText({ model, prompt: `Snapshot:\n${snapshot}`, tools });
    expect(first.toolCalls[0]?.toolName).toBe("click");
    expect(first.toolCalls[0]?.input).toEqual({ ref: "e17" });
    expect(first.usage.inputTokens).toBe(1500);
    expect(first.usage.inputTokenDetails.cacheReadTokens).toBe(300);
    expect(first.usage.outputTokenDetails.reasoningTokens).toBe(12);

    const second = await generateText({ model, prompt: "next" });
    expect(second.text).toBe("done");
    await expect(generateText({ model, prompt: "again" })).rejects.toThrow("no unused turn");
  });

  test("refuses a ref that is not in the snapshot", () => {
    expect(() => resolveRefPlaceholders({ $refFor: { role: "link", name: "Nope" } }, '- button "Save" [ref=e1]')).toThrow(
      "no element"
    );
  });

  test("a recording wrapper writes a fixture that replays identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-mock-"));
    const path = join(dir, "recorded.json");
    const recorded = recordingModel(new MockReplayModel(fixture), path);
    await generateText({ model: recorded, prompt: '- button "Save" [ref=e2]', tools });
    const written = mockFixtureSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(written.turns[0]?.content).toEqual([{ type: "tool-call", toolName: "click", input: { ref: "e2" } }]);
    expect(written.turns[0]?.usage).toEqual({ inputTokens: 1200, cachedInputTokens: 300, outputTokens: 40, reasoningTokens: 12 });
  });
});

describe("provider selection by id prefix", () => {
  test("mock:<fixture> loads a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-mock-"));
    const path = join(dir, "f.json");
    writeFileSync(path, JSON.stringify(fixture));
    const resolved = await resolveModel(`mock:${path}`, { keys: {} });
    expect(resolved.provider).toBe("mock");
  });

  test("anthropic, openai-compatible and gateway instantiate with their keys", async () => {
    expect((await resolveModel("anthropic/claude-opus-5-5", { keys: { ANTHROPIC_API_KEY: "k" } })).model.modelId).toBe("claude-opus-5-5");
    expect(
      (await resolveModel("openai-compatible/qwen3", { keys: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1" } })).provider
    ).toBe("openai-compatible");
  });

  test("a missing key or unknown provider is a typed error", async () => {
    await expect(resolveModel("anthropic/claude-opus-5-5", { keys: {} })).rejects.toMatchObject({ code: "MODEL_KEY_MISSING" });
    await expect(resolveModel("nope/model", { keys: {} })).rejects.toBeInstanceOf(ModelResolutionError);
    await expect(resolveModel("claude-code/sonnet", { keys: {} })).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
  });

  test("openrouter ids are checked against the model list", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5.5" }, { id: "anthropic/claude-opus-5.5" }] }))) as unknown as typeof fetch;
    await expect(
      resolveModel("openrouter/anthropic/claude-sonnet-5-5", { keys: { OPENROUTER_API_KEY: "k" }, fetch: fakeFetch })
    ).rejects.toThrow("Available: anthropic/claude-sonnet-5.5, anthropic/claude-opus-5.5");
    const ok = await resolveModel("openrouter/anthropic/claude-sonnet-5.5", { keys: { OPENROUTER_API_KEY: "k" }, fetch: fakeFetch });
    expect(ok.provider).toBe("openrouter");
  });

  // A fake endpoint that records each request and answers like an OpenAI-style chat completion.
  const captureFetch = () => {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: input instanceof Request ? input.url : String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      });
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  test("openai-compatible calls the configured base URL with its optional key", async () => {
    const { calls, fetchImpl } = captureFetch();
    const resolved = await resolveModel("openai-compatible/llama-3.3-70b", {
      keys: { OPENAI_COMPATIBLE_BASE_URL: "https://llm.internal.example/v1", OPENAI_COMPATIBLE_API_KEY: "sk-compatible-0000" },
      fetch: fetchImpl
    });
    expect(resolved.provider).toBe("openai-compatible");
    expect((await generateText({ model: resolved.model, prompt: "hi" })).text).toBe("ok");
    expect(calls[0]?.url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("llama-3.3-70b");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-compatible-0000");

    const keyless = captureFetch();
    const local = await resolveModel("openai-compatible/qwen3", { keys: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1" }, fetch: keyless.fetchImpl });
    await generateText({ model: local.model, prompt: "hi" });
    expect(keyless.calls[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(keyless.calls[0]?.headers.get("authorization")).toBeNull();
  });

  test("openai-compatible without a base URL, or with a non-http one, is blocked before a call", async () => {
    await expect(resolveModel("openai-compatible/qwen3", { keys: { OPENAI_COMPATIBLE_API_KEY: "k" } })).rejects.toMatchObject({
      code: "MODEL_KEY_MISSING",
      message: expect.stringContaining("OPENAI_COMPATIBLE_BASE_URL")
    });
    await expect(resolveModel("openai-compatible/qwen3", { keys: { OPENAI_COMPATIBLE_BASE_URL: "file:///etc/passwd" } })).rejects.toMatchObject({
      code: "MODEL_UNAVAILABLE"
    });
  });

  test("xai/ and google/ instantiate with their own keys", async () => {
    const xai = await resolveModel("xai/grok-4", { keys: { XAI_API_KEY: "xai-key-0000" } });
    expect(xai.provider).toBe("xai");
    expect(xai.model.modelId).toBe("grok-4");
    await expect(resolveModel("xai/grok-4", { keys: { OPENAI_API_KEY: "k" } })).rejects.toMatchObject({
      code: "MODEL_KEY_MISSING",
      message: expect.stringContaining("XAI_API_KEY")
    });
    const google = await resolveModel("google/gemini-2.5-pro", { keys: { GOOGLE_GENERATIVE_AI_API_KEY: "g-key-0000" } });
    expect(google.provider).toBe("google");
    expect(google.model.modelId).toBe("gemini-2.5-pro");
    await expect(resolveModel("google/gemini-2.5-pro", { keys: {} })).rejects.toMatchObject({ code: "MODEL_KEY_MISSING" });
  });

  test("xai/ sends the key to the xAI API through the given fetch", async () => {
    const { calls, fetchImpl } = captureFetch();
    const xai = await resolveModel("xai/grok-4", { keys: { XAI_API_KEY: "xai-key-0000" }, fetch: fetchImpl });
    await generateText({ model: xai.model, prompt: "hi" }).catch(() => undefined);
    expect(calls[0]?.url.startsWith("https://api.x.ai/")).toBe(true);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer xai-key-0000");
  });

  test("every provider the backend accepts is one the runner can instantiate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jl-mock-"));
    const path = join(dir, "f.json");
    writeFileSync(path, JSON.stringify(fixture));
    const keys: Record<string, string> = { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1" };
    for (const provider of modelProviders) if (provider.keyEnv) keys[provider.keyEnv] = "test-key-0000";
    const openRouterList = (async () => new Response(JSON.stringify({ data: [{ id: "vendor/model" }] }))) as unknown as typeof fetch;
    for (const provider of modelProviders) {
      const id =
        provider.prefix === "mock" ? `mock:${path}` : provider.prefix === "openrouter" ? "openrouter/vendor/model" : `${provider.prefix}/some-model`;
      if (provider.prefix === "claude-code") {
        // Development only: refused unless the runner allows it, never "unknown".
        await expect(resolveModel(id, { keys })).rejects.toThrow("local development only");
        continue;
      }
      expect((await resolveModel(id, { keys, fetch: openRouterList })).provider).toBe(provider.prefix);
    }
    await expect(resolveModel("nope/model", { keys })).rejects.toThrow("Supported prefixes: openrouter/");
  });
});
