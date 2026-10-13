import { describe, expect, test } from "bun:test";

import { applyApiScriptFixes, defaultApiPolicy } from "@jittle-lamp/shared";

import { buildApiScripts, classifyToken, isApiRequest, jsonLeaves, pathAllowed, shapeOf, type BuilderStep } from "../src/api/script-builder";
import type { CapturedRequest } from "../src/runtime/capture";

// Roadmap 2026-10-13 §2.3: correlation of dynamic values against earlier responses, binding to run
// params, volatile timestamps, review flags, auth header templating and read filtering.

const origin = "https://api.example.test";
const policy = { ...defaultApiPolicy, allowedPaths: ["/api/**"] };
const t = (ms: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, 0, ms)).toISOString();

function request(input: Partial<CapturedRequest> & { seq: number; method: string; url: string; at: number }): CapturedRequest {
  const { at, ...rest } = input;
  return {
    kind: "request",
    startedAt: t(at),
    finishedAt: t(at + 50),
    resourceType: "fetch",
    requestHeaders: [{ name: "accept", value: "application/json" }],
    status: 200,
    statusText: "OK",
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    durationMs: 50,
    ...rest
  };
}

const json = (value: unknown) => ({ disposition: "captured" as const, encoding: "utf8" as const, mimeType: "application/json", value: JSON.stringify(value), byteLength: 10 });

const applicationId = "4f6c1c2a-3b1d-4e0f-9c7a-1234567890ab";
const studentId = "7b2e9a10-aaaa-4bbb-8ccc-0987654321fe";

const steps: BuilderStep[] = [
  { stepId: "s1", instructionKey: "sha256:a", startedAt: t(0), finishedAt: t(1000), eligible: true },
  { stepId: "s2", instructionKey: "sha256:b", startedAt: t(1001), finishedAt: t(2000), eligible: true }
];

const requests: CapturedRequest[] = [
  // s1: creates an application for a student named by a run param, with session headers.
  request({
    seq: 1,
    method: "POST",
    url: `${origin}/api/applications?school=HQ`,
    at: 100,
    requestHeaders: [
      { name: "content-type", value: "application/json" },
      { name: "cookie", value: "[redacted]" },
      { name: "authorization", value: "[redacted]" },
      { name: "x-dev-domain", value: "pcf" },
      { name: "x-request-id", value: "11111111-2222-4333-8444-555555555555" }
    ],
    requestBody: json({ studentName: "Nguyen Van A", submittedAt: "2026-10-13T10:00:00.000Z", dob: "2021-04-02", amount: 1500, nested: { level: "K1" } }),
    status: 201,
    responseBody: json({ data: { application: { id: applicationId, number: 123456, student: { id: studentId } } }, ok: true, items: [] })
  }),
  request({ seq: 2, method: "GET", url: `${origin}/api/applications/${applicationId}`, at: 300, responseBody: json({ id: applicationId, status: "PENDING" }) }),
  // Noise: a stylesheet and a third-party call are never part of a script.
  request({ seq: 3, method: "GET", url: `${origin}/static/app.css`, at: 350, resourceType: "stylesheet" }),
  request({ seq: 4, method: "POST", url: "https://analytics.example.test/collect", at: 360 }),
  // s2: approves the application created in s1 (cross-step capture) with an unexplained id.
  request({
    seq: 5,
    method: "PUT",
    url: `${origin}/api/applications/${applicationId}/approve`,
    at: 1200,
    requestHeaders: [{ name: "content-type", value: "application/json" }],
    requestBody: json({ reviewerId: 998877, note: "ok" }),
    responseBody: json({ id: applicationId, status: "APPROVED" })
  })
];

describe("API script builder", () => {
  const { scripts } = buildApiScripts({
    requests,
    steps,
    baseUrl: "https://uat.example.test",
    apiOrigins: [origin],
    apiPolicy: policy,
    params: { SCHOOL_CODE: "HQ", "person.name": "Nguyen Van A" },
    recordedAt: t(5000)
  });
  const [s1, s2] = scripts;

  test("keeps API requests only and orders them per step", () => {
    expect(scripts.map((script) => script.stepId)).toEqual(["s1", "s2"]);
    expect(s1?.requests.map((request) => [request.seq, request.method, request.mutation, request.check])).toEqual([
      [1, "POST", true, true],
      [2, "GET", false, false]
    ]);
    expect(isApiRequest(requests[2]!, { baseUrl: null, apiOrigins: [origin], apiPolicy: policy })).toBe(false);
    expect(isApiRequest(requests[3]!, { baseUrl: null, apiOrigins: [origin], apiPolicy: policy })).toBe(false);
  });

  test("binds values that match run params and templates auth headers", () => {
    const create = s1?.requests[0];
    expect(create?.query).toEqual({ school: "{{param.SCHOOL_CODE}}" });
    expect(create?.bodyTemplate).toEqual({ studentName: "{{param.person.name}}", submittedAt: "{{now:iso}}", dob: "{{now:date}}", amount: 1500, nested: { level: "K1" } });
    expect(create?.headersTemplate).toEqual({ "content-type": "application/json", cookie: "{{auth.cookie}}", authorization: "{{auth.authorization}}", "x-dev-domain": "{{auth.x-dev-domain}}" });
    expect(s1?.auth).toEqual({ "x-dev-domain": "pcf" });
    expect(JSON.stringify(s1)).not.toContain("[redacted]");
    expect(JSON.stringify(s1)).not.toContain("11111111-2222");
  });

  test("captures a UUID that appears in a later path from the response that produced it", () => {
    const read = s1?.requests[1];
    expect(read?.pathTemplate).toBe("/api/applications/{{v1}}");
    expect(read?.captures).toEqual([{ as: "v1", fromSeq: 1, path: "data.application.id" }]);
  });

  test("records status class and a two-level response shape for mutations", () => {
    expect(s1?.requests[0]?.expect).toEqual({
      statusClass: "2xx",
      shape: { data: { application: "object" }, ok: "boolean", items: "array" }
    });
    expect(s1?.requests[1]?.expect?.statusClass).toBe("2xx");
  });

  test("a value from an earlier step's script becomes a cross-step capture; an unknown one is flagged", () => {
    const approve = s2?.requests[0];
    expect(approve?.pathTemplate).toBe("/api/applications/{{v1}}/approve");
    // The nearest earlier response holding the value wins: the read of step s1, not its create.
    expect(approve?.captures).toEqual([{ as: "v1", fromSeq: 2, fromStepId: "s1", path: "id" }]);
    expect(s2?.reviewFlags).toEqual([{ seq: 1, location: "body.reviewerId", value: "998877", reason: "integer value not found in an earlier response", candidates: [] }]);
    expect(approve?.numericLeaves).toEqual([]);
  });

  test("a value produced by a step without a script is flagged with candidates from the step's own responses", () => {
    const { scripts: flagged } = buildApiScripts({
      requests: [
        request({ seq: 1, method: "GET", url: `${origin}/api/me`, at: 100, responseBody: json({ id: studentId, tenant: "pcf" }) }),
        request({ seq: 2, method: "GET", url: `${origin}/api/lookup`, at: 1100, responseBody: json({ token: 424242 }) }),
        request({ seq: 3, method: "POST", url: `${origin}/api/students/${studentId}/notes`, at: 1200, requestBody: json({ text: "hi" }), status: 201, responseBody: json({ ok: true }) })
      ],
      steps: [
        { ...steps[0]!, eligible: false },
        { ...steps[1]! }
      ],
      baseUrl: null,
      apiOrigins: [origin],
      apiPolicy: policy,
      params: {}
    });
    expect(flagged).toHaveLength(1);
    const script = flagged[0]!;
    expect(script.stepId).toBe("s2");
    expect(script.requests[1]?.pathTemplate).toBe(`/api/students/${studentId}/notes`);
    expect(script.reviewFlags).toEqual([
      { seq: 2, location: "path[3]", value: studentId, reason: "uuid value came from a step without an API script", candidates: [{ fromSeq: 1, path: "token", sample: "424242" }] }
    ]);
    // The reviewer's fix rewrites the literal into a capture and clears the flag.
    const fixed = applyApiScriptFixes(script, [{ seq: 2, location: "path[3]", fromSeq: 1, path: "token" }]);
    expect(fixed.requests[1]?.pathTemplate).toBe("/api/students/{{v1}}/notes");
    expect(fixed.requests[1]?.captures).toEqual([{ as: "v1", fromSeq: 1, path: "token" }]);
    expect(fixed.reviewFlags).toEqual([]);
    expect(() => applyApiScriptFixes(script, [{ seq: 2, location: "path[3]", fromSeq: 2, path: "token" }])).toThrow(/cannot capture/);
  });

  test("outputs of earlier steps bind like params; a numeric body leaf remembers its type", () => {
    const { scripts: bound } = buildApiScripts({
      requests: [request({ seq: 1, method: "POST", url: `${origin}/api/holds`, at: 1200, requestBody: json({ applicationId: 123456, seats: 2 }), status: 201, responseBody: json({ ok: true }) })],
      steps,
      baseUrl: null,
      apiOrigins: [origin],
      apiPolicy: policy,
      params: {},
      outputs: [{ stepId: "s1", name: "registration.applicationId", value: "123456" }]
    });
    const hold = bound[0]?.requests[0];
    expect(bound[0]?.stepId).toBe("s2");
    expect(hold?.bodyTemplate).toEqual({ applicationId: "{{param.registration.applicationId}}", seats: 2 });
    expect(hold?.numericLeaves).toEqual(["applicationId"]);
    expect(bound[0]?.reviewFlags).toEqual([]);
  });

  test("steps that are not eligible or have no API traffic get no script", () => {
    const { scripts: none } = buildApiScripts({ requests, steps: steps.map((step) => ({ ...step, eligible: false })), baseUrl: null, apiOrigins: [origin], apiPolicy: policy, params: {} });
    expect(none).toEqual([]);
  });

  test("helpers: token classes, path globs, leaves and shapes", () => {
    expect(classifyToken(applicationId)).toBe("uuid");
    expect(classifyToken("2026-10-13T10:00:00Z")).toBe("timestamp");
    expect(classifyToken("2026-10-13")).toBe("date");
    expect(classifyToken("123456")).toBe("integer");
    expect(classifyToken("123")).toBeNull();
    expect(classifyToken("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toBe("jwt");
    expect(classifyToken("Widget")).toBeNull();
    expect(pathAllowed("/api/v1/x", ["/api/**"])).toBe(true);
    expect(pathAllowed("/api/v1/x", ["/api/*"])).toBe(false);
    expect(pathAllowed("/other", ["/api/**"])).toBe(false);
    expect(pathAllowed("/anything", [])).toBe(true);
    expect(jsonLeaves({ a: { b: [1, "x"] }, c: true })).toEqual([
      { path: "a.b[0]", value: "1" },
      { path: "a.b[1]", value: "x" },
      { path: "c", value: "true" }
    ]);
    expect(shapeOf({ a: { b: { c: 1 } }, d: null, e: [1] })).toEqual({ a: { b: "object" }, d: "null", e: "array" });
    expect(shapeOf([1])).toBeNull();
  });
});
