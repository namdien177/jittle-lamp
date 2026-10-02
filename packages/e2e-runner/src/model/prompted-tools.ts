import type {
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
    "TOOL PROTOCOL. You cannot run tools yourself. Choose the next tool call and reply with ONLY one JSON object, no prose, no code fence:",
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

export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model reply");
  let depth = 0;
  let quoted = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (quoted) {
      if (char === "\\") index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, index + 1));
    }
  }
  throw new Error("unterminated JSON object in model reply");
}

let bridgeCallCounter = 0;

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
    const result = await inner.doGenerate({
      ...rest,
      prompt: rewritePrompt(options.prompt, [protocol, jsonHint].filter((part): part is string => part !== null).join("\n\n") || null)
    });
    const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

    if (protocol) {
      try {
        const parsed = extractJsonObject(text) as { tool?: unknown; input?: unknown };
        const name = typeof parsed.tool === "string" ? parsed.tool : "";
        if (tools.some((tool) => tool.name === name)) {
          bridgeCallCounter += 1;
          const content: LanguageModelV4Content[] = [
            { type: "tool-call", toolCallId: `bridge-${bridgeCallCounter}`, toolName: name, input: JSON.stringify(parsed.input ?? {}) }
          ];
          return { ...result, content, finishReason: { unified: "tool-calls", raw: "prompted-tool-call" } };
        }
      } catch {
        // Fall through: the caller sees text and retries or repairs, as with any provider.
      }
    }

    if (wantsJson) {
      try {
        return { ...result, content: [{ type: "text", text: JSON.stringify(extractJsonObject(text)) }] };
      } catch {
        return result;
      }
    }
    return result;
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
