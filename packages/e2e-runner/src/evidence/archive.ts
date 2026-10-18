import {
  compactSessionArchive,
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

import type { CapturedConsole, CapturedNavigation, CapturedRequest } from "../runtime/capture";
import type { QueryStepLogEvent } from "../runtime/step-log";

// Runner capture → session archive v4 (ADR 0002 decision 4, handover 0.5; roadmap 2026-10-13
// phase A). e2e 0.19 removed the Playwright trace, so the sections come from the runner's own
// worker-side capture (requests.jsonl, console.jsonl, navigations.jsonl written by
// runtime/capture.ts), interactions from e2e's engine events (progress.jsonl), and step
// annotations and `step:<id>` tags from the run report. Everything passes through the run's
// redactor before it is returned.

export type EngineEvent = { at: string; name: string; detail: string };
// What a person did during a live take-over (design.md §5.4): tagged user:takeover.
export type TakeoverEvent = { at: string; stepId: string | null; kind: "start" | "end" | "input"; inputKind?: string; detail: string };

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

// e2e engine details read like `tap button "Sign in"`, `type "…" into textbox "Email"` or
// `press "Enter" on textbox "Password"`: the target is the trailing `role "name"`.
export function parseTarget(detail: string): { role?: string; name?: string; textPreview?: string } {
  const match = /([a-z]+)\s+"([^"]*)"\s*(?:\([^)]*\))?\s*$/i.exec(detail);
  if (!match?.[1]) return { textPreview: detail.slice(0, 240) };
  const name = match[2] ?? "";
  return { role: match[1], name, ...(name ? { textPreview: name.slice(0, 240) } : {}) };
}

// Engine event names, agent grammar (agent/actions.js) and replayed locator kinds alike.
const clickActions = new Set(["tap", "doubleTap", "longPress", "secondaryTap", "tapAt", "click", "dblclick", "hover", "hoverAt"]);
const inputActions = new Set(["type", "typeSecret", "typeText", "fill", "select", "selectOption", "upload", "setInputFiles", "check", "uncheck", "clear"]);
const keyActions = new Set(["press", "pressKey"]);

// The key of `press "Enter" on textbox "Email"`; the whole detail is a fallback for odd prose.
function parseKey(detail: string): string {
  const match = /^press\s+"([^"]*)"/i.exec(detail);
  return match?.[1] || "Unidentified";
}

function parseNavigateUrl(detail: string): string | null {
  const match = /^navigate to\s+"([^"]*)"/i.exec(detail);
  const url = match?.[1];
  if (!url) return null;
  return /^https?:/i.test(url) ? url : null;
}

export type BuildArchiveInput = {
  report: RunReport;
  requests: readonly CapturedRequest[];
  consoleLog: readonly CapturedConsole[];
  navigations: readonly CapturedNavigation[];
  engineEvents: readonly EngineEvent[];
  takeoverEvents?: readonly TakeoverEvent[];
  // [Query] steps (roadmap §5.4): one `integration` entry each, tagged like actions.
  queryEvents?: readonly QueryStepLogEvent[];
  // When the recording's first frame was written (e2e's video artifact `startedAt`); the runner's
  // `attempt-started` time stands in when the engine reported none.
  videoStartedAt: string | null;
  sessionId: string;
  name: string;
  videoDurationMs: number | null;
  redact: (text: string) => string;
};

export function buildRunArchive(input: BuildArchiveInput): { archive: SessionArchive; videoStartedAt: string } {
  const parsedVideoStart = input.videoStartedAt ? Date.parse(input.videoStartedAt) : Number.NaN;
  const videoStartMs = Number.isNaN(parsedVideoStart) ? Date.parse(input.report.startedAt) : parsedVideoStart;
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

  // Statements [Query] steps ran, redacted by column already; the run's redactor passes once more.
  for (const event of input.queryEvents ?? []) {
    const ms = Date.parse(event.at);
    if (Number.isNaN(ms)) continue;
    actions.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: event.at,
        tags: tagsAt(windows, ms).length > 0 ? tagsAt(windows, ms) : [stepTag(event.stepId)],
        payload: {
          kind: "integration",
          integration: "sql",
          profile: event.profile,
          statement: event.statement,
          rowCount: event.rowCount,
          sample: event.sample,
          durationMs: event.durationMs
        }
      })
    });
  }

  // Navigations of the top document, from the capture: `app.open`, submits, the app's own moves.
  for (const navigation of input.navigations) {
    if (navigation.event !== "navigated") continue;
    const ms = Date.parse(navigation.at);
    actions.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: navigation.at,
        tags: tagsAt(windows, ms),
        payload: { kind: "interaction", type: "navigation", url: navigation.url, navigationType: "location" }
      })
    });
  }

  // Interactions: one per engine action (agent-driven or replayed), target from its prose.
  for (const event of input.engineEvents) {
    const ms = Date.parse(event.at);
    if (Number.isNaN(ms)) continue;
    const name = event.name;
    const isClick = clickActions.has(name);
    const isInput = inputActions.has(name);
    const isKey = keyActions.has(name);
    if (name === "navigate") {
      const url = parseNavigateUrl(event.detail);
      // The capture already lists this navigation when the browser performed it.
      if (!url) continue;
      if (input.navigations.some((navigation) => navigation.url === url && Math.abs(Date.parse(navigation.at) - ms) < 5_000)) continue;
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
    if (!isClick && !isInput && !isKey) continue;
    const target = parseTarget(event.detail || name);
    const interactionTarget = {
      selectorAlternates: [],
      ...(target.role ? { role: target.role } : {}),
      ...(target.name ? { name: target.name } : {}),
      ...(target.textPreview ? { textPreview: target.textPreview } : {})
    };
    actions.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "actions", index),
        seq,
        at: new Date(ms).toISOString(),
        tags: tagsAt(windows, ms),
        // Typed values are never kept (same rule as the extension); e2e's prose already masks secrets.
        payload: isInput
          ? {
              kind: "interaction",
              type: "input",
              target: interactionTarget,
              inputKind: name === "select" || name === "selectOption" ? "select" : name === "check" || name === "uncheck" ? "checkbox" : "text",
              redacted: true,
              ...(name === "check" || name === "uncheck" ? { checked: name === "check" } : {})
            }
          : isKey
            ? { kind: "interaction", type: "keyboard", eventType: "keydown", key: parseKey(event.detail), target: interactionTarget }
            : { kind: "interaction", type: "click", target: interactionTarget }
      })
    });
  }

  for (const entry of input.consoleLog) {
    const ms = Date.parse(entry.at);
    if (Number.isNaN(ms)) continue;
    consoleEntries.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "console", index),
        seq,
        at: entry.at,
        tags: tagsAt(windows, ms),
        payload: { kind: "console", level: entry.level, message: entry.source === "pageerror" ? `Uncaught ${entry.message}` : entry.message, args: [] }
      })
    });
  }

  for (const request of input.requests) {
    const ms = Date.parse(request.startedAt);
    if (Number.isNaN(ms)) continue;
    if (!/^https?:/i.test(request.url)) continue;
    const subtype = subtypeOf(request.resourceType);
    const status = typeof request.status === "number" && request.status >= 100 && request.status <= 599 ? request.status : undefined;
    networkEntries.push({
      at: ms,
      build: (seq, index) => ({
        id: generateArchiveEntryId(sessionId, "network", index),
        seq,
        at: request.startedAt,
        tags: tagsAt(windows, ms),
        subtype,
        payload: {
          kind: "network",
          method: request.method || "GET",
          url: request.url,
          subtype,
          ...(status ? { status } : {}),
          ...(request.statusText ? { statusText: request.statusText } : {}),
          ...(typeof request.durationMs === "number" && request.durationMs >= 0 ? { durationMs: request.durationMs } : {}),
          request: { headers: request.requestHeaders, cookies: [], ...(request.requestBody ? { body: request.requestBody } : {}) },
          ...(status
            ? {
                response: {
                  headers: request.responseHeaders ?? [],
                  setCookieHeaders: [],
                  setCookies: [],
                  ...(request.responseBody ? { body: request.responseBody } : {})
                }
              }
            : { failureText: request.failureText ?? "request did not complete" })
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

  // Same clean-up as extension recordings: no preflights, analytics or asset bodies, secrets masked.
  const archive = compactSessionArchive(sessionArchiveSchema.parse(JSON.parse(input.redact(JSON.stringify(raw)))));
  return { archive, videoStartedAt };
}
