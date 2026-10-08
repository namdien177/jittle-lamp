import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod/v4";
import {
  organizationStorageOverviewSchema,
  organizationStorageSchema,
  storageImpactSchema,
  storageSettingsSchema,
  storageTransferSchema,
  storageUsageReportSchema,
  type CreateOrganizationStorageInput,
  type StorageConnectionInput,
  type StorageSettings,
  type StorageUsageGranularity,
  type UpdateOrganizationStorageInput
} from "@jittle-lamp/shared";

import type { FetchToken } from "./api";
import { useAuth } from "./auth";
import { apiOrigin } from "./env";
import { queryKeys, useAuthToken } from "./queries";

// Organisation storage: usage statistics and bring-your-own S3 storages. Responses are validated
// against the shared contract in packages/shared/src/storage.ts.

async function request<T>(getToken: FetchToken, path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Sign in is required.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
    throw new Error(message ?? `Request failed (${response.status}).`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`Unexpected response from ${path.split("?")[0]}.`);
  return parsed.data;
}

const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const orgPath = (orgId: string) => `/orgs/${encodeURIComponent(orgId)}`;
const verifiedSchema = z.object({ ok: z.literal(true), verifiedAt: z.number() });

export const storageApi = {
  usage: (getToken: FetchToken, orgId: string, input: { granularity: StorageUsageGranularity; from?: string; to?: string }) => {
    const params = new URLSearchParams({ granularity: input.granularity });
    if (input.from) params.set("from", input.from);
    if (input.to) params.set("to", input.to);
    return request(getToken, `${orgPath(orgId)}/storage/usage?${params}`, storageUsageReportSchema);
  },
  overview: (getToken: FetchToken, orgId: string) => request(getToken, `${orgPath(orgId)}/storage`, organizationStorageOverviewSchema),
  updateSettings: (getToken: FetchToken, orgId: string, input: Partial<StorageSettings>) =>
    request(getToken, `${orgPath(orgId)}/storage/settings`, storageSettingsSchema, send("PATCH", input)),
  testConnection: (getToken: FetchToken, orgId: string, input: StorageConnectionInput) =>
    request(getToken, `${orgPath(orgId)}/storages/test`, verifiedSchema, send("POST", input)),
  testStorage: (getToken: FetchToken, orgId: string, storageId: string) =>
    request(getToken, `${orgPath(orgId)}/storages/${encodeURIComponent(storageId)}/test`, verifiedSchema, { method: "POST" }),
  createStorage: (getToken: FetchToken, orgId: string, input: CreateOrganizationStorageInput) =>
    request(getToken, `${orgPath(orgId)}/storages`, organizationStorageSchema, send("POST", input)),
  updateStorage: (getToken: FetchToken, orgId: string, storageId: string, input: UpdateOrganizationStorageInput) =>
    request(getToken, `${orgPath(orgId)}/storages/${encodeURIComponent(storageId)}`, organizationStorageSchema, send("PATCH", input)),
  impact: (getToken: FetchToken, orgId: string, storageId: string) =>
    request(getToken, `${orgPath(orgId)}/storages/${encodeURIComponent(storageId)}/impact`, storageImpactSchema),
  deleteStorage: (getToken: FetchToken, orgId: string, storageId: string, confirmName: string) =>
    request(getToken, `${orgPath(orgId)}/storages/${encodeURIComponent(storageId)}/delete`, storageImpactSchema, send("POST", { confirmName })),
  startTransfer: (getToken: FetchToken, orgId: string, input: { sourceStorageId: string | null; targetStorageId: string }) =>
    request(getToken, `${orgPath(orgId)}/storage/transfers`, storageTransferSchema, send("POST", input)),
  controlTransfer: (getToken: FetchToken, orgId: string, transferId: string, action: "pause" | "resume" | "cancel") =>
    request(getToken, `${orgPath(orgId)}/storage/transfers/${encodeURIComponent(transferId)}/${action}`, storageTransferSchema, { method: "POST" })
};

export const storageKeys = {
  all: (orgId: string) => ["org-storage", orgId] as const,
  overview: (orgId: string) => [...storageKeys.all(orgId), "overview"] as const,
  usage: (orgId: string, granularity: StorageUsageGranularity, from: string, to: string) =>
    [...storageKeys.all(orgId), "usage", granularity, from, to] as const,
  impact: (orgId: string, storageId: string) => [...storageKeys.all(orgId), "impact", storageId] as const
};

function useEnabled(): boolean {
  const auth = useAuth();
  return auth.isLoaded && Boolean(auth.isSignedIn);
}

export function useStorageUsage(orgId: string, input: { granularity: StorageUsageGranularity; from: string; to: string }) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: storageKeys.usage(orgId, input.granularity, input.from, input.to),
    queryFn: () => storageApi.usage(getToken, orgId, input),
    enabled: useEnabled() && Boolean(orgId),
    placeholderData: (previous) => previous
  });
}

// Polls every 3 s while a transfer is in flight.
export function useStorageOverview(orgId: string) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: storageKeys.overview(orgId),
    queryFn: () => storageApi.overview(getToken, orgId),
    enabled: useEnabled() && Boolean(orgId),
    refetchInterval: (query) => (query.state.data?.activeTransfer ? 3_000 : false)
  });
}

export function useStorageImpact(orgId: string, storageId: string | null) {
  const getToken = useAuthToken();
  return useQuery({
    queryKey: storageKeys.impact(orgId, storageId ?? "none"),
    queryFn: () => storageApi.impact(getToken, orgId, storageId ?? ""),
    enabled: useEnabled() && Boolean(orgId && storageId),
    staleTime: 0
  });
}

// Every storage mutation can change usage, the storage list and the activity log.
export function useStorageMutation<TInput, TResult>(orgId: string, run: (getToken: FetchToken, input: TInput) => Promise<TResult>) {
  const getToken = useAuthToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => run(getToken, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: storageKeys.all(orgId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.organizationActivity(orgId) });
    }
  });
}
