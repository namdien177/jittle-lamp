import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata
} from "@ai-sdk/provider";
import {
  computeCostUsd,
  findModelPrice,
  type ModelAccountEvent,
  type ModelAccountEventKind,
  type ModelAccountUsage,
  type ModelPrice,
  type RunModelAccount,
  type RunModelAccountsReport
} from "@jittle-lamp/shared";

// Model account failover (design.md §9.3, ADR 0002 amendment 2026-10-13), the way CLIProxy
// rotates keys: one provider model per account, tried in priority order. A rate limit, an
// exhausted quota or a rejected key moves the call to the next account; any other error is the
// call's own and is thrown as it is. The AI SDK's retries run around this wrapper, so when the
// last account fails the SDK backs off and asks again.
//
// Each account carries what was left of its budget when the run started. Calls are priced as
// they finish; an account with `overBudget: "stop"` is skipped once its share is spent, and the
// run stops with BUDGET_EXCEEDED when no other account is left. `finish` accounts keep serving.

export type FailoverAccount = { account: RunModelAccount; model: LanguageModelV4 };

export type ModelAccountLogEntry =
  | { type: "usage"; usage: ModelAccountUsage }
  | { type: "event"; event: ModelAccountEvent }
  | { type: "stopped"; at: string; message: string };

export class ModelBudgetExceededError extends Error {
  readonly code = "BUDGET_EXCEEDED";
  constructor(message: string) {
    super(message);
    this.name = "ModelBudgetExceededError";
  }
}

// Per-account state of one process: spend so far, cooldown, rejected key, spent budget. The act
// and judge models share one when they use the same provider, so both count against its budget.
export type AccountState = { spentUsd: number; coolingUntil: number; rejected: boolean; exhausted: boolean };
export type AccountLedger = Map<string, AccountState>;
export const createAccountLedger = (): AccountLedger => new Map();

type Failure = { kind: Exclude<ModelAccountEventKind, "budget_exhausted">; retryAfterMs: number | null };

const header = (headers: Record<string, string> | undefined, name: string): string | undefined => {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
};

export function retryAfterMs(headers: Record<string, string> | undefined, now = Date.now()): number | null {
  const ms = header(headers, "retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Math.round(Number(ms)));
  const value = header(headers, "retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

const quotaPattern = /insufficient[_ ]quota|quota|billing|credit|payment required|exceeded your current/i;

// Which account failures move a call to the next account; null for the call's own errors.
export function classifyAccountError(error: unknown): Failure | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { statusCode?: unknown; status?: unknown; responseHeaders?: Record<string, string>; responseBody?: unknown; message?: unknown };
  const status = typeof candidate.statusCode === "number" ? candidate.statusCode : typeof candidate.status === "number" ? candidate.status : null;
  const text = `${typeof candidate.message === "string" ? candidate.message : ""} ${typeof candidate.responseBody === "string" ? candidate.responseBody : ""}`;
  if (status === 401 || status === 403) return { kind: "auth_failed", retryAfterMs: null };
  if (status === 402) return { kind: "quota_exhausted", retryAfterMs: null };
  if (status === 429) {
    return quotaPattern.test(text)
      ? { kind: "quota_exhausted", retryAfterMs: retryAfterMs(candidate.responseHeaders) }
      : { kind: "rate_limited", retryAfterMs: retryAfterMs(candidate.responseHeaders) };
  }
  return null;
}

const usageCounts = (usage: LanguageModelV4Usage) => ({
  inputTokens: usage.inputTokens.noCache ?? Math.max(0, (usage.inputTokens.total ?? 0) - (usage.inputTokens.cacheRead ?? 0)),
  cachedInputTokens: usage.inputTokens.cacheRead ?? 0,
  outputTokens: usage.outputTokens.text ?? Math.max(0, (usage.outputTokens.total ?? 0) - (usage.outputTokens.reasoning ?? 0)),
  reasoningTokens: usage.outputTokens.reasoning ?? 0
});

// OpenRouter reports what each call cost; other providers are priced from the price table.
const providerCost = (metadata: SharedV4ProviderMetadata | undefined): number | null => {
  const usage = (metadata?.openrouter as { usage?: { cost?: unknown } } | undefined)?.usage;
  return typeof usage?.cost === "number" && usage.cost >= 0 ? usage.cost : null;
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

export function failoverModel(input: {
  modelId: string;
  accounts: readonly FailoverAccount[];
  prices?: readonly ModelPrice[];
  log?: (entry: ModelAccountLogEntry) => void;
  ledger?: AccountLedger;
  now?: () => number;
}): LanguageModelV4 {
  const first = input.accounts[0];
  if (!first) throw new Error("failoverModel needs at least one account");
  const now = input.now ?? Date.now;
  const price = input.prices ? findModelPrice(input.prices, input.modelId) : null;
  const state = input.ledger ?? createAccountLedger();
  for (const { account } of input.accounts) {
    if (!state.has(account.id)) state.set(account.id, { spentUsd: 0, coolingUntil: 0, rejected: false, exhausted: false });
  }
  const stateOf = (id: string) => state.get(id)!;
  const log = input.log ?? (() => undefined);

  // Accounts in the order to try now: the healthy ones by priority, then those cooling down from
  // a rate limit (soonest first). Rejected keys and spent `stop` accounts are left out.
  const candidates = (): FailoverAccount[] => {
    const at = now();
    const open = input.accounts.filter(({ account }) => !stateOf(account.id).rejected && !stateOf(account.id).exhausted);
    return [
      ...open.filter(({ account }) => stateOf(account.id).coolingUntil <= at),
      ...open.filter(({ account }) => stateOf(account.id).coolingUntil > at).sort((a, b) => stateOf(a.account.id).coolingUntil - stateOf(b.account.id).coolingUntil)
    ];
  };

  // The error of the last key a provider rejected, thrown again once no account is left.
  let rejection: unknown;
  const fail = (account: RunModelAccount, failure: Failure, error: unknown) => {
    const entry = stateOf(account.id);
    if (failure.kind === "auth_failed") {
      entry.rejected = true;
      rejection = error;
    }
    entry.coolingUntil = now() + (failure.retryAfterMs ?? (failure.kind === "rate_limited" ? 30_000 : 60 * 60_000));
    log({
      type: "event",
      event: { accountId: account.id, kind: failure.kind, at: new Date(now()).toISOString(), retryAfterMs: failure.retryAfterMs, message: errorMessage(error) }
    });
  };

  const record = (account: RunModelAccount, usage: LanguageModelV4Usage, metadata: SharedV4ProviderMetadata | undefined) => {
    const counts = usageCounts(usage);
    const costUsd = providerCost(metadata) ?? (price ? computeCostUsd(counts, price) : null);
    log({ type: "usage", usage: { accountId: account.id, modelId: input.modelId, calls: 1, ...counts, costUsd } });
    const entry = stateOf(account.id);
    entry.spentUsd += costUsd ?? 0;
    if (account.remainingUsd !== null && account.overBudget === "stop" && !entry.exhausted && entry.spentUsd >= account.remainingUsd) {
      entry.exhausted = true;
      log({
        type: "event",
        event: {
          accountId: account.id,
          kind: "budget_exhausted",
          at: new Date(now()).toISOString(),
          retryAfterMs: null,
          message: `Spent $${entry.spentUsd.toFixed(4)} of the $${account.remainingUsd.toFixed(4)} left in its budget.`
        }
      });
    }
  };

  const noneLeft = (lastError: unknown): never => {
    if (lastError !== undefined) throw lastError;
    const spent = input.accounts.some(({ account }) => stateOf(account.id).exhausted);
    if (!spent) throw rejection ?? new Error("No model account is left for this run.");
    const message = "Every model account that may serve this run has spent its budget.";
    log({ type: "stopped", at: new Date(now()).toISOString(), message });
    throw new ModelBudgetExceededError(message);
  };

  async function attempt<T>(call: (target: FailoverAccount) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (const target of candidates()) {
      try {
        return await call(target);
      } catch (error) {
        const failure = classifyAccountError(error);
        if (!failure) throw error;
        fail(target.account, failure, error);
        lastError = error;
      }
    }
    return noneLeft(lastError);
  }

  return {
    specificationVersion: "v4",
    provider: first.model.provider,
    modelId: first.model.modelId,
    supportedUrls: first.model.supportedUrls,
    doGenerate(options: LanguageModelV4CallOptions) {
      return attempt(async (target) => {
        const result = await target.model.doGenerate(options);
        record(target.account, result.usage, result.providerMetadata);
        return result;
      });
    },
    doStream(options: LanguageModelV4CallOptions) {
      return attempt(async (target) => {
        const result = await target.model.doStream(options);
        const counted = result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === "finish") record(target.account, part.usage, part.providerMetadata);
              controller.enqueue(part);
            }
          })
        );
        return { ...result, stream: counted };
      });
    }
  };
}

// Folds a run's account log (JSONL entries) into what the run report carries.
export function summarizeAccountLog(entries: readonly ModelAccountLogEntry[]): RunModelAccountsReport {
  const usage = new Map<string, ModelAccountUsage>();
  const events: ModelAccountEvent[] = [];
  let stopped = false;
  for (const entry of entries) {
    if (entry.type === "event") events.push(entry.event);
    else if (entry.type === "stopped") stopped = true;
    else {
      const key = `${entry.usage.accountId}\u0000${entry.usage.modelId}`;
      const current = usage.get(key);
      usage.set(
        key,
        current
          ? {
              ...current,
              calls: current.calls + entry.usage.calls,
              inputTokens: current.inputTokens + entry.usage.inputTokens,
              cachedInputTokens: current.cachedInputTokens + entry.usage.cachedInputTokens,
              outputTokens: current.outputTokens + entry.usage.outputTokens,
              reasoningTokens: current.reasoningTokens + entry.usage.reasoningTokens,
              costUsd:
                current.costUsd === null && entry.usage.costUsd === null
                  ? null
                  : Math.round(((current.costUsd ?? 0) + (entry.usage.costUsd ?? 0)) * 1_000_000) / 1_000_000
            }
          : entry.usage
      );
    }
  }
  return { usage: [...usage.values()], events, stopped };
}
