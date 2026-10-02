import type { Notification, TestRunDetail, TestRunStatus, TestRunSummary } from "@jittle-lamp/shared";

import { isSafeRunId, parseDeepLink, type DeepLinkTarget } from "../../deep-link";

// Live progress of one run (design.md §5.4 "Progress while a run executes"): the run detail page
// polls GET /test-runs/:id every 2 s while the run is queued or executing, backs off on errors and
// stops once the run settles. Pure state machine; the React hook only schedules timers.

export const runPollIntervalMs = 2_000;
export const runPollMaxBackoffMs = 30_000;
// Without any loaded run, give up after this many failures and show the error with a retry.
export const runPollMaxInitialErrors = 3;

const activeStatuses: ReadonlySet<TestRunStatus> = new Set(["queued", "claimed", "running", "paused"]);

export function isRunActive(status: TestRunStatus): boolean {
  return activeStatuses.has(status);
}

export type LiveRunPhase = "loading" | "live" | "settled" | "error";

export type LiveRunState = {
  runId: string;
  phase: LiveRunPhase;
  run: TestRunDetail | null;
  consecutiveErrors: number;
  error: string | null;
  // Bumped by every event so a scheduler can re-arm on each transition.
  revision: number;
};

export type LiveRunEvent =
  | { type: "loaded"; run: TestRunDetail }
  | { type: "failed"; message: string }
  // Fetch now: after the user cancels a run, presses retry, or a deep link reopens the page.
  | { type: "refresh" };

export function initialLiveRunState(runId: string): LiveRunState {
  return { runId, phase: "loading", run: null, consecutiveErrors: 0, error: null, revision: 0 };
}

export function reduceLiveRun(state: LiveRunState, event: LiveRunEvent): LiveRunState {
  const revision = state.revision + 1;
  switch (event.type) {
    case "loaded":
      // A response for another run (stale after navigation) is ignored.
      if (event.run.id !== state.runId) return state;
      return {
        ...state,
        run: event.run,
        phase: isRunActive(event.run.status) ? "live" : "settled",
        consecutiveErrors: 0,
        error: null,
        revision
      };
    case "failed":
      return { ...state, phase: "error", consecutiveErrors: state.consecutiveErrors + 1, error: event.message, revision };
    case "refresh":
      return { ...state, phase: "loading", consecutiveErrors: 0, error: null, revision };
  }
}

/** Milliseconds until the next fetch, or null when polling should stop. */
export function nextRunPollDelay(state: LiveRunState): number | null {
  switch (state.phase) {
    case "loading":
      return 0;
    case "live":
      return runPollIntervalMs;
    case "settled":
      return null;
    case "error": {
      const wasActive = state.run !== null && isRunActive(state.run.status);
      if (state.run !== null && !wasActive) return null;
      if (state.run === null && state.consecutiveErrors >= runPollMaxInitialErrors) return null;
      return Math.min(runPollIntervalMs * 2 ** state.consecutiveErrors, runPollMaxBackoffMs);
    }
  }
}

/** True on the transition into a finished run, so the page can refresh lists and the bell. */
export function didRunSettle(previous: LiveRunState, next: LiveRunState): boolean {
  return previous.phase !== "settled" && next.phase === "settled" && previous.run !== null;
}

export type RunQueueLabel = { tone: "neutral" | "accent" | "success" | "warning" | "danger"; text: string };

export function describeRunState(run: Pick<TestRunSummary, "status" | "outcome" | "queuePosition" | "blockedReason" | "flaky">): RunQueueLabel {
  switch (run.status) {
    case "queued":
      if (run.blockedReason === "NO_RUNNER") return { tone: "warning", text: "Queued · waiting for a runner" };
      // queuePosition counts the runs ahead of this one in its pool.
      if (run.queuePosition === null) return { tone: "neutral", text: "Queued" };
      return { tone: "neutral", text: run.queuePosition === 0 ? "Queued · next" : `Queued · ${run.queuePosition} ahead` };
    case "claimed":
      return { tone: "accent", text: "Starting" };
    case "running":
      return { tone: "accent", text: "Running" };
    case "paused":
      return { tone: "warning", text: "Paused" };
    case "cancelled":
      return { tone: "neutral", text: "Cancelled" };
    case "completed":
    case "failed":
      if (run.outcome === "passed") return { tone: "success", text: run.flaky ? "Passed · flaky" : "Passed" };
      if (run.outcome === "blocked") return { tone: "warning", text: "Blocked" };
      if (run.outcome === "failed") return { tone: "danger", text: "Failed" };
      return { tone: run.status === "failed" ? "danger" : "neutral", text: run.status === "failed" ? "Failed" : "Finished" };
  }
}

const runSubjectTypes = new Set(["test_run", "test-run", "run"]);

/** Where a notification leads in the desktop app; null when it has no desktop page. */
export function notificationTarget(notification: Pick<Notification, "kind" | "subjectType" | "subjectId" | "url">): DeepLinkTarget | null {
  if (runSubjectTypes.has(notification.subjectType) && isSafeRunId(notification.subjectId)) {
    return { kind: "run", runId: notification.subjectId };
  }
  const url = notification.url;
  if (!url) return null;
  const deepLink = parseDeepLink(url);
  if (deepLink) return deepLink;
  let pathname: string;
  try {
    pathname = new URL(url, "https://app.invalid").pathname;
  } catch {
    return null;
  }
  const match = /^\/test-runs\/([^/]+)\/?$/.exec(pathname);
  const runId = match?.[1] ? safeDecode(match[1]) : null;
  return isSafeRunId(runId) ? { kind: "run", runId } : null;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
