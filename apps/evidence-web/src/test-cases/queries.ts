import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { useTestOrgId } from "./org";
import { testKeys } from "./query-keys";
import { filtersToQuery, type ListFilters, type ListSort } from "./list-model";
import { isRunActive, runPollInterval } from "./run-model";

// Org-scoped keys from the shared factory (query-keys.ts), also used by admin-queries.ts.
export const testQueryKeys = {
  all: (orgId: string | null) => testKeys.cases(orgId),
  list: (orgId: string | null, filters: ListFilters, sort: ListSort) => testKeys.caseList(orgId, filters, sort),
  detail: (orgId: string | null, id: string) => testKeys.caseDetail(orgId, id),
  versions: (orgId: string | null, id: string) => testKeys.caseVersions(orgId, id),
  scripts: (orgId: string | null, id: string) => testKeys.caseScripts(orgId, id),
  runs: (orgId: string | null, id: string) => testKeys.caseRuns(orgId, id),
  similar: (orgId: string | null, q: string, excludeId: string | null) => testKeys.similar(orgId, q, excludeId),
  run: (orgId: string | null, id: string) => testKeys.run(orgId, id),
  environments: (orgId: string | null) => testKeys.environments(orgId),
  macros: (orgId: string | null) => testKeys.macros(orgId),
  credentials: (orgId: string | null) => testKeys.credentials(orgId),
  tags: (orgId: string | null) => testKeys.tags(orgId),
  elementNames: (orgId: string | null, evidenceId: string) => testKeys.elementNames(orgId, evidenceId)
};

// Signed in and the active organisation is known; queries wait for both so nothing is cached under
// the wrong organisation.
function useSignedIn(): boolean {
  const auth = useAuth();
  const orgId = useTestOrgId();
  return auth.isLoaded && Boolean(auth.isSignedIn) && orgId !== null;
}

const pageSize = 200;

export function useTestCaseList(filters: ListFilters, sort: ListSort) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const enabled = useSignedIn();
  const query = useInfiniteQuery({
    queryKey: testQueryKeys.list(orgId, filters, sort),
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
  const orgId = useTestOrgId();
  const enabled = useSignedIn() && testCaseId !== null;
  return useQuery({
    queryKey: testQueryKeys.detail(orgId, testCaseId ?? "none"),
    queryFn: () => testApi.getTestCase(getToken, testCaseId ?? ""),
    enabled
  });
}

export function useTestCaseVersions(testCaseId: string | null, enabled: boolean) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({
    queryKey: testQueryKeys.versions(orgId, testCaseId ?? "none"),
    queryFn: () => testApi.listVersions(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null
  });
}

export function useStepScripts(testCaseId: string | null, enabled = true) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({
    queryKey: testQueryKeys.scripts(orgId, testCaseId ?? "none"),
    queryFn: () => testApi.listScripts(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null
  });
}

export function useTestCaseRuns(testCaseId: string | null, enabled = true) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({
    queryKey: testQueryKeys.runs(orgId, testCaseId ?? "none"),
    queryFn: () => testApi.listRuns(getToken, testCaseId ?? ""),
    enabled: useSignedIn() && enabled && testCaseId !== null,
    // Keep the queue pills and statuses moving while something is queued or running.
    refetchInterval: (query) => (query.state.data?.items.some((run) => isRunActive(run.status)) ? 5_000 : false)
  });
}

export function useTestRun(runId: string | null) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({
    queryKey: testQueryKeys.run(orgId, runId ?? "none"),
    queryFn: ({ signal }) => testApi.getRun(getToken, runId ?? "", signal),
    enabled: useSignedIn() && runId !== null,
    refetchInterval: (query) => runPollInterval(query.state.data),
    refetchIntervalInBackground: false
  });
}

export function useSimilarTestCases(q: string, excludeId: string | null = null) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const trimmed = q.trim();
  return useQuery({
    queryKey: testQueryKeys.similar(orgId, trimmed, excludeId),
    queryFn: ({ signal }) => testApi.similar(getToken, trimmed, signal, excludeId),
    enabled: useSignedIn() && trimmed.length >= 6,
    staleTime: 60_000,
    retry: false
  });
}

const configStale = 5 * 60_000;

export function useTestEnvironments() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({ queryKey: testQueryKeys.environments(orgId), queryFn: () => testApi.listEnvironments(getToken), enabled: useSignedIn(), staleTime: configStale });
}

export function useTestMacros() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({ queryKey: testQueryKeys.macros(orgId), queryFn: () => testApi.listMacros(getToken), enabled: useSignedIn(), staleTime: configStale });
}

export function useTestCredentials() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({ queryKey: testQueryKeys.credentials(orgId), queryFn: () => testApi.listCredentials(getToken), enabled: useSignedIn(), staleTime: configStale, retry: false });
}

export function useTestTags() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({ queryKey: testQueryKeys.tags(orgId), queryFn: () => testApi.listTags(getToken), enabled: useSignedIn(), staleTime: configStale });
}

// Element names for editor suggestions: targets of the last run's recorded interactions. Only the
// archive JSON is fetched, never the recording.
export function useRunElementNames(evidenceId: string | null, enabled: boolean) {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  return useQuery({
    queryKey: testQueryKeys.elementNames(orgId, evidenceId ?? "none"),
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

// The case list and the review queue, without refetching details that a mutation just set.
function invalidateCaseLists(queryClient: QueryClient, orgId: string | null): void {
  void queryClient.invalidateQueries({ queryKey: testKeys.caseLists(orgId) });
  void queryClient.invalidateQueries({ queryKey: testKeys.reviewQueue(orgId) });
}

export function useCreateTestCase() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { transcript: string; environmentId?: string | null; status?: "draft" | "review" | "active" }) => testApi.createTestCase(getToken, input),
    onSuccess: (created) => {
      queryClient.setQueryData(testQueryKeys.detail(orgId, created.id), created);
      invalidateCaseLists(queryClient, orgId);
    }
  });
}

export function useUpdateTestCase() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string } & UpdateTestCaseRequest) => {
      const { id, ...body } = input;
      return testApi.updateTestCase(getToken, id, body);
    },
    onSuccess: (updated: TestCaseDetail) => {
      queryClient.setQueryData(testQueryKeys.detail(orgId, updated.id), updated);
      invalidateCaseLists(queryClient, orgId);
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.versions(orgId, updated.id) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.scripts(orgId, updated.id) });
    }
  });
}

export function useBulkTestCases() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<BulkTestCaseRequest> & Pick<BulkTestCaseRequest, "action" | "ids">) => testApi.bulk(getToken, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.all(orgId) });
    }
  });
}

export function useCreateTestRun() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { testCaseId: string } & Partial<CreateTestRunRequest>) => {
      const { testCaseId, ...body } = input;
      return testApi.createRun(getToken, testCaseId, body);
    },
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs(orgId, input.testCaseId) });
    }
  });
}

export function useCancelTestRun() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { runId: string; testCaseId: string }) => testApi.cancelRun(getToken, input.runId),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.run(orgId, input.runId) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.runs(orgId, input.testCaseId) });
    }
  });
}

export function useClearStepScripts() {
  const getToken = useAuthToken();
  const orgId = useTestOrgId();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { testCaseId: string; stepId?: string }) => testApi.clearScripts(getToken, input.testCaseId, input.stepId),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.scripts(orgId, input.testCaseId) });
      void queryClient.invalidateQueries({ queryKey: testQueryKeys.detail(orgId, input.testCaseId) });
    }
  });
}
