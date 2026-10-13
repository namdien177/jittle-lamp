import { z } from "zod/v4";

// Replayable API scripts (roadmap 2026-10-13 §2.3, §2.4): what the runner builds from the request
// log of a passed step, stores as a `test_step_scripts` row of kind `api-requests`, and replays
// with `fetch` on a later run instead of driving the browser.
//
// Placeholders inside templates:
//   {{v1}}              a value captured from an earlier response (see `captures`)
//   {{param.NAME}}      a run param or a variable produced earlier in the run ({alias.name} too)
//   {{auth.cookie}}     resolved from the browser session at replay; `{{auth.<header>}}` for the
//                       other auth headers (`x-dev-domain` keeps its recorded literal in `auth`)
//   {{now:iso}}         a timestamp regenerated at replay; `{{now:date}}` for a date-only value

export const apiScriptSchemaVersion = "jl-api-1" as const;

export const apiStatusClassSchema = z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]);

// A field of an earlier response bound to a placeholder. `fromSeq` is the script-local sequence
// of the source request; `fromStepId` names the step whose script holds it when the source lies in
// an earlier step of the same run (its script must have replayed first).
export const apiCaptureSchema = z.object({
  as: z.string().regex(/^v\d+$/),
  fromSeq: z.number().int().positive(),
  fromStepId: z.string().min(1).optional(),
  // Dotted JSON path into the response body (`data.application.id`, `items[0].id`), or
  // `header.<name>` for a response header.
  path: z.string().min(1)
});

// Where a value sits inside a request: `path[2]`, `query.<name>`, `header.<name>`,
// `body.<json path>`.
export const apiLocationSchema = z.string().regex(/^(path\[\d+\]|query\..+|header\..+|body(\..+)?)$/);

export const apiReviewFlagSchema = z.object({
  seq: z.number().int().positive(),
  location: apiLocationSchema,
  // The literal left in the template (never a secret: auth headers are replaced before this).
  value: z.string(),
  reason: z.string().min(1),
  // Fields of earlier responses a reviewer may bind the value to, with a short sample each.
  candidates: z
    .array(z.object({ fromSeq: z.number().int().positive(), fromStepId: z.string().min(1).optional(), path: z.string().min(1), sample: z.string() }))
    .default([])
});

export const apiShapeSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const apiScriptRequestSchema = z.object({
  seq: z.number().int().positive(),
  method: z.string().min(1),
  // Path and query relative to the origin; the origin comes from the environment at replay.
  origin: z.string().min(1),
  pathTemplate: z.string().min(1),
  query: z.record(z.string(), z.string()).default({}),
  headersTemplate: z.record(z.string(), z.string()).default({}),
  // JSON bodies travel parsed so the reviewer sees fields; other bodies as text.
  bodyKind: z.enum(["json", "text"]).nullable().default(null),
  bodyTemplate: z.unknown().optional(),
  // Body leaves that were numbers in the recording and now hold a placeholder.
  numericLeaves: z.array(z.string()).default([]),
  mutation: z.boolean(),
  // Reads are kept for context and not checked unless a reviewer turns this on.
  check: z.boolean(),
  captures: z.array(apiCaptureSchema).default([]),
  expect: z
    .object({
      statusClass: apiStatusClassSchema,
      // Keys and JSON types of the recorded response body, two levels deep; null when the body
      // was not JSON.
      shape: apiShapeSchema.nullable()
    })
    .nullable()
    .default(null),
  // What the recording answered, for the reviewer.
  recorded: z.object({ status: z.number().int().nullable(), durationMs: z.number().nullable() }).optional()
});

export const apiRequestScriptSchema = z.object({
  schemaVersion: z.literal(apiScriptSchemaVersion),
  stepId: z.string().min(1),
  instructionKey: z.string().min(1).nullable(),
  recordedAt: z.string().min(1),
  requests: z.array(apiScriptRequestSchema),
  // Non-secret auth header literals (`x-dev-domain`), resolved by `{{auth.<name>}}`.
  auth: z.record(z.string(), z.string()).default({}),
  reviewFlags: z.array(apiReviewFlagSchema).default([])
});

export type ApiCapture = z.infer<typeof apiCaptureSchema>;
export type ApiReviewFlag = z.infer<typeof apiReviewFlagSchema>;
export type ApiScriptRequest = z.infer<typeof apiScriptRequestSchema>;
export type ApiRequestScript = z.infer<typeof apiRequestScriptSchema>;
export type ApiStatusClass = z.infer<typeof apiStatusClassSchema>;

// One replayed request as the run page lists it under an `api-replayed` / `api-handoff` step.
export const apiRequestItemSchema = z.object({
  seq: z.number().int().positive(),
  method: z.string().min(1),
  path: z.string().min(1),
  status: z.number().int().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  mutation: z.boolean(),
  // Set on the request that ended the replay.
  error: z.string().nullable().default(null)
});
export type ApiRequestItem = z.infer<typeof apiRequestItemSchema>;

export const stepRequestsSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  mutations: z.number().int().nonnegative(),
  items: z.array(apiRequestItemSchema).optional()
});
export type StepRequestsSummary = z.infer<typeof stepRequestsSummarySchema>;

// Runner ↔ backend: GET /test-runs/:id/cache/api/:stepId and PUT with a script or a stale mark.
export const apiCacheReadResponseSchema = z.object({
  status: z.enum(["hit", "miss"]),
  script: apiRequestScriptSchema.optional(),
  scriptId: z.string().min(1).optional(),
  version: z.number().int().positive().optional()
});
export const apiCacheWriteRequestSchema = z.union([
  z.object({ script: apiRequestScriptSchema }),
  z.object({ stale: z.literal(true), reason: z.string().min(1).max(500) })
]);

// Reuse window lookups (roadmap §2.6): the outputs of the newest passed run of a case.
export const recentOutputsResponseSchema = z.object({
  runId: z.string().min(1).nullable(),
  finishedAt: z.number().int().nullable(),
  outputs: z.record(z.string(), z.string())
});
export type RecentOutputsResponse = z.infer<typeof recentOutputsResponseSchema>;

// A reviewer binds a flagged literal to a field of an earlier response (roadmap §3.4).
export const apiScriptFixSchema = z.object({
  seq: z.number().int().positive(),
  location: apiLocationSchema,
  fromSeq: z.number().int().positive(),
  fromStepId: z.string().min(1).optional(),
  path: z.string().min(1)
});
export type ApiScriptFix = z.infer<typeof apiScriptFixSchema>;

export const patchStepScriptRequestSchema = z.object({ fixes: z.array(apiScriptFixSchema).min(1).max(50) });
export type PatchStepScriptRequest = z.infer<typeof patchStepScriptRequestSchema>;

export const statusClassOf = (status: number): ApiStatusClass => {
  if (status < 200) return "1xx";
  if (status < 300) return "2xx";
  if (status < 400) return "3xx";
  if (status < 500) return "4xx";
  return "5xx";
};

// `a.b[0].c` → ["a", "b", 0, "c"]
export function parseJsonPath(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const segment of path.split(".")) {
    if (segment.length === 0) continue;
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) {
      parts.push(segment);
      continue;
    }
    if (match[1]) parts.push(match[1]);
    for (const index of (match[2] ?? "").matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]));
  }
  return parts;
}

export function getJsonPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of parseJsonPath(path)) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function setJsonPath(value: unknown, path: string, replacement: unknown): boolean {
  const parts = parseJsonPath(path);
  const last = parts.pop();
  if (last === undefined) return false;
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return false;
    current = (current as Record<string | number, unknown>)[part];
  }
  if (current === null || typeof current !== "object") return false;
  (current as Record<string | number, unknown>)[last] = replacement;
  return true;
}

// Replaces the literal at `location` of `request` with `placeholder`; false when the location
// does not exist in the request.
export function setAtLocation(request: ApiScriptRequest, location: string, placeholder: string): boolean {
  const pathIndex = /^path\[(\d+)\]$/.exec(location);
  if (pathIndex) {
    const segments = request.pathTemplate.split("/");
    const index = Number(pathIndex[1]);
    if (index >= segments.length) return false;
    segments[index] = placeholder;
    request.pathTemplate = segments.join("/");
    return true;
  }
  if (location.startsWith("query.")) {
    const name = location.slice("query.".length);
    if (!(name in request.query)) return false;
    request.query[name] = placeholder;
    return true;
  }
  if (location.startsWith("header.")) {
    const name = location.slice("header.".length);
    if (!(name in request.headersTemplate)) return false;
    request.headersTemplate[name] = placeholder;
    return true;
  }
  if (location === "body") {
    if (request.bodyKind !== "text") return false;
    request.bodyTemplate = placeholder;
    return true;
  }
  if (location.startsWith("body.")) {
    if (request.bodyKind !== "json") return false;
    return setJsonPath(request.bodyTemplate, location.slice("body.".length), placeholder);
  }
  return false;
}

export function nextCaptureName(script: Pick<ApiRequestScript, "requests">): string {
  let max = 0;
  for (const request of script.requests) {
    for (const capture of request.captures) max = Math.max(max, Number(capture.as.slice(1)) || 0);
  }
  return `v${max + 1}`;
}

// Applies reviewer fixes: the literal becomes a capture of the chosen field and its flag goes.
// Throws on a location that is not flagged, so a stale UI cannot rewrite the wrong value.
export function applyApiScriptFixes(script: ApiRequestScript, fixes: readonly ApiScriptFix[]): ApiRequestScript {
  const next: ApiRequestScript = structuredClone(script);
  for (const fix of fixes) {
    const request = next.requests.find((candidate) => candidate.seq === fix.seq);
    if (!request) throw new Error(`No request ${fix.seq} in the script`);
    const flagIndex = next.reviewFlags.findIndex((flag) => flag.seq === fix.seq && flag.location === fix.location);
    if (flagIndex === -1) throw new Error(`Request ${fix.seq} has no flagged value at ${fix.location}`);
    // A capture must come from an earlier request of this script, or from another step's script.
    if (fix.fromStepId === undefined && fix.fromSeq >= fix.seq) throw new Error(`Request ${fix.seq} cannot capture from request ${fix.fromSeq}`);
    const as = nextCaptureName(next);
    if (!setAtLocation(request, fix.location, `{{${as}}}`)) throw new Error(`Request ${fix.seq} has no value at ${fix.location}`);
    request.captures.push({ as, fromSeq: fix.fromSeq, ...(fix.fromStepId ? { fromStepId: fix.fromStepId } : {}), path: fix.path });
    next.reviewFlags.splice(flagIndex, 1);
  }
  return next;
}
