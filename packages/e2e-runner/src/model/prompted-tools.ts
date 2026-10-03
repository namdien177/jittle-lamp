import type {
  LanguageModelV4Usage,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Message,
  LanguageModelV4Prompt
} from "@ai-sdk/provider";

// Tool calling by prompt, for providers that cannot return AI SDK function-tool calls. The
// claude-code provider (development only, handover §4b) runs its own CLI tools and ignores
// `tools`, while e2e's act loop needs tool-call parts with `toolChoice: required`. This adapter
// describes the tools in the prompt, asks for one JSON object, and turns it back into tool calls.

type FunctionTool = { type: "function"; name: string; description?: string; inputSchema: unknown };

function functionTools(options: LanguageModelV4CallOptions): FunctionTool[] {
  return (options.tools ?? []).filter((tool): tool is FunctionTool & typeof tool => tool.type === "function") as FunctionTool[];
}

function stringifyOutput(output: unknown): string {
  if (output && typeof output === "object" && "type" in output && "value" in output) {
    const { type, value } = output as { type: string; value: unknown };
    if (type === "text" || type === "error-text") return String(value);
    if (type === "json" || type === "error-json") return JSON.stringify(value);
    if (type === "content" && Array.isArray(value)) {
      return value
        .map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : `[${part.type ?? "part"} omitted]`))
        .join("\n");
    }
  }
  return JSON.stringify(output);
}

function messageText(message: LanguageModelV4Message): string {
  if (message.role === "system") return message.content;
  return message.content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "reasoning":
          return "";
        case "tool-call":
          return `CALL ${part.toolName} ${typeof part.input === "string" ? part.input : JSON.stringify(part.input)}`;
        case "tool-result":
          return `RESULT ${part.toolName}: ${stringifyOutput(part.output)}`;
        case "file":
          return "[file omitted]";
        default:
          return "";
      }
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function toolProtocol(tools: readonly FunctionTool[], choice: LanguageModelV4CallOptions["toolChoice"]): string {
  const required =
    choice?.type === "tool"
      ? `You must call the tool "${choice.toolName}".`
      : choice?.type === "required"
        ? "You must call exactly one tool."
        : "Call a tool when one fits; otherwise reply with text.";
  const list = tools
    .map((tool) => `- ${tool.name}: ${tool.description ?? ""}\n  input JSON schema: ${JSON.stringify(tool.inputSchema)}`)
    .join("\n");
  return [
    "TOOL PROTOCOL. You cannot run tools yourself. Choose the next tool call and reply with ONLY one JSON object, no prose, no code fence, no second thoughts:",
    '{"tool": "<tool name>", "input": { ...arguments matching the schema... }}',
    required,
    "Available tools:",
    list
  ].join("\n");
}

function rewritePrompt(prompt: LanguageModelV4Prompt, protocol: string | null): LanguageModelV4Prompt {
  const system = prompt.filter((message) => message.role === "system").map(messageText);
  const turns = prompt.filter((message) => message.role !== "system");
  const transcript = turns
    .map((message) => `${message.role === "assistant" ? "ASSISTANT" : message.role === "tool" ? "TOOL" : "USER"}:\n${messageText(message)}`)
    .join("\n\n");
  return [
    { role: "system", content: [...system, ...(protocol ? [protocol] : [])].join("\n\n") },
    { role: "user", content: [{ type: "text", text: transcript }] }
  ];
}

// Every top-level JSON object in a reply, in order (fenced or not).
export function extractJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let quoted = false;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"' && depth > 0) quoted = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          out.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // not JSON; keep scanning
        }
        start = -1;
      }
    }
  }
  return out;
}

export function extractJsonObject(text: string): unknown {
  const found = extractJsonObjects(text);
  if (found.length === 0) throw new Error("no JSON object in model reply");
  return found[0];
}

// The tool call a reply settles on: a native tool-call part, else the last JSON object naming a
// known tool (models sometimes correct themselves mid-reply).
export function pickToolCall(
  content: readonly LanguageModelV4Content[],
  toolNames: ReadonlySet<string>
): { toolName: string; input: unknown } | null {
  const native = [...content].reverse().find((part) => part.type === "tool-call" && toolNames.has(part.toolName));
  if (native && native.type === "tool-call") {
    return { toolName: native.toolName, input: typeof native.input === "string" ? JSON.parse(native.input || "{}") : native.input };
  }
  const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  const candidates = extractJsonObjects(text)
    .filter((value): value is { tool: string; input?: unknown } => {
      const record = value as { tool?: unknown };
      return typeof record.tool === "string" && toolNames.has(record.tool);
    });
  const last = candidates.at(-1);
  return last ? { toolName: last.tool, input: last.input ?? {} } : null;
}

let bridgeCallCounter = 0;

const sum = (a: number | undefined, b: number | undefined) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
function addUsage(a: LanguageModelV4Usage, b: LanguageModelV4Usage): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: sum(a.inputTokens.total, b.inputTokens.total),
      noCache: sum(a.inputTokens.noCache, b.inputTokens.noCache),
      cacheRead: sum(a.inputTokens.cacheRead, b.inputTokens.cacheRead),
      cacheWrite: sum(a.inputTokens.cacheWrite, b.inputTokens.cacheWrite)
    },
    outputTokens: {
      total: sum(a.outputTokens.total, b.outputTokens.total),
      text: sum(a.outputTokens.text, b.outputTokens.text),
      reasoning: sum(a.outputTokens.reasoning, b.outputTokens.reasoning)
    }
  };
}

export function promptedToolCalling(inner: LanguageModelV4): LanguageModelV4 {
  const generate = async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4GenerateResult> => {
    const tools = functionTools(options);
    const wantsJson = options.responseFormat?.type === "json";
    const protocol = tools.length > 0 && options.toolChoice?.type !== "none" ? toolProtocol(tools, options.toolChoice) : null;
    const jsonHint =
      wantsJson && options.responseFormat?.type === "json" && options.responseFormat.schema
        ? `Reply with ONLY one JSON object matching this schema, no prose, no code fence: ${JSON.stringify(options.responseFormat.schema)}`
        : null;

    const { tools: _tools, toolChoice: _choice, responseFormat: _format, ...rest } = options;
    const instructions = [protocol, jsonHint].filter((part): part is string => part !== null).join("\n\n") || null;
    let prompt = rewritePrompt(options.prompt, instructions);
    let result = await inner.doGenerate({ ...rest, prompt });
    let usage = result.usage;

    if (protocol) {
      const names = new Set(tools.map((tool) => tool.name));
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const picked = pickToolCall(result.content, names);
        if (picked) {
          bridgeCallCounter += 1;
          const content: LanguageModelV4Content[] = [
            { type: "tool-call", toolCallId: `bridge-${bridgeCallCounter}`, toolName: picked.toolName, input: JSON.stringify(picked.input ?? {}) }
          ];
          return { ...result, usage, content, finishReason: { unified: "tool-calls", raw: "prompted-tool-call" } };
        }
        if (attempt === 1 || options.toolChoice?.type === "auto" || options.toolChoice === undefined) break;
        // One correction round: the reply was not a usable tool call.
        const replyText = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
        prompt = [
          ...prompt,
          { role: "assistant", content: [{ type: "text", text: replyText || "(empty)" }] },
          {
            role: "user",
            content: [{ type: "text", text: `That was not a valid tool call. Reply with ONLY one JSON object {"tool": <one of: ${[...names].join(", ")}>, "input": {...}} and nothing else.` }]
          }
        ];
        result = await inner.doGenerate({ ...rest, prompt });
        usage = addUsage(usage, result.usage);
      }
    }
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

    if (wantsJson) {
      const last = extractJsonObjects(text).at(-1);
      if (last !== undefined) return { ...result, usage, content: [{ type: "text", text: JSON.stringify(last) }] };
    }
    return { ...result, usage };
  };

  return {
    specificationVersion: "v4",
    provider: inner.provider,
    modelId: inner.modelId,
    supportedUrls: inner.supportedUrls,
    doGenerate: generate,
    async doStream(options) {
      const result = await generate(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            for (const part of result.content) {
              if (part.type === "text") {
                controller.enqueue({ type: "text-start", id: "t" });
                controller.enqueue({ type: "text-delta", id: "t", delta: part.text });
                controller.enqueue({ type: "text-end", id: "t" });
              } else if (part.type === "tool-call") controller.enqueue(part);
            }
            controller.enqueue({ type: "finish", usage: result.usage, finishReason: result.finishReason });
            controller.close();
          }
        })
      };
    }
  };
}
