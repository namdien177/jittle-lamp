import { describe, expect, test } from "bun:test";

import { APICallError, type LanguageModelV4, type LanguageModelV4CallOptions, type LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import type { RunModelAccount } from "@jittle-lamp/shared";

import {
  classifyAccountError,
  createAccountLedger,
  failoverModel,
  ModelBudgetExceededError,
  retryAfterMs,
  summarizeAccountLog,
  type ModelAccountLogEntry
} from "../src/model/failover";
import { resolveModel } from "../src/model/providers";

// Model account failover (design.md §9.3): rate limits, quotas and rejected keys move a call to
// the next account; per-account spend stops `stop` accounts at their budget.

const options: LanguageModelV4CallOptions = { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };

const result = (inputTokens: number, outputTokens: number): LanguageModelV4GenerateResult => ({
  content: [{ type: "text", text: "ok" }],
  finishReason: { unified: "stop", raw: undefined },
  usage: {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 }
  },
  warnings: []
});

const apiError = (statusCode: number, extra: { headers?: Record<string, string>; body?: string } = {}) =>
  new APICallError({
    message: `HTTP ${statusCode}`,
    url: "https://api.example.test",
    requestBodyValues: {},
    statusCode,
    ...(extra.headers ? { responseHeaders: extra.headers } : {}),
    ...(extra.body ? { responseBody: extra.body } : {})
  });

// A model whose calls follow a script: an error to throw or a result to return.
const scripted = (steps: Array<Error | LanguageModelV4GenerateResult>) => {
  let calls = 0;
  const model: LanguageModelV4 = {
    specificationVersion: "v4",
    provider: "anthropic.messages",
    modelId: "claude-opus-5-5",
    supportedUrls: {},
    async doGenerate() {
      const step = steps[Math.min(calls, steps.length - 1)];
      calls += 1;
      if (step instanceof Error) throw step;
      return step!;
    },
    async doStream() {
      throw new Error("not used");
    }
  };
  return { model, calls: () => calls };
};

const account = (id: string, extra: Partial<RunModelAccount> = {}): RunModelAccount => ({
  id,
  provider: "anthropic",
  label: id,
  apiKey: `key-${id}`,
  baseUrl: null,
  remainingUsd: null,
  overBudget: "finish",
  ...extra
});

const price = { modelId: "anthropic/claude-opus-5-5", inputUsdPerMtok: 1_000_000, cachedInputUsdPerMtok: 0, outputUsdPerMtok: 0 };

describe("model account failover", () => {
  test("classifies rate limits, quotas and rejected keys, and nothing else", () => {
    expect(classifyAccountError(apiError(429, { headers: { "Retry-After": "7" } }))).toEqual({ kind: "rate_limited", retryAfterMs: 7000 });
    expect(classifyAccountError(apiError(429, { body: '{"error":{"code":"insufficient_quota"}}' }))?.kind).toBe("quota_exhausted");
    expect(classifyAccountError(apiError(402))?.kind).toBe("quota_exhausted");
    expect(classifyAccountError(apiError(401))?.kind).toBe("auth_failed");
    expect(classifyAccountError(apiError(403))?.kind).toBe("auth_failed");
    expect(classifyAccountError(apiError(400))).toBeNull();
    expect(classifyAccountError(apiError(500))).toBeNull();
    expect(classifyAccountError(new Error("context length exceeded"))).toBeNull();
    expect(retryAfterMs({ "retry-after-ms": "250" })).toBe(250);
  });

  test("moves a rate-limited call to the next account and stays there while the first cools down", async () => {
    let now = 1_000_000;
    const first = scripted([apiError(429, { headers: { "retry-after": "60" } }), result(10, 5)]);
    const second = scripted([result(10, 5)]);
    const log: ModelAccountLogEntry[] = [];
    const model = failoverModel({
      modelId: "anthropic/claude-opus-5-5",
      accounts: [
        { account: account("a"), model: first.model },
        { account: account("b"), model: second.model }
      ],
      log: (entry) => log.push(entry),
      now: () => now
    });
    await model.doGenerate(options);
    await model.doGenerate(options);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(2);
    expect(log.filter((entry) => entry.type === "event")).toMatchObject([
      { type: "event", event: { accountId: "a", kind: "rate_limited", retryAfterMs: 60_000 } }
    ]);
    // Once the cooldown ends the first account serves again.
    now += 61_000;
    await model.doGenerate(options);
    expect(first.calls()).toBe(2);
    expect(summarizeAccountLog(log).usage).toMatchObject([
      { accountId: "b", calls: 2 },
      { accountId: "a", calls: 1 }
    ]);
  });

  test("throws the call's own errors without trying other accounts", async () => {
    const first = scripted([apiError(400)]);
    const second = scripted([result(1, 1)]);
    const model = failoverModel({
      modelId: "anthropic/claude-opus-5-5",
      accounts: [
        { account: account("a"), model: first.model },
        { account: account("b"), model: second.model }
      ]
    });
    await expect(model.doGenerate(options)).rejects.toMatchObject({ statusCode: 400 });
    expect(second.calls()).toBe(0);
  });

  test("never retries a rejected key and rethrows the last error when every account fails", async () => {
    const first = scripted([apiError(401)]);
    const second = scripted([apiError(429)]);
    const model = failoverModel({
      modelId: "anthropic/claude-opus-5-5",
      accounts: [
        { account: account("a"), model: first.model },
        { account: account("b"), model: second.model }
      ]
    });
    await expect(model.doGenerate(options)).rejects.toMatchObject({ statusCode: 429 });
    // The SDK retries: the cooling account is tried again, the rejected key is not.
    await expect(model.doGenerate(options)).rejects.toMatchObject({ statusCode: 429 });
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(2);
  });

  test("a `stop` account leaves at its budget and the run stops when no account is left", async () => {
    // 1 input token costs $1 at this price.
    const stop = scripted([result(3, 0)]);
    const log: ModelAccountLogEntry[] = [];
    const ledger = createAccountLedger();
    const make = () =>
      failoverModel({
        modelId: "anthropic/claude-opus-5-5",
        accounts: [{ account: account("a", { remainingUsd: 5, overBudget: "stop" }), model: stop.model }],
        prices: [price],
        log: (entry) => log.push(entry),
        ledger
      });
    // Act and judge share the ledger, so both count against the same budget.
    const act = make();
    const judge = make();
    await act.doGenerate(options);
    await judge.doGenerate(options);
    await expect(act.doGenerate(options)).rejects.toBeInstanceOf(ModelBudgetExceededError);
    const summary = summarizeAccountLog(log);
    expect(summary.stopped).toBe(true);
    expect(summary.usage).toEqual([
      { accountId: "a", modelId: "anthropic/claude-opus-5-5", calls: 2, inputTokens: 6, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 6 }
    ]);
    expect(summary.events.map((event) => event.kind)).toEqual(["budget_exhausted"]);
  });

  test("a `finish` account keeps serving past its budget, and a `stop` account hands over to the next", async () => {
    const finish = scripted([result(3, 0)]);
    const model = failoverModel({
      modelId: "anthropic/claude-opus-5-5",
      accounts: [{ account: account("a", { remainingUsd: 1, overBudget: "finish" }), model: finish.model }],
      prices: [price]
    });
    await model.doGenerate(options);
    await model.doGenerate(options);
    expect(finish.calls()).toBe(2);

    const stop = scripted([result(3, 0)]);
    const next = scripted([result(1, 0)]);
    const handover = failoverModel({
      modelId: "anthropic/claude-opus-5-5",
      accounts: [
        { account: account("a", { remainingUsd: 1, overBudget: "stop" }), model: stop.model },
        { account: account("b"), model: next.model }
      ],
      prices: [price]
    });
    await handover.doGenerate(options);
    await handover.doGenerate(options);
    expect(stop.calls()).toBe(1);
    expect(next.calls()).toBe(1);
  });

  test("resolveModel builds one provider per account with only that account's key", async () => {
    const resolved = await resolveModel("anthropic/claude-opus-5-5", {
      keys: { ANTHROPIC_API_KEY: "env-key-should-not-be-used" },
      accounts: [account("a"), account("b"), account("other", { provider: "openai" })]
    });
    expect(resolved.model.specificationVersion).toBe("v4");
    expect(resolved.model.modelId).toBe("claude-opus-5-5");
  });
});
