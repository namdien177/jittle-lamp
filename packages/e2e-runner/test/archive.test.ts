import { describe, expect, test } from "bun:test";

import { runReportSchema, type ArchiveAction, type RunReport } from "@jittle-lamp/shared";

import { buildRunArchive, parseTarget } from "../src/evidence/archive";
import { captureBody, captureHeaders, secretsFromEnv } from "../src/runtime/capture";

// The archive built from the runner's own capture (e2e 0.19 removed the Playwright trace):
// network entries with bodies, console entries, interactions from engine events, step tags from
// the report windows, and the video anchor from e2e's video artifact.

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 13, 10, 0, seconds)).toISOString();

const report: RunReport = runReportSchema.parse({
  schemaVersion: 1,
  runId: "run_1",
  testCase: { id: null, key: "TC-1", title: "Logout", transcriptVersion: 1, fingerprint: "fp" },
  environment: { id: null, name: "fixture", baseUrl: "http://127.0.0.1:4000" },
  params: {},
  runner: {
    runner: "jl-e2e",
    runnerVersion: "1.8.2",
    engine: "e2e",
    engineVersion: "0.20.0",
    browser: "chromium",
    browserVersion: null,
    headless: true,
    viewport: { width: 1440, height: 900 },
    cacheMode: "read-write",
    host: "cli"
  },
  model: { act: "mock:x", judge: "mock:x", provider: "mock" },
  status: "completed",
  outcome: "passed",
  blockedReason: null,
  missing: [],
  startedAt: t(0),
  finishedAt: t(30),
  durationMs: 30_000,
  steps: [
    {
      stepId: "s1",
      parentStepId: null,
      ordinal: 1,
      type: "open",
      label: "/login",
      checkpointId: null,
      status: "passed",
      mode: "deterministic",
      cacheReason: "not-cacheable",
      startedAt: t(2),
      finishedAt: t(4),
      durationMs: 2000,
      videoOffsetMs: 0,
      observed: null,
      error: null,
      screenshot: null,
      actions: 0,
      usage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null },
      visionInput: false
    },
    {
      stepId: "s2",
      parentStepId: null,
      ordinal: 2,
      type: "act",
      label: "Sign in",
      checkpointId: "cp1",
      status: "passed",
      mode: "replayed",
      cacheReason: "hit",
      cacheDetail: null,
      startedAt: t(5),
      finishedAt: t(12),
      durationMs: 7000,
      videoOffsetMs: 3000,
      observed: "Signed in",
      error: null,
      screenshot: null,
      actions: 3,
      usage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null },
      visionInput: false
    }
  ],
  totals: {
    stepsTotal: 2,
    stepsReplayed: 1,
    stepsAgent: 0,
    stepsHandoff: 0,
    usage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null },
    judgeUsage: { modelId: null, modelCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: null }
  },
  priceTableVersion: null,
  flaky: false,
  attempt: 1,
  artifacts: [],
  errors: []
});

const redact = (text: string) => text.replaceAll("hunter22", "[redacted]");

type Interaction = Extract<ArchiveAction["payload"], { kind: "interaction" }>;
const interactionsOf = (actions: readonly ArchiveAction[]): Interaction[] =>
  actions.flatMap((entry) => (entry.payload.kind === "interaction" ? [entry.payload] : []));

function build() {
  return buildRunArchive({
    report,
    requests: [
      {
        kind: "request",
        seq: 1,
        startedAt: t(3),
        finishedAt: t(3),
        method: "GET",
        url: "http://127.0.0.1:4000/login",
        resourceType: "document",
        requestHeaders: [{ name: "accept", value: "text/html" }],
        status: 200,
        statusText: "OK",
        responseHeaders: [{ name: "content-type", value: "text/html" }],
        responseBody: { disposition: "captured", encoding: "utf8", mimeType: "text/html", value: "<html></html>", byteLength: 13 },
        durationMs: 12
      },
      {
        kind: "request",
        seq: 2,
        startedAt: t(8),
        finishedAt: t(8),
        method: "POST",
        url: "http://127.0.0.1:4000/api/login",
        resourceType: "fetch",
        requestHeaders: [{ name: "content-type", value: "application/json" }, { name: "cookie", value: "[redacted]" }],
        requestBody: { disposition: "captured", encoding: "utf8", mimeType: "application/json", value: '{"email":"a@example.test","password":"hunter22"}', byteLength: 48 },
        status: 200,
        statusText: "OK",
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        responseBody: { disposition: "captured", encoding: "utf8", mimeType: "application/json", value: '{"ok":true}', byteLength: 11 },
        durationMs: 40
      },
      {
        kind: "request",
        seq: 3,
        startedAt: t(9),
        finishedAt: t(9),
        method: "GET",
        url: "http://127.0.0.1:4000/api/missing",
        resourceType: "xhr",
        requestHeaders: [],
        durationMs: 5,
        failureText: "net::ERR_CONNECTION_REFUSED"
      }
    ],
    consoleLog: [
      { kind: "console", seq: 4, at: t(8), source: "console", level: "info", message: "login ok" },
      { kind: "console", seq: 5, at: t(9), source: "pageerror", level: "error", message: "TypeError: x is undefined" }
    ],
    navigations: [
      { kind: "navigation", seq: 6, at: t(3), url: "http://127.0.0.1:4000/login", event: "page-opened" },
      { kind: "navigation", seq: 7, at: t(3), url: "http://127.0.0.1:4000/login", event: "navigated" },
      { kind: "navigation", seq: 8, at: t(9), url: "http://127.0.0.1:4000/dashboard", event: "navigated" }
    ],
    engineEvents: [
      { at: t(6), name: "type", detail: 'type "a@example.test" into textbox "Email"' },
      { at: t(7), name: "typeSecret", detail: 'fill secret "ADMIN.password" into textbox "Password"' },
      { at: t(8), name: "tap", detail: 'tap button "Sign in"' },
      { at: t(10), name: "press", detail: 'press "Enter" on textbox "Search"' },
      { at: t(11), name: "observation", detail: "page" }
    ],
    videoStartedAt: t(2),
    sessionId: "jl_run_1",
    name: "TC-1 Logout",
    videoDurationMs: 28_000,
    redact
  });
}

describe("buildRunArchive from runner capture", () => {
  test("network entries keep headers and bodies, failures carry failureText", () => {
    const { archive } = build();
    expect(archive.sections.network).toHaveLength(3);
    const login = archive.sections.network.find((entry) => entry.payload.url.endsWith("/api/login"));
    expect(login?.subtype).toBe("fetch");
    expect(login?.payload.status).toBe(200);
    expect(login?.payload.request.body?.value).toContain('"email":"a@example.test"');
    expect(login?.payload.request.body?.value).not.toContain("hunter22");
    expect(login?.payload.response?.body?.value).toBe('{"ok":true}');
    expect(login?.tags).toEqual(["step:s2", "checkpoint:cp1"]);
    const failed = archive.sections.network.find((entry) => entry.payload.url.endsWith("/api/missing"));
    expect(failed?.payload.failureText).toBe("net::ERR_CONNECTION_REFUSED");
    expect(failed?.payload.response).toBeUndefined();
  });

  test("console entries and page errors are tagged by step", () => {
    const { archive } = build();
    expect(archive.sections.console.map((entry) => entry.payload.message)).toEqual(["login ok", "Uncaught TypeError: x is undefined"]);
    expect(archive.sections.console[1]?.payload.level).toBe("error");
    expect(archive.sections.console[0]?.tags).toEqual(["step:s2", "checkpoint:cp1"]);
  });

  test("interactions come from engine events and navigations from the capture", () => {
    const { archive } = build();
    const interactions = interactionsOf(archive.sections.actions);
    expect(interactions.map((payload) => payload.type)).toEqual(["navigation", "input", "input", "click", "navigation", "keyboard"]);
    const click = interactions.find((payload) => payload.type === "click");
    expect(click?.target).toMatchObject({ role: "button", name: "Sign in" });
    const secret = interactions.filter((payload) => payload.type === "input")[1];
    expect(secret?.type === "input" ? secret.redacted : null).toBe(true);
    expect(JSON.stringify(secret)).not.toContain("hunter22");
    const key = interactions.find((payload) => payload.type === "keyboard");
    expect(key?.type === "keyboard" ? key.key : null).toBe("Enter");
    expect(archive.summary.actionCount).toBe(6);
    expect(archive.page.url).toBe("http://127.0.0.1:4000/login");
  });

  test("video anchor is the recording start; step annotations measure from it", () => {
    const { archive, videoStartedAt } = build();
    expect(videoStartedAt).toBe(t(2));
    const steps = archive.annotations.filter((annotation) => annotation.kind === "step");
    expect(steps.map((step) => step.kind === "step" && step.videoOffsetMs)).toEqual([0, 3000]);
    expect(archive.sections.actions[0]?.payload).toMatchObject({ kind: "lifecycle", detail: "Runner started recording." });
  });

  test("without an engine anchor the report start stands in", () => {
    const { videoStartedAt } = buildRunArchive({
      report,
      requests: [],
      consoleLog: [],
      navigations: [],
      engineEvents: [],
      videoStartedAt: null,
      sessionId: "jl_run_2",
      name: "x",
      videoDurationMs: null,
      redact
    });
    expect(videoStartedAt).toBe(t(0));
  });
});

describe("capture helpers", () => {
  test("parseTarget reads the trailing role and name, also with a trailing note", () => {
    expect(parseTarget('tap button "Sign in"')).toMatchObject({ role: "button", name: "Sign in" });
    expect(parseTarget('tap button "Sign in" (replayed)')).toMatchObject({ role: "button", name: "Sign in" });
    expect(parseTarget("scroll down")).toEqual({ textPreview: "scroll down" });
  });

  test("captureHeaders replaces sensitive headers and redacts the rest", () => {
    expect(captureHeaders({ authorization: "Bearer abc", "x-note": "hunter22 here" }, redact)).toEqual([
      { name: "authorization", value: "[redacted]" },
      { name: "x-note", value: "[redacted] here" }
    ]);
  });

  test("captureBody keeps text up to 64 KiB, omits binary, redacts secrets", () => {
    const encoder = new TextEncoder();
    expect(captureBody(encoder.encode('{"p":"hunter22"}'), "application/json", redact)).toEqual({
      disposition: "captured",
      encoding: "utf8",
      mimeType: "application/json",
      value: '{"p":"[redacted]"}',
      byteLength: 16
    });
    const big = captureBody(encoder.encode("a".repeat(70_000)), "text/plain", redact);
    expect(big?.disposition).toBe("truncated");
    expect(big?.value?.length).toBe(64 * 1024);
    expect(big?.omittedByteLength).toBe(70_000 - 64 * 1024);
    expect(captureBody(new Uint8Array([1, 2, 3]), "image/png", redact)).toEqual({ disposition: "omitted", mimeType: "image/png", byteLength: 3, reason: "binary body" });
    expect(captureBody(null, "text/plain", redact)).toBeUndefined();
    expect(captureBody(new Uint8Array(), "text/plain", redact)).toBeUndefined();
  });

  test("secretsFromEnv reads the listed env names and model account keys", () => {
    expect(
      secretsFromEnv({
        JL_REDACT_ENVS: "JL_CRED_ADMIN_PASSWORD,JL_RUN_TOKEN,MISSING",
        JL_CRED_ADMIN_PASSWORD: "hunter22",
        JL_RUN_TOKEN: "tok_1",
        JL_MODEL_ACCOUNTS: JSON.stringify([{ apiKey: "sk-live" }, { apiKey: null }])
      }).sort()
    ).toEqual(["hunter22", "sk-live", "tok_1"]);
    expect(secretsFromEnv({})).toEqual([]);
  });
});
