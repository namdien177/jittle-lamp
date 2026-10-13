import { describe, expect, test } from "bun:test";

import {
  blockedReasonSchema,
  computeCostUsd,
  defaultModelPrices,
  executionModeSchema,
  findModelPrice,
  modelPriceCandidates,
  resolveModelPrice,
  runReportSchema,
  runStepResultSchema,
  testRunStepModeSchema
} from "@jittle-lamp/shared";

describe("model prices", () => {
  test("seeded defaults price act and judge models and their claude-code aliases", () => {
    const opus = findModelPrice(defaultModelPrices, "anthropic/claude-opus-5-5");
    expect(opus).toMatchObject({ inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 });
    expect(findModelPrice(defaultModelPrices, "claude-code:sonnet")).toMatchObject({ inputUsdPerMtok: 2, outputUsdPerMtok: 10 });
    expect(findModelPrice(defaultModelPrices, "mock:mock-act")).toBeNull();
  });

  test("router ids are priced like the vendor model unless the router id has its own row", () => {
    expect(resolveModelPrice(defaultModelPrices, "openrouter/anthropic/claude-sonnet-5-5")).toMatchObject({
      matchedModelId: "anthropic/claude-sonnet-5-5",
      price: { inputUsdPerMtok: 2, outputUsdPerMtok: 10 }
    });
    // OpenRouter lists dotted versions.
    expect(resolveModelPrice(defaultModelPrices, "openrouter/anthropic/claude-opus-5.5")?.matchedModelId).toBe("anthropic/claude-opus-5-5");
    expect(resolveModelPrice(defaultModelPrices, "gateway/anthropic/claude-haiku-4-5")?.matchedModelId).toBe("gateway/anthropic/claude-haiku-4-5");
    const orgRows = [
      ...defaultModelPrices,
      { modelId: "openai/gpt-5", inputUsdPerMtok: 1.25, cachedInputUsdPerMtok: 0.125, outputUsdPerMtok: 10 },
      { modelId: "openrouter/anthropic/claude-sonnet-5-5", inputUsdPerMtok: 3, cachedInputUsdPerMtok: 0.3, outputUsdPerMtok: 15 }
    ];
    expect(resolveModelPrice(orgRows, "gateway/openai/gpt-5")?.matchedModelId).toBe("openai/gpt-5");
    expect(resolveModelPrice(orgRows, "openrouter/openai/gpt-5")?.price.inputUsdPerMtok).toBe(1.25);
    expect(resolveModelPrice(orgRows, "openrouter/anthropic/claude-sonnet-5-5")?.price.inputUsdPerMtok).toBe(3);
    // No row and no vendor equivalent: cost unknown.
    expect(findModelPrice(orgRows, "openai-compatible/llama-3.3-70b")).toBeNull();
    expect(findModelPrice(orgRows, "xai/grok-4")).toBeNull();
    expect(modelPriceCandidates("openrouter/meta-llama/llama-3.3-70b")).toEqual(["openrouter/meta-llama/llama-3.3-70b", "meta-llama/llama-3.3-70b", "openrouter/meta-llama/llama-3-3-70b", "meta-llama/llama-3-3-70b"]);
  });

  test("cost = input + cached input + (output + reasoning) at per-million rates", () => {
    const price = { modelId: "x", inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 };
    // 1M input = $4, 1M cached = $0.20, 0.5M output + 0.5M reasoning = $20
    expect(computeCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 500_000 }, price)).toBe(24.2);
    expect(computeCostUsd({ inputTokens: 3700, cachedInputTokens: 1900, outputTokens: 90, reasoningTokens: 20 }, price)).toBe(0.01738);
  });
});

describe("run schemas (roadmap 2026-10-13 §2.5, §5)", () => {
  const step = {
    stepId: "st_1",
    parentStepId: null,
    ordinal: 1,
    type: "query",
    label: "a K1 student -> {student}",
    checkpointId: null,
    status: "passed",
    mode: "query",
    cacheReason: null,
    startedAt: "2026-10-13T00:00:00.000Z",
    finishedAt: "2026-10-13T00:00:01.000Z",
    durationMs: 1000,
    videoOffsetMs: null,
    observed: null,
    error: null,
    screenshot: null,
    actions: 0,
    usage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null },
    visionInput: false
  };

  test("execution modes, step modes and blocked reasons", () => {
    expect(executionModeSchema.options).toEqual(["full", "hybrid", "api"]);
    expect(testRunStepModeSchema.options).toEqual(expect.arrayContaining(["api-replayed", "api-handoff", "query", "agent", "replayed"]));
    expect(blockedReasonSchema.options).toEqual(expect.arrayContaining(["API_NOT_CONFIGURED", "DATABASE_UNREACHABLE", "QUERY_REJECTED", "NO_RUNNER"]));
  });

  test("step outputs and request summaries are optional, so old runner reports still validate", () => {
    expect(runStepResultSchema.parse(step)).not.toHaveProperty("outputs");
    const withOutputs = runStepResultSchema.parse({
      ...step,
      mode: "api-replayed",
      outputs: { "student.id": "4711", applicationId: "APP-1" },
      requests: { count: 3, mutations: 1 }
    });
    expect(withOutputs.outputs).toEqual({ "student.id": "4711", applicationId: "APP-1" });
    expect(withOutputs.requests).toEqual({ count: 3, mutations: 1 });
    expect(runStepResultSchema.safeParse({ ...step, requests: { count: -1, mutations: 0 } }).success).toBe(false);
    expect(runStepResultSchema.safeParse({ ...step, outputs: { id: 4711 } }).success).toBe(false);
  });

  test("the run report's execution mode is optional", () => {
    const shape = runReportSchema.pick({ executionMode: true, blockedReason: true });
    expect(shape.parse({ blockedReason: "API_NOT_CONFIGURED" })).toEqual({ blockedReason: "API_NOT_CONFIGURED" });
    expect(shape.parse({ executionMode: "api", blockedReason: null }).executionMode).toBe("api");
    expect(shape.safeParse({ executionMode: "fast", blockedReason: null }).success).toBe(false);
  });
});
