import { describe, expect, test } from "bun:test";

import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4Content } from "@ai-sdk/provider";

import { extractJsonObjects, pickToolCall, promptedToolCalling } from "../src/model/prompted-tools";

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

function scripted(replies: string[]): LanguageModelV4 & { prompts: unknown[] } {
  const prompts: unknown[] = [];
  return {
    specificationVersion: "v4",
    provider: "scripted",
    modelId: "scripted",
    supportedUrls: {},
    prompts,
    async doGenerate(options: LanguageModelV4CallOptions) {
      prompts.push(options.prompt);
      const text = replies.shift() ?? "";
      return { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
    async doStream() {
      throw new Error("not used");
    }
  };
}

const toolOptions = (choice: NonNullable<LanguageModelV4CallOptions["toolChoice"]>): LanguageModelV4CallOptions => ({
  prompt: [
    { role: "system", content: "You are a test agent." },
    { role: "user", content: [{ type: "text", text: 'Screen: #n6 button "Save"' }] }
  ],
  tools: [
    { type: "function", name: "tap", description: "tap a node", inputSchema: { type: "object" } },
    { type: "function", name: "complete_step", description: "finish", inputSchema: { type: "object" } }
  ],
  toolChoice: choice
});

describe("prompted tool-calling bridge (claude-code, development only)", () => {
  test("finds every JSON object in a reply", () => {
    expect(extractJsonObjects('x {"a":1} y ```json\n{"b":{"c":"}"}}\n```')).toEqual([{ a: 1 }, { b: { c: "}" } }]);
  });

  test("takes the last tool call the model settles on", () => {
    const content: LanguageModelV4Content[] = [
      { type: "text", text: '{"tool": "fill", "input": {}}\nfill is not a tool, so: {"tool": "tap", "input": {"target": "n6"}}' }
    ];
    expect(pickToolCall(content, new Set(["tap", "complete_step"]))).toEqual({ toolName: "tap", input: { target: "n6" } });
  });

  test("turns a JSON reply into a tool-call part and sums usage over one correction round", async () => {
    const inner = scripted(["I would click it.", '{"tool":"tap","input":{"target":"n6"}}']);
    const result = await promptedToolCalling(inner).doGenerate(toolOptions({ type: "required" }));
    expect(result.content).toEqual([{ type: "tool-call", toolCallId: expect.any(String), toolName: "tap", input: '{"target":"n6"}' }]);
    expect(result.finishReason.unified).toBe("tool-calls");
    expect(result.usage.inputTokens.total).toBe(20);
    expect(JSON.stringify(inner.prompts[0])).toContain("TOOL PROTOCOL");
  });

  test("judge calls get the last JSON object back as plain text", async () => {
    const inner = scripted(['```json\n{"verdict":"fails"}\n```\nActually: {"protocolVersion":"agent-judgment-2","explanation":"ok","verdict":"holds"}']);
    const result = await promptedToolCalling(inner).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "judge" }] }],
      responseFormat: { type: "json", schema: { type: "object" } }
    });
    expect(result.content).toEqual([{ type: "text", text: '{"protocolVersion":"agent-judgment-2","explanation":"ok","verdict":"holds"}' }]);
  });
});
