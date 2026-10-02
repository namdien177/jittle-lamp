import { unzipSync } from "fflate";

import {
  checkpointTag,
  generateArchiveEntryId,
  takeoverTag,
  sessionArchiveSchema,
  sessionSchemaVersion,
  stepTag,
  type ArchiveAction,
  type ArchiveConsoleEntry,
  type ArchiveNetworkEntry,
  type NetworkSubtype,
  type RunReport,
  type SessionArchive
} from "@jittle-lamp/shared";

// Playwright trace (written by e2e with secrets already masked) → session archive v4 (ADR 0002
// decision 4, handover 0.5). Interactions come from the trace's input actions, with targets from
// e2e's engine events; network and console from the trace; step annotations and `step:<id>` tags
// from the run report. Everything passes through the run's redactor before it is returned.

type TraceEvent = Record<string, unknown> & { type?: string };

export type EngineEvent = { at: string; name: string; detail: string };
// What a person did during a live take-over (design.md §5.4): tagged user:takeover.
export type TakeoverEvent = { at: string; stepId: string | null; kind: "start" | "end" | "input"; inputKind?: string; detail: string };

const maxBodyBytes = 64 * 1024;
const sensitiveHeaders = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token", "x-csrf-token"]);
const textMime = /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|graphql)|[^;]*\+json|[^;]*\+xml)/i;

function parseLines(bytes: Uint8Array | undefined): TraceEvent[] {
  if (!bytes) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TraceEvent];
      } catch {
        return [];
      }
    });
}

function subtypeOf(resourceType: unknown): NetworkSubtype {
  switch (resourceType) {
    case "document":
    case "stylesheet":
    case "script":
    case "image":
    case "font":
    case "media":
    case "websocket":
    case "fetch":
    case "xhr":
      return resourceType;
    default:
      return "other";
  }
}

function headers(list: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: { name?: unknown; value?: unknown }) =>
    typeof entry.name === "string" && entry.name.length > 0
      ? [{ name: entry.name, value: sensitiveHeaders.has(entry.name.toLowerCase()) ? "[redacted]" : String(entry.value ?? "") }]
      : []
  );
}

function body(
  files: Record<string, Uint8Array>,
  content: { _file?: unknown; mimeType?: unknown; size?: unknown; text?: unknown } | undefined
) {
  if (!content) return undefined;
  const mimeType = typeof content.mimeType === "string" && content.mimeType !== "x-unknown" ? content.mimeType : undefined;
  const file = typeof content._file === "string" ? files[content._file] : undefined;
  const raw = file ?? (typeof content.text === "string" ? new TextEncoder().encode(content.text) : undefined);
  if (!raw) return typeof content.size === "number" && content.size > 0 ? { disposition: "unavailable" as const, ...(mimeType ? { mimeType } : {}), reason: "body not kept in the trace" } : undefined;
  if (mimeType && !textMime.test(mimeType)) {
    return { disposition: "omitted" as const, mimeType, byteLength: raw.byteLength, reason: "binary body" };
  }
  const truncated = raw.byteLength > maxBodyBytes;
  const value = new TextDecoder().decode(truncated ? raw.slice(0, maxBodyBytes) : raw);
  return {
    disposition: truncated ? ("truncated" as const) : ("captured" as const),
    encoding: "utf8" as const,
    ...(mimeType ? { mimeType } : {}),
    value,
    byteLength: raw.byteLength,
    ...(truncated ? { omittedByteLength: raw.byteLength - maxBodyBytes } : {})
  };
}

type StepWindow = { stepId: string; checkpointId: string | null; parentStepId: string | null; start: number; end: number };

function stepWindows(report: RunReport): StepWindow[] {
  return report.steps
    .filter((step) => step.startedAt !== null)
    .map((step) => ({
      stepId: step.stepId,
      checkpointId: step.checkpointId,
      parentStepId: step.parentStepId,
      start: Date.parse(step.startedAt ?? ""),
      end: step.finishedAt ? Date.parse(step.finishedAt) : Number.POSITIVE_INFINITY
    }));
}

// Tags for an entry at `ms`: the innermost step running then, plus its checkpoint.
function tagsAt(windows: readonly StepWindow[], ms: number): string[] {
  const running = windows.filter((window) => ms >= window.start && ms <= window.end);
  const innermost = running.find((window) => !running.some((other) => other.parentStepId === window.stepId)) ?? running.at(-1);
  if (!innermost) return [];
  return [stepTag(innermost.stepId), ...(innermost.checkpointId ? [checkpointTag(innermost.checkpointId)] : [])];
}

// e2e engine details read like `tap button "Sign in"` or `type "…" into textbox "Email"`.
export function parseTarget(detail: string): { role?: string; name?: string; textPreview?: string } {
  const match = /([a-z]+)\s+"([^"]*)"\s*$/i.exec(detail);
  if (!match?.[1]) return { textPreview: detail.slice(0, 240) };
  const name = match[2] ?? "";
  return { role: match[1], name, ...(name ? { textPreview: name.slice(0, 240) } : {}) };
}

export type BuildArchiveInput = {
  traceZip: Uint8Array | null;
  report: RunReport;
  engineEvents: readonly EngineEvent[];
  takeoverEvents?: readonly TakeoverEvent[];
  sessionId: string;
  name: string;
  videoDurationMs: number | null;
  redact: (text: string) => string;
};

export function buildRunArchive(input: BuildArchiveInput): { archive: SessionArchive; videoStartedAt: string } {
  const files = input.traceZip ? unzipSync(input.traceZip) : {};
  const traceEvents = Object.entries(files)
    .filter(([name]) => name.endsWith(".trace"))
    .flatMap(([, bytes]) => parseLines(bytes));
  const networkEvents = Object.entries(files)
    .filter(([name]) => name.endsWith(".network"))
    .flatMap(([, bytes]) => parseLines(bytes));

  const options = traceEvents.find((event) => event.type === "context-options");
  const wallTime = typeof options?.wallTime === "number" ? options.wallTime : Date.parse(input.report.startedAt);
  const monotonicTime = typeof options?.monotonicTime === "number" ? options.monotonicTime : 0;
  const wall = (time: unknown) => wallTime + ((typeof time === "number" ? time : monotonicTime) - monotonicTime);

  // The video starts with the page; step offsets and the timeline anchor both measure from it.
  const pageEvent = traceEvents.find((event) => event.type === "event" && event.method === "page");
  const videoStartMs = pageEvent ? wall(pageEvent.time) : wallTime;
  const videoStartedAt = new Date(videoStartMs).toISOString();
  const windows = stepWindows(input.report);

  type Timed<T> = { at: number; build: (seq: number, index: number) => T };
  const actions: Array<Timed<ArchiveAction>> = [];
  const consoleEntries: Array<Timed<ArchiveConsoleEntry>> = [];
  const networkEntries: Array<Timed<ArchiveNetworkEntry>> = [];
  const sessionId = input.sessionId;

  actions.push({
    at: videoStartMs,
    build: (seq, index) => ({
      id: generateArchiveEntryId(sessionId, "actions", index),
      seq,
      at: new Date(videoStartMs).toISOString(),
      tags: [],
      payload: { kind: "lifecycle", phase: "recording", detail: "Runner started recording." }
    })
  });

  for (const step of input.report.steps) {
    if (!step.startedAt) continue;
    const startMs = Date.parse(step.startedAt);
    const tags = [stepTag(step.stepId), ...(step.checkpointId ? [checkpointTag(step.checkpointId)] : [])];
    actions.push({
      at: startMs,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: step.startedAt ?? "",
        tags,
        payload: { kind: "lifecycle", phase: "recording", detail: `Step ${step.ordinal} ${step.type} started: ${step.label}` }
      })
    });
    if (step.finishedAt) {
      const finishedAt = step.finishedAt;
      actions.push({
        at: Date.parse(finishedAt),
        build: (seq, index) => ({
          id: generateArchiveEntryId(sessionId, "actions", index),
          seq,
          at: finishedAt,
          tags,
          payload:
            step.status === "failed" || step.status === "blocked"
              ? {
                  kind: "error",
                  source: "runtime",
                  message: `Step ${step.ordinal} ${step.status}${step.error ? ` (${step.error.code})` : ""}: ${step.error?.message || step.observed || step.label}`
                }
              : { kind: "lifecycle", phase: "recording", detail: `Step ${step.ordinal} ${step.status}${step.mode ? ` (${step.mode})` : ""}: ${step.label}` }
        })
      });
    }
  }

  for (const event of input.takeoverEvents ?? []) {
    const ms = Date.parse(event.at);
    const tags = [...(event.stepId ? [stepTag(event.stepId)] : []), takeoverTag];
    actions.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: event.at,
        tags,
        payload:
          event.kind === "input"
            ? event.inputKind === "type"
              ? { kind: "interaction", type: "input", inputKind: "text", redacted: true, target: { selectorAlternates: [], textPreview: `Take-over: ${event.detail}`.slice(0, 240) } }
              : event.inputKind === "press"
                ? { kind: "interaction", type: "keyboard", eventType: "keydown", key: event.detail.replace(/^pressed /, "") || "Unidentified", redacted: false }
                : { kind: "interaction", type: "click", target: { selectorAlternates: [], textPreview: `Take-over: ${event.detail}`.slice(0, 240) } }
            : { kind: "lifecycle", phase: event.kind === "start" ? "paused" : "recording", detail: event.kind === "start" ? "Take-over started: the run is paused and still recording." : "Take-over ended: the agent continues." }
      })
    });
  }

  // Interactions: input actions from the trace, targets from the nearest engine event.
  const engine = input.engineEvents.map((event) => ({ ...event, ms: Date.parse(event.at) }));
  const usedEngine = new Set<number>();
  for (const event of traceEvents) {
    if (event.type !== "before") continue;
    const method = String(event.method ?? "");
    const params = (event.params ?? {}) as Record<string, unknown>;
    const ms = wall(event.startTime);
    if (method === "goto" && typeof params.url === "string") {
      const url = params.url;
      actions.push({
        at: ms,
        build: (seq, index) => ({
          id: generateArchiveEntryId(sessionId, "actions", index),
          seq,
          at: new Date(ms).toISOString(),
          tags: tagsAt(windows, ms),
          payload: { kind: "interaction", type: "navigation", url, navigationType: "location" }
        })
      });
      continue;
    }
    if (!["click", "dblclick", "fill", "type", "press", "selectOption", "check", "uncheck", "hover", "setInputFiles", "tap"].includes(method)) continue;
    let nearest = -1;
    let distance = Number.POSITIVE_INFINITY;
    engine.forEach((candidate, index) => {
      if (usedEngine.has(index)) return;
      const delta = Math.abs(candidate.ms - ms);
      if (delta < distance) {
        distance = delta;
        nearest = index;
      }
    });
    const matched = nearest >= 0 && distance < 5_000 ? engine[nearest] : undefined;
    if (matched) usedEngine.add(nearest);
    const target = parseTarget(matched?.detail ?? method);
    const interactionTarget = {
      selectorAlternates: [],
      ...(target.role ? { role: target.role } : {}),
      ...(target.name ? { name: target.name } : {}),
      ...(target.textPreview ? { textPreview: target.textPreview } : {})
    };
    const isInput = method === "fill" || method === "type" || method === "selectOption" || method === "setInputFiles";
    actions.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: new Date(ms).toISOString(),
        tags: tagsAt(windows, ms),
        // Typed values are never kept (same rule as the extension): only their length.
        payload: isInput
          ? {
              kind: "interaction",
              type: "input",
              target: interactionTarget,
              inputKind: method === "selectOption" ? "select" : "text",
              redacted: true,
              ...(typeof params.value === "string" ? { valueLength: params.value.length } : {})
            }
          : method === "press"
            ? { kind: "interaction", type: "keyboard", eventType: "keydown", key: String(params.key ?? "Unidentified") || "Unidentified", target: interactionTarget }
            : { kind: "interaction", type: "click", target: interactionTarget }
      })
    });
  }

  for (const event of traceEvents) {
    if (event.type !== "console") continue;
    const ms = wall(event.time);
    const messageType = String(event.messageType ?? "log");
    const level = messageType === "error" ? "error" : messageType === "warning" || messageType === "warn" ? "warn" : messageType === "debug" ? "debug" : "info";
    const text = String(event.text ?? "");
    consoleEntries.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "console", index),
        seq,
        at: new Date(ms).toISOString(),
        tags: tagsAt(windows, ms),
        payload: { kind: "console", level, message: text, args: [] }
      })
    });
  }

  for (const event of networkEvents) {
    if (event.type !== "resource-snapshot") continue;
    const snapshot = (event.snapshot ?? {}) as Record<string, any>;
    const request = snapshot.request ?? {};
    const response = snapshot.response ?? {};
    if (typeof request.url !== "string" || !/^https?:/i.test(request.url)) continue;
    const ms = typeof snapshot.startedDateTime === "string" ? Date.parse(snapshot.startedDateTime) : wall(snapshot._monotonicTime);
    const subtype = subtypeOf(snapshot._resourceType);
    const status = typeof response.status === "number" && response.status >= 100 && response.status <= 599 ? response.status : undefined;
    const requestBody = request.postData ? body(files, { _file: request.postData._file, mimeType: request.postData.mimeType, text: request.postData.text }) : undefined;
    const responseBody = body(files, response.content);
    networkEntries.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "network", index),
        seq,
        at: new Date(ms).toISOString(),
        tags: tagsAt(windows, ms),
        subtype,
        payload: {
          kind: "network",
          method: String(request.method ?? "GET"),
          url: request.url,
          subtype,
          ...(status ? { status } : {}),
          ...(typeof response.statusText === "string" && response.statusText.length > 0 ? { statusText: response.statusText } : {}),
          ...(typeof snapshot.time === "number" && snapshot.time >= 0 ? { durationMs: snapshot.time } : {}),
          request: { headers: headers(request.headers), cookies: [], ...(requestBody ? { body: requestBody } : {}) },
          ...(status
            ? {
                response: {
                  headers: headers(response.headers),
                  setCookieHeaders: [],
                  setCookies: [],
                  ...(responseBody ? { body: responseBody } : {})
                }
              }
            : { failureText: String(response._failureText ?? "request did not complete") })
        }
      })
    });
  }

  // One sequence across sections, in time order.
  const all = [
    ...actions.map((item) => ({ ...item, section: "actions" as const })),
    ...consoleEntries.map((item) => ({ ...item, section: "console" as const })),
    ...networkEntries.map((item) => ({ ...item, section: "network" as const }))
  ].sort((a, b) => a.at - b.at);
  const built = { actions: [] as ArchiveAction[], console: [] as ArchiveConsoleEntry[], network: [] as ArchiveNetworkEntry[] };
  all.forEach((item, seq) => {
    if (item.section === "actions") built.actions.push((item as Timed<ArchiveAction>).build(seq, built.actions.length));
    else if (item.section === "console") built.console.push((item as Timed<ArchiveConsoleEntry>).build(seq, built.console.length));
    else built.network.push((item as Timed<ArchiveNetworkEntry>).build(seq, built.network.length));
  });

  const firstUrl = built.actions.find((entry) => entry.payload.kind === "interaction" && entry.payload.type === "navigation");
  const pageUrl =
    (firstUrl?.payload.kind === "interaction" && firstUrl.payload.type === "navigation" ? firstUrl.payload.url : null) ??
    input.report.environment.baseUrl ??
    "https://e2e-runner.jittle-lamp.local/";
  const finishedAt = input.report.finishedAt;
  const checkpoints = new Map(input.report.steps.map((step) => [step.checkpointId, step.checkpointId]));

  const raw = {
    schemaVersion: sessionSchemaVersion,
    sessionId,
    name: input.name,
    createdAt: videoStartedAt,
    updatedAt: finishedAt,
    phase: "ready",
    page: { url: pageUrl.split("?")[0], title: input.name },
    recorder: {
      kind: "e2e-runner",
      runner: {
        name: input.report.runner.runner,
        version: input.report.runner.runnerVersion,
        engine: { name: input.report.runner.engine, version: input.report.runner.engineVersion },
        browser: {
          name: input.report.runner.browser ?? "chromium",
          ...(input.report.runner.browserVersion ? { version: input.report.runner.browserVersion } : {}),
          headless: input.report.runner.headless
        },
        viewport: input.report.runner.viewport
      },
      testRun: {
        ...(input.report.runId ? { runId: input.report.runId } : {}),
        ...(input.report.testCase.id ? { testCaseId: input.report.testCase.id } : {}),
        ...(input.report.testCase.key ? { testCaseKey: input.report.testCase.key } : {}),
        ...(input.report.testCase.transcriptVersion ? { transcriptVersion: input.report.testCase.transcriptVersion } : {}),
        ...(input.report.environment.name ? { environment: input.report.environment.name } : {})
      }
    },
    summary: {
      videoDurationMs: input.videoDurationMs,
      actionCount: built.actions.filter((entry) => entry.payload.kind === "interaction").length,
      requestCount: built.network.length
    },
    artifacts: [
      { kind: "recording.webm", relativePath: `${sessionId}/recording.webm`, mimeType: "video/webm" },
      { kind: "session.archive.json", relativePath: `${sessionId}/session.archive.json`, mimeType: "application/json" }
    ],
    sections: built,
    annotations: input.report.steps
      .filter((step) => step.startedAt !== null)
      .map((step) => ({
        id: `step-${step.stepId}`,
        kind: "step",
        stepId: step.stepId,
        ordinal: step.ordinal,
        type: step.type,
        label: step.label || step.type,
        checkpointId: checkpoints.get(step.checkpointId) ?? null,
        parentStepId: step.parentStepId,
        status: step.status,
        mode: step.mode,
        startedAt: step.startedAt,
        endedAt: step.finishedAt,
        videoOffsetMs: Math.max(0, Date.parse(step.startedAt ?? "") - videoStartMs),
        videoEndOffsetMs: step.finishedAt ? Math.max(0, Date.parse(step.finishedAt) - videoStartMs) : null,
        detail: step.error ? `${step.error.code}: ${step.error.message}` : step.observed,
        tags: [stepTag(step.stepId), ...(step.checkpointId ? [checkpointTag(step.checkpointId)] : [])]
      })),
    notes: [
      `${input.report.outcome.toUpperCase()}: ${input.report.testCase.title}`,
      ...(input.report.blockedReason ? [`Blocked: ${input.report.blockedReason}`] : [])
    ]
  };

  const archive = sessionArchiveSchema.parse(JSON.parse(input.redact(JSON.stringify(raw))));
  return { archive, videoStartedAt };
}
