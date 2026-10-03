import { afterEach, describe, expect, it } from "bun:test";

import { testAdminApi } from "../apps/evidence-web/src/test-cases/admin-api";
import { TestApiError } from "../apps/evidence-web/src/test-cases/api";
import { describeRunRequestError, formatWait } from "../apps/evidence-web/src/test-cases/run-errors";
import { isSubscribed, toggleSubscription } from "../apps/evidence-web/src/notifications/subscriptions";

// Review fixes for 1c.5: run request errors (429), error bodies, notification subscriptions and
// the optional channel route.

describe("run request errors", () => {
  const apiError = (code: string, details: Record<string, unknown>) => new TestApiError("server text", 429, code, { error: { code }, ...details });

  it("shows the wait for RATE_LIMITED and the depth for QUEUE_FULL", () => {
    expect(describeRunRequestError(apiError("RATE_LIMITED", { retryAfter: 42 }))).toEqual({
      code: "RATE_LIMITED",
      retryAfterSeconds: 42,
      message: "Too many run requests. Try again in 42 s."
    });
    expect(describeRunRequestError(apiError("RATE_LIMITED", { retryAfter: 300 })).message).toBe("Too many run requests. Try again in 5 min.");
    expect(describeRunRequestError(apiError("QUEUE_FULL", { depth: 3, maxQueuedPerCase: 3 })).message).toBe(
      "This case already has 3 queued runs (limit 3). Wait for one to start or cancel one."
    );
    expect(describeRunRequestError(apiError("QUEUE_FULL", { depth: 20, maxQueuedRuns: 20 })).message).toBe(
      "The organisation queue is full (20 of 20 queued). Try again when queued runs start."
    );
    expect(describeRunRequestError(new Error("Network down")).message).toBe("Network down");
    expect(describeRunRequestError(null).message).toBe("Run request failed.");
    expect(formatWait(0.2)).toBe("1 s");
  });
});

describe("admin client errors and optional routes", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });
  const respond = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  };
  const token = async () => "token";

  it("keeps the error body (409 currentVersion) on TestApiError", async () => {
    respond(409, { error: { code: "VERSION_CONFLICT", message: "Edited elsewhere" }, currentVersion: 7 });
    const failure = await testAdminApi.getTestCase(token, "c1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TestApiError);
    expect((failure as TestApiError).status).toBe(409);
    expect((failure as TestApiError).details).toMatchObject({ currentVersion: 7 });
  });

  it("treats a missing channel route as in-app only and reads subscriptions", async () => {
    respond(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    expect(await testAdminApi.listNotificationChannels(token)).toEqual([]);
    respond(200, { subscribed: ["run.finished"], unsubscribed: ["runner.offline"] });
    expect(await testAdminApi.getNotificationSubscriptions(token)).toEqual({ subscribed: ["run.finished"], unsubscribed: ["runner.offline"] });
  });
});

describe("notification subscriptions", () => {
  const perms = { canApprove: true, canManageConfig: false };
  it("defaults review events on for approvers and toggles kinds between lists", () => {
    const none = { subscribed: [], unsubscribed: [] };
    expect(isSubscribed("review.pending_count", none, perms)).toBe(true);
    expect(isSubscribed("runner.offline", none, perms)).toBe(false);
    expect(isSubscribed("run.finished", none, perms)).toBe(false);
    const off = toggleSubscription(none, "review.pending_count", false);
    expect(off).toEqual({ subscribed: [], unsubscribed: ["review.pending_count"] });
    expect(isSubscribed("review.pending_count", off, perms)).toBe(false);
    expect(toggleSubscription(off, "review.pending_count", true)).toEqual({ subscribed: ["review.pending_count"], unsubscribed: [] });
  });
});
