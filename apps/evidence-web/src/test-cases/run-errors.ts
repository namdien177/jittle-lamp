// Run request failures as people should read them (design.md §10.3): rate limit with the wait, a
// full queue with its depth, anything else with the server's message. Used by every place that
// requests runs (the run dialog, the bulk "Run" action).

export type RunRequestErrorView = { message: string; code: string | null; retryAfterSeconds: number | null };

type ErrorLike = { message?: unknown; status?: unknown; code?: unknown; details?: unknown };

function numberField(source: unknown, key: string): number | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatWait(seconds: number): string {
  const whole = Math.max(1, Math.ceil(seconds));
  if (whole < 90) return `${whole} s`;
  const minutes = Math.round(whole / 60);
  return `${minutes} min`;
}

export function describeRunRequestError(error: unknown): RunRequestErrorView {
  const like = (error && typeof error === "object" ? error : {}) as ErrorLike;
  const message = typeof like.message === "string" && like.message.length > 0 ? like.message : "Run request failed.";
  const code = typeof like.code === "string" ? like.code : null;
  const details = like.details;
  if (code === "RATE_LIMITED") {
    const retryAfter = numberField(details, "retryAfter");
    return {
      code,
      retryAfterSeconds: retryAfter,
      message: retryAfter === null ? "Too many run requests. Try again shortly." : `Too many run requests. Try again in ${formatWait(retryAfter)}.`
    };
  }
  if (code === "QUEUE_FULL") {
    const depth = numberField(details, "depth");
    const perCase = numberField(details, "maxQueuedPerCase");
    const orgLimit = numberField(details, "maxQueuedRuns");
    if (perCase !== null) {
      return { code, retryAfterSeconds: null, message: `This case already has ${depth ?? perCase} queued run${depth === 1 ? "" : "s"} (limit ${perCase}). Wait for one to start or cancel one.` };
    }
    if (orgLimit !== null) {
      return { code, retryAfterSeconds: null, message: `The organisation queue is full (${depth ?? orgLimit} of ${orgLimit} queued). Try again when queued runs start.` };
    }
    return { code, retryAfterSeconds: null, message };
  }
  return { code, retryAfterSeconds: null, message };
}
