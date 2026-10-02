import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseSessionArchiveJson,
  type BulkTestCaseRequest,
  type CreateTestRunRequest,
  type TestCaseDetail,
  type TestCaseListResponse,
  type UpdateTestCaseRequest
} from "@jittle-lamp/shared";
import { dedupeElementNames, elementNameFromTarget, elementNamesFromRenderedCode, type InteractionTargetLike } from "@jittle-lamp/ui";

import { api } from "../api";
import { useAuth } from "../auth";
import { useAuthToken } from "../queries";
import { testApi } from "./api";
import { filtersToQuery, type ListFilters, type ListSort } from "./list-model";
import { isRunActive, runPollInterval } from "./run-model";

export const testQueryKeys = {
  all: ["test-cases"] as const,
  list: (filters: ListFilters, sort: ListSort) => ["test-cases", "list", filters, sort] as const,
  detail: (id: string) => ["test-cases", "detail", id] as const,
  versions: (id: string) => ["test-cases", "versions", id] as const,
  scripts: (id: string) => ["test-cases", "scripts", id] as const,
  runs: (id: string) => ["test-cases", "runs", id] as const,
  similar: (q: string) => ["test-cases", "similar", q] as const,
  run: (id: string) => ["test-runs", id] as const,
  environments: () => ["test-config", "environments"] as const,
  macros: () => ["test-config", "macros"] as const,
  credentials: () => ["test-config", "credentials"] as const,
  tags: () => ["test-config", "tags"] as const,
  elementNames: (evidenceId: string) => ["test-runs", "element-names", evidenceId] as const
};

function useSignedIn(): boolean {
  const auth = useAuth();
  return auth.isLoaded && Boolean(auth.isSignedIn);
}

const pageSize = 200;

export function useTestCaseList(filters: ListFilters, sort: ListSort) {
  const getToken = useAuthToken();
  const enabled = useSignedIn();
  const query = useInfiniteQuery({
    queryKey: testQueryKeys.list(filters, sort),
    queryFn: ({ pageParam, signal }) => testApi.listTestCases(getToken, filtersToQuery(filters, sort, { limit: pageSize, cursor: pageParam }), signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page: TestCaseListResponse) => page.nextCursor,
    enabled,
    placeholderData: (previous) => previous,
    staleTime: 20_000
  });
  const pages = query.data?.pages ?? [];
  return {
    ...query,
    items: pages.flatMap((page) => page.items),
    total: pages[0]?.total ?? 0,
    tagCounts: pages[0]?.tagCounts ?? {}
  };
}

export function useTestCase(testCaseId: string | null) {
  const getToken = useAuthToken();
  const enabled = useSignedIn() && testCaseId !== null;
  return useQuery({
    queryKey: testQueryKeys.detail(testCaseId ?? "none"),
    queryFn: () => testApi.getTestCase(getToken, testCaseId ?? ""),
    enabled
  });
}

export function useTestCaseVersions(testCaseId: string | null, enabled: boolean) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: testQueryKeys.versions(testCaseId ?? "none"),
    queryFn: () => testApi.listVersions(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null
  });
}

export function useStepScripts(testCaseId: string | null, enabled = true) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: testQueryKeys.scripts(testCaseId ?? "none"),
    queryFn: () => testApi.listScripts(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null
  });
}

export function useTestCaseRuns(testCaseId: string | null, enabled = true) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: testQueryKeys.runs(testCaseId ?? "none"),
    queryFn: () => testApi.listRuns(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null,
    // Keep the queue pills and statuses moving while something is queued or running.
    refetchInterval: (query) => (query.state.data?.items.some((run) => isRunActive(run.status)) ? 5_000 : false)
  });
}

export function useTestRun(runId: string | null) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: testQueryKeys.run(runId ?? "none"),
    queryFn: ({ signal }) => testApi.getRun(getToken, runId ?? "", signal),
    enabled: useSignedIn() && runId !== null,
    refetchInterval: (query) => runPollInterval(query.state.data),
    refetchIntervalInBackground: false
  });
}

export function useSimilarTestCases(q: string) {
  const getToken = useAuthToken();
  const trimmed = q.trim();
  return useQuery({
    queryKey: testQueryKeys.similar(trimmed),
    queryFn: ({ signal }) => testApi.similar(getToken, trimmed, signal),
    enabled: useSignedIn() && trimmed.length >= 6,
    staleTime: 60_000,
    retry: false
  });
}

const configStale = 5 * 60_000;

export function useTestEnvironments() {
  const getToken = useAuthToken();
  return useQuery({ queryKey: testQueryKeys.environments(), queryFn: () => testApi.listEnvironments(getToken), enabled: useSignedIn(), staleTime: configStale });
}

export function useTestMacros() {
  const getToken = useAuthToken();
  return useQuery({ queryKey: testQueryKeys.macros(), queryFn: () => testApi.listMacros(getToken), enabled: useSignedIn(), staleTime: configStale });
}

export function useTestCredentials() {
  const getToken = useAuthToken();
  return useQuery({ queryKey: testQueryKeys.credentials(), queryFn: () => testApi.listCredentials(getToken), enabled: useSignedIn(), staleTime: configStale, retry: false });
}

export function useTestTags() {
  const getToken = useAuthToken();
  return useQuery({ queryKey: testQueryKeys.tags(), queryFn: () => testApi.listTags(getToken), enabled: useSignedIn(), staleTime: configStale });
}

// Element names for editor suggestions: targets of the last run's recorded interactions. Only the
// archive JSON is fetched, never the recording.
export function useRunElementNames(evidenceId: string | null, enabled: boolean) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: testQueryKeys.elementNames(evidenceId ?? "none"),
    queryFn: async ({ signal }) => {
      const playback = await api.loadEvidencePlayback(getToken, evidenceId ?? "", undefined, signal);
      const archiveArtifact = playback.artifacts.find((artifact) => artifact.kind === "network-log" && artifact.uploadStatus === "uploaded");
      const readUrl = archiveArtifact ? playback.readUrls.find((url) => url.artifactId === archiveArtifact.id) : undefined;
      if (!readUrl) return [];
      const response = await fetch(readUrl.url, { signal });
      if (!response.ok) return [];
      const archive = parseSessionArchiveJson(await response.text());
      const names = archive.sections.actions.flatMap((action) => {
        const target = (action.payload as { target?: InteractionTargetLike }).target;
        const name = target ? elementNameFromTarget(target) : null;
        return name ? [name] : [];
      });
      return dedupeElementNames(names);
    },
    enabled: useSignedIn() && enabled && evidenceId !== null,
    staleTime: Infinity,
    retry: false
  });
}

export function scriptElementNames(scripts: readonly { renderedCode: string }[]): string[] {
  return dedupeElementNames(scripts.flatMap((script) => elementNamesFromRenderedCode(script.renderedCode)));
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

export function useCreateTestCase() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { transcript: string; environmentId?: string | null; status?: "draft" | "review" | "active" }) => testApi.createTestCase(getToken, input),
    onSuccess: (created) => {
      queryClient.setQueryData(testQueryKeys.detail(created.id), created);
      void queryClient.invalidateQueries({ queryKey: [...testQueryKeys.all, "list"] });
    }
  });
}

export function useUpdateTestCase() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & UpdateTestCaseRequest) => {
      const { id, ...body } = input;
      return testApi.updateTestCase(getToken, id, body);
    },
    onSuccess: (updated: TestCaseDetail) => {
      queryClient.setQueryData(testQueryKeys.detail(updated.id), updated);
      void queryClient.invalidateQueries({ queryKey: [...testQueryKeys.all, "list"] });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.versions(updated.id) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.scripts(updated.id) });
    }
  });
}

export function useBulkTestCases() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<BulkTestCaseRequest> & Pick<BulkTestCaseRequest, "action" | "ids">) => testApi.bulk(getToken, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.all });
    }
  });
}

export function useCreateTestRun() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { testCaseId: string } & Partial<CreateTestRunRequest>) => {
      const { testCaseId, ...body } = input;
      return testApi.createRun(getToken, testCaseId, body);
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs(input.testCaseId) });
    }
  });
}

export function useCancelTestRun() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; testCaseId: string }) => testApi.cancelRun(getToken, input.runId),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.run(input.runId) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs(input.testCaseId) });
    }
  });
}

export function useClearStepScripts() {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { testCaseId: string; stepId?: string }) => testApi.clearScripts(getToken, input.testCaseId, input.stepId),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.scripts(input.testCaseId) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.detail(input.testCaseId) });
    }
  });
}
