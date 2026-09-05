import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createSessionDraft, transitionDraftPhase, updateDraftPage, type CaptureSessionDraft } from "@jittle-lamp/shared";

type BackgroundModule = typeof import("../apps/extension/src/background");
type StubTab = {
  id: number;
  status?: string;
  title?: string;
  url?: string;
};

type ChromeHarness = ReturnType<typeof createChromeHarness>;

let backgroundTest: BackgroundModule["__backgroundTest"];
let chromeHarness: ChromeHarness;

beforeAll(async () => {
  chromeHarness = createChromeHarness();
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: chromeHarness.chrome
  });
  Object.defineProperty(globalThis, "clients", {
    configurable: true,
    value: {
      matchAll: async () => chromeHarness.getClientMatches()
    }
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: chromeHarness.fetch
  });

  const backgroundModule = await import("../apps/extension/src/background");
  backgroundTest = backgroundModule.__backgroundTest;
});

beforeEach(async () => {
  await backgroundTest.resetForTests();
  chromeHarness.reset();
});

describe("background recovery", () => {
  test("does not claim offscreen-only runtime messages", async () => {
    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/offscreen-stop-and-export",
      sessionId: "jl_test1234",
      archive: {
        schemaVersion: 3,
        sessionId: "jl_test1234",
        name: "Example",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        phase: "processing",
        page: {
          title: "Example",
          url: "https://example.com"
        },
        artifacts: [],
        sections: {
          actions: [],
          console: [],
          network: []
        },
        annotations: [],
        notes: []
      }
    });

    expect(result.responded).toBeFalse();
  });

  test("schedules the recording duration limit when capture starts", async () => {
    const restoreStartTime = freezeSystemTime("2026-01-01T00:00:00.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });
    restoreStartTime();

    const alarmInfo = chromeHarness.getAlarmInfo(backgroundTest.maxRecordingDurationAlarmName);

    expect(result.responded).toBeTrue();
    expect(alarmInfo?.when).toBe(new Date("2026-01-01T00:05:00.000Z").getTime());
  });

  test("uses the shorter duration limit for desktop capture", async () => {
    const restoreStartTime = freezeSystemTime("2026-01-01T00:00:00.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      captureTarget: "desktop"
    });
    restoreStartTime();

    expect(result.responded).toBeTrue();
    expect(chromeHarness.getAlarmInfo(backgroundTest.maxRecordingDurationAlarmName)?.when).toBe(
      new Date("2026-01-01T00:02:00.000Z").getTime()
    );
  });

  test("uses a popup-provided name for new recording sessions", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      name: "Checkout failure repro"
    });
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(activeDraft?.name).toBe("Checkout failure repro");
    expect(activeDraft?.nameEdited).toBeTrue();
  });

  test("starts desktop recording through the offscreen display picker while keeping active-tab telemetry", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      captureTarget: "desktop",
      playTabAudio: true
    });
    const startMessage = chromeHarness.runtimeMessages.find((message) => hasMessageType(message, "jl/offscreen-start-recording"));
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(startMessage).toMatchObject({
      type: "jl/offscreen-start-recording",
      tabId: 7,
      captureTarget: "desktop",
      playTabAudio: true
    });
    expect(startMessage).not.toHaveProperty("streamId");
    expect(startMessage).toHaveProperty("captureAudio", true);
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeTrue();
    expect(lastLifecycleDetail(activeDraft)).toContain("Started desktop recording");
    expect(lastLifecycleDetail(activeDraft)).toContain("Active-tab actions and network capture");
  });

  test("aborts active recordings without exporting artifacts", async () => {
    const draft = createRecordingDraft();
    await backgroundTest.saveDraft(draft);

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-abort-recording"
    });
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(activeDraft).toBeNull();
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-abort-recording"))
    ).toBeTrue();
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeFalse();
  });

  test("joins duplicate Finish clicks and rejects conflicting actions while saving", async () => {
    const exportResponse = createDeferred<unknown>();
    const initialDraft = createRecordingDraft();
    chromeHarness.setOffscreenStopResponse(exportResponse.promise);
    await backgroundTest.saveDraft(initialDraft);

    const firstFinish = chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });
    await waitForRuntimeMessage("jl/offscreen-stop-and-export");
    const secondFinish = chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const stateResult = await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-get-state" });
    const stateResponse = stateResult.response as {
      state?: { recordingOperation?: string | null; canStart?: boolean; canStop?: boolean };
    };
    expect(stateResponse.state?.recordingOperation).toBe("stopping");
    expect(stateResponse.state?.canStart).toBeFalse();
    expect(stateResponse.state?.canStop).toBeFalse();

    const conflictingStart = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });
    expect(conflictingStart.response).toMatchObject({
      ok: false,
      error: expect.stringContaining('while "stopping" is active')
    });

    const lateInteraction = await chromeHarness.dispatchRuntimeMessage(
      {
        type: "jl/interaction",
        sessionId: initialDraft.sessionId,
        payload: {
          kind: "interaction",
          type: "click",
          selector: "#late-click"
        }
      },
      { tab: createTab({ id: 7, url: "https://example.com/start" }) }
    );
    expect(lateInteraction.response).toEqual({ ok: true });

    exportResponse.resolve({
      ok: true,
      destination: "downloads",
      recordingBytes: 128,
      eventBytes: 64
    });
    const [firstResult, secondResult] = await Promise.all([firstFinish, secondFinish]);
    const activeDraft = await backgroundTest.readDraft();

    expect(firstResult.response).toMatchObject({ ok: true });
    expect(secondResult.response).toMatchObject({ ok: true });
    expect(activeDraft?.events.some((event) => event.payload.kind === "interaction" && event.payload.selector === "#late-click")).toBeFalse();
    expect(
      chromeHarness.runtimeMessages.filter((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toHaveLength(1);
    const exportMessage = chromeHarness.runtimeMessages.find((message) =>
      hasMessageType(message, "jl/offscreen-stop-and-export")
    ) as { archive?: { phase?: string } } | undefined;
    expect(exportMessage?.archive?.phase).toBe("ready");
    expect(
      chromeHarness.runtimeMessages.filter((message) => hasMessageType(message, "jl/offscreen-stop-recording"))
    ).toHaveLength(1);
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-start-recording"))
    ).toBeFalse();
  });

  test("pauses active recordings without exporting artifacts", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-pause-recording"
    });
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(activeDraft?.phase).toBe("paused");
    expect(lastLifecycleDetail(activeDraft)).toBe("Paused recording from the popup.");
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-pause-recording"))
    ).toBeTrue();
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeFalse();
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-end-capture"))
    ).toBeTrue();
    expect(chromeHarness.clearedAlarms).toContain(backgroundTest.maxRecordingDurationAlarmName);
  });

  test("resumes paused recordings without starting a new session", async () => {
    await backgroundTest.saveDraft(createPausedDraft());

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-resume-recording"
    });
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(activeDraft?.phase).toBe("recording");
    expect(lastLifecycleDetail(activeDraft)).toBe("Resumed recording from the popup.");
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-resume-recording"))
    ).toBeTrue();
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeTrue();
    expect(chromeHarness.createdAlarms).toContain(backgroundTest.maxRecordingDurationAlarmName);
  });

  test("injects the page network probe when debugger capture starts", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });

    expect(result.responded).toBeTrue();
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
    expect(chromeHarness.executeScriptCalls.some((call) => call.files?.includes("network-probe.js"))).toBeTrue();
  });

  test("records page-probe network messages for the active tab", async () => {
    const draft = createRecordingDraft();
    await backgroundTest.saveDraft(draft);

    const result = await chromeHarness.dispatchRuntimeMessage(
      {
        type: "jl/network",
        sessionId: draft.sessionId,
        payload: {
          kind: "network",
          method: "POST",
          url: "https://example.com/api/login",
          subtype: "fetch",
          status: 200,
          statusText: "OK",
          durationMs: 32,
          requestId: "page-fetch-test",
          request: {
            headers: [{ name: "content-type", value: "application/json" }],
            cookies: [],
            body: {
              disposition: "captured",
              encoding: "utf8",
              mimeType: "application/json",
              value: "{\"username\":\"demo\"}",
              byteLength: 19
            }
          },
          response: {
            headers: [{ name: "content-type", value: "application/json" }],
            setCookieHeaders: [],
            setCookies: [],
            body: {
              disposition: "captured",
              encoding: "utf8",
              mimeType: "application/json",
              value: "{\"ok\":true}",
              byteLength: 11
            }
          }
        }
      },
      { tab: { id: 7 } as chrome.tabs.Tab }
    );

    const activeDraft = await backgroundTest.readDraft();
    const networkEvents = activeDraft?.events.filter((event) => event.payload.kind === "network") ?? [];

    expect(result.responded).toBeTrue();
    expect(networkEvents).toHaveLength(1);
    expect(networkEvents[0]?.payload.kind === "network" ? networkEvents[0].payload.url : undefined).toBe(
      "https://example.com/api/login"
    );
  });

  test("does not duplicate page-probe requests when CDP reports the same request", async () => {
    const draft = createRecordingDraft();
    await backgroundTest.saveDraft(draft);

    await chromeHarness.dispatchRuntimeMessage(
      {
        type: "jl/network",
        sessionId: draft.sessionId,
        payload: {
          kind: "network",
          method: "GET",
          url: "https://example.com/api/users",
          subtype: "fetch",
          status: 200,
          requestId: "page-fetch-users",
          request: {
            headers: [],
            cookies: []
          }
        }
      },
      { tab: { id: 7 } as chrome.tabs.Tab }
    );

    await chromeHarness.emitDebuggerEvent({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: "cdp-fetch-users",
      request: {
        method: "GET",
        url: "https://example.com/api/users",
        headers: {}
      }
    });
    await chromeHarness.emitDebuggerEvent({ tabId: 7 }, "Network.responseReceived", {
      requestId: "cdp-fetch-users",
      type: "Fetch",
      response: {
        status: 200,
        statusText: "OK",
        headers: {},
        mimeType: "application/json"
      }
    });
    await chromeHarness.emitDebuggerEvent({ tabId: 7 }, "Network.loadingFinished", {
      requestId: "cdp-fetch-users"
    });

    const activeDraft = await backgroundTest.readDraft();
    const networkEvents = activeDraft?.events.filter((event) => event.payload.kind === "network") ?? [];

    expect(networkEvents).toHaveLength(1);
    expect(networkEvents[0]?.payload.kind === "network" ? networkEvents[0].payload.requestId : undefined).toBe(
      "page-fetch-users"
    );
  });

  test("starts recording with the page probe when the debugger API is unavailable", async () => {
    chromeHarness.setDebuggerApiAvailable(false);
    chromeHarness.setNetworkPermissionGranted(false);
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });

    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(chromeHarness.debuggerAttachTabs).toEqual([]);
    expect(chromeHarness.executeScriptCalls.some((call) => call.files?.includes("network-probe.js"))).toBeTrue();
    expect(activeDraft?.phase).toBe("recording");
    expect(lastLifecycleDetail(activeDraft)).toContain("fetch/XHR capture will use the page probe");
  });

  test("skips debugger capture on Microsoft Edge while recording", async () => {
    const restoreNavigator = setNavigatorForTest({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.4022.52"
    });

    try {
      chromeHarness.setTab({
        id: 7,
        status: "complete",
        title: "Example",
        url: "https://example.com/start"
      });

      const result = await chromeHarness.dispatchRuntimeMessage({
        type: "jl/popup-start-recording"
      });

      const activeDraft = await backgroundTest.readDraft();

      expect(result.responded).toBeTrue();
      expect(chromeHarness.debuggerAttachTabs).toEqual([]);
      expect(chromeHarness.debuggerCommands).toEqual([]);
      expect(chromeHarness.executeScriptCalls.some((call) => call.files?.includes("network-probe.js"))).toBeTrue();
      expect(activeDraft?.phase).toBe("recording");
      expect(lastLifecycleDetail(activeDraft)).toContain("Browser debugger capture is unavailable");
    } finally {
      restoreNavigator();
    }
  });

  test("does not request optional network permission from the background start path", async () => {
    chromeHarness.setNetworkPermissionGranted(false);
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });

    expect(result.responded).toBeTrue();
    expect(chromeHarness.permissionRequests).toEqual([]);
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
  });

  test("requests optional site access when a widget start asks for it", async () => {
    chromeHarness.setNetworkPermissionGranted(false);
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      requestSiteAccess: true
    });

    expect(result.responded).toBeTrue();
    expect(chromeHarness.permissionRequests).toEqual([
      {
        permissions: ["webRequest"],
        origins: ["http://*/*", "https://*/*"]
      }
    ]);
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
  });

  test("still starts recording when optional network fallback permission is missing", async () => {
    chromeHarness.setNetworkPermissionGranted(false);
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording"
    });

    expect(result.responded).toBeTrue();
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
    expect(chromeHarness.getAlarmInfo(backgroundTest.maxRecordingDurationAlarmName)).toBeDefined();
  });

  test("retains upload failure details across reads and refuses to replace the session", async () => {
    chromeHarness.setOffscreenStopResponse({ ok: false, error: "HTTP 413: too large" });
    await backgroundTest.saveDraft(createRecordingDraft());
    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });
    const failed = await backgroundTest.readDraft();
    expect(failed?.phase).toBe("failed");
    expect(lastLifecycleDetail(failed)).toContain("HTTP 413");
    const start = await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-start-recording" });
    expect((start.response as { ok: boolean }).ok).toBeFalse();
    expect((await backgroundTest.readDraft())?.sessionId).toBe(failed?.sessionId);
  });

  test("keeps a canceled local save recoverable and marks ready only after confirmed save", async () => {
    await backgroundTest.saveDraft(transitionDraftPhase(createRecordingDraft(), "failed", "HTTP 413"));
    chromeHarness.setOffscreenStopResponse({ ok: false, error: "Download canceled" });
    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-save-local" });
    expect((await backgroundTest.readDraft())?.phase).toBe("failed");
    expect(lastLifecycleDetail(await backgroundTest.readDraft())).toContain("Download canceled");
    chromeHarness.setOffscreenStopResponse({ ok: true, destination: "downloads" });
    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-save-local" });
    expect((await backgroundTest.readDraft())?.phase).toBe("ready");
    expect(lastLifecycleDetail(await backgroundTest.readDraft())).toContain("your machine");
  });

  test("rejects artifact download requests from content scripts", async () => {
    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/download-artifact", url: "blob:chrome-extension://test/blob", filename: "recording.webm"
    }, { tab: { id: 7 }, url: "https://example.com" } as chrome.runtime.MessageSender);
    expect((result.response as { ok: boolean }).ok).toBeFalse();
  });

  test("keeps stale uploads recoverable before allowing another recording", async () => {
    await backgroundTest.saveDraft(
      transitionDraftPhase(
        createRecordingDraft(),
        "processing",
        "Captured tab closed; exported the partial session.",
        new Date("2026-01-01T00:00:02.000Z")
      )
    );

    const restoreStaleTime = freezeSystemTime("2026-01-01T00:06:00.000Z");
    const result = await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-get-state" });
    restoreStaleTime();

    const response = result.response as {
      state?: {
        activeSession?: { phase?: string };
        canStart?: boolean;
        canStop?: boolean;
      };
    };
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(response.state?.activeSession?.phase).toBe("failed");
    expect(response.state?.canStart).toBeFalse();
    expect(response.state?.canStop).toBeFalse();
    expect(activeDraft?.phase).toBe("failed");
    expect(lastLifecycleDetail(activeDraft)).toBe(
      "Previous upload did not complete. Retry upload or save locally before starting another recording."
    );
  });

  test("exports the partial session when the recording reaches five minutes", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());

    await backgroundTest.handleMaxRecordingDurationAlarm();

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.phase).toBe("ready");
    expect(lifecycleDetails(activeDraft)).toContain(
      "Stopped recording automatically after reaching the 5-minute limit."
    );
    expect(chromeHarness.clearedAlarms).toContain(backgroundTest.maxRecordingDurationAlarmName);
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeTrue();
  });

  test("reports the two-minute limit when desktop capture stops automatically", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Example",
      url: "https://example.com/start"
    });
    await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      captureTarget: "desktop"
    });

    await backgroundTest.handleMaxRecordingDurationAlarm();

    expect(lifecycleDetails(await backgroundTest.readDraft())).toContain(
      "Stopped recording automatically after reaching the 2-minute desktop limit."
    );
  });

  test("exports the session when the recorder reaches the safe video byte limit", async () => {
    const draft = createRecordingDraft();
    await backgroundTest.saveDraft(draft);

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/offscreen-recording-limit-reached",
      sessionId: draft.sessionId,
      reason: "size",
      recordingBytes: 45 * 1024 * 1024
    });
    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(activeDraft?.phase).toBe("ready");
    expect(lifecycleDetails(activeDraft)).toContain(
      "Stopped recording automatically before the video exceeded the safe upload size."
    );
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeTrue();
  });

  test("passes the persisted extension auth token to offscreen exports", async () => {
    const token = createExtensionSessionToken();
    await chrome.storage.local.set({
      "jittle-lamp.cloud-auth-extension-session": {
        token,
        origin: "https://jl-api.monthlyparty.com",
        expiresAt: Date.now() + 60 * 60 * 1000,
        checkedAt: new Date().toISOString(),
        accountLabel: "nam.do@littlelives.com · LittleLives"
      }
    });
    chromeHarness.setOffscreenStopResponse({
      ok: true,
      destination: "cloud",
      recordingBytes: 128,
      eventBytes: 64,
      cloudUrl: "https://jittlelamp.dev/evidence/ev_123"
    });
    await backgroundTest.saveDraft(createRecordingDraft());

    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const stopMessage = chromeHarness.runtimeMessages.find((message) =>
      hasMessageType(message, "jl/offscreen-stop-and-export")
    ) as { cloudAuthToken?: string; cloudRequired?: boolean } | undefined;
    const activeDraft = await backgroundTest.readDraft();

    expect(stopMessage?.cloudAuthToken).toBe(token);
    expect(stopMessage?.cloudRequired).toBe(true);
    expect(activeDraft?.phase).toBe("ready");
    expect(lastLifecycleDetail(activeDraft)).toContain("Saved session directly to cloud");
  });

  test("refreshes an expired extension auth token before stop export", async () => {
    const expiredToken = createExtensionSessionToken({ expiresInSeconds: -60 });
    const refreshedToken = createExtensionSessionToken();
    await chrome.storage.local.set({
      "jittle-lamp.cloud-auth-extension-session": {
        token: expiredToken,
        origin: "https://jl-api.monthlyparty.com",
        checkedAt: new Date().toISOString(),
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token-1",
        refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
      }
    });
    chromeHarness.queueFetchResponse("https://jl-api.monthlyparty.com/extension-auth/sessions/refresh", {
      accessToken: refreshedToken,
      refreshToken: "refresh-token-2",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshExpiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000
    });
    chromeHarness.setOffscreenStopResponse({
      ok: true,
      destination: "cloud",
      recordingBytes: 128,
      eventBytes: 64,
      cloudUrl: "https://jittlelamp.dev/evidence/ev_refreshed"
    });
    await backgroundTest.saveDraft(createRecordingDraft());

    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const stopMessage = chromeHarness.runtimeMessages.find((message) =>
      hasMessageType(message, "jl/offscreen-stop-and-export")
    ) as { cloudAuthToken?: string; cloudRequired?: boolean } | undefined;
    const stored = chromeHarness.getLocalValue("jittle-lamp.cloud-auth-extension-session") as
      | { refreshToken?: string }
      | undefined;

    expect(stopMessage?.cloudAuthToken).toBe(refreshedToken);
    expect(stopMessage?.cloudRequired).toBe(true);
    expect(stored?.refreshToken).toBe("refresh-token-2");
  });

  test("polls a pending approved extension auth flow before stop export falls back to downloads", async () => {
    const token = createExtensionSessionToken();
    chromeHarness.queueFetchResponse("https://jl-api.monthlyparty.com/extension-auth/flows/device-stop", {
      status: "approved",
      accessToken: token,
      expiresAt: Date.now() + 60 * 60 * 1000
    });
    chromeHarness.queueFetchResponse("https://jl-api.monthlyparty.com/protected/me", {
      user: { email: "nam.do@littlelives.com" },
      organizations: [{ id: "org_1", name: "LittleLives", isActive: true }]
    });
    await chrome.storage.local.set({
      "jittle-lamp.cloud-auth-pending-flow": {
        deviceCode: "device-stop",
        verificationUriComplete: "https://jittlelamp.dev/extension-auth?user_code=STOP-1234",
        expiresAt: Date.now() + 60 * 1000,
        intervalSeconds: 5,
        startedAt: new Date().toISOString()
      }
    });
    chromeHarness.setOffscreenStopResponse({
      ok: true,
      destination: "cloud",
      recordingBytes: 128,
      eventBytes: 64,
      cloudUrl: "https://jittlelamp.dev/evidence/ev_pending"
    });
    await backgroundTest.saveDraft(createRecordingDraft());

    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const stopMessage = chromeHarness.runtimeMessages.find((message) =>
      hasMessageType(message, "jl/offscreen-stop-and-export")
    ) as { cloudAuthToken?: string; cloudRequired?: boolean } | undefined;

    expect(stopMessage?.cloudAuthToken).toBe(token);
    expect(stopMessage?.cloudRequired).toBe(true);
    expect(chromeHarness.getLocalValue("jittle-lamp.cloud-auth-extension-session")).toBeTruthy();
  });

  test("uses the validated extension auth cache when storage briefly disappears during stop export", async () => {
    const token = createExtensionSessionToken();
    await chrome.storage.local.set({
      "jittle-lamp.cloud-auth-session": {
        token,
        origin: "https://jl-api.monthlyparty.com",
        checkedAt: new Date().toISOString(),
        expiresAt: Date.now() + 60 * 60 * 1000
      },
      "jittle-lamp.cloud-auth-extension-session": {
        token,
        origin: "https://jl-api.monthlyparty.com",
        checkedAt: new Date().toISOString(),
        expiresAt: Date.now() + 60 * 60 * 1000
      }
    });
    chromeHarness.queueFetchResponse("https://jl-api.monthlyparty.com/protected/me", {
      user: { email: "nam.do@littlelives.com" },
      organizations: [{ id: "org_1", name: "LittleLives", isActive: true }]
    });
    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-get-state" });
    await chrome.storage.local.remove([
      "jittle-lamp.cloud-auth-session",
      "jittle-lamp.cloud-auth-extension-session"
    ]);
    chromeHarness.setOffscreenStopResponse({
      ok: true,
      destination: "cloud",
      recordingBytes: 128,
      eventBytes: 64,
      cloudUrl: "https://jittlelamp.dev/evidence/ev_cached"
    });
    await backgroundTest.saveDraft(createRecordingDraft());

    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const stopMessage = chromeHarness.runtimeMessages.find((message) =>
      hasMessageType(message, "jl/offscreen-stop-and-export")
    ) as { cloudAuthToken?: string; cloudRequired?: boolean } | undefined;

    expect(stopMessage?.cloudAuthToken).toBe(token);
    expect(stopMessage?.cloudRequired).toBe(true);
  });

  test("marks pending recovery and schedules an alarm when debugger detaches during loading", async () => {
    const draft = createRecordingDraft();
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Example",
      url: "https://example.com/start"
    });

    await backgroundTest.saveDraft(draft);
    await backgroundTest.handleDebuggerDetach({ tabId: 7 }, "target_closed");

    const storedMeta = chromeHarness.getSessionValue(backgroundTest.sessionStorageMetaKey) as {
      recovery?: { tabId: number; startedAt: string; detachReason: string };
    };
    const activeDraft = await backgroundTest.readDraft();

    expect(storedMeta.recovery?.tabId).toBe(7);
    expect(storedMeta.recovery?.detachReason).toBe("target_closed");
    expect(chromeHarness.createdAlarms).toContain(backgroundTest.getPendingRecoveryAlarmName(7));
    expect(lastLifecycleDetail(activeDraft)).toContain("waiting for the tab to finish loading");
  });

  test("reconnects on tab completion and clears recovery metadata and alarm", async () => {
    const draft = createRecordingDraft();
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Before",
      url: "https://example.com/before"
    });

    await backgroundTest.saveDraft(draft);
    await backgroundTest.handleDebuggerDetach({ tabId: 7 }, "target_closed");

    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "After",
      url: "https://example.com/after"
    });

    await backgroundTest.handleCompletedTabUpdate(7);

    const storedMeta = chromeHarness.getSessionValue(backgroundTest.sessionStorageMetaKey) as {
      recovery?: unknown;
    };
    const activeDraft = await backgroundTest.readDraft();

    expect(storedMeta.recovery).toBeUndefined();
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
    expect(chromeHarness.clearedAlarms).toContain(backgroundTest.getPendingRecoveryAlarmName(7));
    expect(
      chromeHarness.tabMessages.some(
        (entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-begin-capture")
      )
    ).toBeTrue();
    expect(lastLifecycleDetail(activeDraft)).toBe("Resumed capture after same-tab navigation.");
  });

  test("reinjects capture while a refreshed tab is still loading", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Reloading",
      url: "https://example.com/reload"
    });
    chromeHarness.setNextTabMessageError("Receiving end does not exist.");

    await backgroundTest.handleLoadingTabUpdate(7);

    expect(
      chromeHarness.executeScriptCalls.some((call) => call.tabId === 7 && call.files?.includes("content.js"))
    ).toBeTrue();
    expect(
      chromeHarness.executeScriptCalls.some((call) => call.tabId === 7 && call.files?.includes("network-probe.js"))
    ).toBeTrue();
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeTrue();
  });

  test("moves desktop telemetry to the newly active tab", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Before",
      url: "https://example.com/before"
    });
    await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      captureTarget: "desktop"
    });
    chromeHarness.setTab({
      id: 8,
      status: "complete",
      title: "After",
      url: "https://example.com/after"
    });

    await backgroundTest.handleActivatedTabUpdate(8);

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.page.tabId).toBe(8);
    expect(chromeHarness.debuggerDetachTabs).toContain(7);
    expect(chromeHarness.debuggerAttachTabs).toContain(8);
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 7 && hasMessageType(entry.message, "jl/content-end-capture"))
    ).toBeTrue();
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 8 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeTrue();
    expect(lastLifecycleDetail(activeDraft)).toBe("Desktop telemetry moved to the active tab.");
  });

  test("records tab context on actions networks and console logs", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());
    const draft = await backgroundTest.readDraft();

    if (!draft) {
      throw new Error("Expected a draft.");
    }

    await chromeHarness.dispatchRuntimeMessage(
      {
        type: "jl/interaction",
        sessionId: draft.sessionId,
        payload: {
          kind: "interaction",
          type: "click",
          selector: "#submit"
        }
      },
      { tab: { id: 7, title: "Checkout", url: "https://example.com/checkout" } as chrome.tabs.Tab }
    );
    await chromeHarness.dispatchRuntimeMessage(
      {
        type: "jl/network",
        sessionId: draft.sessionId,
        payload: {
          kind: "network",
          method: "POST",
          url: "https://example.com/api/save",
          subtype: "fetch",
          request: {
            headers: [],
            cookies: []
          }
        }
      },
      { tab: { id: 7, title: "Checkout", url: "https://example.com/checkout" } as chrome.tabs.Tab }
    );
    await chromeHarness.emitDebuggerEvent({ tabId: 7 }, "Runtime.consoleAPICalled", {
      type: "info",
      args: [{ type: "string", value: "Saved" }]
    });

    const activeDraft = await backgroundTest.readDraft();
    const interaction = activeDraft?.events.find((event) => event.payload.kind === "interaction");
    const network = activeDraft?.events.find((event) => event.payload.kind === "network");
    const consoleEntry = activeDraft?.events.find((event) => event.payload.kind === "console");

    expect(interaction?.tab).toEqual({ id: 7, title: "Checkout", url: "https://example.com/checkout" });
    expect(network?.tab).toEqual({ id: 7, title: "Checkout", url: "https://example.com/checkout" });
    expect(consoleEntry?.tab).toEqual({ id: 7, title: "Example", url: "https://example.com/start" });
  });

  test("keeps tab-capture telemetry on the captured tab when another tab activates", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());
    chromeHarness.setTab({
      id: 8,
      status: "complete",
      title: "Other",
      url: "https://example.com/other"
    });

    await backgroundTest.handleActivatedTabUpdate(8);

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.page.tabId).toBe(7);
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 8 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeFalse();
  });

  test("can stop desktop recording after telemetry pauses on an unrecordable active tab", async () => {
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "Before",
      url: "https://example.com/before"
    });
    await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-start-recording",
      captureTarget: "desktop"
    });
    chromeHarness.setTab({
      id: 9,
      status: "complete",
      title: "Extensions",
      url: "chrome://extensions"
    });

    await backgroundTest.handleActivatedTabUpdate(9);
    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-stop-recording" });

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.phase).toBe("ready");
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeTrue();
  });

  test("resumes paused recordings by binding telemetry to the current http tab", async () => {
    await backgroundTest.saveDraft(createPausedDraftWithoutTab());
    chromeHarness.setTab({
      id: 8,
      status: "complete",
      title: "Resume",
      url: "https://example.com/resume"
    });

    await chromeHarness.dispatchRuntimeMessage({ type: "jl/popup-resume-recording" });

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.phase).toBe("recording");
    expect(activeDraft?.page.tabId).toBe(8);
    expect(chromeHarness.debuggerAttachTabs).toContain(8);
    expect(
      chromeHarness.tabMessages.some((entry) => entry.tabId === 8 && hasMessageType(entry.message, "jl/content-begin-capture"))
    ).toBeTrue();
  });

  test("keeps recording and marks page action capture paused when navigation reinjection is blocked", async () => {
    await backgroundTest.saveDraft(createRecordingDraft());
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "After",
      url: "https://different.example/after"
    });
    chromeHarness.setNextTabMessageError("Receiving end does not exist.");
    chromeHarness.setNextExecuteScriptError("Cannot access contents of url \"https://different.example/after\".");

    await backgroundTest.handleCompletedTabUpdate(7);

    const activeDraft = await backgroundTest.readDraft();

    expect(activeDraft?.phase).toBe("recording");
    expect(lastLifecycleDetail(activeDraft)).toContain("Page action capture paused after navigation");
    expect(lastLifecycleDetail(activeDraft)).toContain("Video and browser-level network capture continue");
  });

  test("exports the partial session when the recovery alarm fires after timeout", async () => {
    const restoreDetachedTime = freezeSystemTime("2026-01-01T00:00:00.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Example",
      url: "https://example.com/start"
    });

    await backgroundTest.saveDraft(createRecordingDraft());
    await backgroundTest.handleDebuggerDetach({ tabId: 7 }, "target_closed");
    restoreDetachedTime();

    const restoreExpiredTime = freezeSystemTime("2026-01-01T00:00:20.000Z");
    await backgroundTest.handlePendingRecoveryAlarm(backgroundTest.getPendingRecoveryAlarmName(7));
    restoreExpiredTime();

    const activeDraft = await backgroundTest.readDraft();
    const storedMeta = chromeHarness.getSessionValue(backgroundTest.sessionStorageMetaKey) as {
      recovery?: unknown;
    };

    expect(activeDraft?.phase).toBe("ready");
    expect(lastLifecycleDetail(activeDraft)).toBe(
      "Saved session with browser downloads because the desktop companion was unavailable."
    );
    expect(storedMeta.recovery).toBeUndefined();
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeTrue();
  });

  test("returns a clear error when the offscreen recorder does not answer stop requests", async () => {
    chromeHarness.setOffscreenStopResponse(undefined);
    await backgroundTest.saveDraft(createRecordingDraft());

    const result = await chromeHarness.dispatchRuntimeMessage({
      type: "jl/popup-stop-recording"
    });

    const activeDraft = await backgroundTest.readDraft();

    expect(result.responded).toBeTrue();
    expect(
      result.response &&
        typeof result.response === "object" &&
        "ok" in result.response &&
        (result.response as { ok?: unknown }).ok === false
    ).toBeTrue();
    expect(activeDraft?.phase).toBe("failed");
    expect(lastLifecycleDetail(activeDraft)).toContain("Failed to finalize recording: Offscreen recorder did not respond.");
  });

  test("worker restart resumes stored recovery when the tab is already complete", async () => {
    const restoreDetachedTime = freezeSystemTime("2026-01-01T00:00:00.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Before",
      url: "https://example.com/before"
    });

    await backgroundTest.saveDraft(createRecordingDraft());
    await backgroundTest.handleDebuggerDetach({ tabId: 7 }, "target_closed");
    restoreDetachedTime();

    await backgroundTest.resetForTests({ preserveStorage: true });
    chromeHarness.reset({ preserveStorage: true });
    chromeHarness.setTab({
      id: 7,
      status: "complete",
      title: "After",
      url: "https://example.com/after"
    });

    const restoreResumeTime = freezeSystemTime("2026-01-01T00:00:05.000Z");
    await backgroundTest.readDraft();
    await Promise.resolve();
    await backgroundTest.flushDraftMutations();
    restoreResumeTime();

    const activeDraft = await backgroundTest.readDraft();
    const storedMeta = chromeHarness.getSessionValue(backgroundTest.sessionStorageMetaKey) as {
      recovery?: unknown;
    };

    expect(storedMeta.recovery).toBeUndefined();
    expect(chromeHarness.debuggerAttachTabs).toContain(7);
    expect(lastLifecycleDetail(activeDraft)).toBe("Resumed capture after same-tab navigation.");
  });

  test("worker restart expires stale stored recovery instead of leaving it pending", async () => {
    const restoreDetachedTime = freezeSystemTime("2026-01-01T00:00:00.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Example",
      url: "https://example.com/start"
    });

    await backgroundTest.saveDraft(createRecordingDraft());
    await backgroundTest.handleDebuggerDetach({ tabId: 7 }, "target_closed");
    restoreDetachedTime();

    await backgroundTest.resetForTests({ preserveStorage: true });
    chromeHarness.reset({ preserveStorage: true });

    const restoreExpiredTime = freezeSystemTime("2026-01-01T00:00:20.000Z");
    chromeHarness.setTab({
      id: 7,
      status: "loading",
      title: "Example",
      url: "https://example.com/start"
    });

    await backgroundTest.readDraft();
    await Promise.resolve();
    await backgroundTest.flushDraftMutations();
    restoreExpiredTime();

    const activeDraft = await backgroundTest.readDraft();
    const storedMeta = chromeHarness.getSessionValue(backgroundTest.sessionStorageMetaKey) as {
      recovery?: unknown;
    };

    expect(activeDraft?.phase).toBe("ready");
    expect(storedMeta.recovery).toBeUndefined();
    expect(
      chromeHarness.runtimeMessages.some((message) => hasMessageType(message, "jl/offscreen-stop-and-export"))
    ).toBeTrue();
  });
});

function createRecordingDraft(): CaptureSessionDraft {
  return transitionDraftPhase(
    createSessionDraft({
      page: {
        tabId: 7,
        title: "Example",
        url: "https://example.com/start"
      },
      now: new Date("2026-01-01T00:00:00.000Z")
    }),
    "recording",
    "Started active-tab recording in the offscreen document.",
    new Date("2026-01-01T00:00:01.000Z")
  );
}

function createPausedDraft(): CaptureSessionDraft {
  return transitionDraftPhase(
    createRecordingDraft(),
    "paused",
    "Paused recording from the popup.",
    new Date("2026-01-01T00:00:02.000Z")
  );
}

function createPausedDraftWithoutTab(): CaptureSessionDraft {
  return updateDraftPage(createPausedDraft(), {
    title: "Paused",
    url: "https://example.com/paused"
  });
}

function lastLifecycleDetail(draft: CaptureSessionDraft | null): string | undefined {
  if (!draft) {
    return undefined;
  }

  for (let index = draft.events.length - 1; index >= 0; index -= 1) {
    const payload = draft.events[index]?.payload;

    if (payload?.kind === "lifecycle") {
      return payload.detail;
    }
  }

  return undefined;
}

function lifecycleDetails(draft: CaptureSessionDraft | null): string[] {
  return (draft?.events ?? []).flatMap((event) => {
    const payload = event.payload;

    return payload.kind === "lifecycle" ? [payload.detail] : [];
  });
}

function hasMessageType(message: unknown, type: string): boolean {
  return Boolean(
    message &&
      typeof message === "object" &&
      "type" in message &&
      (message as { type?: unknown }).type === type
  );
}

function createExtensionSessionToken(options: { expiresInSeconds?: number } = {}): string {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson({
      token_type: "extension_session",
      scope: "extension",
      sub: "user_test",
      exp: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 60 * 60)
    }),
    "signature"
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function freezeSystemTime(isoTimestamp: string): () => void {
  const fixedTimeMs = new Date(isoTimestamp).getTime();
  const realDate = Date;

  class FakeDate extends Date {
    constructor(value?: string | number | Date) {
      super(value ?? fixedTimeMs);
    }

    static override now(): number {
      return fixedTimeMs;
    }
  }

  Object.defineProperty(globalThis, "Date", {
    configurable: true,
    value: FakeDate
  });

  return () => {
    Object.defineProperty(globalThis, "Date", {
      configurable: true,
      value: realDate
    });
  };
}

function setNavigatorForTest(navigatorValue: {
  userAgent?: string;
  userAgentData?: {
    brands?: Array<{
      brand?: string;
    }>;
  };
}): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: navigatorValue
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "navigator", descriptor);
      return;
    }

    Reflect.deleteProperty(globalThis, "navigator");
  };
}

function createDeferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

async function waitForRuntimeMessage(type: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (chromeHarness.runtimeMessages.some((message) => hasMessageType(message, type))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  throw new Error(`Timed out waiting for runtime message: ${type}`);
}

function createChromeHarness() {
  const installedListeners: Array<() => void> = [];
  const messageListeners: Array<
    (rawMessage: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void
  > = [];
  const debuggerEventListeners: Array<(source: chrome.debugger.Debuggee, method: string, params?: unknown) => void> = [];
  const debuggerDetachListeners: Array<(source: chrome.debugger.Debuggee, reason: string) => void> = [];
  const tabUpdatedListeners: Array<(tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void> = [];
  const tabRemovedListeners: Array<(tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void> = [];
  const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];

  const sessionStorage = new Map<string, unknown>();
  const localStorage = new Map<string, unknown>();
  const tabsById = new Map<number, chrome.tabs.Tab>();
  const alarms = new Map<string, chrome.alarms.AlarmCreateInfo>();
  const runtimeMessages: unknown[] = [];
  const tabMessages: Array<{ tabId: number; message: unknown }> = [];
  const debuggerAttachTabs: number[] = [];
  const debuggerDetachTabs: number[] = [];
  const debuggerCommands: Array<{ tabId: number; method: string }> = [];
  const executeScriptCalls: Array<{ tabId?: number; files?: string[]; hasFunc: boolean }> = [];
  const createdAlarms: string[] = [];
  const clearedAlarms: string[] = [];
  const permissionRequests: chrome.permissions.Permissions[] = [];
  const fetchResponses = new Map<string, unknown[]>();

  let offscreenPresent = false;
  let networkPermissionGranted = true;
  let nextPermissionRequestResult = true;
  let nextTabMessageError: string | null = null;
  let nextExecuteScriptError: string | null = null;
  let offscreenStartResponse: unknown = {
    ok: true
  };
  let offscreenStopResponse: unknown = {
    ok: true,
    destination: "downloads",
    recordingBytes: 128,
    eventBytes: 64
  };

  const debuggerApi = {
    onEvent: {
      addListener(listener: (source: chrome.debugger.Debuggee, method: string, params?: unknown) => void): void {
        debuggerEventListeners.push(listener);
      }
    },
    onDetach: {
      addListener(listener: (source: chrome.debugger.Debuggee, reason: string) => void): void {
        debuggerDetachListeners.push(listener);
      }
    },
    async attach(debuggee: chrome.debugger.Debuggee): Promise<void> {
      if (typeof debuggee.tabId === "number") {
        debuggerAttachTabs.push(debuggee.tabId);
      }
    },
    async sendCommand(debuggee: chrome.debugger.Debuggee, method: string): Promise<unknown> {
      debuggerCommands.push({ tabId: debuggee.tabId ?? -1, method });
      return {};
    },
    async detach(debuggee: chrome.debugger.Debuggee): Promise<void> {
      if (typeof debuggee.tabId === "number") {
        debuggerDetachTabs.push(debuggee.tabId);
      }
    }
  };

  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: {
        addListener(listener: () => void): void {
          installedListeners.push(listener);
        }
      },
      onMessage: {
        addListener(
          listener: (
            rawMessage: unknown,
            sender: chrome.runtime.MessageSender,
            sendResponse: (response?: unknown) => void
          ) => boolean | void
        ): void {
          messageListeners.push(listener);
        }
      },
      async sendMessage(message: unknown): Promise<unknown> {
        runtimeMessages.push(message);

        if (["jl/offscreen-stop-and-export", "jl/offscreen-save-local", "jl/offscreen-retry-cloud-upload"].some((type) => hasMessageType(message, type))) {
          return offscreenStopResponse;
        }

        if (hasMessageType(message, "jl/offscreen-start-recording")) {
          return offscreenStartResponse;
        }

        return { ok: true };
      },
      getURL(path: string): string {
        return `chrome-extension://test/${path}`;
      }
    },
    debugger: debuggerApi,
    tabs: {
      onUpdated: {
        addListener(listener: (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void): void {
          tabUpdatedListeners.push(listener);
        }
      },
      onRemoved: {
        addListener(listener: (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void): void {
          tabRemovedListeners.push(listener);
        }
      },
      async get(tabId: number): Promise<chrome.tabs.Tab> {
        const tab = tabsById.get(tabId);

        if (!tab) {
          throw new Error(`Unknown tab ${tabId}`);
        }

        return { ...tab };
      },
      async query(): Promise<chrome.tabs.Tab[]> {
        return [...tabsById.values()].map((tab) => ({ ...tab }));
      },
      async sendMessage(tabId: number, message: unknown): Promise<void> {
        if (nextTabMessageError) {
          const message = nextTabMessageError;
          nextTabMessageError = null;
          throw new Error(message);
        }

        tabMessages.push({ tabId, message });
      }
    },
    storage: {
      local: createStorageArea(localStorage),
      session: {
        async get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> {
          if (keys === undefined) {
            return Object.fromEntries(sessionStorage.entries());
          }

          if (typeof keys === "string") {
            return sessionStorage.has(keys) ? { [keys]: sessionStorage.get(keys) } : {};
          }

          if (Array.isArray(keys)) {
            return Object.fromEntries(
              keys.filter((key) => sessionStorage.has(key)).map((key) => [key, sessionStorage.get(key)])
            );
          }

          return Object.fromEntries(
            Object.keys(keys).map((key) => [key, sessionStorage.has(key) ? sessionStorage.get(key) : keys[key]])
          );
        },
        async set(items: Record<string, unknown>): Promise<void> {
          for (const [key, value] of Object.entries(items)) {
            sessionStorage.set(key, value);
          }
        },
        async remove(keys: string | string[]): Promise<void> {
          const normalizedKeys = Array.isArray(keys) ? keys : [keys];

          for (const key of normalizedKeys) {
            sessionStorage.delete(key);
          }
        }
      }
    },
    permissions: {
      async contains(permissions: chrome.permissions.Permissions): Promise<boolean> {
        return networkPermissionGranted && hasNetworkCapturePermission(permissions);
      },
      async request(permissions: chrome.permissions.Permissions): Promise<boolean> {
        permissionRequests.push(permissions);
        const granted = nextPermissionRequestResult;
        nextPermissionRequestResult = true;
        if (granted && hasNetworkCapturePermission(permissions)) {
          networkPermissionGranted = true;
        }
        return granted;
      }
    },
    scripting: {
      async executeScript(input: {
        target?: { tabId?: number };
        files?: string[];
        func?: () => unknown;
      }): Promise<Array<{ result?: unknown }>> {
        if (nextExecuteScriptError) {
          const message = nextExecuteScriptError;
          nextExecuteScriptError = null;
          throw new Error(message);
        }

        executeScriptCalls.push({
          ...(input.target?.tabId !== undefined ? { tabId: input.target.tabId } : {}),
          ...(input.files !== undefined ? { files: input.files } : {}),
          hasFunc: typeof input.func === "function"
        });

        if (typeof input.func === "function") {
          return [{ result: true }];
        }

        return [];
      }
    },
    alarms: {
      onAlarm: {
        addListener(listener: (alarm: chrome.alarms.Alarm) => void): void {
          alarmListeners.push(listener);
        }
      },
      create(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void {
        alarms.set(name, alarmInfo);
        createdAlarms.push(name);
      },
      async clear(name: string): Promise<boolean> {
        clearedAlarms.push(name);
        return alarms.delete(name);
      }
    },
    offscreen: {
      async createDocument(): Promise<void> {
        offscreenPresent = true;
      },
      async closeDocument(): Promise<void> {
        offscreenPresent = false;
      }
    },
    tabCapture: {
      getMediaStreamId(
        _options: chrome.tabCapture.GetMediaStreamOptions,
        callback: (streamId?: string) => void
      ): void {
        callback("stream-id");
      }
    }
  };

  return {
    chrome,
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const queuedResponses = fetchResponses.get(url);
      const payload = queuedResponses?.shift();

      if (!queuedResponses?.length) {
        fetchResponses.delete(url);
      }

      if (payload === undefined) {
        return Response.json({ error: "not queued" }, { status: 404 });
      }

      return Response.json(payload);
    },
    runtimeMessages,
    tabMessages,
    debuggerAttachTabs,
    debuggerDetachTabs,
    debuggerCommands,
    executeScriptCalls,
    createdAlarms,
    clearedAlarms,
    permissionRequests,
    setTab(tab: StubTab): void {
      tabsById.set(tab.id, createTab(tab));
    },
    setNetworkPermissionGranted(granted: boolean): void {
      networkPermissionGranted = granted;
    },
    setNextTabMessageError(message: string): void {
      nextTabMessageError = message;
    },
    setNextExecuteScriptError(message: string): void {
      nextExecuteScriptError = message;
    },
    setDebuggerApiAvailable(available: boolean): void {
      if (available) {
        (chrome as { debugger?: typeof debuggerApi }).debugger = debuggerApi;
      } else {
        delete (chrome as { debugger?: typeof debuggerApi }).debugger;
      }
    },
    setNextPermissionRequestResult(granted: boolean): void {
      nextPermissionRequestResult = granted;
    },
    getSessionValue(key: string): unknown {
      return localStorage.get(key);
    },
    getLocalValue(key: string): unknown {
      return localStorage.get(key);
    },
    getAlarmInfo(name: string): chrome.alarms.AlarmCreateInfo | undefined {
      return alarms.get(name);
    },
    async dispatchRuntimeMessage(
      message: unknown,
      sender: chrome.runtime.MessageSender = {}
    ): Promise<{ responded: boolean; response?: unknown }> {
      return await new Promise((resolve) => {
        let pendingAsyncResponse = false;
        let settled = false;

        const sendResponse = (response?: unknown) => {
          if (settled) {
            return;
          }

          settled = true;
          resolve({
            responded: true,
            response
          });
        };

        for (const listener of messageListeners) {
          const result = listener(message, sender, sendResponse);

          if (result === true) {
            pendingAsyncResponse = true;
          }
        }

        queueMicrotask(() => {
          if (!pendingAsyncResponse && !settled) {
            settled = true;
            resolve({
              responded: false
            });
            return;
          }

          setTimeout(() => {
            if (settled) {
              return;
            }

            settled = true;
            resolve({
              responded: false
            });
          }, 25);
        });
      });
    },
    async emitDebuggerEvent(
      source: chrome.debugger.Debuggee,
      method: string,
      params?: unknown
    ): Promise<void> {
      for (const listener of debuggerEventListeners) {
        listener(source, method, params);
      }

      await backgroundTest.flushDraftMutations();
    },
    setOffscreenStartResponse(response: unknown): void {
      offscreenStartResponse = response;
    },
    setOffscreenStopResponse(response: unknown): void {
      offscreenStopResponse = response;
    },
    queueFetchResponse(url: string, response: unknown): void {
      const queuedResponses = fetchResponses.get(url) ?? [];
      queuedResponses.push(response);
      fetchResponses.set(url, queuedResponses);
    },
    getClientMatches(): Array<{ url: string }> {
      return offscreenPresent ? [{ url: chrome.runtime.getURL("offscreen.html") }] : [];
    },
    reset(options?: { preserveStorage?: boolean }): void {
      runtimeMessages.length = 0;
      tabMessages.length = 0;
      debuggerAttachTabs.length = 0;
      debuggerDetachTabs.length = 0;
      debuggerCommands.length = 0;
      executeScriptCalls.length = 0;
      createdAlarms.length = 0;
      clearedAlarms.length = 0;
      permissionRequests.length = 0;
      fetchResponses.clear();
      tabsById.clear();
      alarms.clear();
      offscreenPresent = false;
      networkPermissionGranted = true;
      nextPermissionRequestResult = true;
      nextTabMessageError = null;
      nextExecuteScriptError = null;
      offscreenStartResponse = {
        ok: true
      };
      offscreenStopResponse = {
        ok: true,
        destination: "downloads",
        recordingBytes: 128,
        eventBytes: 64
      };
      (chrome as { debugger?: typeof debuggerApi }).debugger = debuggerApi;

      if (!options?.preserveStorage) {
        sessionStorage.clear();
        localStorage.clear();
      }
    }
  };
}

function createStorageArea(storage: Map<string, unknown>): chrome.storage.StorageArea {
  return {
    async get(keys?: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> {
      if (keys === undefined) {
        return Object.fromEntries(storage.entries());
      }

      if (typeof keys === "string") {
        return storage.has(keys) ? { [keys]: storage.get(keys) } : {};
      }

      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)]));
      }

      return Object.fromEntries(
        Object.keys(keys).map((key) => [key, storage.has(key) ? storage.get(key) : keys[key]])
      );
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        storage.set(key, value);
      }
    },
    async remove(keys: string | string[]): Promise<void> {
      const normalizedKeys = Array.isArray(keys) ? keys : [keys];

      for (const key of normalizedKeys) {
        storage.delete(key);
      }
    },
    async clear(): Promise<void> {
      storage.clear();
    }
  } as chrome.storage.StorageArea;
}

function hasNetworkCapturePermission(permissions: chrome.permissions.Permissions): boolean {
  return Boolean(
    permissions.permissions?.includes("webRequest") &&
      permissions.origins?.includes("http://*/*") &&
      permissions.origins?.includes("https://*/*")
  );
}

function createTab(tab: StubTab): chrome.tabs.Tab {
  return {
    active: true,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: true,
    id: tab.id,
    incognito: false,
    index: 0,
    pinned: false,
    selected: true,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    windowId: 1
  };
}
