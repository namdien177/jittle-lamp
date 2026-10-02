import {
  createTestRunRequestSchema,
  createTestRunResponseSchema,
  notificationListResponseSchema,
  testCaseDetailSchema,
  testCaseListResponseSchema,
  testEnvironmentSchema,
  testRunDetailSchema,
  testRunListResponseSchema,
  type CreateTestRunResponse,
  type TestCaseDetail,
  type TestCaseListResponse,
  type TestCaseStatus,
  type TestEnvironment,
  type TestRunDetail
} from "@jittle-lamp/shared";
import { z } from "zod/v4";

import { apiOrigin, type FetchToken } from "../api";

// Desktop client of the backend test-case queue (ADR 0002 decision 3: the desktop app triggers
// runs and reviews evidence, it hosts no runner). Every response is validated against the shared
// contract in packages/shared/src/test-api.ts.

export type CreateRunInput = z.input<typeof createTestRunRequestSchema>;
export type TestRunListResponse = z.infer<typeof testRunListResponseSchema>;
export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export type TestCaseListFilter = {
  q?: string;
  status?: readonly TestCaseStatus[];
  limit?: number;
  cursor?: string;
};

export type TestApi = {
  listTestCases: (filter?: TestCaseListFilter) => Promise<TestCaseListResponse>;
  getTestCase: (testCaseId: string) => Promise<TestCaseDetail>;
  listCaseRuns: (testCaseId: string, options?: { limit?: number }) => Promise<TestRunListResponse>;
  listRuns: (options?: { limit?: number; cursor?: string }) => Promise<TestRunListResponse>;
  getRun: (runId: string) => Promise<TestRunDetail>;
  createRun: (testCaseId: string, input: CreateRunInput) => Promise<CreateTestRunResponse>;
  cancelRun: (runId: string) => Promise<void>;
  listEnvironments: () => Promise<TestEnvironment[]>;
  listNotifications: () => Promise<NotificationListResponse>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
};

export class TestApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null
  ) {
    super(message);
    this.name = "TestApiError";
  }
}

const listShape = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);

/** Lists may come back as `{ items }`, a named array such as `{ environments }`, or a bare array. */
export function extractListItems(payload: unknown, name: string): unknown[] {
  const parsed = listShape.safeParse(payload);
  if (!parsed.success) return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  for (const key of ["items", name]) {
    const value = parsed.data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function describeContractError(error: z.ZodError, what: string): string {
  const first = error.issues[0];
  const path = first?.path.map(String).join(".") || "(root)";
  return `The backend returned an unexpected ${what} (${path}: ${first?.message ?? "invalid"}).`;
}

export function createTestApi(options: { getToken: FetchToken; fetcher?: typeof fetch; origin?: string }): TestApi {
  const fetcher = options.fetcher ?? fetch;
  const origin = (options.origin ?? apiOrigin).replace(/\/+$/, "");

  async function request(method: string, path: string, init: { query?: URLSearchParams; body?: unknown } = {}): Promise<unknown> {
    const token = await options.getToken();
    if (!token) throw new TestApiError("Sign in to use test cases.", 401, null);
    const query = init.query?.toString();
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetcher(`${origin}${path}${query ? `?${query}` : ""}`, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
    });
    if (response.status === 204) return undefined;
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const error = z.object({ error: z.object({ message: z.string().optional(), code: z.string().optional() }) }).safeParse(payload);
      throw new TestApiError(
        error.success && error.data.error.message ? error.data.error.message : `Request failed (${response.status}).`,
        response.status,
        error.success ? (error.data.error.code ?? null) : null
      );
    }
    return payload;
  }

  function parse<T>(schema: z.ZodType<T>, payload: unknown, what: string): T {
    const result = schema.safeParse(payload);
    if (!result.success) throw new TestApiError(describeContractError(result.error, what), null, "CONTRACT_MISMATCH");
    return result.data;
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    listTestCases: async (filter = {}) => {
      const query = new URLSearchParams();
      if (filter.q?.trim()) query.set("q", filter.q.trim());
      if (filter.status?.length) query.set("status", filter.status.join(","));
      query.set("limit", String(filter.limit ?? 100));
      if (filter.cursor) query.set("cursor", filter.cursor);
      return parse(testCaseListResponseSchema, await request("GET", "/test-cases", { query }), "test case list");
    },
    getTestCase: async (testCaseId) =>
      parse(testCaseDetailSchema, await request("GET", `/test-cases/${id(testCaseId)}`), "test case"),
    listCaseRuns: async (testCaseId, runOptions = {}) =>
      parse(
        testRunListResponseSchema,
        await request("GET", "/test-runs", { query: new URLSearchParams({ testCaseId, limit: String(runOptions.limit ?? 20) }) }),
        "run list"
      ),
    listRuns: async (runOptions = {}) => {
      const query = new URLSearchParams({ limit: String(runOptions.limit ?? 50) });
      if (runOptions.cursor) query.set("cursor", runOptions.cursor);
      return parse(testRunListResponseSchema, await request("GET", "/test-runs", { query }), "run list");
    },
    getRun: async (runId) => parse(testRunDetailSchema, await request("GET", `/test-runs/${id(runId)}`), "run"),
    createRun: async (testCaseId, input) =>
      parse(
        createTestRunResponseSchema,
        await request("POST", `/test-cases/${id(testCaseId)}/runs`, { body: createTestRunRequestSchema.parse(input) }),
        "run request result"
      ),
    cancelRun: async (runId) => {
      await request("POST", `/test-runs/${id(runId)}/cancel`);
    },
    listEnvironments: async () =>
      parse(z.array(testEnvironmentSchema), extractListItems(await request("GET", "/test-environments"), "environments"), "environment list"),
    listNotifications: async () =>
      parse(notificationListResponseSchema, await request("GET", "/notifications"), "notification list"),
    markNotificationRead: async (notificationId) => {
      await request("POST", `/notifications/${id(notificationId)}/read`);
    },
    markAllNotificationsRead: async () => {
      await request("POST", "/notifications/read-all");
    }
  };
}
