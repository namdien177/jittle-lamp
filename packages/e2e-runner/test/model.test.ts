import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateText, jsonSchema, tool, type ToolSet } from "ai";

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
});
