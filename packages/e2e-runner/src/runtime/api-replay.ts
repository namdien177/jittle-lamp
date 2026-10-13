import type { ApiPolicy, ApiRequestItem, ApiRequestScript, ApiScriptRequest, ApiStatusClass } from "@jittle-lamp/shared";

// Replay of an API script (roadmap 2026-10-13 §2.4): the requests of a passed step sent again
// with `fetch`, placeholders resolved from the live browser session, earlier responses and the
// run's variables. The first failed check stops the replay with an ApiReplayHandoff so the step
// falls back to the UI. This module runs inside the e2e worker: only type imports from shared.

export type ReplayCookie = { name: string; value: string };
export type ReplaySetCookie = { name: string; value: string; url: string };

export type ReplayedResponse = { status: number; headers: Record<string, string>; body: unknown; text: string };

// Responses of API steps replayed earlier in the same run, keyed by step id then script seq, so
// a capture with `fromStepId` resolves.
export type ReplayStore = Map<string, Map<number, ReplayedResponse>>;

export type ApiReplayContext = {
  stepId: string;
  baseUrl: string | null;
  apiOrigins: readonly string[];
  apiPolicy: ApiPolicy & { authHeaders?: readonly string[]; authStorageKeys?: readonly string[] };
  fetch: typeof fetch;
  cookies: () => Promise<ReplayCookie[]>;
  // Bearer token kept in localStorage under one of `apiPolicy.authStorageKeys`, when the app does
  // that; null skips the `authorization` header.
  bearerToken?: () => Promise<string | null>;
  // `{{param.NAME}}`: run params and outputs produced so far.
  param: (name: string) => string | undefined;
  store: ReplayStore;
  // Cookies the replayed responses set, handed to the browser so later UI steps stay signed in.
  onSetCookie?: (cookies: ReplaySetCookie[]) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type ApiReplayResult = {
  count: number;
  mutations: number;
  items: ApiRequestItem[];
};

export class ApiReplayHandoff extends Error {
  readonly code = "API_REPLAY_HANDOFF";
  constructor(
    readonly seq: number,
    readonly reason: string,
    readonly items: ApiRequestItem[]
  ) {
    super(`API replay stopped at request ${seq}: ${reason}`);
    this.name = "ApiReplayHandoff";
  }
}

const placeholderPattern = /\{\{([^{}]+)\}\}/g;

export function statusClassOf(status: number): ApiStatusClass {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
}

function getAt(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const parts: Array<string | number> = match[1] ? [match[1]] : [];
    for (const index of (match[2] ?? "").matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]));
    for (const part of parts) {
      if (current === null || typeof current !== "object") return undefined;
      current = (current as Record<string | number, unknown>)[part];
    }
  }
  return current;
}

// A JSON value is checked against the recorded shape: every recorded key is present with the
// same JSON type; recorded nulls accept anything, extra keys are fine.
export function matchesShape(value: unknown, shape: Record<string, unknown>): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "response is not a JSON object";
  for (const [key, expected] of Object.entries(shape)) {
    const actual = (value as Record<string, unknown>)[key];
    if (expected === "null") continue;
    if (actual === undefined) return `missing "${key}"`;
    if (typeof expected === "string") {
      const type = actual === null ? "null" : Array.isArray(actual) ? "array" : typeof actual;
      if (type !== expected) return `"${key}" is ${type}, recorded ${expected}`;
      continue;
    }
    if (expected !== null && typeof expected === "object") {
      const nested = matchesShape(actual, expected as Record<string, unknown>);
      if (nested) return `${key}: ${nested}`;
    }
  }
  return null;
}

type Resolved = { value: unknown; missing: string | null };

function resolvePlaceholder(token: string, request: ApiScriptRequest, ctx: ApiReplayContext, captured: Map<string, unknown>, auth: Record<string, string | null>): Resolved {
  if (token.startsWith("param.")) {
    const value = ctx.param(token.slice("param.".length));
    return value === undefined ? { value: undefined, missing: `{{${token}}} is not set` } : { value, missing: null };
  }
  if (token.startsWith("auth.")) {
    const name = token.slice("auth.".length);
    const value = auth[name];
    return value === undefined || value === null ? { value: undefined, missing: `{{${token}}} unavailable` } : { value, missing: null };
  }
  if (token === "now:iso") return { value: (ctx.now ?? (() => new Date()))().toISOString(), missing: null };
  if (token === "now:date") return { value: (ctx.now ?? (() => new Date()))().toISOString().slice(0, 10), missing: null };
  if (/^v\d+$/.test(token)) {
    if (captured.has(token)) return { value: captured.get(token), missing: null };
    const capture = request.captures.find((candidate) => candidate.as === token);
    return { value: undefined, missing: capture ? `{{${token}}} was not captured from request ${capture.fromSeq}` : `{{${token}}} has no capture` };
  }
  return { value: undefined, missing: `unknown placeholder {{${token}}}` };
}

// Substitutes placeholders in a template string; a lone placeholder keeps the value's own type
// when `typed` is set (so a captured number stays a number in a JSON body).
function substitute(template: string, request: ApiScriptRequest, ctx: ApiReplayContext, captured: Map<string, unknown>, auth: Record<string, string | null>, typed: boolean): Resolved {
  const whole = /^\{\{([^{}]+)\}\}$/.exec(template);
  if (whole && typed) return resolvePlaceholder(whole[1] ?? "", request, ctx, captured, auth);
  let missing: string | null = null;
  const value = template.replace(placeholderPattern, (_match, token: string) => {
    const resolved = resolvePlaceholder(token, request, ctx, captured, auth);
    if (resolved.missing && !missing) missing = resolved.missing;
    return resolved.value === undefined || resolved.value === null ? "" : typeof resolved.value === "string" ? resolved.value : JSON.stringify(resolved.value);
  });
  return { value, missing };
}

function substituteDeep(value: unknown, request: ApiScriptRequest, ctx: ApiReplayContext, captured: Map<string, unknown>, auth: Record<string, string | null>, path: string, errors: string[]): unknown {
  if (typeof value === "string") {
    const resolved = substitute(value, request, ctx, captured, auth, true);
    if (resolved.missing) errors.push(resolved.missing);
    if (request.numericLeaves.includes(path) && typeof resolved.value === "string" && resolved.value.trim() !== "" && Number.isFinite(Number(resolved.value))) return Number(resolved.value);
    return resolved.value;
  }
  if (Array.isArray(value)) return value.map((item, index) => substituteDeep(item, request, ctx, captured, auth, `${path}[${index}]`, errors));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, substituteDeep(item, request, ctx, captured, auth, path ? `${path}.${key}` : key, errors)])
    );
  }
  return value;
}

function parseSetCookie(header: string, url: string): ReplaySetCookie | null {
  const first = header.split(";")[0] ?? "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  return { name: first.slice(0, eq).trim(), value: first.slice(eq + 1).trim(), url };
}

function setCookieHeaders(headers: Headers): string[] {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") return withGetter.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export async function replayApi(script: ApiRequestScript, ctx: ApiReplayContext): Promise<ApiReplayResult> {
  const items: ApiRequestItem[] = [];
  const fail = (seq: number, reason: string): never => {
    throw new ApiReplayHandoff(seq, reason, items);
  };
  // Policy first: a script over the request cap never starts.
  if (script.requests.length > ctx.apiPolicy.maxRequestsPerStep) fail(1, `${script.requests.length} requests exceed the limit of ${ctx.apiPolicy.maxRequestsPerStep} per step`);
  const origins = new Set<string>();
  for (const origin of [...ctx.apiOrigins, ...(ctx.baseUrl ? [ctx.baseUrl] : [])]) {
    try {
      origins.add(new URL(origin).origin);
    } catch {
      // ignored
    }
  }

  const cookieHeader = (await ctx.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const bearer = ctx.bearerToken && (ctx.apiPolicy.authStorageKeys?.length ?? 0) > 0 ? await ctx.bearerToken() : null;
  const auth: Record<string, string | null> = {
    ...script.auth,
    cookie: cookieHeader.length > 0 ? cookieHeader : null,
    authorization: bearer ? (bearer.toLowerCase().startsWith("bearer ") ? bearer : `Bearer ${bearer}`) : null
  };

  const captured = new Map<string, unknown>();
  const own = new Map<number, ReplayedResponse>();
  ctx.store.set(ctx.stepId, own);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spacingMs = ctx.apiPolicy.rateLimitPerSecond > 0 ? 1000 / ctx.apiPolicy.rateLimitPerSecond : 0;
  let lastSentAt = 0;
  let mutations = 0;

  for (const request of script.requests) {
    // Captures this request needs, from the replayed responses of this step or an earlier one.
    for (const capture of request.captures) {
      const source = capture.fromStepId ? ctx.store.get(capture.fromStepId)?.get(capture.fromSeq) : own.get(capture.fromSeq);
      if (!source) {
        fail(request.seq, capture.fromStepId ? `request ${capture.fromSeq} of step ${capture.fromStepId} did not replay before this step` : `request ${capture.fromSeq} has no response to capture from`);
        continue;
      }
      const value = capture.path.startsWith("header.") ? source.headers[capture.path.slice("header.".length).toLowerCase()] : getAt(source.body, capture.path);
      if (value === undefined) fail(request.seq, `${capture.path} is missing from the response of request ${capture.fromSeq}`);
      captured.set(capture.as, value);
    }

    const errors: string[] = [];
    const path = substitute(request.pathTemplate, request, ctx, captured, auth, false);
    if (path.missing) errors.push(path.missing);
    const url = new URL(String(path.value), request.origin);
    for (const [name, template] of Object.entries(request.query)) {
      const resolved = substitute(template, request, ctx, captured, auth, false);
      if (resolved.missing) errors.push(resolved.missing);
      url.searchParams.set(name, String(resolved.value ?? ""));
    }
    if (!origins.has(url.origin)) fail(request.seq, `${url.origin} is not one of the environment's API origins`);
    const headers = new Headers();
    for (const [name, template] of Object.entries(request.headersTemplate)) {
      const resolved = substitute(template, request, ctx, captured, auth, false);
      // An auth header the session does not have is left out rather than sent empty.
      if (resolved.missing && template.startsWith("{{auth.")) continue;
      if (resolved.missing) errors.push(resolved.missing);
      headers.set(name, String(resolved.value ?? ""));
    }
    let body: BodyInit | undefined;
    if (request.bodyKind === "json") {
      body = JSON.stringify(substituteDeep(request.bodyTemplate, request, ctx, captured, auth, "", errors));
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    } else if (request.bodyKind === "text" && typeof request.bodyTemplate === "string") {
      const resolved = substitute(request.bodyTemplate, request, ctx, captured, auth, false);
      if (resolved.missing) errors.push(resolved.missing);
      body = String(resolved.value ?? "");
    }
    if (errors.length > 0) fail(request.seq, errors[0] ?? "unresolved placeholder");

    const wait = spacingMs - (Date.now() - lastSentAt);
    if (lastSentAt > 0 && wait > 0) await sleep(wait);
    lastSentAt = Date.now();
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await ctx.fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), redirect: "manual" });
    } catch (error) {
      items.push({ seq: request.seq, method: request.method, path: url.pathname, status: null, durationMs: Date.now() - startedAt, mutation: request.mutation, error: error instanceof Error ? error.message : String(error) });
      fail(request.seq, `request failed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const text = await response.text();
    const durationMs = Date.now() - startedAt;
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name.toLowerCase()] = value;
    });
    own.set(request.seq, { status: response.status, headers: responseHeaders, body: parsed, text });
    if (request.mutation) mutations += 1;
    const item: ApiRequestItem = { seq: request.seq, method: request.method, path: url.pathname, status: response.status, durationMs, mutation: request.mutation, error: null };
    items.push(item);

    const cookies = setCookieHeaders(response.headers)
      .map((header) => parseSetCookie(header, url.toString()))
      .filter((cookie): cookie is ReplaySetCookie => cookie !== null);
    if (cookies.length > 0 && ctx.onSetCookie) await ctx.onSetCookie(cookies);

    if (request.check && request.expect) {
      const statusClass = statusClassOf(response.status);
      if (statusClass !== request.expect.statusClass) {
        item.error = `status ${response.status}, recorded ${request.expect.statusClass}`;
        fail(request.seq, item.error);
      }
      if (request.expect.shape) {
        const mismatch = matchesShape(parsed, request.expect.shape);
        if (mismatch) {
          item.error = `response shape: ${mismatch}`;
          fail(request.seq, item.error);
        }
      }
    }
  }
  return { count: items.length, mutations, items };
}
