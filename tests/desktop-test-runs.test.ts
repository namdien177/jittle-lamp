import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { testCaseLinkSchema, webhookRuleSchema } from "@jittle-lamp/shared";

import {
  buildRunDeepLink,
  deepLinkTargetPath,
  findDeepLinkInArgv,
  isExternalHttpUrl,
  isSameFileUrl,
  parseDeepLink
} from "../apps/desktop/src/deep-link";
import {
  describeRunState,
  didRunSettle,
  initialLiveRunState,
  nextRunPollDelay,
  notificationTarget,
  reduceLiveRun,
  runListRefreshInterval,
  runPollIntervalMs,
  runPollMaxBackoffMs,
  type LiveRunState
} from "../apps/desktop/src/mainview/test-runs/live-run";
import { createTestApi, extractListItems, TestApiError } from "../apps/desktop/src/mainview/test-runs/test-api";
import { webPaths, webUrl } from "../apps/desktop/src/mainview/test-runs/web-links";
import { getViewerReadOnlyNotice, shouldClearViewerTempSession } from "../apps/desktop/src/mainview/viewer-source";
import { isAllowedArtifactUrl, loadRemoteEvidence, selectPlaybackArtifacts } from "../apps/desktop/src/session/remote-evidence";
import { canonicalArchiveBundles } from "./fixtures/canonical-fixtures";
import {
  fixtureEnvironment,
  fixtureNotification,
  fixtureRunDetail,
  fixtureRunSummary,
  fixtureTestCaseDetail
} from "./fixtures/test-api-fixtures";

const runId = "run-7f3c2a10-0000-4000-8000-000000000001";

describe("jittle-lamp:// deep links", () => {
  test("parses run links in the spellings the OS delivers", () => {
    for (const link of [
      `jittle-lamp://run?runId=${runId}`,
      `jittle-lamp://run/?runId=${runId}`,
      `jittle-lamp:///run?runId=${runId}`,
      `jittle-lamp:run?runId=${runId}`,
      `JITTLE-LAMP://RUN?runId=${runId}`
    ]) {
      expect(parseDeepLink(link)).toEqual({ kind: "run", runId });
    }
  });

  test("rejects other schemes, actions, traversal and malformed IDs", () => {
    for (const link of [
      `https://run?runId=${runId}`,
      `jittle-lamp://case?runId=${runId}`,
      `jittle-lamp://run/extra?runId=${runId}`,
      "jittle-lamp://run?runId=../../etc/passwd",
      "jittle-lamp://run?runId=..",
      "jittle-lamp://run?runId=a%2Fb",
      "jittle-lamp://run?runId=a/b",
      "jittle-lamp://run?runId=",
      "jittle-lamp://run",
      `jittle-lamp://run?runId=${runId}&runId=other`,
      `jittle-lamp://user:pw@run?runId=${runId}`,
      `jittle-lamp://run?runId=${runId}#frag`,
      `jittle-lamp://run?runId=${"a".repeat(200)}`,
      `jittle-lamp://run?runId=${"a".repeat(3000)}`,
      "not a url",
      null,
      42
    ]) {
      expect(parseDeepLink(link)).toBeNull();
    }
  });

  test("finds the link among second-instance argv and builds the renderer path", () => {
    const argv = ["/Applications/Jittle Lamp.app/Contents/MacOS/Jittle Lamp", "--flag", `jittle-lamp://run?runId=${runId}`];
    expect(findDeepLinkInArgv(argv)).toBe(`jittle-lamp://run?runId=${runId}`);
    expect(findDeepLinkInArgv(["electron", "."])).toBeNull();
    expect(deepLinkTargetPath({ kind: "run", runId })).toBe(`/test-runs/${runId}`);
    expect(buildRunDeepLink(runId)).toBe(`jittle-lamp://run?runId=${runId}`);
    expect(buildRunDeepLink("../x")).toBeNull();
  });
});

describe("live run polling state machine", () => {
  const start = (): LiveRunState => initialLiveRunState(runId);

  test("fetches immediately, polls every 2 s while active and stops when settled", () => {
    let state = start();
    expect(nextRunPollDelay(state)).toBe(0);
    state = reduceLiveRun(state, { type: "loaded", run: fixtureRunDetail({ status: "queued" }) });
    expect(state.phase).toBe("live");
    expect(nextRunPollDelay(state)).toBe(runPollIntervalMs);
    expect(runPollIntervalMs).toBe(2_000);
    const running = reduceLiveRun(state, { type: "loaded", run: fixtureRunDetail({ status: "running" }) });
    expect(nextRunPollDelay(running)).toBe(2_000);
    const done = reduceLiveRun(running, { type: "loaded", run: fixtureRunDetail({ status: "completed" }) });
    expect(done.phase).toBe("settled");
    expect(nextRunPollDelay(done)).toBeNull();
    expect(didRunSettle(running, done)).toBe(true);
    expect(didRunSettle(done, done)).toBe(false);
    expect(didRunSettle(start(), reduceLiveRun(start(), { type: "loaded", run: fixtureRunDetail() }))).toBe(false);
  });

  test("treats claimed and paused runs as active and cancelled or failed as settled", () => {
    for (const status of ["claimed", "paused"] as const) {
      expect(reduceLiveRun(start(), { type: "loaded", run: fixtureRunDetail({ status }) }).phase).toBe("live");
    }
    for (const status of ["cancelled", "failed"] as const) {
      expect(reduceLiveRun(start(), { type: "loaded", run: fixtureRunDetail({ status }) }).phase).toBe("settled");
    }
  });

  test("backs off on errors while a run is active and gives up without any run", () => {
    let state = reduceLiveRun(start(), { type: "loaded", run: fixtureRunDetail({ status: "running" }) });
    const delays: Array<number | null> = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      state = reduceLiveRun(state, { type: "failed", message: "offline" });
      delays.push(nextRunPollDelay(state));
    }
    expect(delays).toEqual([4_000, 8_000, 16_000, runPollMaxBackoffMs, runPollMaxBackoffMs, runPollMaxBackoffMs]);
    expect(state.run?.status).toBe("running");
    const recovered = reduceLiveRun(state, { type: "loaded", run: fixtureRunDetail({ status: "running" }) });
    expect(recovered.consecutiveErrors).toBe(0);
    expect(nextRunPollDelay(recovered)).toBe(2_000);

    let missing = start();
    for (let attempt = 0; attempt < 3; attempt += 1) missing = reduceLiveRun(missing, { type: "failed", message: "404" });
    expect(nextRunPollDelay(missing)).toBeNull();
    const retried = reduceLiveRun(missing, { type: "refresh" });
    expect(nextRunPollDelay(retried)).toBe(0);
  });

  test("ignores responses for another run and bumps the revision on every event", () => {
    const state = start();
    const other = reduceLiveRun(state, { type: "loaded", run: fixtureRunDetail({ id: "run-other" }) });
    expect(other).toBe(state);
    const next = reduceLiveRun(state, { type: "refresh" });
    expect(next.revision).toBe(state.revision + 1);
  });

  test("run lists refresh only while a listed run is active", () => {
    expect(runListRefreshInterval([fixtureRunSummary({ status: "completed" }), fixtureRunSummary({ status: "queued" })])).toBe(5_000);
    expect(runListRefreshInterval([fixtureRunSummary({ status: "completed" })])).toBe(false);
    expect(runListRefreshInterval(undefined)).toBe(false);
  });

  test("labels queue, attachment-free and outcome states", () => {
    expect(describeRunState(fixtureRunSummary({ status: "queued", queuePosition: 2 }))).toEqual({ tone: "neutral", text: "Queued · 2 ahead" });
    expect(describeRunState(fixtureRunSummary({ status: "queued", queuePosition: 0 })).text).toBe("Queued · next");
    expect(describeRunState(fixtureRunSummary({ status: "queued", blockedReason: "NO_RUNNER" })).tone).toBe("warning");
    expect(describeRunState(fixtureRunSummary({ status: "queued", queuePosition: 0, blockedReason: "BUDGET_EXCEEDED" }))).toEqual({ tone: "warning", text: "Queued · daily model budget used up" });
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "blocked" })).text).toBe("Blocked");
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "passed", flaky: true })).text).toBe("Passed · flaky");
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "failed" })).tone).toBe("danger");
  });
});

describe("notifications", () => {
  const web = "https://web.example.test";

  test("open run notifications on the run page and ignore unsafe targets", () => {
    expect(notificationTarget(fixtureNotification(), web)).toEqual({ kind: "run", runId });
    expect(notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "batch-1", url: `/test-runs/${runId}` }), web)).toEqual({
      kind: "run",
      runId
    });
    expect(
      notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "b", url: `jittle-lamp://run?runId=${runId}` }), web)
    ).toEqual({ kind: "run", runId });
    expect(notificationTarget(fixtureNotification({ subjectType: "test_run", subjectId: "../x", url: null }), web)).toBeNull();
    expect(notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "b", url: "/test-runs/..%2Fx" }), web)).toBeNull();
    expect(notificationTarget(fixtureNotification({ kind: "import.finished", subjectType: "test_import_batch", subjectId: "b", url: null }), web)).toBeNull();
  });

  test("batch, import, review and runner notifications open the web app on its own origin", () => {
    const cases = [
      [{ kind: "import.finished", subjectType: "test_import_batch", url: "/test-cases/import/batch-1" }, `${web}/test-cases/import/batch-1`],
      [{ kind: "review.pending_count", subjectType: "organization", url: "/test-cases?status=review" }, `${web}/test-cases?status=review`],
      [{ kind: "batch.finished", subjectType: "test_run_batch", url: "/test-run-batches/b1" }, `${web}/test-run-batches/b1`],
      [{ kind: "runner.offline", subjectType: "runner_worker", url: "/settings/runner-pools" }, `${web}/settings/runner-pools`]
    ] as const;
    for (const [overrides, url] of cases) {
      expect(notificationTarget(fixtureNotification({ ...overrides, subjectId: "x" }), web)).toEqual({ kind: "web", url });
    }
    for (const url of ["//evil.example.test/x", "https://evil.example.test/x", "javascript:alert(1)", "\\evil"]) {
      expect(notificationTarget(fixtureNotification({ kind: "import.finished", subjectType: "test_import_batch", subjectId: "x", url }), web)).toBeNull();
    }
  });
});

describe("web links and external URLs", () => {
  test("build web-app links only on the configured origin", () => {
    expect(webUrl("https://web.example.test", webPaths.reviewQueue())).toBe("https://web.example.test/test-cases/review");
    expect(webUrl("https://web.example.test/", webPaths.caseEditor("case-0412") ?? "")).toBe("https://web.example.test/test-cases?case=case-0412&tab=steps");
    expect(webPaths.caseEditor("../x")).toBeNull();
    expect(webPaths.importBatch("b/1")).toBeNull();
    expect(webUrl("https://web.example.test", "//evil.example.test")).toBeNull();
    expect(webUrl("file:///x", "/test-cases")).toBeNull();
  });

  test("only http(s) URLs leave the app and only the bundled view counts as the main view", () => {
    expect(isExternalHttpUrl("https://jira.example.test/browse/PCF-1")).toBe(true);
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "jittle-lamp://run?runId=x", "https://u:p@x.test", 7]) {
      expect(isExternalHttpUrl(url)).toBe(false);
    }
    const view = "file:///Applications/Jittle%20Lamp.app/dist/views/mainview/index.html";
    expect(isSameFileUrl(`${view}#x`, view)).toBe(true);
    expect(isSameFileUrl("file:///etc/passwd", view)).toBe(false);
    expect(isSameFileUrl("https://example.test/dist/views/mainview/index.html", view)).toBe(false);
  });

  test("test case links and webhook callbacks accept only http(s)", () => {
    expect(testCaseLinkSchema.safeParse({ url: "https://jira.example.test/browse/PCF-1" }).success).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(testCaseLinkSchema.safeParse({ url }).success).toBe(false);
    }
    const rule = { when: { events: ["push"] }, run: { suiteId: "s" }, environment: { id: "e" } };
    expect(webhookRuleSchema.safeParse({ ...rule, report: { callbackUrl: "file:///x" } }).success).toBe(false);
    expect(webhookRuleSchema.safeParse({ ...rule, report: { callbackUrl: "https://ci.example.test/hook" } }).success).toBe(true);
  });
});

describe("desktop test API client", () => {
  type Call = { url: string; method: string; body: unknown; authorization: string | null };

  const client = (respond: (call: Call) => Response) => {
    const calls: Call[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        authorization: new Headers(init?.headers).get("authorization")
      };
      calls.push(call);
      return respond(call);
    }) as typeof fetch;
    return { api: createTestApi({ getToken: async () => "session-token", fetcher, origin: "https://api.example.test/" }), calls };
  };

  test("lists, loads and runs cases against the contract routes", async () => {
    const { api, calls } = client((call) => {
      if (call.url.includes("/runs") && call.method === "POST") {
        return Response.json({ runId, attached: true, status: "running", queuePosition: null, requestedBy: [{ userId: "u", name: "Quinn" }] });
      }
      if (call.url.endsWith("/test-cases/case-0412")) return Response.json(fixtureTestCaseDetail());
      if (call.url.includes("/test-environments")) return Response.json({ environments: [fixtureEnvironment()] });
      return Response.json({ items: [], total: 0, nextCursor: null, tagCounts: {} });
    });
    await api.listTestCases({ q: " logout ", status: ["active", "review"] });
    expect(calls[0]?.url).toBe("https://api.example.test/test-cases?q=logout&status=active%2Creview&limit=100");
    expect(calls[0]?.authorization).toBe("Bearer session-token");
    expect((await api.getTestCase("case-0412")).key).toBe("TC-0412");
    const run = await api.createRun("case-0412", { environmentId: "env-pcf-uat", force: true });
    expect(run).toMatchObject({ runId, attached: true, batchId: null, runIds: [] });
    expect(calls[2]).toMatchObject({
      url: "https://api.example.test/test-cases/case-0412/runs",
      method: "POST",
      body: { environmentId: "env-pcf-uat", force: true, params: {}, cacheMode: "read-write", trigger: "manual", dataset: false }
    });
    expect(await api.listEnvironments()).toEqual([fixtureEnvironment()]);
  });

  test("encodes IDs, surfaces backend errors and rejects contract drift", async () => {
    const { api, calls } = client((call) =>
      call.url.includes("/cancel")
        ? Response.json({ error: { code: "TEST_RUN_FORBIDDEN", message: "Only the requester can cancel this run" } }, { status: 403 })
        : Response.json({ id: runId, status: "running" })
    );
    await expect(api.cancelRun("a/b")).rejects.toMatchObject({ status: 403, code: "TEST_RUN_FORBIDDEN", message: "Only the requester can cancel this run" });
    expect(calls[0]?.url).toBe("https://api.example.test/test-runs/a%2Fb/cancel");
    const drift = await api.getRun(runId).catch((error: unknown) => error);
    expect(drift).toBeInstanceOf(TestApiError);
    expect((drift as TestApiError).code).toBe("CONTRACT_MISMATCH");
  });

  test("requires a session token before calling the backend", async () => {
    let called = false;
    const api = createTestApi({
      getToken: async () => null,
      fetcher: (async () => {
        called = true;
        return Response.json({});
      }) as unknown as typeof fetch
    });
    await expect(api.listNotifications()).rejects.toMatchObject({ status: 401 });
    expect(called).toBe(false);
  });

  test("normalises list envelopes", () => {
    expect(extractListItems([1], "environments")).toEqual([1]);
    expect(extractListItems({ items: [2] }, "environments")).toEqual([2]);
    expect(extractListItems({ environments: [3] }, "environments")).toEqual([3]);
    expect(extractListItems("nope", "environments")).toEqual([]);
  });
});

describe("cloud evidence in the desktop viewer", () => {
  const directories: string[] = [];
  afterAll(async () => {
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const apiOrigin = "https://api.example.test";
  const artifact = (id: string, kind: string, mimeType: string) => ({ id, kind, mimeType });
  const playback = (urls: { archive: string; recording: string }, mimeType = "video/webm") => ({
    evidence: { id: "evidence-run-1" },
    artifacts: [artifact("a", "network-log", "application/json"), artifact("v", "recording", mimeType)],
    readUrls: [
      { artifactId: "v", url: urls.recording, expiresAt: 1, renewAfterMs: 1 },
      { artifactId: "a", url: urls.archive, expiresAt: 1, renewAfterMs: 1 }
    ]
  });

  test("picks the archive and a playable recording from playback links", () => {
    expect(selectPlaybackArtifacts(playback({ archive: "https://s3.example.test/a", recording: "https://s3.example.test/v" }, "video/mp4"))).toEqual({
      archiveUrl: "https://s3.example.test/a",
      recordingUrl: "https://s3.example.test/v",
      recordingMimeType: "video/mp4"
    });
    expect(selectPlaybackArtifacts(playback({ archive: "https://s3.example.test/a", recording: "https://s3.example.test/v" }, "application/x-mpegURL"))).toBeNull();
  });

  test("allows HTTPS artifact hosts and the API origin, never other loopback services", () => {
    expect(isAllowedArtifactUrl("https://bucket.s3.example.test/key?sig=1", apiOrigin)).toBe(true);
    expect(isAllowedArtifactUrl("http://127.0.0.1:3301/dev-artifacts/t", "http://127.0.0.1:3301")).toBe(true);
    for (const url of [
      "http://127.0.0.1:48115/api/sessions",
      "https://127.0.0.1:48115/api/sessions",
      "https://localhost/x",
      "https://[::1]/x",
      "http://evil.example.test/blob",
      "file:///etc/passwd",
      "https://user:pw@example.test/x"
    ]) {
      expect(isAllowedArtifactUrl(url, "http://127.0.0.1:3301")).toBe(false);
    }
  });

  type Seen = { url: string; init: RequestInit };
  const backend = (
    respond: (url: string) => Response,
    seen: Seen[]
  ): typeof fetch =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init: init ?? {} });
      return respond(url);
    }) as typeof fetch;

  test("resolves playback from the evidence ID, validates the archive, then streams the recording", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "jl-remote-evidence-"));
    directories.push(tempRoot);
    const registry = new Map<string, { videoPath: string }>();
    const seen: Seen[] = [];
    const fetcher = backend((url) => {
      if (url === `${apiOrigin}/evidences/evidence-run-1/playback`) {
        return Response.json(playback({ archive: "https://s3.example.test/archive", recording: "https://s3.example.test/rec" }));
      }
      return url.endsWith("/archive") ? new Response(JSON.stringify(canonicalArchiveBundles.small)) : new Response(new Uint8Array([1, 2, 3]));
    }, seen);
    const payload = await loadRemoteEvidence({ evidenceId: "evidence-run-1", authToken: "session-token" }, registry, { apiOrigin, fetcher, tempRoot });
    expect(seen.map((entry) => entry.url)).toEqual([
      `${apiOrigin}/evidences/evidence-run-1/playback`,
      "https://s3.example.test/archive",
      "https://s3.example.test/rec"
    ]);
    expect(new Headers(seen[0]?.init.headers).get("authorization")).toBe("Bearer session-token");
    for (const entry of seen.slice(1)) {
      expect(entry.init.credentials).toBe("omit");
      expect(entry.init.redirect).toBe("error");
      expect(new Headers(entry.init.headers).has("authorization")).toBe(false);
    }
    expect(payload).toMatchObject({ source: "cloud", evidenceId: "evidence-run-1", videoMimeType: "video/webm" });
    expect(payload.videoPath.endsWith(".webm")).toBe(true);
    expect([...(await readFile(payload.videoPath))]).toEqual([1, 2, 3]);
    expect(payload.tempId && registry.has(payload.tempId)).toBe(true);
    expect(shouldClearViewerTempSession(payload)).toBe(true);
    expect(getViewerReadOnlyNotice("cloud")).toMatch(/read-only/);
  });

  test("refuses loopback artifact URLs and never downloads the recording for an invalid archive", async () => {
    const registry = new Map<string, { videoPath: string }>();
    const seen: Seen[] = [];
    const loopback = backend(
      () => Response.json(playback({ archive: "http://127.0.0.1:48115/api/archive", recording: "https://s3.example.test/rec" })),
      seen
    );
    await expect(loadRemoteEvidence({ evidenceId: "e1", authToken: "t" }, registry, { apiOrigin, fetcher: loopback })).rejects.toThrow(/HTTPS/);
    expect(seen).toHaveLength(1);

    const invalidSeen: Seen[] = [];
    const invalid = backend(
      (url) =>
        url.includes("/playback")
          ? Response.json(playback({ archive: "https://s3.example.test/archive", recording: "https://s3.example.test/rec" }))
          : new Response("{}"),
      invalidSeen
    );
    await expect(loadRemoteEvidence({ evidenceId: "e1", authToken: "t" }, registry, { apiOrigin, fetcher: invalid })).rejects.toThrow(/Invalid session archive/);
    expect(invalidSeen.map((entry) => entry.url)).not.toContain("https://s3.example.test/rec");
    expect(registry.size).toBe(0);
  });

  test("rejects unsafe evidence IDs, missing tokens and backend errors before any artifact download", async () => {
    const registry = new Map<string, { videoPath: string }>();
    const seen: Seen[] = [];
    const denied = backend(() => Response.json({ error: { message: "nope" } }, { status: 403 }), seen);
    await expect(loadRemoteEvidence({ evidenceId: "../e", authToken: "t" }, registry, { apiOrigin, fetcher: denied })).rejects.toThrow(/evidence ID/);
    await expect(loadRemoteEvidence({ evidenceId: "e1", authToken: "" }, registry, { apiOrigin, fetcher: denied })).rejects.toThrow(/Sign in/);
    expect(seen).toHaveLength(0);
    await expect(loadRemoteEvidence({ evidenceId: "e1", authToken: "t" }, registry, { apiOrigin, fetcher: denied })).rejects.toThrow(/403/);
    expect(seen).toHaveLength(1);
  });
});
