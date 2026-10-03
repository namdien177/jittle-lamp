import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage
} from "@ai-sdk/provider";
import { z } from "zod/v4";

// `mock:<fixture>` replays recorded model turns from a JSON file, with no network. Every parser,
// replay, queue, backend and UI test runs on it (handover §4b). A turn is picked by its `match`
// (tools offered, prompt text) so fixtures survive small prompt changes; turns without `match`
// are consumed in order.

const toolCallInputSchema: z.ZodType<unknown> = z.unknown();

export const mockTurnSchema = z.object({
  match: z
    .object({
      tools: z.array(z.string().min(1)).optional(),
      // Only calls that offer no tools (judge calls for assert, waitFor and extract).
      noTools: z.boolean().optional(),
      promptIncludes: z.array(z.string().min(1)).optional()
    })
    .optional(),
  // Repeat this turn instead of consuming it (handy for "done" or judge turns).
  repeat: z.boolean().default(false),
  // Simulated model latency, for tests that need a step to take a while.
  delayMs: z.number().int().nonnegative().default(0),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("reasoning"), text: z.string() }),
      z.object({ type: z.literal("tool-call"), toolName: z.string().min(1), input: toolCallInputSchema })
    ])
  ),
  finishReason: z.enum(["stop", "length", "content-filter", "tool-calls", "error", "other"]).optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().default(0),
      cachedInputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      reasoningTokens: z.number().int().nonnegative().default(0)
    })
    .default({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
});

export const mockFixtureSchema = z.object({
  schemaVersion: z.literal(1),
  description: z.string().optional(),
  modelId: z.string().min(1).default("mock-model"),
  turns: z.array(mockTurnSchema)
});

export type MockTurn = z.infer<typeof mockTurnSchema>;
export type MockFixture = z.infer<typeof mockFixtureSchema>;

export type MockCallLog = {
  turnIndex: number;
  tools: string[];
};

export function promptText(options: LanguageModelV4CallOptions): string {
  return JSON.stringify(options.prompt);
}

function offeredTools(options: LanguageModelV4CallOptions): string[] {
  return (options.tools ?? []).map((tool) => ("name" in tool ? tool.name : "")).filter((name) => name.length > 0);
}

// `{ "$refFor": { "role": "button", "name": "Save" } }` inside a tool input is replaced by the
// element id the current screen gives that control, so fixtures do not depend on id numbering.
// e2e lists the screen as `#n6 button "Save"`; playwright-mcp style `- button "Save" [ref=e12]`
// is accepted too.
export function resolveRefPlaceholders(input: unknown, prompt: string): unknown {
  if (Array.isArray(input)) return input.map((item) => resolveRefPlaceholders(item, prompt));
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const target = record.$refFor;
  if (target && typeof target === "object") {
    const { role, name } = target as { role?: string; name?: string };
    const text = prompt.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    const lines = text.split("\n");
    const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rolePart = role ? escaped(role) : "[\\w-]+";
    const namePart = name ? escaped(name) : '[^"]*';
    const e2eStyle = new RegExp(`#([\\w-]+)\\s+${rolePart}\\s+"${namePart}"`);
    const mcpStyle = new RegExp(`${rolePart}\\s+"${namePart}"[^\\n]*?\\[ref=([\\w-]+)\\]`);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      const match = e2eStyle.exec(line) ?? mcpStyle.exec(line);
      if (match?.[1]) return match[1];
    }
    throw new Error(`mock model: no element ${role ?? "*"} "${name ?? "*"}" in the current screen.`);
  }
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolveRefPlaceholders(value, prompt)]));
}

function toUsage(turn: MockTurn): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: turn.usage.inputTokens + turn.usage.cachedInputTokens,
      noCache: turn.usage.inputTokens,
      cacheRead: turn.usage.cachedInputTokens,
      cacheWrite: 0
    },
    outputTokens: {
      total: turn.usage.outputTokens + turn.usage.reasoningTokens,
      text: turn.usage.outputTokens,
      reasoning: turn.usage.reasoningTokens
    }
  };
}

export class MockReplayModel implements LanguageModelV4 {
  readonly specificationVersion = "v4" as const;
  readonly provider = "mock";
  readonly modelId: string;
  readonly supportedUrls = {};
  readonly calls: MockCallLog[] = [];
  private readonly used = new Set<number>();
  private callCounter = 0;

  constructor(private readonly fixture: MockFixture, modelId?: string) {
    this.modelId = modelId ?? fixture.modelId;
  }

  static fromFile(path: string, modelId?: string): MockReplayModel {
    if (!existsSync(path)) throw new Error(`mock model fixture not found: ${path}`);
    return new MockReplayModel(mockFixtureSchema.parse(JSON.parse(readFileSync(path, "utf8"))), modelId);
  }

  private pick(options: LanguageModelV4CallOptions): { turn: MockTurn; index: number } {
    const tools = offeredTools(options);
    const prompt = promptText(options);
    for (const [index, turn] of this.fixture.turns.entries()) {
      if (this.used.has(index)) continue;
      const match = turn.match;
      if (match?.tools && !match.tools.every((tool) => tools.includes(tool))) continue;
      if (match?.noTools && tools.length > 0) continue;
      if (match?.promptIncludes && !match.promptIncludes.every((text) => prompt.includes(text))) continue;
      if (!turn.repeat) this.used.add(index);
      this.calls.push({ turnIndex: index, tools });
      return { turn, index };
    }
    throw new Error(
      `mock model: fixture has no unused turn for this call (tools offered: ${tools.join(", ") || "none"}; ${this.calls.length} calls served).`
    );
  }

  private content(turn: MockTurn, options: LanguageModelV4CallOptions): LanguageModelV4Content[] {
    const prompt = promptText(options);
    return turn.content.map((part): LanguageModelV4Content => {
      if (part.type === "text") return { type: "text", text: part.text };
      if (part.type === "reasoning") return { type: "reasoning", text: part.text };
      this.callCounter += 1;
      return {
        type: "tool-call",
        toolCallId: `mock-call-${this.callCounter}`,
        toolName: part.toolName,
        input: JSON.stringify(resolveRefPlaceholders(part.input ?? {}, prompt))
      };
    });
  }

  async doGenerate(options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> {
    const { turn } = this.pick(options);
    if (turn.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    const content = this.content(turn, options);
    const hasToolCall = content.some((part) => part.type === "tool-call");
    return {
      content,
      finishReason: { unified: turn.finishReason ?? (hasToolCall ? "tool-calls" : "stop"), raw: undefined },
      usage: toUsage(turn),
      response: { id: `mock-${this.calls.length}`, modelId: this.modelId, timestamp: new Date(0) },
      warnings: []
    };
  }

  async doStream(options: LanguageModelV4CallOptions) {
    const result = await this.doGenerate(options);
    const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
    result.content.forEach((part, index) => {
      if (part.type === "text") {
        parts.push({ type: "text-start", id: `t${index}` }, { type: "text-delta", id: `t${index}`, delta: part.text }, { type: "text-end", id: `t${index}` });
      } else if (part.type === "reasoning") {
        parts.push(
          { type: "reasoning-start", id: `r${index}` },
          { type: "reasoning-delta", id: `r${index}`, delta: part.text },
          { type: "reasoning-end", id: `r${index}` }
        );
      } else if (part.type === "tool-call") {
        parts.push(part);
      }
    });
    parts.push({ type: "finish", usage: result.usage, finishReason: result.finishReason });
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        }
      })
    };
  }
}

// Wraps a real model and appends every turn to a fixture file, so a run on a real model can be
// replayed later by `mock:<fixture>` without a key.
export function recordingModel(inner: LanguageModelV4, fixturePath: string): LanguageModelV4 {
  const fixture: MockFixture = { schemaVersion: 1, modelId: inner.modelId, turns: [] };
  const save = () => writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  const record = (options: LanguageModelV4CallOptions, result: LanguageModelV4GenerateResult) => {
    const tools = offeredTools(options);
    fixture.turns.push({
      match: tools.length > 0 ? { tools } : undefined,
      repeat: false,
      delayMs: 0,
      content: result.content.flatMap((part): MockTurn["content"] => {
        if (part.type === "text") return [{ type: "text" as const, text: part.text }];
        if (part.type === "reasoning") return [{ type: "reasoning" as const, text: part.text }];
        if (part.type === "tool-call") {
          return [{ type: "tool-call" as const, toolName: part.toolName, input: JSON.parse(part.input) as unknown }];
        }
        return [];
      }),
      finishReason: result.finishReason.unified,
      usage: {
        inputTokens: result.usage.inputTokens.noCache ?? result.usage.inputTokens.total ?? 0,
        cachedInputTokens: result.usage.inputTokens.cacheRead ?? 0,
        outputTokens: result.usage.outputTokens.text ?? result.usage.outputTokens.total ?? 0,
        reasoningTokens: result.usage.outputTokens.reasoning ?? 0
      }
    });
    save();
  };

  return {
    specificationVersion: "v4",
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    async doGenerate(options) {
      const result = await inner.doGenerate(options);
      record(options, result);
      return result;
    },
    async doStream(options) {
      // Recording needs whole turns; generate and re-stream.
      const result = await inner.doGenerate(options);
      record(options, result);
      const replay = new MockReplayModel({ schemaVersion: 1, modelId: inner.modelId, turns: [fixture.turns.at(-1) as MockTurn] });
      return replay.doStream(options);
    }
  };
}
