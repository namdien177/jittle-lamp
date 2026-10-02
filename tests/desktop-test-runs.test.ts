import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildRunDeepLink,
  deepLinkTargetPath,
  findDeepLinkInArgv,
  parseDeepLink
} from "../apps/desktop/src/deep-link";
import { selectPlaybackArtifacts } from "../apps/desktop/src/mainview/cloud-evidence";
import {
  describeRunState,
  didRunSettle,
  initialLiveRunState,
  nextRunPollDelay,
  notificationTarget,
  reduceLiveRun,
  runPollIntervalMs,
  runPollMaxBackoffMs,
  type LiveRunState
} from "../apps/desktop/src/mainview/test-runs/live-run";
import { createTestApi, extractListItems, TestApiError } from "../apps/desktop/src/mainview/test-runs/test-api";
import { getViewerReadOnlyNotice, shouldClearViewerTempSession } from "../apps/desktop/src/mainview/viewer-source";
import { isAllowedArtifactUrl, loadRemoteEvidence } from "../apps/desktop/src/session/remote-evidence";
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

  test("labels queue, attachment-free and outcome states", () => {
    expect(describeRunState(fixtureRunSummary({ status: "queued", queuePosition: 2 }))).toEqual({ tone: "neutral", text: "Queued · 2 ahead" });
    expect(describeRunState(fixtureRunSummary({ status: "queued", queuePosition: 0 })).text).toBe("Queued · next");
    expect(describeRunState(fixtureRunSummary({ status: "queued", blockedReason: "NO_RUNNER" })).tone).toBe("warning");
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "blocked" })).text).toBe("Blocked");
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "passed", flaky: true })).text).toBe("Passed · flaky");
    expect(describeRunState(fixtureRunSummary({ status: "completed", outcome: "failed" })).tone).toBe("danger");
  });
});

describe("notifications", () => {
  test("open run notifications on the run page and ignore unsafe targets", () => {
    expect(notificationTarget(fixtureNotification())).toEqual({ kind: "run", runId });
    expect(notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "batch-1", url: `/test-runs/${runId}` }))).toEqual({
      kind: "run",
      runId
    });
    expect(
      notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "b", url: `jittle-lamp://run?runId=${runId}` }))
    ).toEqual({ kind: "run", runId });
    expect(notificationTarget(fixtureNotification({ subjectType: "test_run", subjectId: "../x", url: null }))).toBeNull();
    expect(notificationTarget(fixtureNotification({ subjectType: "import_batch", subjectId: "b", url: "/test-runs/..%2Fx" }))).toBeNull();
    expect(notificationTarget(fixtureNotification({ kind: "import.finished", subjectType: "import_batch", subjectId: "b", url: null }))).toBeNull();
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

  test("picks the archive and a playable recording from playback links", () => {
    const artifact = (id: string, kind: string, mimeType: string) => ({
      id,
      evidenceId: "e",
      kind,
      mimeType,
      bytes: 1,
      checksum: "c",
      uploadStatus: "uploaded",
      createdAt: 1,
      updatedAt: 1
    });
    expect(
      selectPlaybackArtifacts({
        artifacts: [artifact("a", "network-log", "application/json"), artifact("v", "recording", "video/mp4")],
        readUrls: [
          { artifactId: "v", url: "https://s3.example.test/v", expiresAt: 1, renewAfterMs: 1 },
          { artifactId: "a", url: "https://s3.example.test/a", expiresAt: 1, renewAfterMs: 1 }
        ]
      })
    ).toEqual({ archiveUrl: "https://s3.example.test/a", recordingUrl: "https://s3.example.test/v", recordingMimeType: "video/mp4" });
    expect(
      selectPlaybackArtifacts({
        artifacts: [artifact("a", "network-log", "application/json"), artifact("v", "recording", "application/x-mpegURL")],
        readUrls: [
          { artifactId: "v", url: "https://s3.example.test/v", expiresAt: 1, renewAfterMs: 1 },
          { artifactId: "a", url: "https://s3.example.test/a", expiresAt: 1, renewAfterMs: 1 }
        ]
      })
    ).toBeNull();
  });

  test("allows HTTPS and loopback HTTP artifact URLs only", () => {
    expect(isAllowedArtifactUrl("https://bucket.s3.example.test/key?sig=1")).toBe(true);
    expect(isAllowedArtifactUrl("http://127.0.0.1:3301/blob")).toBe(true);
    expect(isAllowedArtifactUrl("http://evil.example.test/blob")).toBe(false);
    expect(isAllowedArtifactUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedArtifactUrl("https://user:pw@example.test/x")).toBe(false);
  });

  test("downloads signed artifacts into a temp cloud session without sending credentials", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "jl-remote-evidence-"));
    directories.push(tempRoot);
    const registry = new Map<string, { videoPath: string }>();
    const inits: RequestInit[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init ?? {});
      return String(input).endsWith("/archive")
        ? new Response(JSON.stringify(canonicalArchiveBundles.small))
        : new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    const payload = await loadRemoteEvidence(
      { evidenceId: "evidence-run-1", archiveUrl: "https://s3.example.test/archive", recordingUrl: "https://s3.example.test/rec", recordingMimeType: "video/webm" },
      registry,
      { fetcher, tempRoot }
    );
    expect(payload.source).toBe("cloud");
    expect(payload.evidenceId).toBe("evidence-run-1");
    expect(payload.videoMimeType).toBe("video/webm");
    expect(payload.videoPath.endsWith(".webm")).toBe(true);
    expect([...(await readFile(payload.videoPath))]).toEqual([1, 2, 3]);
    expect(payload.tempId && registry.has(payload.tempId)).toBe(true);
    expect(shouldClearViewerTempSession(payload)).toBe(true);
    expect(getViewerReadOnlyNotice("cloud")).toMatch(/read-only/);
    for (const init of inits) {
      expect(init.credentials).toBe("omit");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
    }
  });

  test("rejects unsafe evidence IDs, URLs and invalid archives", async () => {
    const registry = new Map<string, { videoPath: string }>();
    const base = { evidenceId: "e1", archiveUrl: "https://s3.example.test/a", recordingUrl: "https://s3.example.test/r", recordingMimeType: "video/webm" };
    await expect(loadRemoteEvidence({ ...base, evidenceId: "../e" }, registry)).rejects.toThrow(/evidence ID/);
    await expect(loadRemoteEvidence({ ...base, recordingUrl: "http://evil.example.test/r" }, registry)).rejects.toThrow(/HTTPS/);
    await expect(loadRemoteEvidence({ ...base, recordingMimeType: "text/html" }, registry)).rejects.toThrow(/Unsupported/);
    const fetcher = (async () => new Response("{}")) as unknown as typeof fetch;
    await expect(loadRemoteEvidence(base, registry, { fetcher })).rejects.toThrow(/Invalid session archive/);
    expect(registry.size).toBe(0);
  });
});
