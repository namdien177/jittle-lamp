import { useRef } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";

import type { FetchToken } from "../api";
import { useAuth } from "../auth";
import { notificationPollMs } from "../notifications/notification-links";
import { useAccountProfile, useOrganizationRoles } from "../queries";
import { testAdminApi } from "./admin-api";
import { testKeys } from "./query-keys";

// TanStack Query hooks for the test-case admin surfaces. Keys carry the active organisation so a
// workspace switch never shows another organisation's configuration.

function useTokenGetter(): FetchToken {
  const auth = useAuth();
  const authRef = useRef(auth);
  authRef.current = auth;
  return useRef<FetchToken>(() => authRef.current.getToken()).current;
}

function useActiveOrg(): { orgId: string | null; role: string | null; ready: boolean } {
  const auth = useAuth();
  const profile = useAccountProfile();
  const org = profile.data?.organizations.find((item) => item.id === profile.data?.activeOrgId) ?? null;
  return { orgId: org?.id ?? null, role: org?.role ?? null, ready: auth.isLoaded && Boolean(auth.isSignedIn) && Boolean(org) };
}

// Org-scoped keys from the shared factory (query-keys.ts), the same keys the case workspace uses.
export const testAdminKeys = {
  all: (orgId: string | null) => testKeys.org(orgId),
  cases: (orgId: string | null) => testKeys.cases(orgId),
  reviewQueue: (orgId: string | null) => testKeys.reviewQueue(orgId),
  testCase: (orgId: string | null, caseId: string) => testKeys.caseDetail(orgId, caseId),
  similar: (orgId: string | null, title: string, caseId: string) => testKeys.similar(orgId, title, caseId),
  importBatch: (orgId: string | null, batchId: string) => testKeys.importBatch(orgId, batchId),
  environments: (orgId: string | null) => testKeys.environments(orgId),
  credentials: (orgId: string | null) => testKeys.credentials(orgId),
  macros: (orgId: string | null) => testKeys.macros(orgId),
  tags: (orgId: string | null) => testKeys.tags(orgId),
  runSettings: (orgId: string | null) => testKeys.runSettings(orgId),
  modelSettings: (orgId: string | null) => testKeys.modelSettings(orgId),
  modelCosts: (orgId: string | null, from: number, to: number) => testKeys.modelCosts(orgId, from, to),
  runnerPools: (orgId: string | null) => testKeys.runnerPools(orgId),
  notifications: (orgId: string | null) => testKeys.notifications(orgId),
  notificationSubscriptions: (orgId: string | null) => testKeys.notificationSubscriptions(orgId),
  notificationChannels: (orgId: string | null) => testKeys.notificationChannels(orgId)
};

// ---------------------------------------------------------------------------------------------
// Permissions: the active role's grants from GET /orgs/:orgId/roles, falling back to the default
// grants (apps/backend/src/services/organization-permissions.ts) while that loads.
// ---------------------------------------------------------------------------------------------

export type TestPermission =
  | "test_case.view"
  | "test_case.create"
  | "test_case.update"
  | "test_case.approve"
  | "test_case.delete"
  | "test_run.create"
  | "test_run.view"
  | "test_config.manage"
  | "test_config.use";

const defaultTestGrants: Record<string, readonly TestPermission[]> = {
  developer: ["test_case.view", "test_run.create", "test_run.view", "test_config.use"],
  qa_engineer: ["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.view", "test_config.use"],
  moderator: ["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.view", "test_config.manage", "test_config.use"],
  admin: ["test_case.view", "test_case.create", "test_case.update", "test_case.approve", "test_case.delete", "test_run.create", "test_run.view", "test_config.manage", "test_config.use"]
};

export function useTestPermissions(): { can: (permission: TestPermission) => boolean; loading: boolean } {
  const { orgId, role } = useActiveOrg();
  const roles = useOrganizationRoles(orgId);
  const granted = roles.data?.roles.find((item) => item.key === role)?.permissions as readonly string[] | undefined;
  const list: readonly string[] = granted ?? (role ? (defaultTestGrants[role] ?? []) : []);
  return { can: (permission) => list.includes(permission), loading: roles.isPending };
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

function useOrgQuery<T>(key: (orgId: string | null) => QueryKey, fetcher: (getToken: FetchToken) => Promise<T>, options: { enabled?: boolean; retry?: false; refetchInterval?: number | false | ((data: T | undefined) => number | false) } = {}) {
  const { orgId, ready } = useActiveOrg();
  const getToken = useTokenGetter();
  const interval = options.refetchInterval;
  return useQuery<T>({
    queryKey: key(orgId),
    queryFn: () => fetcher(getToken),
    enabled: ready && (options.enabled ?? true),
    ...(options.retry === false ? { retry: false } : {}),
    ...(interval === undefined ? {} : { refetchInterval: typeof interval === "function" ? (query) => interval(query.state.data) : interval })
  });
}

export const useReviewQueue = () =>
  useOrgQuery(testAdminKeys.reviewQueue, (getToken) => testAdminApi.listTestCases(getToken, { status: ["review"], limit: 500 }));

export const useAdminTestCase = (caseId: string | null) =>
  useOrgQuery((orgId) => testAdminKeys.testCase(orgId, caseId ?? "none"), (getToken) => testAdminApi.getTestCase(getToken, caseId ?? ""), {
    enabled: Boolean(caseId)
  });

export const useSimilarForCase = (caseId: string | null, title: string | null) =>
  useOrgQuery(
    (orgId) => testAdminKeys.similar(orgId, title ?? "", caseId ?? "none"),
    (getToken) => testAdminApi.similarTestCases(getToken, { title: title ?? "", excludeId: caseId ?? "" }),
    { enabled: Boolean(caseId && title) }
  );

export const useImportBatch = (batchId: string | null) =>
  useOrgQuery((orgId) => testAdminKeys.importBatch(orgId, batchId ?? "none"), (getToken) => testAdminApi.getImportBatch(getToken, batchId ?? ""), {
    enabled: Boolean(batchId),
    refetchInterval: (data) => (data && (data.status === "parsing" || data.status === "committing" || data.items.some((item) => item.state === "pending")) ? 2_000 : false)
  });

export const useTestEnvironments = () => useOrgQuery(testAdminKeys.environments, testAdminApi.listEnvironments);
export const useTestCredentials = () => useOrgQuery(testAdminKeys.credentials, testAdminApi.listCredentials);
export const useTestMacros = () => useOrgQuery(testAdminKeys.macros, testAdminApi.listMacros);
export const useTestTags = () => useOrgQuery(testAdminKeys.tags, testAdminApi.listTags);
export const useTestRunSettings = () => useOrgQuery(testAdminKeys.runSettings, testAdminApi.getRunSettings);
export const useModelSettings = () => useOrgQuery(testAdminKeys.modelSettings, testAdminApi.getModelSettings);
export const useRunnerPools = () => useOrgQuery(testAdminKeys.runnerPools, testAdminApi.listRunnerPools, { refetchInterval: 15_000 });
export const useNotificationChannels = () => useOrgQuery(testAdminKeys.notificationChannels, testAdminApi.listNotificationChannels, { retry: false });
export const useNotificationSubscriptions = () => useOrgQuery(testAdminKeys.notificationSubscriptions, testAdminApi.getNotificationSubscriptions);
export const useModelCosts = (range: { from: number; to: number }) =>
  useOrgQuery((orgId) => testAdminKeys.modelCosts(orgId, range.from, range.to), (getToken) => testAdminApi.getModelCosts(getToken, range));
export const useNotifications = () => useOrgQuery(testAdminKeys.notifications, testAdminApi.listNotifications, { refetchInterval: notificationPollMs });

// ---------------------------------------------------------------------------------------------
// Mutations: each invalidates the lists it changes.
// ---------------------------------------------------------------------------------------------

export function useTestAdminMutation<TInput, TResult>(
  mutationFn: (getToken: FetchToken, input: TInput) => Promise<TResult>,
  invalidate: Array<(orgId: string | null) => QueryKey>
) {
  const getToken = useTokenGetter();
  const queryClient = useQueryClient();
  const { orgId } = useActiveOrg();
  return useMutation({
    mutationFn: (input: TInput) => mutationFn(getToken, input),
    onSuccess: () => {
      for (const key of invalidate) void queryClient.invalidateQueries({ queryKey: key(orgId) });
    }
  });
}

export function useActiveOrgId(): string | null {
  return useActiveOrg().orgId;
}
