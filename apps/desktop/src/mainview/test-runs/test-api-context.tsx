import React, { createContext, useContext, useEffect, useReducer } from "react";
import { useQuery } from "@tanstack/react-query";

import type { TestRunDetail } from "@jittle-lamp/shared";

import { initialLiveRunState, nextRunPollDelay, reduceLiveRun, runListRefreshInterval, type LiveRunState } from "./live-run";
import { webUrl } from "./web-links";
import type { TestApi, TestCaseListFilter } from "./test-api";

type TestApiContextValue = {
  api: TestApi;
  webOrigin: string;
  // Opens an http(s) URL in the system browser (desktop openExternalUrl).
  openExternal: (url: string) => void;
};

const TestApiContext = createContext<TestApiContextValue | null>(null);

export function TestApiProvider(props: TestApiContextValue & { children: React.ReactNode }): React.JSX.Element {
  const { api, webOrigin, openExternal } = props;
  const value = React.useMemo(() => ({ api, webOrigin, openExternal }), [api, webOrigin, openExternal]);
  return <TestApiContext.Provider value={value}>{props.children}</TestApiContext.Provider>;
}

function useTestContext(): TestApiContextValue {
  const value = useContext(TestApiContext);
  if (!value) throw new Error("Test API is unavailable outside the signed-in workspace.");
  return value;
}

export function useTestApi(): TestApi {
  return useTestContext().api;
}

/** Opens a web-app path (`/test-cases/review`) on the configured web origin; null paths are ignored. */
export function useOpenInWeb(): { webOrigin: string; openPath: (path: string | null) => void; openUrl: (url: string) => void } {
  const { webOrigin, openExternal } = useTestContext();
  return {
    webOrigin,
    openUrl: openExternal,
    openPath: (path) => {
      const url = path ? webUrl(webOrigin, path) : null;
      if (url) openExternal(url);
    }
  };
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
    staleTime: 5_000,
    refetchInterval: (query) => runListRefreshInterval(query.state.data?.items)
  });
}

export function useTestRuns() {
  const api = useTestApi();
  return useQuery({
    queryKey: testQueryKeys.runs(),
    queryFn: () => api.listRuns({ limit: 50 }),
    staleTime: 5_000,
    // Keeps queued and running rows current without opening each run.
    refetchInterval: (query) => runListRefreshInterval(query.state.data?.items)
  });
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
