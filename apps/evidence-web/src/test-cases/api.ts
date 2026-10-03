import { z } from "zod/v4";
import {
  bulkTestCaseResponseSchema,
  createTestRunResponseSchema,
  duplicateTestCaseResponseSchema,
  similarTestCasesResponseSchema,
  stepScriptSchema,
  testCaseDetailSchema,
  testCaseListResponseSchema,
  testCaseVersionSchema,
  testCredentialSchema,
  testEnvironmentSchema,
  testMacroSchema,
  testRunDetailSchema,
  testRunListResponseSchema,
  testTagSchema,
  type BulkTestCaseRequest,
  type CreateTestCaseRequest,
  type CreateTestRunRequest,
  type DuplicateTestCaseRequest,
  type TestCaseListQuery,
  type UpdateTestCaseRequest
} from "@jittle-lamp/shared";

import { apiOrigin } from "../env";
import type { FetchToken } from "../api";
import { listQuerySearchParams } from "./list-model";

// Typed client for the test-case platform routes (design.md §6). Every response is validated
// against the shared contract, so a backend drift shows up as an error here, not as a broken page.

export class TestApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status: number, code: string | null, details: unknown) {
    super(message);
    this.name = "TestApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isConflictError(error: unknown): error is TestApiError {
  return error instanceof TestApiError && error.status === 409;
}

async function request(getToken: FetchToken, path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await getToken();
  if (!token) throw new Error("Sign in is required.");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${apiOrigin}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const error = (payload as { error?: { message?: string; code?: string } } | null)?.error;
    throw new TestApiError(error?.message ?? `Request failed (${response.status}).`, response.status, error?.code ?? null, payload);
  }
  return payload;
}

// The contract fixes payload shapes; envelopes ({ testCase }, { items }) vary by route, so accept
// the bare payload or the first matching envelope key.
export function parseEnvelope<T>(schema: z.ZodType<T>, payload: unknown, keys: readonly string[], label: string): T {
  const direct = schema.safeParse(payload);
  if (direct.success) return direct.data;
  if (payload && typeof payload === "object") {
    for (const key of keys) {
      const value = (payload as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const nested = schema.safeParse(value);
      if (nested.success) return nested.data;
    }
  }
  throw new Error(`Unexpected ${label} response: ${direct.error.issues[0]?.path.join(".") ?? ""} ${direct.error.issues[0]?.message ?? ""}`.trim());
}

function parseList<T>(schema: z.ZodType<T>, payload: unknown, keys: readonly string[], label: string): T[] {
  return parseEnvelope(z.array(schema), payload, ["items", ...keys], label);
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const id = (value: string) => encodeURIComponent(value);

export const testApi = {
  listTestCases: async (getToken: FetchToken, query: Partial<TestCaseListQuery>, signal?: AbortSignal) =>
    parseEnvelope(
      testCaseListResponseSchema,
      await request(getToken, `/test-cases?${listQuerySearchParams(query).toString()}`, signal ? { signal } : {}),
      [],
      "test case list"
    ),

  getTestCase: async (getToken: FetchToken, testCaseId: string) =>
    parseEnvelope(testCaseDetailSchema, await request(getToken, `/test-cases/${id(testCaseId)}`), ["testCase"], "test case"),

  createTestCase: async (getToken: FetchToken, input: Partial<CreateTestCaseRequest> & Pick<CreateTestCaseRequest, "transcript">) =>
    parseEnvelope(testCaseDetailSchema, await request(getToken, "/test-cases", { method: "POST", ...json(input) }), ["testCase"], "created test case"),

  updateTestCase: async (getToken: FetchToken, testCaseId: string, input: UpdateTestCaseRequest) =>
    parseEnvelope(
      testCaseDetailSchema,
      await request(getToken, `/test-cases/${id(testCaseId)}`, { method: "PATCH", ...json(input) }),
      ["testCase"],
      "updated test case"
    ),

  deleteTestCase: async (getToken: FetchToken, testCaseId: string) => {
    await request(getToken, `/test-cases/${id(testCaseId)}`, { method: "DELETE" });
  },

  listVersions: async (getToken: FetchToken, testCaseId: string) =>
    parseList(testCaseVersionSchema, await request(getToken, `/test-cases/${id(testCaseId)}/versions`), ["versions"], "versions"),

  listScripts: async (getToken: FetchToken, testCaseId: string) =>
    parseList(stepScriptSchema, await request(getToken, `/test-cases/${id(testCaseId)}/scripts`), ["scripts"], "step scripts"),

  clearScripts: async (getToken: FetchToken, testCaseId: string, stepId?: string) => {
    await request(getToken, `/test-cases/${id(testCaseId)}/scripts${stepId ? `/${id(stepId)}` : ""}`, { method: "DELETE" });
  },

  duplicateTestCase: async (getToken: FetchToken, testCaseId: string, input: Partial<DuplicateTestCaseRequest>) =>
    parseEnvelope(
      duplicateTestCaseResponseSchema,
      await request(getToken, `/test-cases/${id(testCaseId)}/duplicate`, { method: "POST", ...json(input) }),
      [],
      "duplicate"
    ),

  bulk: async (getToken: FetchToken, input: Partial<BulkTestCaseRequest> & Pick<BulkTestCaseRequest, "action" | "ids">) =>
    parseEnvelope(bulkTestCaseResponseSchema, await request(getToken, "/test-cases/bulk", { method: "POST", ...json(input) }), [], "bulk action"),

  // `title` is what the route matches on; `q` is the contract's alias.
  similar: async (getToken: FetchToken, q: string, signal?: AbortSignal, excludeId?: string | null) =>
    parseEnvelope(
      similarTestCasesResponseSchema,
      await request(
        getToken,
        `/test-cases/similar?${new URLSearchParams({ q, title: q, ...(excludeId ? { excludeId } : {}) }).toString()}`,
        signal ? { signal } : {}
      ),
      [],
      "similar cases"
    ),

  createRun: async (getToken: FetchToken, testCaseId: string, input: Partial<CreateTestRunRequest>) =>
    parseEnvelope(
      createTestRunResponseSchema,
      await request(getToken, `/test-cases/${id(testCaseId)}/runs`, { method: "POST", ...json(input) }),
      [],
      "run request"
    ),

  listRuns: async (getToken: FetchToken, testCaseId: string, cursor?: string) =>
    parseEnvelope(
      testRunListResponseSchema,
      await request(getToken, `/test-cases/${id(testCaseId)}/runs${cursor ? `?cursor=${id(cursor)}` : ""}`),
      [],
      "runs"
    ),

  getRun: async (getToken: FetchToken, runId: string, signal?: AbortSignal) =>
    parseEnvelope(testRunDetailSchema, await request(getToken, `/test-runs/${id(runId)}`, signal ? { signal } : {}), ["run"], "run"),

  cancelRun: async (getToken: FetchToken, runId: string) => {
    await request(getToken, `/test-runs/${id(runId)}/cancel`, { method: "POST", ...json({}) });
  },

  listEnvironments: async (getToken: FetchToken) =>
    parseList(testEnvironmentSchema, await request(getToken, "/test-environments"), ["environments"], "environments"),

  listMacros: async (getToken: FetchToken) => parseList(testMacroSchema, await request(getToken, "/test-macros"), ["macros"], "macros"),

  listCredentials: async (getToken: FetchToken) =>
    parseList(testCredentialSchema, await request(getToken, "/test-credentials"), ["credentials"], "credentials"),

  listTags: async (getToken: FetchToken) => parseList(testTagSchema, await request(getToken, "/test-tags"), ["tags"], "tags")
};
