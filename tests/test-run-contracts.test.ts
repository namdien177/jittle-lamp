import { describe, expect, test } from "bun:test";

import { computeCostUsd, defaultModelPrices, findModelPrice } from "@jittle-lamp/shared";

describe("model prices", () => {
  test("seeded defaults price act and judge models and their claude-code aliases", () => {
    const opus = findModelPrice(defaultModelPrices, "anthropic/claude-opus-5-5");
    expect(opus).toMatchObject({ inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 });
    expect(findModelPrice(defaultModelPrices, "claude-code:sonnet")).toMatchObject({ inputUsdPerMtok: 2, outputUsdPerMtok: 10 });
    expect(findModelPrice(defaultModelPrices, "mock:mock-act")).toBeNull();
  });

  test("cost = input + cached input + (output + reasoning) at per-million rates", () => {
    const price = { modelId: "x", inputUsdPerMtok: 4, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 20 };
    // 1M input = $4, 1M cached = $0.20, 0.5M output + 0.5M reasoning = $20
    expect(computeCostUsd({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 500_000, reasoningTokens: 500_000 }, price)).toBe(24.2);
    expect(computeCostUsd({ inputTokens: 3700, cachedInputTokens: 1900, outputTokens: 90, reasoningTokens: 20 }, price)).toBe(0.01738);
  });
});
