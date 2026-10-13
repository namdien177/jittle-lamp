import {
  apiRequestScriptSchema,
  statusClassOf,
  type ApiCapture,
  type ApiPolicy,
  type ApiRequestScript,
  type ApiReviewFlag,
  type ApiScriptRequest
} from "@jittle-lamp/shared";

import type { CapturedRequest } from "../runtime/capture";

// Request log → API script per passed step (roadmap 2026-10-13 §2.3). Pure: the runner reads
// requests.jsonl and the step log, this module decides what a replay would send. Correlation
// works by exact-string search of dynamic-looking values in earlier responses of the same run;
// what it cannot resolve is flagged `review` with the fields a reviewer may bind it to.

export type BuilderStep = {
  stepId: string;
  instructionKey: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  // Whether a script may be built for the step (passed, UI-driven, in a block that allows API).
  eligible: boolean;
};

export type BuilderOutput = { stepId: string; name: string; value: string };

export type BuildApiScriptsInput = {
  requests: readonly CapturedRequest[];
  // Executing leaf steps, in run order.
  steps: readonly BuilderStep[];
  baseUrl: string | null;
  apiOrigins: readonly string[];
  apiPolicy: ApiPolicy & { authHeaders?: readonly string[] };
  // Run params (values are public; secrets never reach the request log).
  params: Readonly<Record<string, string>>;
  // Variables the run produced, with the step that produced each.
  outputs?: readonly BuilderOutput[];
  recordedAt?: string;
};

export type BuildApiScriptsResult = { scripts: ApiRequestScript[] };

export const apiResourceTypes = new Set(["xhr", "fetch"]);
// Headers that identify the session: templated as {{auth.<name>}} (roadmap §2.3 step 3).
export const defaultAuthHeaders = ["authorization", "cookie", "x-dev-domain"] as const;
// Auth headers whose value is a secret: never kept, resolved from the live session at replay.
const secretAuthHeaders = new Set(["authorization", "cookie", "proxy-authorization"]);
// Request headers the browser or the transport sets; a replay sends its own.
const droppedRequestHeaders = new Set([
  "host",
  "content-length",
  "origin",
  "referer",
  "user-agent",
  "accept-encoding",
  "accept-language",
  "connection",
  "pragma",
  "cache-control",
  "priority",
  "dnt",
  "upgrade-insecure-requests",
  "x-request-id",
  "x-trace-id",
  "x-correlation-id",
  "traceparent",
  "tracestate",
  "if-none-match",
  "if-modified-since"
]);
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const integerPattern = /^\d{4,}$/;
const jwtPattern = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export type DynamicKind = "uuid" | "integer" | "jwt" | "timestamp" | "date" | null;

export function classifyToken(value: string): DynamicKind {
  if (uuidPattern.test(value)) return "uuid";
  if (isoTimestampPattern.test(value)) return "timestamp";
  if (isoDatePattern.test(value)) return "date";
  if (jwtPattern.test(value)) return "jwt";
  if (integerPattern.test(value)) return "integer";
  return null;
}

// scout-style path globs: `**` spans segments, `*` one segment.
export function pathAllowed(pathname: string, allowedPaths: readonly string[]): boolean {
  if (allowedPaths.length === 0) return true;
  return allowedPaths.some((pattern) => {
    const source = pattern
      .split("**")
      .map((part) => part.split("*").map(escapeRegExp).join("[^/]*"))
      .join(".*");
    return new RegExp(`^${source}$`).test(pathname);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function allowedOrigins(baseUrl: string | null, apiOrigins: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const origin of apiOrigins) {
    try {
      origins.add(new URL(origin).origin);
    } catch {
      // not a URL: ignored
    }
  }
  if (baseUrl) {
    try {
      origins.add(new URL(baseUrl).origin);
    } catch {
      // ignored
    }
  }
  return origins;
}

// Requests an API script may contain: app traffic to the environment's API origins.
export function isApiRequest(request: CapturedRequest, input: Pick<BuildApiScriptsInput, "baseUrl" | "apiOrigins" | "apiPolicy">): boolean {
  if (!apiResourceTypes.has(request.resourceType)) return false;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (!allowedOrigins(input.baseUrl, input.apiOrigins).has(url.origin)) return false;
  return pathAllowed(url.pathname, input.apiPolicy.allowedPaths);
}

type Leaf = { path: string; value: string };

// Primitive leaves of a JSON value with their dotted paths (`data.items[0].id`).
export function jsonLeaves(value: unknown, prefix = ""): Leaf[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item, index) => jsonLeaves(item, `${prefix}[${index}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => jsonLeaves(item, prefix ? `${prefix}.${key}` : key));
  }
  if (typeof value === "boolean") return [{ path: prefix, value: String(value) }];
  return [{ path: prefix, value: String(value) }];
}

// Keys and JSON types of a response body, two levels deep (roadmap §2.3 step 4).
export function shapeOf(value: unknown, depth = 2): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const shape: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) shape[key] = "null";
    else if (Array.isArray(item)) shape[key] = "array";
    else if (typeof item === "object") shape[key] = depth > 1 ? (shapeOf(item, depth - 1) ?? "object") : "object";
    else shape[key] = typeof item;
  }
  return shape;
}

function parseJsonBody(body: CapturedRequest["requestBody"]): { kind: "json" | "text"; value: unknown } | null {
  if (!body || body.disposition !== "captured" || body.value === undefined) return null;
  if (body.mimeType && /json/i.test(body.mimeType)) {
    try {
      return { kind: "json", value: JSON.parse(body.value) };
    } catch {
      return { kind: "text", value: body.value };
    }
  }
  return { kind: "text", value: body.value };
}

type IndexedResponse = {
  stepId: string | null;
  // Script-local sequence when the request's step gets a script; null otherwise.
  localSeq: number | null;
  leaves: Leaf[];
};

// The requests of one step, in recorded order, with the step's window.
function groupByStep(input: BuildApiScriptsInput, requests: readonly CapturedRequest[]): Map<string, CapturedRequest[]> {
  const windows = input.steps.flatMap((step) => {
    if (!step.startedAt) return [];
    return [{ stepId: step.stepId, start: Date.parse(step.startedAt), end: step.finishedAt ? Date.parse(step.finishedAt) : Number.POSITIVE_INFINITY }];
  });
  const groups = new Map<string, CapturedRequest[]>();
  for (const request of requests) {
    const at = Date.parse(request.startedAt);
    const owner = windows.filter((window) => at >= window.start && at <= window.end).at(-1);
    if (!owner) continue;
    groups.set(owner.stepId, [...(groups.get(owner.stepId) ?? []), request]);
  }
  return groups;
}

export function buildApiScripts(input: BuildApiScriptsInput): BuildApiScriptsResult {
  const apiRequests = [...input.requests].filter((request) => isApiRequest(request, input)).sort((a, b) => a.seq - b.seq);
  const groups = groupByStep(input, apiRequests);
  const authNames = new Set<string>([...defaultAuthHeaders, ...(input.apiPolicy.authHeaders ?? []).map((name) => name.toLowerCase())]);
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const outputs = input.outputs ?? [];
  const stepOrder = new Map(input.steps.map((step, index) => [step.stepId, index]));

  // Responses seen so far in recorded order; later requests search them nearest first.
  const responses: IndexedResponse[] = [];
  const scripts: ApiRequestScript[] = [];

  for (const step of input.steps) {
    const requests = groups.get(step.stepId) ?? [];
    if (!step.eligible || requests.length === 0) {
      // Still searchable by later steps, but nothing can capture from them.
      for (const request of requests) responses.push({ stepId: step.stepId, localSeq: null, leaves: responseLeaves(request) });
      continue;
    }
    const position = stepOrder.get(step.stepId) ?? 0;
    const bindable: Array<[string, string]> = [
      ...Object.entries(input.params),
      ...outputs.filter((output) => (stepOrder.get(output.stepId) ?? Number.POSITIVE_INFINITY) < position).map((output): [string, string] => [output.name, output.value])
    ];
    const scriptRequests: ApiScriptRequest[] = [];
    const reviewFlags: ApiReviewFlag[] = [];
    const auth: Record<string, string> = {};
    let captureCount = 0;
    const stepStart = responses.length;

    requests.forEach((request, index) => {
      const seq = index + 1;
      const url = new URL(request.url);
      const captures: ApiCapture[] = [];
      const captureFor = (source: IndexedResponse, path: string): string => {
        const existing = captures.find((capture) => capture.path === path && capture.fromSeq === source.localSeq && (capture.fromStepId ?? step.stepId) === source.stepId);
        if (existing) return `{{${existing.as}}}`;
        captureCount += 1;
        const as = `v${captureCount}`;
        captures.push({ as, fromSeq: source.localSeq ?? 0, ...(source.stepId !== step.stepId && source.stepId ? { fromStepId: source.stepId } : {}), path });
        return `{{${as}}}`;
      };

      // One value of the request: bound to a param, captured, regenerated or flagged.
      const resolve = (value: string, location: string): string => {
        const param = bindable.find(([, candidate]) => candidate === value && value.length > 0);
        if (param) return `{{param.${param[0]}}}`;
        const kind = classifyToken(value);
        if (kind === null) return value;
        if (kind === "timestamp") return "{{now:iso}}";
        if (kind === "date") return "{{now:date}}";
        // Nearest earlier response first: the same step, then earlier steps.
        for (let cursor = responses.length - 1; cursor >= 0; cursor -= 1) {
          const source = responses[cursor];
          if (!source) continue;
          const leaf = source.leaves.find((candidate) => candidate.value === value);
          if (!leaf) continue;
          if (source.localSeq !== null) return captureFor(source, leaf.path);
          reviewFlags.push({ seq, location, value, reason: `${kind} value came from a step without an API script`, candidates: candidatesFor(responses, stepStart, step.stepId) });
          return value;
        }
        reviewFlags.push({ seq, location, value, reason: `${kind} value not found in an earlier response`, candidates: candidatesFor(responses, stepStart, step.stepId) });
        return value;
      };

      const segments = url.pathname.split("/").map((segment, position) => (segment.length === 0 ? segment : resolve(decodeURIComponent(segment), `path[${position}]`)));
      const query: Record<string, string> = {};
      for (const [name, value] of url.searchParams) query[name] = resolve(value, `query.${name}`);

      const headersTemplate: Record<string, string> = {};
      for (const header of request.requestHeaders) {
        const name = header.name.toLowerCase();
        if (name.startsWith(":") || droppedRequestHeaders.has(name)) continue;
        if (authNames.has(name)) {
          headersTemplate[name] = `{{auth.${name}}}`;
          if (!secretAuthHeaders.has(name) && header.value !== "[redacted]") auth[name] = header.value;
          continue;
        }
        headersTemplate[name] = resolve(header.value, `header.${name}`);
      }

      const body = parseJsonBody(request.requestBody);
      const numericLeaves: string[] = [];
      let bodyTemplate: unknown;
      if (body?.kind === "json") {
        bodyTemplate = structuredClone(body.value);
        for (const leaf of jsonLeaves(body.value)) {
          const original = getAt(bodyTemplate, leaf.path);
          if (typeof original === "boolean") continue;
          const resolved = resolve(leaf.value, `body.${leaf.path}`);
          if (resolved === leaf.value) continue;
          setAt(bodyTemplate, leaf.path, resolved);
          if (typeof original === "number") numericLeaves.push(leaf.path);
        }
      } else if (body?.kind === "text") {
        bodyTemplate = resolve(String(body.value), "body");
      }

      const mutation = !readMethods.has(request.method.toUpperCase());
      const responseBody = parseJsonBody(request.responseBody);
      scriptRequests.push({
        seq,
        method: request.method.toUpperCase(),
        origin: url.origin,
        pathTemplate: segments.join("/"),
        query,
        headersTemplate,
        bodyKind: body?.kind ?? null,
        ...(body ? { bodyTemplate } : {}),
        numericLeaves,
        mutation,
        check: mutation,
        captures,
        expect:
          request.status === undefined
            ? null
            : { statusClass: statusClassOf(request.status), shape: responseBody?.kind === "json" ? shapeOf(responseBody.value) : null },
        recorded: { status: request.status ?? null, durationMs: request.durationMs }
      });
      responses.push({ stepId: step.stepId, localSeq: seq, leaves: responseLeaves(request) });
    });

    scripts.push(
      apiRequestScriptSchema.parse({
        schemaVersion: "jl-api-1",
        stepId: step.stepId,
        instructionKey: step.instructionKey,
        recordedAt,
        requests: scriptRequests,
        auth,
        reviewFlags
      })
    );
  }
  return { scripts };
}

function responseLeaves(request: CapturedRequest): Leaf[] {
  const leaves: Leaf[] = [];
  const body = parseJsonBody(request.responseBody);
  if (body?.kind === "json") leaves.push(...jsonLeaves(body.value));
  for (const header of request.responseHeaders ?? []) {
    if (header.value === "[redacted]") continue;
    leaves.push({ path: `header.${header.name.toLowerCase()}`, value: header.value });
  }
  return leaves;
}

// Fields of this step's earlier responses a reviewer may bind a flagged value to.
function candidatesFor(responses: readonly IndexedResponse[], stepStart: number, stepId: string): ApiReviewFlag["candidates"] {
  const candidates: ApiReviewFlag["candidates"] = [];
  for (const source of responses.slice(stepStart)) {
    if (source.localSeq === null || source.stepId !== stepId) continue;
    for (const leaf of source.leaves) {
      if (candidates.length >= 50) return candidates;
      // Body fields and the Location header; other response headers never carry an id.
      if (leaf.path.startsWith("header.") && leaf.path !== "header.location") continue;
      candidates.push({ fromSeq: source.localSeq, path: leaf.path, sample: leaf.value.slice(0, 60) });
    }
  }
  return candidates;
}

function pathParts(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const segment of path.split(".")) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) continue;
    if (match[1]) parts.push(match[1]);
    for (const index of (match[2] ?? "").matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]));
  }
  return parts;
}

function getAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of pathParts(path)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function setAt(value: unknown, path: string, replacement: unknown): void {
  const parts = pathParts(path);
  const last = parts.pop();
  if (last === undefined) return;
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return;
    current = (current as Record<string | number, unknown>)[part];
  }
  if (current !== null && typeof current === "object") (current as Record<string | number, unknown>)[last] = replacement;
}
