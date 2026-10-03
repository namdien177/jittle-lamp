import { z } from "zod/v4";
import {
  bulkTestCaseResponseSchema,
  createRunnerPoolResponseSchema,
  duplicateTestCaseResponseSchema,
  importBatchSchema,
  modelCostReportSchema,
  modelSettingsSchema,
  notificationChannelSchema,
  notificationListResponseSchema,
  notificationSubscriptionsSchema,
  runnerPoolSchema,
  similarTestCasesResponseSchema,
  testCaseDetailSchema,
  testCaseListResponseSchema,
  testCredentialSchema,
  testEnvironmentSchema,
  testMacroSchema,
  testRunSettingsSchema,
  testTagSchema,
  type BulkTestCaseRequest,
  type CreateImportRequest,
  type DuplicateTestCaseRequest,
  type NotificationKind,
  type TestCaseStatus
} from "@jittle-lamp/shared";

import type { FetchToken } from "../api";
import { apiOrigin } from "../env";
import { TestApiError } from "./api";

// Typed client for the test-case admin surfaces (import, review, duplicate, settings, notifications).
// Every response is validated against the shared contract in packages/shared/src/test-api.ts.

// One error type for both test-case clients; `details` keeps the whole error body (409
// currentVersion, 429 retryAfter and depth).
export { TestApiError };

async function request<T>(getToken: FetchToken, path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error("Sign in is required.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
    throw new TestApiError(payload?.error?.message ?? `Request failed (${response.status}).`, response.status, payload?.error?.code ?? null, payload);
  }
  if (response.status === 204) return schema.parse(undefined);
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new TestApiError(`Unexpected response from ${path.split("?")[0]}.`, response.status, "INVALID_RESPONSE", body);
  }
  return parsed.data;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// Lists come back either bare or wrapped (`{ items }`, `{ environments }` …).
function listOf<T>(item: z.ZodType<T>, ...keys: string[]): z.ZodType<T[]> {
  return z.union([z.array(item), z.record(z.string(), z.unknown())]).transform((value, ctx) => {
    const list = Array.isArray(value) ? value : [...keys, "items"].map((key) => value[key]).find(Array.isArray);
    const parsed = z.array(item).safeParse(list);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", message: "Expected a list" });
      return z.NEVER;
    }
    return parsed.data;
  }) as unknown as z.ZodType<T[]>;
}

// Single objects come back either bare or wrapped (`{ environment }`).
function oneOf<T>(item: z.ZodType<T>, key: string): z.ZodType<T> {
  return z.union([item, z.object({ [key]: item }).transform((value) => value[key] as T)]) as unknown as z.ZodType<T>;
}

const okSchema = z.unknown().transform(() => true);

const importCreatedSchema = z.union([
  importBatchSchema.transform((batch) => batch.id),
  z.object({ batchId: z.string().min(1) }).transform((value) => value.batchId),
  z.object({ batch: importBatchSchema }).transform((value) => value.batch.id)
]);

const id = (value: string) => encodeURIComponent(value);

export type EnvironmentInput = {
  name: string;
  baseUrl: string;
  variables: Record<string, string>;
  runnerPool: string;
  agentInstructions: string | null;
  notes: string | null;
};

export type CredentialInput = {
  profile: string;
  kind: z.infer<typeof testCredentialSchema>["kind"];
  environmentId: string | null;
  fields: Record<string, string>;
  // Write-only: a string sets the value, null removes the field, omitted keeps it.
  secretFields: Record<string, string | null>;
};

export type MacroInput = {
  name: string;
  params: z.infer<typeof testMacroSchema>["params"];
  transcript: string;
  status: "draft" | "active";
};

export type TagInput = { namespace: string; name: string; color: string; description: string | null };

export const testAdminApi = {
  // Import and review -------------------------------------------------------------------------
  createImport: (getToken: FetchToken, body: CreateImportRequest) =>
    request(getToken, "/test-cases/import", importCreatedSchema, json("POST", body)),
  getImportBatch: (getToken: FetchToken, batchId: string) =>
    request(getToken, `/test-cases/import/${id(batchId)}`, oneOf(importBatchSchema, "batch")),
  patchImportBatch: (
    getToken: FetchToken,
    batchId: string,
    body: { decisions?: Array<{ itemId: string; decision: z.infer<typeof importBatchSchema>["items"][number]["decision"] }>; commit?: boolean }
  ) => request(getToken, `/test-cases/import/${id(batchId)}`, oneOf(importBatchSchema, "batch"), json("PATCH", { decisions: [], commit: false, ...body })),
  listTestCases: (getToken: FetchToken, query: { status?: TestCaseStatus[]; limit?: number; q?: string }) => {
    const params = new URLSearchParams();
    if (query.status?.length) params.set("status", query.status.join(","));
    if (query.q) params.set("q", query.q);
    params.set("limit", String(query.limit ?? 500));
    return request(getToken, `/test-cases?${params.toString()}`, testCaseListResponseSchema);
  },
  getTestCase: (getToken: FetchToken, caseId: string) => request(getToken, `/test-cases/${id(caseId)}`, oneOf(testCaseDetailSchema, "testCase")),
  similarTestCases: (getToken: FetchToken, query: { title?: string; transcript?: string; excludeId?: string }) => {
    const params = new URLSearchParams();
    if (query.title) params.set("title", query.title);
    if (query.transcript) params.set("transcript", query.transcript.slice(0, 4000));
    if (query.excludeId) params.set("excludeId", query.excludeId);
    return request(getToken, `/test-cases/similar?${params.toString()}`, similarTestCasesResponseSchema);
  },
  bulkTestCases: (getToken: FetchToken, body: BulkTestCaseRequest) =>
    request(getToken, "/test-cases/bulk", bulkTestCaseResponseSchema, json("POST", body)),
  duplicateTestCase: (getToken: FetchToken, caseId: string, body: DuplicateTestCaseRequest) =>
    request(getToken, `/test-cases/${id(caseId)}/duplicate`, duplicateTestCaseResponseSchema, json("POST", body)),

  // Environments ------------------------------------------------------------------------------
  listEnvironments: (getToken: FetchToken) => request(getToken, "/test-environments", listOf(testEnvironmentSchema, "environments")),
  createEnvironment: (getToken: FetchToken, body: EnvironmentInput) =>
    request(getToken, "/test-environments", oneOf(testEnvironmentSchema, "environment"), json("POST", body)),
  updateEnvironment: (getToken: FetchToken, environmentId: string, body: EnvironmentInput) =>
    request(getToken, `/test-environments/${id(environmentId)}`, oneOf(testEnvironmentSchema, "environment"), json("PATCH", body)),
  deleteEnvironment: (getToken: FetchToken, environmentId: string) =>
    request(getToken, `/test-environments/${id(environmentId)}`, okSchema, { method: "DELETE" }),

  // Credentials -------------------------------------------------------------------------------
  listCredentials: (getToken: FetchToken) => request(getToken, "/test-credentials", listOf(testCredentialSchema, "credentials")),
  createCredential: (getToken: FetchToken, body: CredentialInput) =>
    request(getToken, "/test-credentials", oneOf(testCredentialSchema, "credential"), json("POST", body)),
  updateCredential: (getToken: FetchToken, credentialId: string, body: CredentialInput) =>
    request(getToken, `/test-credentials/${id(credentialId)}`, oneOf(testCredentialSchema, "credential"), json("PATCH", body)),
  rotateCredential: (getToken: FetchToken, credentialId: string, secretFields: Record<string, string>) =>
    request(getToken, `/test-credentials/${id(credentialId)}/rotate`, oneOf(testCredentialSchema, "credential"), json("POST", { secretFields })),
  deleteCredential: (getToken: FetchToken, credentialId: string) =>
    request(getToken, `/test-credentials/${id(credentialId)}`, okSchema, { method: "DELETE" }),

  // Macros ------------------------------------------------------------------------------------
  listMacros: (getToken: FetchToken) => request(getToken, "/test-macros", listOf(testMacroSchema, "macros")),
  createMacro: (getToken: FetchToken, body: MacroInput) => request(getToken, "/test-macros", oneOf(testMacroSchema, "macro"), json("POST", body)),
  updateMacro: (getToken: FetchToken, macroId: string, body: MacroInput) =>
    request(getToken, `/test-macros/${id(macroId)}`, oneOf(testMacroSchema, "macro"), json("PATCH", body)),
  deleteMacro: (getToken: FetchToken, macroId: string) => request(getToken, `/test-macros/${id(macroId)}`, okSchema, { method: "DELETE" }),

  // Tags --------------------------------------------------------------------------------------
  listTags: (getToken: FetchToken) => request(getToken, "/test-tags", listOf(testTagSchema, "tags")),
  createTag: (getToken: FetchToken, body: TagInput) => request(getToken, "/test-tags", oneOf(testTagSchema, "tag"), json("POST", body)),
  updateTag: (getToken: FetchToken, tagId: string, body: TagInput) =>
    request(getToken, `/test-tags/${id(tagId)}`, oneOf(testTagSchema, "tag"), json("PATCH", body)),
  deleteTag: (getToken: FetchToken, tagId: string) => request(getToken, `/test-tags/${id(tagId)}`, okSchema, { method: "DELETE" }),

  // Run settings, model, spend ----------------------------------------------------------------
  getRunSettings: (getToken: FetchToken) => request(getToken, "/test-run-settings", oneOf(testRunSettingsSchema, "settings")),
  updateRunSettings: (getToken: FetchToken, body: z.infer<typeof testRunSettingsSchema>) =>
    request(getToken, "/test-run-settings", oneOf(testRunSettingsSchema, "settings"), json("PUT", body)),
  getModelSettings: (getToken: FetchToken) => request(getToken, "/test-model-settings", oneOf(modelSettingsSchema, "settings")),
  updateModelSettings: (getToken: FetchToken, body: { actModel: string; judgeModel: string; apiKey?: string | null }) =>
    request(getToken, "/test-model-settings", oneOf(modelSettingsSchema, "settings"), json("PUT", body)),
  getModelCosts: (getToken: FetchToken, range: { from: number; to: number }) =>
    request(getToken, `/test-model-costs?from=${range.from}&to=${range.to}`, oneOf(modelCostReportSchema, "report")),

  // Runner pools ------------------------------------------------------------------------------
  listRunnerPools: (getToken: FetchToken) => request(getToken, "/runner-pools", listOf(runnerPoolSchema, "pools")),
  createRunnerPool: (getToken: FetchToken, body: { name: string; maxConcurrentRuns: number }) =>
    request(getToken, "/runner-pools", createRunnerPoolResponseSchema, json("POST", body)),
  issueRegistrationToken: (getToken: FetchToken, poolId: string) =>
    request(getToken, `/runner-pools/${id(poolId)}/registration-token`, createRunnerPoolResponseSchema, json("POST", {})),
  deleteRunnerWorker: (getToken: FetchToken, poolId: string, workerId: string) =>
    request(getToken, `/runner-pools/${id(poolId)}/workers/${id(workerId)}`, okSchema, { method: "DELETE" }),

  // Notifications -----------------------------------------------------------------------------
  listNotifications: (getToken: FetchToken) => request(getToken, "/notifications?limit=30", notificationListResponseSchema),
  markNotificationsRead: (getToken: FetchToken, body: { ids: string[] } | { all: true }) =>
    request(getToken, "/notifications/read", okSchema, json("POST", "all" in body ? { ids: [], all: true } : { ids: body.ids, all: false })),
  getNotificationSubscriptions: (getToken: FetchToken) =>
    request(getToken, "/notifications/subscriptions", notificationSubscriptionsSchema),
  putNotificationSubscriptions: (getToken: FetchToken, body: { subscribed: NotificationKind[]; unsubscribed: NotificationKind[] }) =>
    request(getToken, "/notifications/subscriptions", notificationSubscriptionsSchema, json("PUT", body)),
  // The channel routes land on another branch; until then a 404 means "in-app only".
  listNotificationChannels: async (getToken: FetchToken) => {
    try {
      return await request(getToken, "/notification-channels", listOf(notificationChannelSchema, "channels"));
    } catch (error) {
      if (error instanceof TestApiError && error.status === 404) return [];
      throw error;
    }
  }
};
