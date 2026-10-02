import React, { createContext, useContext, useEffect, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";

import type { TestRunDetail } from "@jittle-lamp/shared";

import { initialLiveRunState, nextRunPollDelay, reduceLiveRun, type LiveRunState } from "./live-run";
import type { TestApi, TestCaseListFilter } from "./test-api";

const TestApiContext = createContext<TestApi | null>(null);

export function TestApiProvider(props: { api: TestApi; children: React.ReactNode }): React.JSX.Element {
  return <TestApiContext.Provider value={props.api}>{props.children}</TestApiContext.Provider>;
}

export function useTestApi(): TestApi {
  const api = useContext(TestApiContext);
  if (!api) throw new Error("Test API is unavailable outside the signed-in workspace.");
  return api;
}

export const testQueryKeys = {
  cases: (filter: TestCaseListFilter) => ["test-cases", filter] as const,
  case: (testCaseId: string) => ["test-case", testCaseId] as const,
  caseRuns: (testCaseId: string) => ["test-case-runs", testCaseId] as const,
  runs: () => ["test-runs"] as const,
  environments: () => ["test-environments"] as const,
  notifications: () => ["notifications"] as const
};

export const notificationPollMs = 30_000;

export function useTestCases(filter: TestCaseListFilter) {
  const api = useTestApi();
  return useQuery({ queryKey: testQueryKeys.cases(filter), queryFn: () => api.listTestCases(filter), placeholderData: (previous) => previous });
}

export function useTestCase(testCaseId: string | null) {
  const api = useTestApi();
  return useQuery({
    queryKey: testQueryKeys.case(testCaseId ?? "none"),
    queryFn: () => api.getTestCase(testCaseId ?? ""),
    enabled: Boolean(testCaseId)
  });
}

export function useCaseRuns(testCaseId: string | null) {
  const api = useTestApi();
  return useQuery({
    queryKey: testQueryKeys.caseRuns(testCaseId ?? "none"),
    queryFn: () => api.listCaseRuns(testCaseId ?? "", { limit: 10 }),
    enabled: Boolean(testCaseId),
    staleTime: 5_000
  });
}

export function useTestRuns() {
  const api = useTestApi();
  return useQuery({ queryKey: testQueryKeys.runs(), queryFn: () => api.listRuns({ limit: 50 }), staleTime: 5_000 });
}

export function useTestEnvironments() {
  const api = useTestApi();
  return useQuery({ queryKey: testQueryKeys.environments(), queryFn: () => api.listEnvironments(), staleTime: 300_000 });
}

export function useNotifications() {
  const api = useTestApi();
  return useQuery({
    queryKey: testQueryKeys.notifications(),
    queryFn: () => api.listNotifications(),
    refetchInterval: notificationPollMs,
    staleTime: 10_000
  });
}

/**
 * Polls one run with the live-run state machine: immediately, then every 2 s while it is queued
 * or executing, with backoff on errors, and not at all once it has settled.
 */
export function useLiveRun(runId: string): { state: LiveRunState; refresh: () => void } {
  const api = useTestApi();
  const [state, dispatch] = useReducer(reduceLiveRun, runId, initialLiveRunState);

  useEffect(() => {
    if (state.runId !== runId) return;
    const delay = nextRunPollDelay(state);
    if (delay === null) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void api
        .getRun(runId)
        .then((run: TestRunDetail) => {
          if (!cancelled) dispatch({ type: "loaded", run });
        })
        .catch((error: unknown) => {
          if (!cancelled) dispatch({ type: "failed", message: error instanceof Error ? error.message : "Unable to load the run." });
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `revision` changes on every transition and re-arms the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, runId, state.revision]);

  return { state, refresh: () => dispatch({ type: "refresh" }) };
}
