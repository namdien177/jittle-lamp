import { describe, expect, test } from "bun:test";

import { apiRequestScriptSchema, defaultApiPolicy, type ApiRequestScript } from "@jittle-lamp/shared";

import { ApiReplayHandoff, matchesShape, replayApi, type ApiReplayContext, type ReplayStore } from "../src/runtime/api-replay";

// Roadmap 2026-10-13 §2.4: captures between requests, status and shape checks, the hand-off error
// with the failing request, auth headers from the session and the environment's policy limits.

const origin = "https://api.example.test";

const script = (): ApiRequestScript =>
  apiRequestScriptSchema.parse({
    schemaVersion: "jl-api-1",
    stepId: "s1",
    instructionKey: null,
    recordedAt: "2026-10-13T10:00:00.000Z",
    auth: { "x-dev-domain": "pcf" },
    requests: [
      {
        seq: 1,
        method: "POST",
        origin,
        pathTemplate: "/api/applications",
        query: { school: "{{param.SCHOOL_CODE}}" },
        headersTemplate: { "content-type": "application/json", cookie: "{{auth.cookie}}", authorization: "{{auth.authorization}}", "x-dev-domain": "{{auth.x-dev-domain}}" },
        bodyKind: "json",
        bodyTemplate: { studentName: "{{param.person.name}}", submittedAt: "{{now:iso}}", amount: "{{param.AMOUNT}}" },
        numericLeaves: ["amount"],
        mutation: true,
        check: true,
        captures: [],
        expect: { statusClass: "2xx", shape: { data: { application: "object" }, ok: "boolean" } }
      },
      {
        seq: 2,
        method: "GET",
        origin,
        pathTemplate: "/api/applications/{{v1}}",
        query: {},
        headersTemplate: { cookie: "{{auth.cookie}}" },
        bodyKind: null,
        numericLeaves: [],
        mutation: false,
        check: false,
        captures: [{ as: "v1", fromSeq: 1, path: "data.application.id" }],
        expect: { statusClass: "2xx", shape: null }
      }
    ],
    reviewFlags: []
  });

type Sent = { url: string; method: string; headers: Record<string, string>; body: string | null };

function fakeFetch(handler: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const record: Sent = { url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null };
    sent.push(record);
    return handler(record);
  }) as unknown as typeof fetch;
  return { sent, fetch: impl };
}

const jsonResponse = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" }, ...init });

function context(overrides: Partial<ApiReplayContext> & Pick<ApiReplayContext, "fetch">): ApiReplayContext {
  const store: ReplayStore = new Map();
  return {
    stepId: "s1",
    baseUrl: "https://uat.example.test",
    apiOrigins: [origin],
    apiPolicy: { ...defaultApiPolicy, rateLimitPerSecond: 1000 },
    cookies: async () => [
      { name: "session", value: "abc" },
      { name: "csrf", value: "xyz" }
    ],
    param: (name) => ({ SCHOOL_CODE: "HQ", "person.name": "Nguyen Van A", AMOUNT: "1500" })[name],
    store,
    now: () => new Date("2026-10-14T00:00:00.000Z"),
    sleep: async () => undefined,
    ...overrides
  };
}

describe("API replay", () => {
  test("sends the requests in order, resolves params, auth and volatile values, and captures across requests", async () => {
    const created = "4f6c1c2a-3b1d-4e0f-9c7a-1234567890ab";
    const { sent, fetch } = fakeFetch((request) =>
      request.method === "POST" ? jsonResponse({ data: { application: { id: created } }, ok: true }, { status: 201 }) : jsonResponse({ id: created, status: "PENDING" })
    );
    const setCookies: unknown[] = [];
    const result = await replayApi(script(), context({ fetch, onSetCookie: async (cookies) => void setCookies.push(...cookies) }));
    expect(result).toMatchObject({ count: 2, mutations: 1 });
    expect(result.items.map((item) => [item.seq, item.method, item.path, item.status, item.mutation, item.error])).toEqual([
      [1, "POST", "/api/applications", 201, true, null],
      [2, "GET", `/api/applications/${created}`, 200, false, null]
    ]);
    expect(sent[0]?.url).toBe(`${origin}/api/applications?school=HQ`);
    expect(sent[0]?.headers).toMatchObject({ cookie: "session=abc; csrf=xyz", "x-dev-domain": "pcf", "content-type": "application/json" });
    // No bearer token in the session: the authorization header is left out, not sent empty.
    expect(sent[0]?.headers.authorization).toBeUndefined();
    expect(JSON.parse(sent[0]?.body ?? "{}")).toEqual({ studentName: "Nguyen Van A", submittedAt: "2026-10-14T00:00:00.000Z", amount: 1500 });
    expect(sent[1]?.url).toBe(`${origin}/api/applications/${created}`);
    expect(setCookies).toEqual([]);
  });

  test("a failed status class stops the replay with the request and reason; later requests never go out", async () => {
    const { sent, fetch } = fakeFetch(() => jsonResponse({ error: "closed" }, { status: 409 }));
    const error = await replayApi(script(), context({ fetch })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiReplayHandoff);
    const handoff = error as ApiReplayHandoff;
    expect(handoff.seq).toBe(1);
    expect(handoff.reason).toBe("status 409, recorded 2xx");
    expect(handoff.items).toHaveLength(1);
    expect(handoff.items[0]?.error).toBe("status 409, recorded 2xx");
    expect(sent).toHaveLength(1);
  });

  test("a response that lost a recorded key fails the shape check", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: { application: null }, ok: true }, { status: 201 }));
    const error = (await replayApi(script(), context({ fetch })).catch((caught: unknown) => caught)) as ApiReplayHandoff;
    expect(error.reason).toBe('response shape: data: "application" is null, recorded object');
    expect(matchesShape({ a: 1, b: [1] }, { a: "number", b: "array", c: "null" })).toBeNull();
    expect(matchesShape({ a: "1" }, { a: "number" })).toBe('"a" is string, recorded number');
  });

  test("a capture whose field is missing hands off before the dependent request", async () => {
    const { sent, fetch } = fakeFetch(() => jsonResponse({ data: { application: {} }, ok: true }, { status: 201 }));
    const error = (await replayApi(script(), context({ fetch })).catch((caught: unknown) => caught)) as ApiReplayHandoff;
    expect(error.seq).toBe(2);
    expect(error.reason).toBe("data.application.id is missing from the response of request 1");
    expect(sent).toHaveLength(1);
  });

  test("cross-step captures read the replay store; an origin outside the policy is refused", async () => {
    const store: ReplayStore = new Map([["s0", new Map([[1, { status: 201, headers: {}, body: { id: "from-s0" }, text: "" }]])]]);
    const cross = script();
    cross.requests = [{ ...cross.requests[1]!, seq: 1, captures: [{ as: "v1", fromSeq: 1, fromStepId: "s0", path: "id" }] }];
    const { sent, fetch } = fakeFetch(() => jsonResponse({ id: "from-s0" }));
    const result = await replayApi(cross, context({ fetch, store }));
    expect(result.items[0]?.path).toBe("/api/applications/from-s0");
    expect(sent).toHaveLength(1);

    const elsewhere = script();
    elsewhere.requests = [{ ...elsewhere.requests[0]!, origin: "https://other.example.test" }];
    const error = (await replayApi(elsewhere, context({ fetch })).catch((caught: unknown) => caught)) as ApiReplayHandoff;
    expect(error.reason).toBe("https://other.example.test is not one of the environment's API origins");
  });

  test("policy limits: the request cap refuses the script, the rate limit spaces requests", async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ data: { application: { id: "x" } }, ok: true }, { status: 201 }));
    const capped = (await replayApi(script(), context({ fetch, apiPolicy: { allowedPaths: [], maxRequestsPerStep: 1, rateLimitPerSecond: 10 } })).catch((caught: unknown) => caught)) as ApiReplayHandoff;
    expect(capped.reason).toBe("2 requests exceed the limit of 1 per step");

    const waits: number[] = [];
    await replayApi(script(), context({ fetch, apiPolicy: { allowedPaths: [], maxRequestsPerStep: 50, rateLimitPerSecond: 2 }, sleep: async (ms) => void waits.push(ms) }));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[0]).toBeLessThanOrEqual(500);
  });

  test("set-cookie headers of replayed responses reach the browser, and a stored bearer token is sent", async () => {
    const { sent, fetch } = fakeFetch((request) =>
      request.method === "POST"
        ? jsonResponse({ data: { application: { id: "id-1" } }, ok: true }, { status: 201, headers: { "content-type": "application/json", "set-cookie": "session=new; Path=/; HttpOnly" } })
        : jsonResponse({ id: "id-1" })
    );
    const cookies: Array<{ name: string; value: string; url: string }> = [];
    await replayApi(
      script(),
      context({
        fetch,
        apiPolicy: { ...defaultApiPolicy, rateLimitPerSecond: 1000, authStorageKeys: ["token"] },
        bearerToken: async () => "tok-123",
        onSetCookie: async (set) => void cookies.push(...set)
      })
    );
    expect(cookies).toEqual([{ name: "session", value: "new", url: `${origin}/api/applications?school=HQ` }]);
    expect(sent[0]?.headers.authorization).toBe("Bearer tok-123");
  });
});
