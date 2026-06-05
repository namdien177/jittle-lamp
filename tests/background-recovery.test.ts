import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createSessionDraft, transitionDraftPhase, type CaptureSessionDraft } from "@jittle-lamp/shared";

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
  const createdAlarms: string[] = [];
  const clearedAlarms: string[] = [];

  let offscreenPresent = false;
  let offscreenStartResponse: unknown = {
    ok: true
  };
  let offscreenStopResponse: unknown = {
    ok: true,
    destination: "downloads",
    recordingBytes: 128,
    eventBytes: 64
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

        if (hasMessageType(message, "jl/offscreen-stop-and-export")) {
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
    debugger: {
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
    },
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
    scripting: {
      async executeScript(input: { func?: () => unknown }): Promise<Array<{ result?: unknown }>> {
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
    runtimeMessages,
    tabMessages,
    debuggerAttachTabs,
    debuggerDetachTabs,
    debuggerCommands,
    createdAlarms,
    clearedAlarms,
    setTab(tab: StubTab): void {
      tabsById.set(tab.id, createTab(tab));
    },
    getSessionValue(key: string): unknown {
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
    setOffscreenStartResponse(response: unknown): void {
      offscreenStartResponse = response;
    },
    setOffscreenStopResponse(response: unknown): void {
      offscreenStopResponse = response;
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
      createdAlarms.length = 0;
      clearedAlarms.length = 0;
      tabsById.clear();
      alarms.clear();
      offscreenPresent = false;
      offscreenStartResponse = {
        ok: true
      };
      offscreenStopResponse = {
        ok: true,
        destination: "downloads",
        recordingBytes: 128,
        eventBytes: 64
      };

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
