import {
  appendDraftEvent,
  captureSessionDraftSchema,
  companionStateSchema,
  contentRuntimeMessageSchema,
  createSessionArchive,
  createSessionDraft,
  offscreenResponseSchema,
  popupRequestSchema,
  renameSessionDraft,
  sanitizeCapturedUrl,
  transitionDraftPhase,
  updateDraftPage,
  type CaptureSessionDraft,
  type CloudAuthState,
  type CompanionState,
  type ContentRuntimeMessage,
  type NetworkSubtype,
  type PopupResponse,
  type PopupSessionSummary,
  type PopupState
} from "@jittle-lamp/shared";

import { createDraftStorageCheckpoint } from "./draft-storage";

declare const __JITTLE_LAMP_WEB_ORIGIN__: string | undefined;
declare const __JITTLE_LAMP_API_ORIGIN__: string | undefined;

const sessionStorageKey = "jittle-lamp.active-session";
const sessionStorageMetaKey = "jittle-lamp.active-session-meta";
const cloudAuthStorageKey = "jittle-lamp.cloud-auth-session";
const cloudAuthDurableStorageKey = "jittle-lamp.cloud-auth-extension-session";
const cloudAuthFlowStorageKey = "jittle-lamp.cloud-auth-pending-flow";
const debuggerProtocolVersion = "1.3";
const offscreenDocumentPath = "offscreen.html";
const companionServerOrigin = "http://127.0.0.1:48115";
const companionHealthTimeoutMs = 1_200;
const companionOnlineRefreshMs = 3_000;
const companionOfflineRefreshMs = 30_000;
const cloudAuthProbeTimeoutMs = 1_800;
const configuredCloudWebOrigin = (
  typeof __JITTLE_LAMP_WEB_ORIGIN__ === "string" ? __JITTLE_LAMP_WEB_ORIGIN__.trim() : ""
).replace(/\/+$/, "");
const configuredCloudApiOrigin = (
  typeof __JITTLE_LAMP_API_ORIGIN__ === "string" ? __JITTLE_LAMP_API_ORIGIN__.trim() : "https://jl-api.monthlyparty.com"
).replace(/\/+$/, "");
const fallbackCloudWebOrigins = ["https://jittlelamp.dev", "http://127.0.0.1:3000", "http://localhost:3000"];
const cloudWebOrigins = [...new Set([configuredCloudWebOrigin, ...fallbackCloudWebOrigins].filter(Boolean))];
const networkBodyCaptureByteLimit = 64 * 1024;
const networkBodyFetchByteLimit = 512 * 1024;
const pendingRecoveryTimeoutMs = 15_000;
const pendingRecoveryAlarmPrefix = "jittle-lamp.pending-recovery.";
const maxRecordingDurationMs = 5 * 60 * 1000;
const staleProcessingDraftTimeoutMs = maxRecordingDurationMs;
const maxRecordingDurationAlarmName = "jittle-lamp.recording-duration-limit";

const networkRequestsByTab = new Map<number, Map<string, NetworkRequestState>>();
const webRequestFallbackTabIds = new Set<number>();

type RecordingPageOverride = {
  title?: string | undefined;
  url?: string | undefined;
};
const stoppingTabIds = new Set<number>();

let draftMutationQueue = Promise.resolve();
let offscreenCreationPromise: Promise<void> | null = null;
let activeDraftCache: CaptureSessionDraft | null = null;
let activeDraftEventCount = 0;
let activeRecoveryState: PendingRecoveryState | null = null;
let pendingRecoveryCheckScheduled = false;
let pendingCloudAuthFlow: PendingCloudAuthFlow | null = null;
let cloudAuthSessionCache: StoredCloudAuthSession | null = null;
let companionStateCache: CompanionState | null = null;
let companionStateCacheExpiresAt = 0;
let companionStateProbePromise: Promise<CompanionState> | null = null;
let webRequestFallbackListenersRegistered = false;

function authDebugLog(event: string, details: Record<string, unknown> = {}): void {
  console.debug("[jittle-lamp/auth]", event, details);
}

type PendingRecoveryState = {
  tabId: number;
  startedAt: string;
  detachReason: string;
};

type PendingCloudAuthFlow = {
  deviceCode: string;
  verificationUriComplete: string;
  expiresAt: number;
  intervalSeconds: number;
  startedAt: string;
};

type SessionStorageMeta = {
  eventCount?: number;
  recovery?: PendingRecoveryState;
};

type NetworkRequestState = {
  hasBaseRequest?: boolean;
  method: string;
  url: string;
  startedAtMs: number;
  subtype?: NetworkSubtype;
  status?: number;
  statusText?: string;
  requestHeaders?: NetworkHeaderEntry[];
  requestCookies?: NetworkAssociatedCookie[];
  requestHasPostData?: boolean;
  responseHeaders?: NetworkHeaderEntry[];
  responseSetCookieHeaders?: string[];
  responseSetCookies?: NetworkSetCookie[];
  responseMimeType?: string;
  requestBody?: NetworkBodyCapture;
  failureText?: string;
};

type NetworkHeaderEntry = {
  name: string;
  value: string;
};

type NetworkCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  priority?: string;
  sameParty?: boolean;
  sourcePort?: number;
  sourceScheme?: string;
  partitionKey?: string;
  partitioned?: boolean;
};

type NetworkAssociatedCookie = {
  cookie: NetworkCookie;
  blockedReasons: string[];
};

type NetworkSetCookie = NetworkCookie & {
  raw: string;
};

type NetworkBodyCapture = {
  disposition: "captured" | "truncated" | "omitted" | "unavailable";
  encoding?: "utf8" | "base64";
  mimeType?: string;
  value?: string;
  byteLength?: number;
  omittedByteLength?: number;
  reason?: string;
};

type CdpRemoteObject = {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  className?: string;
};

type CdpRequestWillBeSentParams = {
  requestId?: string;
  redirectResponse?: CdpResponseMetadata;
  request?: {
    method?: string;
    url?: string;
    headers?: CdpHeaders;
    hasPostData?: boolean;
  };
};

type CdpRequestWillBeSentExtraInfoParams = {
  requestId?: string;
  headers?: CdpHeaders;
  associatedCookies?: Array<{
    blockedReasons?: string[];
    cookie?: CdpCookie;
  }>;
};

type CdpResponseReceivedParams = {
  requestId?: string;
  type?: string;
  response?: CdpResponseMetadata;
};

type CdpResponseReceivedExtraInfoParams = {
  requestId?: string;
  headers?: CdpHeaders;
  headersText?: string;
};

type CdpLoadingFinishedParams = {
  requestId?: string;
};

type CdpLoadingFailedParams = {
  requestId?: string;
  errorText?: string;
};

type CdpHeaders = Record<string, unknown>;

type CdpResponseMetadata = {
  status?: number;
  statusText?: string;
  headers?: CdpHeaders;
  mimeType?: string;
};

type CdpCookie = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
  priority?: string;
  sameParty?: boolean;
  sourcePort?: number;
  sourceScheme?: string;
  partitionKey?: string;
  partitioned?: boolean;
};

type CdpRequestPostDataResult = {
  postData?: string;
};

type CdpResponseBodyResult = {
  body?: string;
  base64Encoded?: boolean;
};

type CdpConsoleCalledParams = {
  type?: string;
  args?: CdpRemoteObject[];
};

type CdpExceptionThrownParams = {
  exceptionDetails?: {
    text?: string;
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: CdpRemoteObject;
  };
};

void restrictStorageAccessToExtensionContexts();

chrome.runtime.onInstalled.addListener(() => {
  console.info("jittle-lamp recorder installed.");
  void restrictStorageAccessToExtensionContexts();
});

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  if (!isHandledRuntimeMessage(rawMessage)) {
    return false;
  }

  void handleIncomingMessage(rawMessage, sender)
    .then((response) => {
      if (response !== undefined) {
        sendResponse(response);
      }
    })
    .catch((error: unknown) => {
      const message = errorMessage(error);
      console.error(message);
      void buildPopupResponse(false, message).then((response) => sendResponse(response));
    });

  return true;
});

chrome.action?.onClicked?.addListener((tab) => {
  void toggleFloatingWidget(tab);
});

const debuggerApi = getDebuggerApi();

if (debuggerApi) {
  debuggerApi.onEvent.addListener((source, method, params) => {
    void queueDraftMutation(() => handleDebuggerEvent(source, method, params));
  });

  debuggerApi.onDetach.addListener((source, reason) => {
    void queueDraftMutation(() => handleDebuggerDetach(source, reason));
  });
}

registerWebRequestFallbackListeners();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  void queueDraftMutation(() => handleCompletedTabUpdate(tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void queueDraftMutation(() => autoStopIfCapturedTabCloses(tabId));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  void queueDraftMutation(() => handleAlarm(alarm.name));
});

async function handleIncomingMessage(
  rawMessage: unknown,
  sender: chrome.runtime.MessageSender
): Promise<unknown | undefined> {
  const popupRequest = popupRequestSchema.safeParse(rawMessage);

  if (popupRequest.success) {
    switch (popupRequest.data.type) {
      case "jl/popup-get-state":
        return buildPopupResponse(true);

      case "jl/popup-start-recording": {
        const targetTabId = popupRequest.data.tabId;
        const targetPage = popupRequest.data.page;
        const playTabAudio = popupRequest.data.playTabAudio ?? false;
        return queueDraftMutation(async () => {
          try {
            await startRecordingSession(targetTabId, targetPage, {
              playTabAudio
            });
            return buildPopupResponse(true);
          } catch (error: unknown) {
            return buildPopupResponse(false, errorMessage(error));
          }
        });
      }

      case "jl/popup-stop-recording":
        return queueDraftMutation(async () => {
          try {
            await stopRecordingSession("Stopped recording from the popup.");
            return buildPopupResponse(true);
	          } catch (error: unknown) {
	            return buildPopupResponse(false, errorMessage(error));
          }
        });

      case "jl/popup-retry-upload":
        return queueDraftMutation(async () => {
          try {
            await retryFailedCloudUpload();
            return buildPopupResponse(true);
          } catch (error: unknown) {
            return buildPopupResponse(false, errorMessage(error));
          }
        });

      case "jl/popup-start-cloud-sign-in":
        try {
          await startCloudSignInFlow();
          return buildPopupResponse(true, "Opened browser sign-in. Approve the extension connection to keep Jittle Lamp signed in.");
        } catch (error: unknown) {
          return buildPopupResponse(false, errorMessage(error));
        }

      case "jl/popup-open-evidence-list":
        await chrome.tabs.create({ url: `${cloudWebOrigins[0]}/evidence` });
        return buildPopupResponse(true);

      case "jl/popup-logout-cloud":
        await clearCloudAuthSession();
        return buildPopupResponse(true, "Signed out of cloud upload for this extension.");

	      case "jl/popup-update-session-name":
        const nextSessionName = popupRequest.data.name;
        return queueDraftMutation(async () => {
          try {
            await updateActiveSessionName(nextSessionName);
            return buildPopupResponse(true);
          } catch (error: unknown) {
            return buildPopupResponse(false, errorMessage(error));
          }
        });
    }
  }

  const contentMessage = contentRuntimeMessageSchema.safeParse(rawMessage);

  if (contentMessage.success) {
    await queueDraftMutation(() => handleContentRuntimeMessage(contentMessage.data, sender));
    return { ok: true };
  }

  return undefined;
}

async function startRecordingSession(
  targetTabId?: number,
  targetPage?: RecordingPageOverride,
  options: { playTabAudio?: boolean } = {}
): Promise<void> {
  const existingDraft = await readDraft();

  if (existingDraft?.phase === "processing" && isStaleProcessingDraft(existingDraft)) {
    await clearDraft();
  } else if (existingDraft && isSessionBusy(existingDraft)) {
    throw new Error("A jittle-lamp session is already active.");
  }

  if (existingDraft && !isSessionBusy(existingDraft)) {
    await clearDraft();
  }

  const tab = await resolveRecordingTab(targetTabId, targetPage);
  const draft = createSessionDraft({
    page: {
      tabId: tab.id,
      title: tab.title ?? tab.url,
      url: tab.url
    }
  });

  await saveDraft(draft);

  try {
    const canUseWebRequestFallback = await hasNetworkCapturePermission();
    if (canUseWebRequestFallback) {
      registerWebRequestFallbackListeners();
    }
    await ensureOffscreenDocument();
    await ensureRecordableTab(tab.id, "before tab capture", targetPage);
    const streamId = await getTabMediaStreamId(tab.id);
    await ensureContentBridge(tab.id, draft.sessionId, { injectNetworkProbe: true });
    await ensureRecordableTab(tab.id, "before debugger attach", targetPage);
    const debuggerAttached = await attachDebugger(tab.id, { canUseWebRequestFallback });

    const offscreenResponse = await sendOffscreenMessage({
      type: "jl/offscreen-start-recording",
      sessionId: draft.sessionId,
      tabId: tab.id,
      streamId,
      playTabAudio: options.playTabAudio ?? false
    });

    if (!offscreenResponse.ok) {
      throw new Error(offscreenResponse.error ?? "Offscreen recorder failed to start.");
    }

    await saveDraft(
      transitionDraftPhase(
        draft,
        "recording",
        debuggerAttached
          ? "Started active-tab recording in the offscreen document."
          : debuggerUnavailableDetail(canUseWebRequestFallback)
      )
    );
    scheduleMaxRecordingDurationAlarm();
  } catch (error: unknown) {
    webRequestFallbackTabIds.delete(tab.id);
    networkRequestsByTab.delete(tab.id);
    await saveDraft(
      transitionDraftPhase(draft, "failed", `Failed to start recording: ${errorMessage(error)}`)
    );

    await signalContentCaptureEnded(tab.id, draft.sessionId);
    await safeDetachDebugger(tab.id);
    await closeOffscreenDocumentIfPresent();

    throw error;
  }
}

async function hasNetworkCapturePermission(): Promise<boolean> {
  const requiredPermissions: chrome.permissions.Permissions = {
    permissions: ["webRequest"],
    origins: ["http://*/*", "https://*/*"]
  };

  try {
    return await chrome.permissions.contains(requiredPermissions);
  } catch {
    return false;
  }
}

async function toggleFloatingWidget(tabHint?: chrome.tabs.Tab): Promise<void> {
  try {
    const tab = await resolveRecordableTabForWidget(tabHint);
    const response = await buildPopupResponse(true);

    await ensureWidgetBridge(tab.id);
    await chrome.tabs.sendMessage(tab.id, {
      type: "jl/content-toggle-widget",
      state: response.state
    });
    scheduleFloatingWidgetStateRefreshes(tab.id);
    await setActionFeedback(tab.id, "");
  } catch (error: unknown) {
    const message = errorMessage(error);
    const tabId = typeof tabHint?.id === "number" ? tabHint.id : undefined;
    console.warn(`[jittle-lamp] Unable to toggle floating widget: ${message}`);
    await setActionFeedback(tabId, "ERR");
  }
}

function scheduleFloatingWidgetStateRefreshes(tabId: number): void {
  for (const delayMs of [250, 1_200, 3_000]) {
    globalThis.setTimeout(() => {
      void refreshFloatingWidgetState(tabId).catch((error: unknown) => {
        console.warn(`[jittle-lamp] Unable to refresh floating widget state: ${errorMessage(error)}`);
      });
    }, delayMs);
  }
}

async function refreshFloatingWidgetState(tabId: number): Promise<void> {
  const response = await buildPopupResponse(true);
  await chrome.tabs.sendMessage(tabId, {
    type: "jl/content-refresh-widget",
    state: response.state
  });
}

async function resolveRecordableTabForWidget(
  tabHint?: chrome.tabs.Tab
): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  if (isRecordableTab(tabHint)) {
    return tabHint;
  }

  if (typeof tabHint?.id === "number") {
    const hydratedTab = await chrome.tabs.get(tabHint.id).catch(() => undefined);
    if (isRecordableTab(hydratedTab)) {
      return hydratedTab;
    }
  }

  return getActiveRecordableTabForWidget();
}

async function setActionFeedback(tabId: number | undefined, text: string): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: "#dc2626", ...(tabId ? { tabId } : {}) });
  await chrome.action.setBadgeText({ text, ...(tabId ? { tabId } : {}) });

  if (!text) {
    return;
  }

  await chrome.action.setTitle({
    title: "Open an http(s) page to show the Jittle Lamp recorder.",
    ...(tabId ? { tabId } : {})
  });
}

async function getActiveRecordableTabForWidget(): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const candidates = await collectActiveTabs();
  const tab = candidates.find((candidate) => isRecordableTab(candidate));

  if (!tab) {
    throw new Error("Open an http(s) page before opening the floating recorder.");
  }

  return tab;
}

async function collectActiveTabs(): Promise<chrome.tabs.Tab[]> {
  const tabById = new Map<number, chrome.tabs.Tab>();
  const queries: chrome.tabs.QueryInfo[] = [
    { active: true, currentWindow: true },
    { active: true, lastFocusedWindow: true },
    { active: true, windowType: "normal" }
  ];

  for (const query of queries) {
    const tabs = await chrome.tabs.query(query).catch(() => []);
    for (const tab of tabs) {
      if (typeof tab.id === "number") {
        tabById.set(tab.id, tab);
      }
    }
  }

  return [...tabById.values()];
}

async function stopRecordingSession(detail: string): Promise<void> {
  const currentDraft = await readDraft();

  if (!currentDraft) {
    return;
  }

  if (currentDraft.phase !== "armed" && currentDraft.phase !== "recording") {
    return;
  }

  const tabId = currentDraft.page.tabId;

  if (typeof tabId !== "number") {
    throw new Error("The active session is missing its tab identifier.");
  }

  const processingDraft = transitionDraftPhase(currentDraft, "processing", detail);
  clearPendingRecovery(tabId);
  await clearPendingRecoveryAlarm(tabId);
  await clearMaxRecordingDurationAlarm();
  await saveDraft(processingDraft);

  let keepOffscreenForRetry = false;

  try {
    stoppingTabIds.add(tabId);
    await signalContentCaptureEnded(tabId, processingDraft.sessionId);
    await safeDetachDebugger(tabId);

    const cloudAuthSession = await resolveCloudUploadSession();
    authDebugLog("stop-cloud-auth", {
      hasToken: Boolean(cloudAuthSession?.token),
      source: cloudAuthSession ? "extension-session" : "none",
      expiresInMs: cloudAuthSession ? cloudAuthSession.expiresAt - Date.now() : undefined
    });
    const offscreenResponse = await sendOffscreenMessage({
      type: "jl/offscreen-stop-and-export",
      sessionId: processingDraft.sessionId,
      archive: createSessionArchive(processingDraft),
      cloudRequired: Boolean(cloudAuthSession?.token),
      ...(cloudAuthSession?.token ? { cloudAuthToken: cloudAuthSession.token } : {})
    });

    if (!offscreenResponse.ok) {
      throw new Error(offscreenResponse.error ?? "Offscreen export failed.");
    }

    await saveDraft(
      transitionDraftPhase(
        processingDraft,
        "ready",
        offscreenResponse.destination === "cloud"
          ? `Saved session directly to cloud${offscreenResponse.cloudUrl ? `: ${offscreenResponse.cloudUrl}` : "."}`
          : offscreenResponse.destination === "companion"
          ? `Saved session to the desktop companion folder at ${offscreenResponse.outputDir ?? "the configured output directory"}.`
          : "Saved session with browser downloads because the desktop companion was unavailable."
      )
    );
  } catch (error: unknown) {
    keepOffscreenForRetry = true;
    await saveDraft(
      transitionDraftPhase(
        processingDraft,
        "failed",
        `Failed to finalize recording: ${errorMessage(error)}`
      )
    );

    throw error;
  } finally {
    stoppingTabIds.delete(tabId);
    webRequestFallbackTabIds.delete(tabId);
    networkRequestsByTab.delete(tabId);
    if (!keepOffscreenForRetry) {
      await closeOffscreenDocumentIfPresent();
    }
  }
}

async function retryFailedCloudUpload(): Promise<void> {
  const currentDraft = await readDraft();

  if (!currentDraft || currentDraft.phase !== "failed") {
    throw new Error("There is no failed recording upload to retry.");
  }

  const cloudAuthSession = await resolveCloudUploadSession();

  if (!cloudAuthSession?.token) {
    throw new Error("Sign in to cloud upload before retrying.");
  }

  await ensureOffscreenDocument();
  const offscreenResponse = await sendOffscreenMessage({
    type: "jl/offscreen-retry-cloud-upload",
    sessionId: currentDraft.sessionId,
    cloudAuthToken: cloudAuthSession.token
  });

  if (!offscreenResponse.ok) {
    await saveDraft(
      transitionDraftPhase(
        currentDraft,
        "failed",
        `Failed to retry cloud upload: ${offscreenResponse.error ?? "Offscreen retry failed."}`
      )
    );
    throw new Error(offscreenResponse.error ?? "Offscreen retry failed.");
  }

  await saveDraft(
    transitionDraftPhase(
      currentDraft,
      "ready",
      `Saved session directly to cloud${offscreenResponse.cloudUrl ? `: ${offscreenResponse.cloudUrl}` : "."}`
    )
  );
  await closeOffscreenDocumentIfPresent();
}

async function updateActiveSessionName(name: string): Promise<void> {
  const currentDraft = await readDraft();

  if (!currentDraft) {
    throw new Error("Start a recording session before renaming it.");
  }

  if (currentDraft.phase === "processing") {
    throw new Error("Session name cannot be changed while export is processing.");
  }

  await saveDraft(renameSessionDraft(currentDraft, name));
}

async function autoStopIfCapturedTabCloses(tabId: number): Promise<void> {
  const draft = await readDraft();

  if (!draft || draft.page.tabId !== tabId || draft.phase !== "recording") {
    return;
  }

  await stopRecordingSession("Captured tab closed; exported the partial session.");
}

async function handleCompletedTabUpdate(tabId: number): Promise<void> {
  const draft = await readDraft();

  if (!draft || draft.page.tabId !== tabId) {
    return;
  }

  if (draft.phase !== "armed" && draft.phase !== "recording") {
    return;
  }

  const pendingRecovery = getPendingRecovery(tabId);
  const tab = await chrome.tabs.get(tabId);

  if (pendingRecovery && isPendingRecoveryExpired(pendingRecovery)) {
    await stopRecordingSession(recoveryTimeoutDetail());
    return;
  }

  if (pendingRecovery && (!tab.url || !isHttpUrl(tab.url))) {
    await stopRecordingSession(
      "Stopped recording and exported the partial session because the tab navigated away from an http(s) page while reconnecting after navigation."
    );
    return;
  }

  if (!tab.url || !isHttpUrl(tab.url)) {
    return;
  }

  const sanitizedUrl = sanitizeCapturedUrl(tab.url);
  let nextDraft = draft;

  if (draft.page.url !== sanitizedUrl || draft.page.title !== (tab.title ?? sanitizedUrl)) {
    nextDraft = appendDraftEvent(
      updateDraftPage(draft, {
        tabId,
        title: tab.title ?? sanitizedUrl,
        url: sanitizedUrl
      }),
        {
          kind: "interaction",
          type: "navigation",
          selector: sanitizedUrl,
          url: sanitizedUrl,
          title: tab.title ?? sanitizedUrl,
          navigationType: "location"
        }
      );
    await saveDraft(nextDraft);
  }

  if (pendingRecovery) {
    try {
      const canUseWebRequestFallback = await hasNetworkCapturePermission();
      if (canUseWebRequestFallback) {
        registerWebRequestFallbackListeners();
      }
      const debuggerAttached = await attachDebugger(tabId, { canUseWebRequestFallback });
      await ensureContentBridge(tabId, nextDraft.sessionId, { injectNetworkProbe: true });
      clearPendingRecovery(tabId);
      await clearPendingRecoveryAlarm(tabId);
      await saveDraft(
        appendDraftEvent(nextDraft, {
          kind: "lifecycle",
          phase: "recording",
          detail: debuggerAttached
            ? "Resumed capture after same-tab navigation."
            : debuggerUnavailableDetail(canUseWebRequestFallback)
        })
      );
      return;
    } catch (error: unknown) {
      await stopRecordingSession(
        `Stopped recording and exported the partial session because capture could not reconnect after navigation: ${errorMessage(error)}`
      );
      return;
    }
  }

  await ensureContentBridge(tabId, nextDraft.sessionId, { injectNetworkProbe: true });
}

async function handleContentRuntimeMessage(
  message: ReturnType<typeof contentRuntimeMessageSchema.parse>,
  sender: chrome.runtime.MessageSender
): Promise<void> {
  const currentDraft = await readDraft();

  if (!currentDraft) {
    return;
  }

  if (message.sessionId !== currentDraft.sessionId) {
    return;
  }

  const senderTabId = sender.tab?.id;

  if (typeof senderTabId === "number" && currentDraft.page.tabId !== senderTabId) {
    console.debug("[jittle-lamp] Ignoring content runtime message from non-active tab.", {
      senderTabId,
      activeTabId: currentDraft.page.tabId,
      type: message.type
    });
    return;
  }

  if (!isSessionBusy(currentDraft)) {
    console.debug("[jittle-lamp] Ignoring content runtime message for non-busy session.", {
      phase: currentDraft.phase,
      type: message.type,
      sessionId: currentDraft.sessionId
    });
    return;
  }

  switch (message.type) {
    case "jl/content-ready": {
      const nextDraft = updateDraftPage(
        currentDraft,
        currentDraft.page.tabId === undefined
          ? {
              title: message.page.title,
              url: message.page.url
            }
          : {
              tabId: currentDraft.page.tabId,
              title: message.page.title,
              url: message.page.url
            }
      );

      await saveDraft(nextDraft);
      return;
    }

    case "jl/interaction":
      await saveDraft(appendDraftEvent(currentDraft, normalizeInteractionPayload(message.payload)));
      return;

    case "jl/network":
      await saveDraft(appendDraftEvent(currentDraft, normalizeContentNetworkPayload(message.payload)));
      return;
  }
}

function registerWebRequestFallbackListeners(): void {
  if (webRequestFallbackListenersRegistered) {
    return;
  }

  if (!("webRequest" in chrome) || !chrome.webRequest) {
    return;
  }

  const filter: chrome.webRequest.RequestFilter = {
    urls: ["http://*/*", "https://*/*"]
  };

  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackRequestStarted(details));
      },
      filter,
      ["requestBody", "extraHeaders"]
    );
    chrome.webRequest.onBeforeSendHeaders.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackRequestHeaders(details));
      },
      filter,
      ["requestHeaders", "extraHeaders"]
    );
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackResponseHeaders(details));
      },
      filter,
      ["responseHeaders", "extraHeaders"]
    );
    chrome.webRequest.onBeforeRedirect.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackRequestCompleted(details));
      },
      filter,
      ["responseHeaders", "extraHeaders"]
    );
    chrome.webRequest.onCompleted.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackRequestCompleted(details));
      },
      filter,
      ["responseHeaders", "extraHeaders"]
    );
    chrome.webRequest.onErrorOccurred.addListener(
      (details) => {
        void queueDraftMutation(() => handleFallbackRequestFailed(details));
      },
      filter
    );
    webRequestFallbackListenersRegistered = true;
  } catch (error: unknown) {
    console.warn("[jittle-lamp] Unable to register webRequest fallback listeners.", errorMessage(error));
  }
}

async function handleFallbackRequestStarted(details: chrome.webRequest.WebRequestBodyDetails): Promise<void> {
  if (!(await shouldCaptureFallbackNetwork(details.tabId))) {
    return;
  }

  const requestState = createNetworkRequestState();
  requestState.hasBaseRequest = true;
  requestState.method = details.method;
  requestState.url = details.url;
  requestState.startedAtMs = details.timeStamp;
  requestState.subtype = deriveWebRequestSubtype(details.type);
  const requestBody = bodyCaptureFromWebRequestBody(details.requestBody);

  if (requestBody) {
    requestState.requestBody = requestBody;
  }

  getNetworkRequests(details.tabId).set(details.requestId, requestState);
}

async function handleFallbackRequestHeaders(details: chrome.webRequest.WebRequestHeadersDetails): Promise<void> {
  if (!(await shouldCaptureFallbackNetwork(details.tabId))) {
    return;
  }

  const requestState = getOrCreateNetworkRequestState(details.tabId, details.requestId);
  requestState.requestHeaders = headerEntriesFromWebRequestHeaders(details.requestHeaders);
}

async function handleFallbackResponseHeaders(details: chrome.webRequest.WebResponseHeadersDetails): Promise<void> {
  if (!(await shouldCaptureFallbackNetwork(details.tabId))) {
    return;
  }

  applyWebRequestResponseMetadata(details);
}

async function handleFallbackRequestCompleted(details: chrome.webRequest.WebResponseHeadersDetails): Promise<void> {
  if (!(await shouldCaptureFallbackNetwork(details.tabId))) {
    return;
  }

  const currentDraft = await readDraft();

  if (!currentDraft || currentDraft.page.tabId !== details.tabId || currentDraft.phase !== "recording") {
    return;
  }

  const requestState = applyWebRequestResponseMetadata(details);
  getNetworkRequests(details.tabId).delete(details.requestId);

  if (!requestState.hasBaseRequest || !isHttpUrl(requestState.url)) {
    return;
  }

  await saveDraft(
    appendDraftEvent(
      currentDraft,
      buildNetworkEventPayload({
        requestState,
        requestId: details.requestId,
        durationMs: Math.max(0, Date.now() - requestState.startedAtMs),
        ...(requestState.requestBody ? { requestBody: requestState.requestBody } : {})
      })
    )
  );
}

async function handleFallbackRequestFailed(details: chrome.webRequest.WebResponseErrorDetails): Promise<void> {
  if (!(await shouldCaptureFallbackNetwork(details.tabId))) {
    return;
  }

  const currentDraft = await readDraft();

  if (!currentDraft || currentDraft.page.tabId !== details.tabId || currentDraft.phase !== "recording") {
    return;
  }

  const requestState = getNetworkRequests(details.tabId).get(details.requestId);
  getNetworkRequests(details.tabId).delete(details.requestId);

  if (!requestState?.hasBaseRequest || !isHttpUrl(requestState.url)) {
    return;
  }

  requestState.failureText = details.error || `Network request failed for ${requestState.url}`;

  await saveDraft(
    appendDraftEvent(
      currentDraft,
      buildNetworkEventPayload({
        requestState,
        requestId: details.requestId,
        durationMs: Math.max(0, Date.now() - requestState.startedAtMs),
        ...(requestState.requestBody ? { requestBody: requestState.requestBody } : {})
      })
    )
  );
}

async function shouldCaptureFallbackNetwork(tabId: number): Promise<boolean> {
  if (!webRequestFallbackTabIds.has(tabId)) {
    return false;
  }

  const currentDraft = await readDraft();
  return Boolean(currentDraft && currentDraft.page.tabId === tabId && currentDraft.phase === "recording");
}

function applyWebRequestResponseMetadata(details: chrome.webRequest.WebResponseHeadersDetails): NetworkRequestState {
  const requestState = getOrCreateNetworkRequestState(details.tabId, details.requestId);

  if (details.method) {
    requestState.method = details.method;
  }

  requestState.url = details.url;
  requestState.status = details.statusCode;
  const statusText = statusTextFromStatusLine(details.statusLine);

  if (statusText) {
    requestState.statusText = statusText;
  }
  requestState.responseHeaders = headerEntriesFromWebRequestHeaders(details.responseHeaders);
  requestState.responseSetCookieHeaders = setCookieHeadersFromEntries(requestState.responseHeaders);
  requestState.responseSetCookies = requestState.responseSetCookieHeaders.map(parseSetCookieHeader);

  if (!requestState.subtype) {
    requestState.subtype = deriveWebRequestSubtype(details.type);
  }

  return requestState;
}

function bodyCaptureFromWebRequestBody(body: chrome.webRequest.WebRequestBody | null): NetworkBodyCapture | undefined {
  if (!body) {
    return undefined;
  }

  if (body.error) {
    return {
      disposition: "unavailable",
      reason: body.error
    };
  }

  if (body.formData && Object.keys(body.formData).length > 0) {
    return createUtf8BodyCapture(JSON.stringify(body.formData), "application/x-www-form-urlencoded");
  }

  const rawBytes = body.raw?.flatMap((entry) => (entry.bytes ? [new Uint8Array(entry.bytes)] : [])) ?? [];

  if (rawBytes.length === 0) {
    return undefined;
  }

  const totalLength = rawBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;

  for (const bytes of rawBytes) {
    combined.set(bytes, offset);
    offset += bytes.byteLength;
  }

  return createUtf8BodyCapture(new TextDecoder().decode(combined));
}

function headerEntriesFromWebRequestHeaders(headers: chrome.webRequest.HttpHeader[] | undefined): NetworkHeaderEntry[] {
  return (headers ?? []).flatMap((header) => {
    if (typeof header.value === "string") {
      return [{ name: header.name, value: header.value }];
    }

    if (header.binaryValue) {
      return [{ name: header.name, value: `[${header.binaryValue.byteLength} bytes]` }];
    }

    return [];
  });
}

function statusTextFromStatusLine(statusLine: string | undefined): string | undefined {
  const match = statusLine?.match(/^HTTP\/\S+\s+\d{3}\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function deriveWebRequestSubtype(resourceType: chrome.webRequest.ResourceType | undefined): NetworkSubtype {
  switch (resourceType) {
    case "xmlhttprequest":
      return "xhr";
    case "main_frame":
    case "sub_frame":
      return "document";
    case "stylesheet":
    case "script":
    case "image":
    case "font":
    case "media":
    case "websocket":
      return resourceType;
    default:
      return "other";
  }
}

function normalizeInteractionPayload(message: Extract<ContentRuntimeMessage, { type: "jl/interaction" }>['payload']) {
  const selector = message.selector ?? message.target?.selector;

  switch (message.type) {
    case "click":
      return {
        ...message,
        ...(selector ? { selector } : {}),
        ...(message.x === undefined && message.clientX !== undefined ? { x: message.clientX } : {}),
        ...(message.y === undefined && message.clientY !== undefined ? { y: message.clientY } : {})
      };

    case "input": {
      const preview = message.valuePreview ?? (typeof message.value === "string" ? message.value.slice(0, 240) : undefined);
      return {
        ...message,
        ...(selector ? { selector } : {}),
        ...(preview ? { valuePreview: preview } : {})
      };
    }

    case "submit":
      return {
        ...message,
        ...(selector ? { selector } : {}),
        ...(message.formSelector === undefined && selector ? { formSelector: selector } : {})
      };

    case "navigation":
      return {
        ...message,
        ...(selector ? { selector } : {}),
        ...(message.url ? { url: sanitizeCapturedUrl(message.url) } : {}),
        ...(message.page?.url ? { page: { ...message.page, url: sanitizeCapturedUrl(message.page.url) } } : {})
      };

    case "keyboard":
      return {
        ...message,
        ...(selector ? { selector } : {})
      };

    case "selection":
      return {
        ...message,
        ...(selector ? { selector } : {}),
        selectedText: message.selectedText.slice(0, 500),
        selectedTextLength: message.selectedTextLength ?? message.selectedText.length
      };
  }
}

function normalizeContentNetworkPayload(message: Extract<ContentRuntimeMessage, { type: "jl/network" }>['payload']) {
  return {
    ...message,
    url: sanitizeCapturedUrl(message.url)
  };
}

async function handleDebuggerEvent(
  source: chrome.debugger.Debuggee,
  method: string,
  params: unknown
): Promise<void> {
  const tabId = source.tabId;

  if (typeof tabId !== "number") {
    return;
  }

  const currentDraft = await readDraft();

  if (!currentDraft || currentDraft.page.tabId !== tabId || currentDraft.phase !== "recording") {
    return;
  }

  switch (method) {
    case "Network.requestWillBeSent": {
      const payload = params as CdpRequestWillBeSentParams;
      const requestId = payload.requestId;
      const requestUrl = payload.request?.url;
      const requestMethod = payload.request?.method;

      if (!requestId || !requestUrl || !requestMethod || !isHttpUrl(requestUrl)) {
        return;
      }

      const existingRequestState = getNetworkRequests(tabId).get(requestId);
      let nextDraft = currentDraft;

      if (existingRequestState?.hasBaseRequest && payload.redirectResponse) {
        applyResponseMetadata(existingRequestState, payload.redirectResponse);

        const { requestBody, responseBody } = await captureNetworkBodies(
          tabId,
          requestId,
          existingRequestState,
          false
        );

        nextDraft = appendDraftEvent(
          nextDraft,
          buildNetworkEventPayload({
            requestState: existingRequestState,
            requestId,
            durationMs: Date.now() - existingRequestState.startedAtMs,
            ...(requestBody ? { requestBody } : {}),
            ...(responseBody ? { responseBody } : {})
          })
        );
      }

      const requestState = createNetworkRequestState(existingRequestState?.hasBaseRequest ? undefined : existingRequestState);

      requestState.hasBaseRequest = true;
      requestState.method = requestMethod;
      requestState.url = requestUrl;
      requestState.startedAtMs = Date.now();

      if (typeof payload.request?.hasPostData === "boolean") {
        requestState.requestHasPostData = payload.request.hasPostData;
      }

      if (!requestState.requestHeaders?.length) {
        requestState.requestHeaders = headerEntriesFromHeaders(payload.request?.headers);
      }

      getNetworkRequests(tabId).set(requestId, requestState);

      if (nextDraft !== currentDraft) {
        await saveDraft(nextDraft);
      }

      return;
    }

    case "Network.requestWillBeSentExtraInfo": {
      const payload = params as CdpRequestWillBeSentExtraInfoParams;
      const requestId = payload.requestId;

      if (!requestId) {
        return;
      }

      const requestState = getOrCreateNetworkRequestState(tabId, requestId);
      requestState.requestHeaders = headerEntriesFromHeaders(payload.headers);
      requestState.requestCookies = (payload.associatedCookies ?? [])
        .map((entry) => toAssociatedCookie(entry.cookie, entry.blockedReasons))
        .filter((entry): entry is NetworkAssociatedCookie => entry !== null);
      return;
    }

    case "Network.responseReceived": {
      const payload = params as CdpResponseReceivedParams;
      const requestId = payload.requestId;
      const status = payload.response?.status;

      if (!requestId || typeof status !== "number") {
        return;
      }

      const requestState = getNetworkRequests(tabId).get(requestId);

      if (requestState) {
        applyResponseMetadata(requestState, payload.response);
        requestState.subtype = deriveNetworkSubtype(payload.type);
      }
      return;
    }

    case "Network.responseReceivedExtraInfo": {
      const payload = params as CdpResponseReceivedExtraInfoParams;
      const requestId = payload.requestId;

      if (!requestId) {
        return;
      }

      const requestState = getOrCreateNetworkRequestState(tabId, requestId);
      const responseHeaders = headerEntriesFromHeaders(payload.headers, payload.headersText);

      requestState.responseHeaders = responseHeaders;
      requestState.responseSetCookieHeaders = setCookieHeadersFromEntries(responseHeaders);
      requestState.responseSetCookies = requestState.responseSetCookieHeaders.map(parseSetCookieHeader);
      return;
    }

    case "Network.loadingFinished": {
      const payload = params as CdpLoadingFinishedParams;
      const requestId = payload.requestId;

      if (!requestId) {
        return;
      }

      const requestState = getNetworkRequests(tabId).get(requestId);

      if (!requestState) {
        return;
      }

      if (!requestState.hasBaseRequest) {
        getNetworkRequests(tabId).delete(requestId);
        return;
      }

      const { requestBody, responseBody } = await captureNetworkBodies(tabId, requestId, requestState, true);
      getNetworkRequests(tabId).delete(requestId);
      await saveDraft(
        appendDraftEvent(
          currentDraft,
          buildNetworkEventPayload({
            requestState,
            requestId,
            durationMs: Date.now() - requestState.startedAtMs,
            ...(requestBody ? { requestBody } : {}),
            ...(responseBody ? { responseBody } : {})
          })
        )
      );
      return;
    }

    case "Network.loadingFailed": {
      const payload = params as CdpLoadingFailedParams;
      const requestId = payload.requestId;

      if (!requestId) {
        return;
      }

      const requestState = getNetworkRequests(tabId).get(requestId);
      getNetworkRequests(tabId).delete(requestId);

      if (!requestState) {
        return;
      }

      if (!requestState.hasBaseRequest) {
        return;
      }

      requestState.failureText = payload.errorText || `Network request failed for ${requestState.url}`;
      const { requestBody, responseBody } = await captureNetworkBodies(tabId, requestId, requestState, false);
      const failedDraft = appendDraftEvent(
        currentDraft,
        buildNetworkEventPayload({
          requestState,
          requestId,
          durationMs: Date.now() - requestState.startedAtMs,
          ...(requestBody ? { requestBody } : {}),
          ...(responseBody ? { responseBody } : {})
        })
      );

      await saveDraft(
        appendDraftEvent(failedDraft, {
          kind: "error",
          message: requestState.failureText,
          source: "runtime"
        })
      );
      return;
    }

    case "Runtime.consoleAPICalled": {
      const payload = params as CdpConsoleCalledParams;

      await saveDraft(
        appendDraftEvent(currentDraft, {
          kind: "console",
          level: toConsoleLevel(payload.type),
          message: sanitizeCapturedText(stringifyConsoleArgs(payload.args).join(" ").trim()),
          args: []
        })
      );
      return;
    }

    case "Runtime.exceptionThrown": {
      const payload = params as CdpExceptionThrownParams;
      const details = payload.exceptionDetails;

      if (!details) {
        return;
      }

      const message = [
        details.text,
        details.url ? `(${details.url}:${(details.lineNumber ?? 0) + 1}:${(details.columnNumber ?? 0) + 1})` : undefined
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join(" ");

      await saveDraft(
        appendDraftEvent(currentDraft, {
          kind: "error",
          message: sanitizeCapturedText(message || details.exception?.description || "Runtime exception thrown."),
          source: "runtime"
        })
      );
      return;
    }
  }
}

async function handleDebuggerDetach(
  source: chrome.debugger.Debuggee,
  reason: string
): Promise<void> {
  const tabId = source.tabId;

  if (typeof tabId !== "number") {
    return;
  }

  networkRequestsByTab.delete(tabId);

  if (stoppingTabIds.has(tabId)) {
    return;
  }

  const draft = await readDraft();

  if (!draft || draft.page.tabId !== tabId || draft.phase !== "recording") {
    return;
  }

  if (getPendingRecovery(tabId)) {
    return;
  }

  const tab = await getTabIfPresent(tabId);

  if (!tab) {
    await stopRecordingSession("Captured tab closed; exported the partial session.");
    return;
  }

  if (!shouldAttemptDetachRecovery(tab)) {
    await stopRecordingSession(
      `Stopped recording and exported the partial session because the Chrome debugger detached unexpectedly: ${reason}.`
    );
    return;
  }

  markPendingRecovery(tabId, reason);
  schedulePendingRecoveryAlarm(getPendingRecovery(tabId));
  await saveDraft(
    appendDraftEvent(draft, {
      kind: "lifecycle",
      phase: "recording",
      detail: `Debugger detached unexpectedly (${reason}); waiting for the tab to finish loading so capture can reconnect.`
    })
  );
}

function markPendingRecovery(tabId: number, detachReason: string): void {
  activeRecoveryState = {
    tabId,
    startedAt: new Date().toISOString(),
    detachReason
  };
}

function getPendingRecovery(tabId: number): PendingRecoveryState | null {
  if (!activeRecoveryState || activeRecoveryState.tabId !== tabId) {
    return null;
  }

  return activeRecoveryState;
}

function clearPendingRecovery(tabId?: number): void {
  if (!activeRecoveryState) {
    return;
  }

  if (tabId !== undefined && activeRecoveryState.tabId !== tabId) {
    return;
  }

  activeRecoveryState = null;
}

function getPendingRecoveryAlarmName(tabId: number): string {
  return `${pendingRecoveryAlarmPrefix}${tabId}`;
}

function getPendingRecoveryExpiryMs(recovery: PendingRecoveryState): number {
  const startedAtMs = Date.parse(recovery.startedAt);

  if (!Number.isFinite(startedAtMs)) {
    return Number.NEGATIVE_INFINITY;
  }

  return startedAtMs + pendingRecoveryTimeoutMs;
}

function isPendingRecoveryExpired(recovery: PendingRecoveryState, nowMs: number = Date.now()): boolean {
  return getPendingRecoveryExpiryMs(recovery) <= nowMs;
}

function schedulePendingRecoveryAlarm(recovery: PendingRecoveryState | null): void {
  if (!recovery) {
    return;
  }

  chrome.alarms.create(getPendingRecoveryAlarmName(recovery.tabId), {
    when: Math.max(Date.now() + 1, getPendingRecoveryExpiryMs(recovery))
  });
}

function scheduleMaxRecordingDurationAlarm(): void {
  chrome.alarms.create(maxRecordingDurationAlarmName, {
    when: Date.now() + maxRecordingDurationMs
  });
}

async function clearPendingRecoveryAlarm(tabId: number): Promise<void> {
  try {
    await chrome.alarms.clear(getPendingRecoveryAlarmName(tabId));
  } catch (error: unknown) {
    console.warn(errorMessage(error));
  }
}

async function clearMaxRecordingDurationAlarm(): Promise<void> {
  try {
    await chrome.alarms.clear(maxRecordingDurationAlarmName);
  } catch (error: unknown) {
    console.warn(errorMessage(error));
  }
}

async function handleAlarm(alarmName: string): Promise<void> {
  if (alarmName === maxRecordingDurationAlarmName) {
    await handleMaxRecordingDurationAlarm();
    return;
  }

  await handlePendingRecoveryAlarm(alarmName);
}

async function handleMaxRecordingDurationAlarm(): Promise<void> {
  const draft = await readDraft();

  if (!draft || (draft.phase !== "armed" && draft.phase !== "recording")) {
    await clearMaxRecordingDurationAlarm();
    return;
  }

  await stopRecordingSession("Stopped recording automatically after reaching the 5-minute limit.");
}

async function handlePendingRecoveryAlarm(alarmName: string): Promise<void> {
  if (!alarmName.startsWith(pendingRecoveryAlarmPrefix)) {
    return;
  }

  const tabId = Number.parseInt(alarmName.slice(pendingRecoveryAlarmPrefix.length), 10);

  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  const draft = await readDraft();
  const pendingRecovery = getPendingRecovery(tabId);

  if (!draft || draft.page.tabId !== tabId || !pendingRecovery) {
    await clearPendingRecoveryAlarm(tabId);
    return;
  }

  if (isPendingRecoveryExpired(pendingRecovery)) {
    await stopRecordingSession(recoveryTimeoutDetail());
    return;
  }

  const tab = await getTabIfPresent(tabId);

  if (!tab) {
    await stopRecordingSession("Captured tab closed; exported the partial session.");
    return;
  }

  if (tab.status === "complete") {
    await handleCompletedTabUpdate(tabId);
    return;
  }

  if (shouldAttemptDetachRecovery(tab)) {
    schedulePendingRecoveryAlarm(pendingRecovery);
    return;
  }

  await stopRecordingSession(recoveryTimeoutDetail());
}

function recoveryTimeoutDetail(): string {
  return "Stopped recording and exported the partial session because capture could not reconnect before the recovery timeout.";
}

async function getTabIfPresent(tabId: number): Promise<chrome.tabs.Tab | null> {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function shouldAttemptDetachRecovery(tab: chrome.tabs.Tab): boolean {
  return tab.status === "loading";
}

async function ensureContentBridge(
  tabId: number,
  sessionId: string,
  options: { injectNetworkProbe?: boolean } = {}
): Promise<void> {
  const injectNetworkProbe = options.injectNetworkProbe ?? false;
  console.debug("[jittle-lamp] Ensuring content bridge.", { tabId, sessionId });
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "jl/content-begin-capture",
      sessionId
    });
    if (injectNetworkProbe) {
      await ensureNetworkProbe(tabId);
    }
    return;
  } catch (error: unknown) {
    const message = rawErrorMessage(error);

    if (!message.includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  if (injectNetworkProbe) {
    await ensureNetworkProbe(tabId);
  }

  await chrome.tabs.sendMessage(tabId, {
    type: "jl/content-begin-capture",
    sessionId
  });
}

async function ensureWidgetBridge(tabId: number): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "jl/content-widget-ping"
    });
    return;
  } catch (error: unknown) {
    const message = rawErrorMessage(error);

    if (!message.includes("Receiving end does not exist")) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

async function ensureNetworkProbe(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["network-probe.js"]
    });
  } catch (error: unknown) {
    console.warn("[jittle-lamp] Unable to inject page network probe.", errorMessage(error));
  }
}

async function signalContentCaptureEnded(tabId: number, sessionId: string): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "jl/content-end-capture",
      sessionId
    });
  } catch (error: unknown) {
    const message = errorMessage(error);

    if (!message.includes("Receiving end does not exist")) {
      console.warn(message);
    }
  }
}

async function attachDebugger(
  tabId: number,
  options: { canUseWebRequestFallback?: boolean } = {}
): Promise<boolean> {
  const debuggerApi = getDebuggerApi();

  if (!debuggerApi) {
    setWebRequestFallback(tabId, options.canUseWebRequestFallback ?? true);
    return false;
  }

  const debuggee = { tabId };

  try {
    await debuggerApi.attach(debuggee, debuggerProtocolVersion);
    await debuggerApi.sendCommand(debuggee, "Network.enable");
    await debuggerApi.sendCommand(debuggee, "Runtime.enable");
    await debuggerApi.sendCommand(debuggee, "Page.enable");
    webRequestFallbackTabIds.delete(tabId);
    return true;
  } catch (error: unknown) {
    if (!isCrossExtensionAccessError(error)) {
      throw error;
    }

    console.warn("[jittle-lamp] Continuing without debugger capture.", {
      tabId,
      reason: rawErrorMessage(error)
    });
    await safeDetachDebugger(tabId);
    setWebRequestFallback(tabId, options.canUseWebRequestFallback ?? true);
    return false;
  }
}

async function safeDetachDebugger(tabId: number): Promise<void> {
  const debuggerApi = getDebuggerApi();

  if (!debuggerApi) {
    return;
  }

  try {
    await debuggerApi.detach({ tabId });
  } catch (error: unknown) {
    const message = rawErrorMessage(error);

    if (
      !message.includes("Detached while handling command") &&
      !message.includes("No target with given id") &&
      !message.includes("Debugger is not attached")
    ) {
      console.warn(message);
    }
  }
}

function getDebuggerApi(): typeof chrome.debugger | undefined {
  const candidate = chrome.debugger;

  if (
    !candidate ||
    typeof candidate.attach !== "function" ||
    typeof candidate.detach !== "function" ||
    typeof candidate.sendCommand !== "function" ||
    !candidate.onEvent ||
    !candidate.onDetach
  ) {
    return undefined;
  }

  return candidate;
}

function setWebRequestFallback(tabId: number, enabled: boolean): void {
  if (enabled) {
    webRequestFallbackTabIds.add(tabId);
  } else {
    webRequestFallbackTabIds.delete(tabId);
  }
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: offscreenDocumentPath,
        reasons: ["USER_MEDIA", "BLOBS"],
        justification: "Record the active tab and export the local session bundle."
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }

  await offscreenCreationPromise;
}

async function closeOffscreenDocumentIfPresent(): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error: unknown) {
    console.warn(errorMessage(error));
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  const serviceWorker = globalThis as typeof globalThis & {
    clients: {
      matchAll: () => Promise<Array<{ url: string }>>;
    };
  };
  const allClients = await serviceWorker.clients.matchAll();
  const offscreenUrl = chrome.runtime.getURL(offscreenDocumentPath);

  return allClients.some((client) => client.url === offscreenUrl);
}

async function getActiveTab(): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const httpCandidates = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
    url: ["http://*/*", "https://*/*"]
  });
  const httpFallbacks = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["http://*/*", "https://*/*"]
  });
  const candidateTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const fallbackTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = [...httpCandidates, ...httpFallbacks].find((tab) => Boolean(tab?.id && tab.url));
  console.debug("[jittle-lamp] Active tab lookup candidates.", {
    lastFocusedWindowHttpTabs: httpCandidates.map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })),
    currentWindowHttpTabs: httpFallbacks.map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })),
    lastFocusedWindowTabs: candidateTabs.map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })),
    currentWindowTabs: fallbackTabs.map((tab) => ({ id: tab.id, url: tab.url, windowId: tab.windowId })),
    selectedTab: activeTab ? { id: activeTab.id, url: activeTab.url, windowId: activeTab.windowId } : null
  });

  if (!activeTab?.id || !activeTab.url) {
    const firstNonHttpTab = [...candidateTabs, ...fallbackTabs].find((tab) => Boolean(tab?.id && tab.url));
    if (firstNonHttpTab?.url) {
      console.warn("[jittle-lamp] Recording startup blocked because active tab is not http(s).", {
        tabId: firstNonHttpTab.id,
        url: firstNonHttpTab.url
      });
      const createdTab = await chrome.tabs.create({ url: "about:blank", active: true });

      if (createdTab.id && createdTab.url && isRecordableStartupUrl(createdTab.url)) {
        console.info("[jittle-lamp] Created a fresh recordable fallback tab.", {
          tabId: createdTab.id,
          url: createdTab.url
        });
        return createdTab as chrome.tabs.Tab & { id: number; url: string };
      }

      throw new Error("jittle-lamp V1 only records active http(s) tabs.");
    }

    console.warn("[jittle-lamp] No active tab with URL found for recording startup.");
    throw new Error("Open an http(s) page before starting jittle-lamp.");
  }

  console.info("[jittle-lamp] Using active tab for recording.", {
    tabId: activeTab.id,
    url: activeTab.url
  });
  return activeTab as chrome.tabs.Tab & { id: number; url: string };
}

async function resolveRecordingTab(
  targetTabId?: number,
  targetPage?: RecordingPageOverride
): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  if (typeof targetTabId !== "number") {
    return getActiveTab();
  }

  return ensureRecordableTab(targetTabId, "from extension recorder window", targetPage);
}

async function ensureRecordableTab(
  tabId: number,
  stage: string,
  fallbackPage?: RecordingPageOverride
): Promise<chrome.tabs.Tab & { id: number; url: string }> {
  const tab = await getTabIfPresent(tabId);
  const fallbackUrl = fallbackPage?.url;

  if (!tab?.id || (!tab.url && !fallbackUrl)) {
    throw new Error(`Recording startup could not find the selected tab (${stage}).`);
  }

  const url = tab.url ?? fallbackUrl;

  if (!url || !isRecordableStartupUrl(url)) {
    console.warn("[jittle-lamp] Recording startup blocked because tab became non-http(s).", {
      stage,
      tabId,
      url
    });
    throw new Error(
      `Recording tab changed to a non-web page before startup completed (${stage}): ${url}`
    );
  }

  return {
    ...tab,
    id: tab.id,
    title: tab.title ?? fallbackPage?.title,
    url
  } as chrome.tabs.Tab & { id: number; url: string };
}

function getNetworkRequests(tabId: number): Map<string, NetworkRequestState> {
  const existing = networkRequestsByTab.get(tabId);

  if (existing) {
    return existing;
  }

  const created = new Map<string, NetworkRequestState>();
  networkRequestsByTab.set(tabId, created);
  return created;
}

function getOrCreateNetworkRequestState(tabId: number, requestId: string): NetworkRequestState {
  const requests = getNetworkRequests(tabId);
  const existing = requests.get(requestId);

  if (existing) {
    return existing;
  }

  const created = createNetworkRequestState();

  requests.set(requestId, created);
  return created;
}

function createNetworkRequestState(seed?: Pick<NetworkRequestState, "requestHeaders" | "requestCookies">): NetworkRequestState {
  return {
    method: "UNKNOWN",
    url: "https://invalid.jittle-lamp.local/unknown",
    startedAtMs: Date.now(),
    ...(seed?.requestHeaders ? { requestHeaders: seed.requestHeaders } : {}),
    ...(seed?.requestCookies ? { requestCookies: seed.requestCookies } : {})
  };
}

function applyResponseMetadata(requestState: NetworkRequestState, response?: CdpResponseMetadata): void {
  if (!response) {
    return;
  }

  const responseHeaders = headerEntriesFromHeaders(response.headers);

  if (typeof response.status === "number") {
    requestState.status = response.status;
  }

  if (response.statusText) {
    requestState.statusText = response.statusText;
  }

  if (response.mimeType) {
    requestState.responseMimeType = response.mimeType;
  }

  if (!requestState.responseHeaders?.length) {
    requestState.responseHeaders = responseHeaders;
  }

  if (!requestState.responseSetCookieHeaders?.length) {
    const setCookieHeaders = setCookieHeadersFromEntries(requestState.responseHeaders ?? responseHeaders);

    if (setCookieHeaders.length > 0) {
      requestState.responseSetCookieHeaders = setCookieHeaders;
      requestState.responseSetCookies = setCookieHeaders.map(parseSetCookieHeader);
    }
  }
}

function buildNetworkEventPayload(input: {
  requestState: NetworkRequestState;
  requestId: string;
  durationMs: number;
  requestBody?: NetworkBodyCapture | undefined;
  responseBody?: NetworkBodyCapture | undefined;
}) {
  const { requestState, requestId, durationMs, requestBody, responseBody } = input;

  return {
    kind: "network" as const,
    method: requestState.method,
    url: requestState.url,
    ...(requestState.subtype ? { subtype: requestState.subtype } : {}),
    ...(typeof requestState.status === "number" ? { status: requestState.status } : {}),
    ...(requestState.statusText ? { statusText: requestState.statusText } : {}),
    durationMs,
    requestId,
    request: {
      headers: requestState.requestHeaders ?? [],
      cookies: requestState.requestCookies ?? [],
      ...(requestBody ? { body: requestBody } : {})
    },
    ...(hasResponseState(requestState, responseBody)
      ? {
          response: {
            headers: requestState.responseHeaders ?? [],
            setCookieHeaders: requestState.responseSetCookieHeaders ?? [],
            setCookies: requestState.responseSetCookies ?? [],
            ...(responseBody ? { body: responseBody } : {})
          }
        }
      : {}),
    ...(requestState.failureText ? { failureText: requestState.failureText } : {})
  };
}

function deriveNetworkSubtype(resourceType: string | undefined): NetworkSubtype {
  switch ((resourceType ?? "").toLowerCase()) {
    case "xhr":
      return "xhr";
    case "fetch":
      return "fetch";
    case "document":
      return "document";
    case "stylesheet":
      return "stylesheet";
    case "script":
      return "script";
    case "image":
      return "image";
    case "font":
      return "font";
    case "media":
      return "media";
    case "websocket":
      return "websocket";
    default:
      return "other";
  }
}

async function captureNetworkBodies(
  tabId: number,
  requestId: string,
  requestState: NetworkRequestState,
  canCaptureResponseBody: boolean
): Promise<{
  requestBody?: NetworkBodyCapture;
  responseBody?: NetworkBodyCapture;
}> {
  const [requestBody, responseBody] = await Promise.all([
    captureRequestBody(tabId, requestId, requestState),
    captureResponseBody(tabId, requestId, requestState, canCaptureResponseBody)
  ]);

  return {
    ...(requestBody ? { requestBody } : {}),
    ...(responseBody ? { responseBody } : {})
  };
}

async function captureRequestBody(
  tabId: number,
  requestId: string,
  requestState: NetworkRequestState
): Promise<NetworkBodyCapture | undefined> {
  if (!shouldAttemptRequestBodyCapture(requestState)) {
    return undefined;
  }

  try {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getRequestPostData",
      { requestId }
    )) as CdpRequestPostDataResult;
    const postData = result.postData ?? "";

    return createUtf8BodyCapture(postData, contentTypeFromHeaders(requestState.requestHeaders));
  } catch (error: unknown) {
    const message = errorMessage(error);
    const mimeType = contentTypeFromHeaders(requestState.requestHeaders);

    return {
      disposition: isMissingRequestPostDataError(message) ? "omitted" : "unavailable",
      ...(mimeType ? { mimeType } : {}),
      reason: isMissingRequestPostDataError(message)
        ? "Request did not expose post data through CDP."
        : message
    };
  }
}

async function captureResponseBody(
  tabId: number,
  requestId: string,
  requestState: NetworkRequestState,
  canCaptureResponseBody: boolean
): Promise<NetworkBodyCapture | undefined> {
  if (!hasResponseState(requestState)) {
    return undefined;
  }

  if (!canCaptureResponseBody) {
    const mimeType = requestState.responseMimeType;

    return {
      disposition: "unavailable",
      ...(mimeType ? { mimeType } : {}),
      reason: "Response body capture requires a completed Network.loadingFinished event."
    };
  }

  if (!responseMayHaveBody(requestState)) {
    const mimeType = requestState.responseMimeType;

    return {
      disposition: "omitted",
      ...(mimeType ? { mimeType } : {}),
      reason: "Response does not carry a body for this request."
    };
  }

  const declaredLength = declaredBodyLength(requestState.responseHeaders);

  if (declaredLength !== undefined && declaredLength > networkBodyFetchByteLimit) {
    const mimeType = requestState.responseMimeType;

    return {
      disposition: "omitted",
      ...(mimeType ? { mimeType } : {}),
      byteLength: declaredLength,
      omittedByteLength: declaredLength,
      reason: `Response body exceeded the ${networkBodyFetchByteLimit}-byte capture ceiling.`
    };
  }

  try {
    const result = (await chrome.debugger.sendCommand(
      { tabId },
      "Network.getResponseBody",
      { requestId }
    )) as CdpResponseBodyResult;

    return createBodyCapture({
      value: result.body ?? "",
      base64Encoded: result.base64Encoded ?? false,
      ...(requestState.responseMimeType ? { mimeType: requestState.responseMimeType } : {})
    });
  } catch (error: unknown) {
    const mimeType = requestState.responseMimeType;

    return {
      disposition: "unavailable",
      ...(mimeType ? { mimeType } : {}),
      reason: errorMessage(error)
    };
  }
}

function shouldAttemptRequestBodyCapture(requestState: NetworkRequestState): boolean {
  if (requestState.requestHasPostData) {
    return true;
  }

  switch (requestState.method.toUpperCase()) {
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return true;

    default:
      return false;
  }
}

function createUtf8BodyCapture(value: string, mimeType?: string): NetworkBodyCapture {
  return createBodyCapture({
    value,
    base64Encoded: false,
    ...(mimeType ? { mimeType } : {})
  });
}

function createBodyCapture(input: {
  value: string;
  base64Encoded: boolean;
  mimeType?: string;
}): NetworkBodyCapture {
  if (input.base64Encoded) {
    const rawValue = input.value;
    const byteLength = estimateBase64ByteLength(rawValue);
    const maxBase64Length = Math.floor(networkBodyCaptureByteLimit / 3) * 4;

    if (byteLength <= networkBodyCaptureByteLimit || maxBase64Length <= 0) {
      return {
        disposition: "captured",
        encoding: "base64",
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        value: rawValue,
        byteLength
      };
    }

    const truncatedValue = rawValue.slice(0, maxBase64Length - (maxBase64Length % 4));
    const capturedByteLength = estimateBase64ByteLength(truncatedValue);

    return {
      disposition: "truncated",
      encoding: "base64",
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      value: truncatedValue,
      byteLength,
      omittedByteLength: Math.max(0, byteLength - capturedByteLength),
      reason: `Body exceeded ${networkBodyCaptureByteLimit} bytes and was truncated locally.`
    };
  }

  const encoder = new TextEncoder();
  const encoded = encoder.encode(input.value);

  if (encoded.length <= networkBodyCaptureByteLimit) {
    return {
      disposition: "captured",
      encoding: "utf8",
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      value: input.value,
      byteLength: encoded.length
    };
  }

  const truncatedValue = new TextDecoder().decode(encoded.slice(0, networkBodyCaptureByteLimit));
  const truncatedByteLength = encoder.encode(truncatedValue).length;

  return {
    disposition: "truncated",
    encoding: "utf8",
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    value: truncatedValue,
    byteLength: encoded.length,
    omittedByteLength: Math.max(0, encoded.length - truncatedByteLength),
    reason: `Body exceeded ${networkBodyCaptureByteLimit} bytes and was truncated locally.`
  };
}

function estimateBase64ByteLength(value: string): number {
  const normalized = value.replace(/\s+/g, "");

  if (normalized.length === 0) {
    return 0;
  }

  const paddingLength = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - paddingLength);
}

function isMissingRequestPostDataError(message: string): boolean {
  return message.includes("No post data") || message.includes("does not have post data");
}

function responseMayHaveBody(requestState: NetworkRequestState): boolean {
  const status = requestState.status;

  if (status === undefined) {
    return true;
  }

  if (requestState.method.toUpperCase() === "HEAD") {
    return false;
  }

  return status !== 101 && status !== 204 && status !== 205 && status !== 304;
}

function hasResponseState(
  requestState: NetworkRequestState,
  responseBody?: NetworkBodyCapture
): boolean {
  return Boolean(
    responseBody ||
      requestState.status !== undefined ||
      requestState.statusText ||
      requestState.responseHeaders?.length ||
      requestState.responseSetCookieHeaders?.length ||
      requestState.responseSetCookies?.length ||
      requestState.responseMimeType
  );
}

function declaredBodyLength(headers: NetworkHeaderEntry[] | undefined): number | undefined {
  const contentLength = headerValue(headers, "content-length");

  if (!contentLength) {
    return undefined;
  }

  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function contentTypeFromHeaders(headers: NetworkHeaderEntry[] | undefined): string | undefined {
  return headerValue(headers, "content-type") || undefined;
}

function headerValue(headers: NetworkHeaderEntry[] | undefined, name: string): string | undefined {
  return headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;
}

function headerEntriesFromHeaders(headers?: CdpHeaders, headersText?: string): NetworkHeaderEntry[] {
  const rawEntries = typeof headersText === "string" ? parseHeaderText(headersText) : [];

  if (rawEntries.length > 0) {
    return rawEntries;
  }

  return Object.entries(headers ?? {}).flatMap(([name, value]) => headerEntriesFromValue(name, value));
}

function parseHeaderText(headersText: string): NetworkHeaderEntry[] {
  const lines = headersText.split(/\r?\n/);
  const headerLines = lines[0]?.includes(":") ? lines : lines.slice(1);

  return headerLines
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const separatorIndex = line.indexOf(":");

      if (separatorIndex <= 0) {
        return [];
      }

      return [
        {
          name: line.slice(0, separatorIndex).trim(),
          value: line.slice(separatorIndex + 1).trim()
        }
      ];
    });
}

function headerEntriesFromValue(name: string, value: unknown): NetworkHeaderEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => headerEntriesFromValue(name, entry));
  }

  if (typeof value === "string") {
    return value.split(/\r?\n/).filter(Boolean).map((entry) => ({ name, value: entry }));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return [{ name, value: String(value) }];
  }

  if (value === undefined || value === null) {
    return [];
  }

  return [{ name, value: JSON.stringify(value) }];
}

function setCookieHeadersFromEntries(headers: NetworkHeaderEntry[]): string[] {
  return headers.filter((entry) => entry.name.toLowerCase() === "set-cookie").map((entry) => entry.value);
}

function parseSetCookieHeader(header: string): NetworkSetCookie {
  const segments = header.split(";").map((segment) => segment.trim()).filter(Boolean);
  const [nameValue = "", ...attributes] = segments;
  const separatorIndex = nameValue.indexOf("=");
  const name = separatorIndex >= 0 ? nameValue.slice(0, separatorIndex).trim() : nameValue.trim();
  const value = separatorIndex >= 0 ? nameValue.slice(separatorIndex + 1).trim() : "";
  const cookie: NetworkSetCookie = {
    raw: header,
    name: name || "set-cookie",
    value
  };

  for (const attribute of attributes) {
    const attributeSeparator = attribute.indexOf("=");
    const attributeName = (attributeSeparator >= 0 ? attribute.slice(0, attributeSeparator) : attribute)
      .trim()
      .toLowerCase();
    const attributeValue = attributeSeparator >= 0 ? attribute.slice(attributeSeparator + 1).trim() : "";

    switch (attributeName) {
      case "domain":
        cookie.domain = attributeValue;
        break;

      case "path":
        cookie.path = attributeValue;
        break;

      case "expires": {
        const expires = Date.parse(attributeValue);

        if (Number.isFinite(expires)) {
          cookie.expires = expires;
        }
        break;
      }

      case "httponly":
        cookie.httpOnly = true;
        break;

      case "secure":
        cookie.secure = true;
        break;

      case "samesite":
        cookie.sameSite = attributeValue;
        break;

      case "priority":
        cookie.priority = attributeValue;
        break;

      case "partitioned":
        cookie.partitioned = true;
        break;
    }
  }

  cookie.session = cookie.expires === undefined;
  return cookie;
}

function toAssociatedCookie(cookie: CdpCookie | undefined, blockedReasons?: string[]): NetworkAssociatedCookie | null {
  const normalizedCookie = toNetworkCookie(cookie);

  if (!normalizedCookie) {
    return null;
  }

  return {
    cookie: normalizedCookie,
    blockedReasons: (blockedReasons ?? []).filter((reason): reason is string => typeof reason === "string")
  };
}

function toNetworkCookie(cookie: CdpCookie | undefined): NetworkCookie | null {
  if (!cookie?.name) {
    return null;
  }

  return {
    name: cookie.name,
    value: cookie.value ?? "",
    ...(cookie.domain ? { domain: cookie.domain } : {}),
    ...(cookie.path ? { path: cookie.path } : {}),
    ...(typeof cookie.expires === "number" ? { expires: cookie.expires } : {}),
    ...(typeof cookie.size === "number" ? { size: cookie.size } : {}),
    ...(typeof cookie.httpOnly === "boolean" ? { httpOnly: cookie.httpOnly } : {}),
    ...(typeof cookie.secure === "boolean" ? { secure: cookie.secure } : {}),
    ...(typeof cookie.session === "boolean" ? { session: cookie.session } : {}),
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.priority ? { priority: cookie.priority } : {}),
    ...(typeof cookie.sameParty === "boolean" ? { sameParty: cookie.sameParty } : {}),
    ...(typeof cookie.sourcePort === "number" ? { sourcePort: cookie.sourcePort } : {}),
    ...(cookie.sourceScheme ? { sourceScheme: cookie.sourceScheme } : {}),
    ...(typeof cookie.partitionKey === "string" ? { partitionKey: cookie.partitionKey } : {}),
    ...(typeof cookie.partitioned === "boolean" ? { partitioned: cookie.partitioned } : {})
  };
}

async function getTabMediaStreamId(tabId: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId(
      {
        targetTabId: tabId
      },
      (streamId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!streamId) {
          reject(new Error("Chrome did not return a tab capture stream identifier."));
          return;
        }

        resolve(streamId);
      }
    );
  });
}

async function readDraft(): Promise<CaptureSessionDraft | null> {
  if (activeDraftCache) {
    return failStaleProcessingDraftIfNeeded(activeDraftCache);
  }

  const stored = await chrome.storage.local.get([sessionStorageKey, sessionStorageMetaKey]);
  let rawDraft = stored[sessionStorageKey];
  let meta = parseSessionStorageMeta(stored[sessionStorageMetaKey]);
  let shouldMigrateSessionDraft = false;

  if (!rawDraft) {
    const legacyStored = await chrome.storage.session.get([sessionStorageKey, sessionStorageMetaKey]);
    rawDraft = legacyStored[sessionStorageKey];
    meta = parseSessionStorageMeta(legacyStored[sessionStorageMetaKey]);
    shouldMigrateSessionDraft = Boolean(rawDraft);
  }

  activeRecoveryState = meta.recovery ?? null;

  if (!rawDraft) {
    return null;
  }

  const parsed = captureSessionDraftSchema.safeParse(rawDraft);

  if (!parsed.success) {
    await clearDraft();
    return null;
  }

  activeDraftCache = parsed.data;
  activeDraftEventCount =
    typeof meta.eventCount === "number"
      ? Math.max(meta.eventCount, parsed.data.events.length)
      : parsed.data.events.length;

  activeDraftCache = await failStaleProcessingDraftIfNeeded(activeDraftCache);

  if (shouldMigrateSessionDraft) {
    await saveDraft(activeDraftCache);
    await chrome.storage.session.remove([sessionStorageKey, sessionStorageMetaKey]);
  }

  if (meta.recovery && typeof parsed.data.page.tabId === "number") {
    schedulePendingRecoveryCheck(parsed.data.page.tabId);
  }

  return activeDraftCache;
}

async function failStaleProcessingDraftIfNeeded(draft: CaptureSessionDraft): Promise<CaptureSessionDraft> {
  if (!isStaleProcessingDraft(draft)) {
    return draft;
  }

  const staleDraft = transitionDraftPhase(
    draft,
    "failed",
    "Previous upload did not complete. Start a new recording or retry upload from the failed status."
  );
  await saveDraft(staleDraft);
  return staleDraft;
}

async function saveDraft(draft: CaptureSessionDraft): Promise<void> {
  activeDraftCache = draft;
  activeDraftEventCount = draft.events.length;

  const checkpoint = createDraftStorageCheckpoint(draft);

  try {
    await chrome.storage.local.set({
      [sessionStorageKey]: checkpoint,
      [sessionStorageMetaKey]: {
        eventCount: draft.events.length,
        ...(activeRecoveryState ? { recovery: activeRecoveryState } : {})
      } satisfies SessionStorageMeta
    });
  } catch (error: unknown) {
    console.warn(`Unable to checkpoint active session in local storage: ${errorMessage(error)}`);
  }
}

async function clearDraft(): Promise<void> {
  const recoveryTabId = activeRecoveryState?.tabId;
  activeDraftCache = null;
  activeDraftEventCount = 0;
  activeRecoveryState = null;
  pendingRecoveryCheckScheduled = false;

  if (typeof recoveryTabId === "number") {
    await clearPendingRecoveryAlarm(recoveryTabId);
  }

  await Promise.all([
    chrome.storage.local.remove([sessionStorageKey, sessionStorageMetaKey]),
    chrome.storage.session.remove([sessionStorageKey, sessionStorageMetaKey])
  ]);
}

function schedulePendingRecoveryCheck(tabId: number): void {
  if (pendingRecoveryCheckScheduled) {
    return;
  }

  pendingRecoveryCheckScheduled = true;
  queueMicrotask(() => {
    pendingRecoveryCheckScheduled = false;
    void queueDraftMutation(async () => {
      const draft = await readDraft();

      if (!draft || draft.page.tabId !== tabId || !getPendingRecovery(tabId)) {
        return;
      }

      const tab = await getTabIfPresent(tabId);
      const pendingRecovery = getPendingRecovery(tabId);

      if (!pendingRecovery) {
        return;
      }

      if (isPendingRecoveryExpired(pendingRecovery)) {
        await stopRecordingSession(recoveryTimeoutDetail());
        return;
      }

      if (!tab) {
        await stopRecordingSession("Captured tab closed; exported the partial session.");
        return;
      }

      if (tab.status === "complete") {
        await handleCompletedTabUpdate(tabId);
        return;
      }

      if (shouldAttemptDetachRecovery(tab)) {
        schedulePendingRecoveryAlarm(pendingRecovery);
        return;
      }

      await stopRecordingSession(recoveryTimeoutDetail());
    });
  });
}

function parseSessionStorageMeta(rawMeta: unknown): SessionStorageMeta {
  if (!rawMeta || typeof rawMeta !== "object") {
    return {};
  }

  const candidate = rawMeta as {
    eventCount?: unknown;
    recovery?: unknown;
  };

  return {
    ...(typeof candidate.eventCount === "number" ? { eventCount: candidate.eventCount } : {}),
    ...(isPendingRecoveryState(candidate.recovery) ? { recovery: candidate.recovery } : {})
  };
}

function isPendingRecoveryState(value: unknown): value is PendingRecoveryState {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    tabId?: unknown;
    startedAt?: unknown;
    detachReason?: unknown;
  };

  return (
    typeof candidate.tabId === "number" &&
    Number.isInteger(candidate.tabId) &&
    candidate.tabId >= 0 &&
    typeof candidate.startedAt === "string" &&
    candidate.startedAt.length > 0 &&
    typeof candidate.detachReason === "string" &&
    candidate.detachReason.length > 0
  );
}

async function buildPopupResponse(ok: boolean, error?: string): Promise<PopupResponse> {
  const [activeSession, companion, cloud] = await Promise.all([
    readDraft(),
    readCompanionState(),
    readCloudAuthState()
  ]);

  return {
    ok,
    state: toPopupState(activeSession, companion, cloud),
    error
  };
}

function toPopupState(
  activeSession: CaptureSessionDraft | null,
  companion: CompanionState,
  cloud: CloudAuthState
): PopupState {
  if (!activeSession) {
    return {
      activeSession: null,
      companion,
      cloud,
      canStart: true,
      canStop: false
    };
  }

  const canStop = activeSession.phase === "armed" || activeSession.phase === "recording";
  const canStart = !isSessionBusy(activeSession);

  return {
    activeSession: toPopupSessionSummary(activeSession),
    companion,
    cloud,
    canStart,
    canStop
  };
}

function toPopupSessionSummary(activeSession: CaptureSessionDraft): PopupSessionSummary {
  return {
    sessionId: activeSession.sessionId,
    name: activeSession.name,
    phase: activeSession.phase,
    createdAt: activeSession.createdAt,
    updatedAt: activeSession.updatedAt,
    page: activeSession.page,
    artifacts: activeSession.artifacts,
    eventCount: activeDraftEventCount || activeSession.events.length,
    ...(deriveSessionStatusText(activeSession)
      ? { statusText: deriveSessionStatusText(activeSession) }
      : {})
  };
}

function deriveSessionStatusText(activeSession: CaptureSessionDraft): string | undefined {
  for (let index = activeSession.events.length - 1; index >= 0; index -= 1) {
    const payload = activeSession.events[index]?.payload;

    if (!payload) {
      continue;
    }

    if (payload.kind === "lifecycle") {
      return payload.detail;
    }

    if (payload.kind === "error") {
      return payload.message;
    }
  }

  return undefined;
}

async function readCompanionState(): Promise<CompanionState> {
  const now = Date.now();

  if (companionStateCache && companionStateCacheExpiresAt > now) {
    return companionStateCache;
  }

  if (companionStateProbePromise) {
    return companionStateProbePromise;
  }

  companionStateProbePromise = probeCompanionState().then((state) => {
    companionStateCache = state;
    companionStateCacheExpiresAt =
      Date.now() + (state.status === "online" ? companionOnlineRefreshMs : companionOfflineRefreshMs);
    return state;
  });

  try {
    return await companionStateProbePromise;
  } finally {
    companionStateProbePromise = null;
  }
}

async function probeCompanionState(): Promise<CompanionState> {
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(`${companionServerOrigin}/health`, {
      signal: AbortSignal.timeout(companionHealthTimeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Desktop companion responded with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      origin?: unknown;
      outputDir?: unknown;
    };

    return companionStateSchema.parse({
      status: "online",
      origin: typeof payload.origin === "string" ? payload.origin : companionServerOrigin,
      ...(typeof payload.outputDir === "string" ? { outputDir: payload.outputDir } : {}),
      checkedAt
    });
  } catch (error: unknown) {
    return companionStateSchema.parse({
      status: "offline",
      origin: companionServerOrigin,
      checkedAt,
      error: errorMessage(error)
    });
  }
}

async function readCloudAuthState(): Promise<CloudAuthState> {
  const checkedAt = new Date().toISOString();

  try {
    let session = await ensureFreshCloudAuthSession();

    if (!session) {
      await resumePendingCloudAuthFlow();
      session = await ensureFreshCloudAuthSession();
    }

    if (!session) {
      return {
        status: "signed-out",
        checkedAt,
        ...(pendingCloudAuthFlow ? { error: "Waiting for browser sign-in" } : {})
      };
    }

    const accountLabel = await readCloudAccountLabel(session.token) ?? session.accountLabel;
    await saveCloudAuthSession({
      token: session.token,
      origin: session.origin,
      ...(accountLabel ? { accountLabel } : {}),
      ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
      ...(session.refreshExpiresAt ? { refreshExpiresAt: session.refreshExpiresAt } : {}),
      expiresAt: normalizeExpirationMs(session.expiresAt) ??
        getJwtExpirationMs(session.token) ??
        Date.now() + 45 * 60 * 1000,
      checkedAt
    });

    return {
      status: "signed-in",
      origin: session.origin,
      ...(accountLabel ? { accountLabel } : {}),
      checkedAt
    };
  } catch (error: unknown) {
    return {
      status: "unknown",
      checkedAt,
      error: errorMessage(error)
    };
  }
}

async function startCloudSignInFlow(): Promise<void> {
  if (pendingCloudAuthFlow && pendingCloudAuthFlow.expiresAt > Date.now()) {
    await chrome.tabs.create({ url: pendingCloudAuthFlow.verificationUriComplete });
    return;
  }

  const response = await fetch(`${configuredCloudApiOrigin}/extension-auth/flows`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Unable to start extension sign-in (${response.status}).`);
  }

  const payload = await response.json() as {
    deviceCode?: unknown;
    verificationUriComplete?: unknown;
    expiresAt?: unknown;
    intervalSeconds?: unknown;
  };

  if (
    typeof payload.deviceCode !== "string" ||
    typeof payload.verificationUriComplete !== "string" ||
    typeof payload.expiresAt !== "number"
  ) {
    throw new Error("Extension sign-in response was invalid.");
  }

  pendingCloudAuthFlow = {
    deviceCode: payload.deviceCode,
    verificationUriComplete: payload.verificationUriComplete,
    expiresAt: payload.expiresAt,
    intervalSeconds: typeof payload.intervalSeconds === "number" ? payload.intervalSeconds : 5,
    startedAt: new Date().toISOString()
  };

  await savePendingCloudAuthFlow(pendingCloudAuthFlow);
  await chrome.tabs.create({ url: payload.verificationUriComplete });
  void pollCloudSignInFlow(pendingCloudAuthFlow);
}

async function resumePendingCloudAuthFlow(): Promise<void> {
  if (pendingCloudAuthFlow) {
    await pollCloudSignInFlow(pendingCloudAuthFlow, { scheduleNext: false });
    return;
  }

  const stored = await readPendingCloudAuthFlow();

  if (!stored) {
    return;
  }

  pendingCloudAuthFlow = stored;
  await pollCloudSignInFlow(stored, { scheduleNext: false });
}

async function pollCloudSignInFlow(
  flow: PendingCloudAuthFlow,
  options: { scheduleNext?: boolean } = {}
): Promise<void> {
  const scheduleNext = options.scheduleNext ?? true;

  if (flow.expiresAt <= Date.now()) {
    if (pendingCloudAuthFlow?.deviceCode === flow.deviceCode) {
      pendingCloudAuthFlow = null;
    }
    await clearPendingCloudAuthFlow(flow.deviceCode);
    return;
  }

  const response = await fetch(`${configuredCloudApiOrigin}/extension-auth/flows/${encodeURIComponent(flow.deviceCode)}`);

  if (!response.ok) {
    throw new Error(`Unable to poll extension sign-in (${response.status}).`);
  }

  const payload = await response.json() as {
    status?: unknown;
    accessToken?: unknown;
    refreshToken?: unknown;
    refreshExpiresAt?: unknown;
    expiresAt?: unknown;
  };

  if (payload.status === "approved" && typeof payload.accessToken === "string") {
    const accountLabel = await readCloudAccountLabel(payload.accessToken);
    await saveCloudAuthSession({
      token: payload.accessToken,
      origin: configuredCloudApiOrigin,
      ...(accountLabel ? { accountLabel } : {}),
      ...(typeof payload.refreshToken === "string" ? { refreshToken: payload.refreshToken } : {}),
      ...(typeof payload.refreshExpiresAt === "number" ? { refreshExpiresAt: payload.refreshExpiresAt } : {}),
      expiresAt: normalizeExpirationMs(payload.expiresAt) ??
        getJwtExpirationMs(payload.accessToken) ??
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      checkedAt: new Date().toISOString()
    });
    if (pendingCloudAuthFlow?.deviceCode === flow.deviceCode) {
      pendingCloudAuthFlow = null;
    }
    await clearPendingCloudAuthFlow(flow.deviceCode);
    return;
  }

  if (payload.status === "expired" || payload.status === "denied") {
    if (pendingCloudAuthFlow?.deviceCode === flow.deviceCode) {
      pendingCloudAuthFlow = null;
    }
    await clearPendingCloudAuthFlow(flow.deviceCode);
    return;
  }

  if (!scheduleNext) {
    return;
  }

  globalThis.setTimeout(() => {
    if (pendingCloudAuthFlow?.deviceCode === flow.deviceCode) {
      void pollCloudSignInFlow(flow).catch((error: unknown) => {
        console.warn(`[jittle-lamp] Unable to poll extension sign-in: ${errorMessage(error)}`);
      });
    }
  }, Math.max(1, flow.intervalSeconds) * 1000);
}

async function readCloudAccountLabel(token: string): Promise<string | undefined> {
  try {
    const response = await fetch(`${configuredCloudApiOrigin}/protected/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` }
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = await response.json() as {
      user?: {
        displayName?: unknown;
        email?: unknown;
      };
      activeOrgId?: unknown;
      organizations?: Array<{
        id?: unknown;
        name?: unknown;
        isActive?: unknown;
      }>;
    };
    const userLabel = typeof payload.user?.email === "string" && payload.user.email.trim()
      ? payload.user.email.trim()
      : typeof payload.user?.displayName === "string" && payload.user.displayName.trim()
        ? payload.user.displayName.trim()
        : undefined;
    const activeOrg = payload.organizations?.find((organization) =>
      organization.isActive === true ||
      (typeof payload.activeOrgId === "string" && organization.id === payload.activeOrgId)
    );
    const orgLabel = typeof activeOrg?.name === "string" && activeOrg.name.trim() ? activeOrg.name.trim() : undefined;

    return [userLabel, orgLabel].filter(Boolean).join(" · ") || userLabel;
  } catch {
    return undefined;
  }
}

async function readStoredCloudAuthSession(): Promise<StoredCloudAuthSession | null> {
  const stored = await chrome.storage.local.get([cloudAuthStorageKey, cloudAuthDurableStorageKey]);
  const primary = parseStoredCloudAuthSession(stored[cloudAuthStorageKey], cloudAuthStorageKey);
  const durable = parseStoredCloudAuthSession(stored[cloudAuthDurableStorageKey], cloudAuthDurableStorageKey);

  authDebugLog("read-stored-session", {
    hasPrimary: stored[cloudAuthStorageKey] !== undefined,
    primaryAccepted: Boolean(primary),
    hasDurable: stored[cloudAuthDurableStorageKey] !== undefined,
    durableAccepted: Boolean(durable)
  });

  if (durable && (!primary || durable.expiresAt >= primary.expiresAt)) {
    authDebugLog("restore-session", { source: cloudAuthDurableStorageKey, expiresInMs: durable.expiresAt - Date.now() });
    cloudAuthSessionCache = durable;
    return durable;
  }

  if (primary) {
    authDebugLog("restore-session", { source: cloudAuthStorageKey, expiresInMs: primary.expiresAt - Date.now() });
    cloudAuthSessionCache = primary;
    return primary;
  }

  try {
    const allStored = await chrome.storage.local.get(null);
    const fallbackDurable = parseStoredCloudAuthSession(allStored[cloudAuthDurableStorageKey], `${cloudAuthDurableStorageKey}:fallback`);
    const fallbackPrimary = parseStoredCloudAuthSession(allStored[cloudAuthStorageKey], `${cloudAuthStorageKey}:fallback`);
    authDebugLog("read-stored-session-fallback", {
      keyCount: Object.keys(allStored).length,
      durableAccepted: Boolean(fallbackDurable),
      primaryAccepted: Boolean(fallbackPrimary)
    });
    const fallbackSession = fallbackDurable ?? fallbackPrimary;
    if (fallbackSession) {
      cloudAuthSessionCache = fallbackSession;
    }
    return fallbackSession;
  } catch {
    authDebugLog("read-stored-session-fallback-failed");
    return null;
  }
}

async function resolveCloudUploadSession(): Promise<StoredCloudAuthSession | null> {
  const storedSession = await ensureFreshCloudAuthSession();

  if (storedSession) {
    return storedSession;
  }

  await resumePendingCloudAuthFlow();
  const resumedSession = await ensureFreshCloudAuthSession();

  if (resumedSession) {
    return resumedSession;
  }

  return readCachedCloudAuthSession("stop-export");
}

async function ensureFreshCloudAuthSession(): Promise<StoredCloudAuthSession | null> {
  const storedSession = await readStoredCloudAuthSession();

  if (storedSession) {
    return storedSession;
  }

  const refreshableSession = await readRefreshableCloudAuthSession();

  if (!refreshableSession) {
    return null;
  }

  return refreshCloudAuthSession(refreshableSession);
}

async function refreshCloudAuthSession(session: RefreshableCloudAuthSession): Promise<StoredCloudAuthSession | null> {
  try {
    const response = await fetch(`${configuredCloudApiOrigin}/extension-auth/sessions/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken })
    });

    if (!response.ok) {
      await clearCloudAuthSession();
      return null;
    }

    const payload = await response.json() as {
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresAt?: unknown;
      refreshExpiresAt?: unknown;
    };

    if (typeof payload.accessToken !== "string" || typeof payload.refreshToken !== "string") {
      await clearCloudAuthSession();
      return null;
    }

    const refreshedSession: StoredCloudAuthSession = {
      token: payload.accessToken,
      origin: configuredCloudApiOrigin,
      ...(session.accountLabel ? { accountLabel: session.accountLabel } : {}),
      refreshToken: payload.refreshToken,
      ...(typeof payload.refreshExpiresAt === "number" ? { refreshExpiresAt: payload.refreshExpiresAt } : {}),
      expiresAt: normalizeExpirationMs(payload.expiresAt) ??
        getJwtExpirationMs(payload.accessToken) ??
        Date.now() + 45 * 60 * 1000,
      checkedAt: new Date().toISOString()
    };

    await saveCloudAuthSession(refreshedSession);
    return refreshedSession;
  } catch {
    return null;
  }
}

function readCachedCloudAuthSession(reason: string): StoredCloudAuthSession | null {
  if (!cloudAuthSessionCache) {
    authDebugLog("read-cached-session", { reason, accepted: false, cachePresent: false });
    return null;
  }

  if (cloudAuthSessionCache.expiresAt <= Date.now() + 30_000) {
    authDebugLog("read-cached-session", {
      reason,
      accepted: false,
      cachePresent: true,
      expiresInMs: cloudAuthSessionCache.expiresAt - Date.now()
    });
    cloudAuthSessionCache = null;
    return null;
  }

  authDebugLog("read-cached-session", {
    reason,
    accepted: true,
    expiresInMs: cloudAuthSessionCache.expiresAt - Date.now(),
    hasAccountLabel: Boolean(cloudAuthSessionCache.accountLabel)
  });
  return cloudAuthSessionCache;
}

function parseStoredCloudAuthSession(rawValue: unknown, source = "unknown"): StoredCloudAuthSession | null {
  const value = parseStoredObject(rawValue);

  if (!value || typeof value !== "object") {
    authDebugLog("reject-stored-session", { source, reason: "missing-object", valueType: typeof rawValue });
    return null;
  }

  const candidate = value as Partial<StoredCloudAuthSession>;
  const expiresAt = typeof candidate.expiresAt === "number" ? candidate.expiresAt : 0;
  const tokenSummary = summarizeAuthToken(candidate.token);

  if (
    typeof candidate.token !== "string" ||
    typeof candidate.origin !== "string" ||
    typeof candidate.checkedAt !== "string" ||
    !candidate.token.trim() ||
    !candidate.origin.trim() ||
    candidate.origin !== configuredCloudApiOrigin ||
    !isExtensionSessionToken(candidate.token) ||
    expiresAt <= Date.now() + 30_000
  ) {
    authDebugLog("reject-stored-session", {
      source,
      reason: summarizeStoredSessionRejection(candidate, expiresAt),
      hasToken: typeof candidate.token === "string" && Boolean(candidate.token.trim()),
      tokenType: tokenSummary.tokenType,
      tokenScope: tokenSummary.scope,
      originMatches: candidate.origin === configuredCloudApiOrigin,
      expiresInMs: expiresAt ? expiresAt - Date.now() : undefined
    });
    return null;
  }

  authDebugLog("accept-stored-session", {
    source,
    tokenType: tokenSummary.tokenType,
    tokenScope: tokenSummary.scope,
    expiresInMs: expiresAt - Date.now(),
    hasAccountLabel: typeof candidate.accountLabel === "string" && Boolean(candidate.accountLabel.trim())
  });

  return {
    token: candidate.token,
    origin: candidate.origin,
    expiresAt,
    checkedAt: candidate.checkedAt,
    ...(typeof candidate.refreshToken === "string" && candidate.refreshToken.trim()
      ? { refreshToken: candidate.refreshToken.trim() }
      : {}),
    ...(typeof candidate.refreshExpiresAt === "number" ? { refreshExpiresAt: candidate.refreshExpiresAt } : {}),
    ...(typeof candidate.accountLabel === "string" && candidate.accountLabel.trim()
      ? { accountLabel: candidate.accountLabel.trim() }
      : {})
  };
}

async function readRefreshableCloudAuthSession(): Promise<RefreshableCloudAuthSession | null> {
  const stored = await chrome.storage.local.get([cloudAuthStorageKey, cloudAuthDurableStorageKey]);
  const primary = parseRefreshableCloudAuthSession(stored[cloudAuthStorageKey]);
  const durable = parseRefreshableCloudAuthSession(stored[cloudAuthDurableStorageKey]);

  if (durable && (!primary || durable.refreshExpiresAt >= primary.refreshExpiresAt)) {
    return durable;
  }

  return primary;
}

function parseRefreshableCloudAuthSession(rawValue: unknown): RefreshableCloudAuthSession | null {
  const value = parseStoredObject(rawValue);

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<StoredCloudAuthSession>;

  if (
    typeof candidate.origin !== "string" ||
    candidate.origin !== configuredCloudApiOrigin ||
    typeof candidate.refreshToken !== "string" ||
    !candidate.refreshToken.trim() ||
    typeof candidate.refreshExpiresAt !== "number" ||
    candidate.refreshExpiresAt <= Date.now() + 30_000
  ) {
    return null;
  }

  return {
    origin: candidate.origin,
    refreshToken: candidate.refreshToken.trim(),
    refreshExpiresAt: candidate.refreshExpiresAt,
    ...(typeof candidate.accountLabel === "string" && candidate.accountLabel.trim()
      ? { accountLabel: candidate.accountLabel.trim() }
      : {})
  };
}

async function readPendingCloudAuthFlow(): Promise<PendingCloudAuthFlow | null> {
  const stored = await chrome.storage.local.get(cloudAuthFlowStorageKey);
  const value = parseStoredObject(stored[cloudAuthFlowStorageKey]);

  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<PendingCloudAuthFlow>;

  if (
    typeof candidate.deviceCode !== "string" ||
    typeof candidate.verificationUriComplete !== "string" ||
    typeof candidate.expiresAt !== "number" ||
    typeof candidate.intervalSeconds !== "number" ||
    typeof candidate.startedAt !== "string" ||
    !candidate.deviceCode.trim() ||
    !candidate.verificationUriComplete.trim() ||
    candidate.expiresAt <= Date.now()
  ) {
    await chrome.storage.local.remove(cloudAuthFlowStorageKey);
    return null;
  }

  return {
    deviceCode: candidate.deviceCode,
    verificationUriComplete: candidate.verificationUriComplete,
    expiresAt: candidate.expiresAt,
    intervalSeconds: candidate.intervalSeconds,
    startedAt: candidate.startedAt
  };
}

function parseStoredObject(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  const payloadSegment = token.split(".")[1];

  if (!payloadSegment) {
    return null;
  }

  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(atob(padded));

    return payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function summarizeAuthToken(token: unknown): { tokenType?: unknown; scope?: unknown; expiresInMs?: number } {
  if (typeof token !== "string") {
    return {};
  }

  const payload = readJwtPayload(token);
  const exp = typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;

  return {
    tokenType: payload?.token_type,
    scope: payload?.scope,
    ...(typeof exp === "number" ? { expiresInMs: exp - Date.now() } : {})
  };
}

function isExtensionSessionToken(token: string): boolean {
  const payload = readJwtPayload(token);

  return payload?.token_type === "extension_session";
}

function isPersistentCloudAuthSession(session: CloudAuthSession): boolean {
  return session.origin === configuredCloudApiOrigin && isExtensionSessionToken(session.token);
}

function summarizeStoredSessionRejection(candidate: Partial<StoredCloudAuthSession>, expiresAt: number): string {
  if (typeof candidate.token !== "string" || !candidate.token.trim()) {
    return "missing-token";
  }
  if (typeof candidate.origin !== "string" || !candidate.origin.trim()) {
    return "missing-origin";
  }
  if (typeof candidate.checkedAt !== "string") {
    return "missing-checked-at";
  }
  if (candidate.origin !== configuredCloudApiOrigin) {
    return "origin-mismatch";
  }
  if (!isExtensionSessionToken(candidate.token)) {
    return "token-not-extension-session";
  }
  if (expiresAt <= Date.now() + 30_000) {
    return "expired";
  }

  return "invalid";
}

async function restrictStorageAccessToExtensionContexts(): Promise<void> {
  try {
    await chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
    authDebugLog("storage-access-level", { accessLevel: "TRUSTED_CONTEXTS" });
  } catch (error: unknown) {
    authDebugLog("storage-access-level-failed", { error: errorMessage(error) });
  }
}

async function savePendingCloudAuthFlow(flow: PendingCloudAuthFlow): Promise<void> {
  if (flow.expiresAt <= Date.now()) {
    await chrome.storage.local.remove(cloudAuthFlowStorageKey);
    return;
  }

  await chrome.storage.local.set({
    [cloudAuthFlowStorageKey]: flow
  });
}

async function clearPendingCloudAuthFlow(deviceCode?: string): Promise<void> {
  if (!deviceCode) {
    await chrome.storage.local.remove(cloudAuthFlowStorageKey);
    return;
  }

  const stored = await readPendingCloudAuthFlow();

  if (!stored || stored.deviceCode === deviceCode) {
    await chrome.storage.local.remove(cloudAuthFlowStorageKey);
  }
}

async function saveCloudAuthSession(session: StoredCloudAuthSession): Promise<void> {
  if (!isPersistentCloudAuthSession(session)) {
    const tokenSummary = summarizeAuthToken(session.token);
    authDebugLog("skip-save-session", {
      reason: "not-persistent-extension-session",
      originMatches: session.origin === configuredCloudApiOrigin,
      tokenType: tokenSummary.tokenType,
      tokenScope: tokenSummary.scope
    });
    return;
  }

  if (session.expiresAt <= Date.now() + 30_000) {
    authDebugLog("clear-expired-session", { expiresInMs: session.expiresAt - Date.now() });
    cloudAuthSessionCache = null;
    await chrome.storage.local.remove([cloudAuthStorageKey, cloudAuthDurableStorageKey]);
    return;
  }

  await chrome.storage.local.set({
    [cloudAuthStorageKey]: session,
    [cloudAuthDurableStorageKey]: session
  });
  authDebugLog("save-session", {
    keys: [cloudAuthStorageKey, cloudAuthDurableStorageKey],
    expiresInMs: session.expiresAt - Date.now(),
    hasAccountLabel: Boolean(session.accountLabel)
  });
  cloudAuthSessionCache = session;
}

async function clearCloudAuthSession(): Promise<void> {
  cloudAuthSessionCache = null;
  await chrome.storage.local.remove([cloudAuthStorageKey, cloudAuthDurableStorageKey, cloudAuthFlowStorageKey]);
}

function getJwtExpirationMs(token: string): number | undefined {
  const payload = readJwtPayload(token);

  return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
}

function normalizeExpirationMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return value < 10_000_000_000 ? value * 1000 : value;
}

type CloudAuthSession = {
  token: string;
  origin: string;
  accountLabel?: string;
  refreshToken?: string;
  refreshExpiresAt?: number;
  expiresAt?: number;
  checkedAt?: string;
};

type StoredCloudAuthSession = CloudAuthSession & {
  token: string;
  origin: string;
  expiresAt: number;
  checkedAt: string;
};

type RefreshableCloudAuthSession = {
  origin: string;
  refreshToken: string;
  refreshExpiresAt: number;
  accountLabel?: string;
};

async function resolveCloudAuthToken(): Promise<CloudAuthSession | null> {
  const storedSession = await readStoredCloudAuthSession();
  if (storedSession) {
    return storedSession;
  }

  for (const origin of cloudWebOrigins) {
    const token = await requestCloudAuthTokenFromOrigin(origin);

    if (token) {
      const expiresAt = getJwtExpirationMs(token);
      return {
        token,
        origin,
        ...(expiresAt ? { expiresAt } : {})
      };
    }
  }

  return null;
}

async function requestCloudAuthTokenFromOrigin(origin: string): Promise<string | null> {
  const pattern = `${origin}/*`;
  const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);

  for (const tab of tabs) {
    if (typeof tab.id !== "number") {
      continue;
    }

    const token = await requestCloudAuthTokenFromTab(tab.id).catch(() => null);

    if (token) {
      return token;
    }
  }

  return null;
}

async function requestCloudAuthTokenFromTab(tabId: number): Promise<string | null> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: requestJittleLampCloudAuthTokenInPage,
    args: [cloudAuthProbeTimeoutMs]
  });

  const value = results[0]?.result;

  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as { token?: unknown };
  return typeof payload.token === "string" && payload.token.trim().length > 0
    ? payload.token
    : null;
}

async function requestJittleLampCloudAuthTokenInPage(
  timeoutMs: number
): Promise<{ token: string | null }> {
  const nonce = crypto.randomUUID();

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", listener);
      resolve({ token: null });
    }, timeoutMs);

    const listener = (event: MessageEvent): void => {
      if (event.source !== window || event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as {
        source?: unknown;
        type?: unknown;
        nonce?: unknown;
        token?: unknown;
      };

      if (
        data?.source !== "jittle-lamp-web-auth-bridge" ||
        data.type !== "jittle-lamp-extension-auth-token-response" ||
        data.nonce !== nonce
      ) {
        return;
      }

      clearTimeout(timer);
      window.removeEventListener("message", listener);
      resolve({
        token: typeof data.token === "string" && data.token.length > 0 ? data.token : null
      });
    };

    window.addEventListener("message", listener);
    window.postMessage(
      {
        source: "jittle-lamp-extension",
        type: "jittle-lamp-extension-auth-token-request",
        nonce
      },
      window.location.origin
    );
  });
}

function isSessionBusy(draft: CaptureSessionDraft): boolean {
  return draft.phase === "armed" || draft.phase === "recording" || draft.phase === "processing";
}

function isStaleProcessingDraft(draft: CaptureSessionDraft): boolean {
  return draft.phase === "processing" && Date.now() - Date.parse(draft.updatedAt) > staleProcessingDraftTimeoutMs;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isRecordableTab(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number; url: string } {
  const url = typeof tab?.url === "string" ? tab.url : typeof tab?.pendingUrl === "string" ? tab.pendingUrl : undefined;
  return typeof tab?.id === "number" && typeof url === "string" && isHttpUrl(url);
}

function isRecordableStartupUrl(url: string): boolean {
  return isHttpUrl(url) || url === "about:blank";
}

function stringifyConsoleArgs(args: CdpRemoteObject[] | undefined): string[] {
  return (args ?? []).map((arg) => stringifyRemoteObject(arg)).filter((value) => value.length > 0);
}

function stringifyRemoteObject(object: CdpRemoteObject): string {
  if (typeof object.unserializableValue === "string") {
    return object.unserializableValue;
  }

  if (typeof object.value === "string") {
    return object.value;
  }

  if (typeof object.value === "number" || typeof object.value === "boolean") {
    return String(object.value);
  }

  if (object.value !== undefined) {
    try {
      return JSON.stringify(object.value);
    } catch {
      return String(object.value);
    }
  }

  return object.description ?? object.className ?? object.type ?? "";
}

function sanitizeCapturedText(input: string): string {
  return input.replace(/https?:\/\/\S+/g, (candidate) => sanitizeCapturedUrl(candidate)).slice(0, 500);
}

function toConsoleLevel(type: string | undefined): "debug" | "info" | "warn" | "error" {
  switch (type) {
    case "debug":
    case "trace":
      return "debug";

    case "warning":
      return "warn";

    case "error":
    case "assert":
      return "error";

    default:
      return "info";
  }
}

function errorMessage(error: unknown): string {
  const message = rawErrorMessage(error);

  if (isCrossExtensionAccessMessage(message)) {
    return "jittle-lamp can only record regular web pages (http/https), not other extension pages.";
  }

  return message;
}

function isCrossExtensionAccessError(error: unknown): boolean {
  return isCrossExtensionAccessMessage(rawErrorMessage(error));
}

function isCrossExtensionAccessMessage(message: string): boolean {
  return message.includes("Cannot access a chrome-extension:// URL of different extension");
}

function debuggerUnavailableDetail(canUseWebRequestFallback = true): string {
  if (canUseWebRequestFallback) {
    return "Started active-tab recording. Browser debugger capture is unavailable, so console capture and CDP response-body capture are unavailable; network metadata will use the browser request observer and fetch/XHR bodies will use the page probe.";
  }

  return "Started active-tab recording. Browser debugger capture is unavailable, so console capture and CDP response-body capture are unavailable; fetch/XHR capture will use the page probe. Grant network recording permission for browser-level metadata.";
}

function rawErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHandledRuntimeMessage(rawMessage: unknown): boolean {
  return popupRequestSchema.safeParse(rawMessage).success || contentRuntimeMessageSchema.safeParse(rawMessage).success;
}

async function sendOffscreenMessage(
  message:
    | {
        type: "jl/offscreen-start-recording";
        sessionId: string;
        tabId: number;
        streamId: string;
        playTabAudio?: boolean;
      }
    | {
        type: "jl/offscreen-stop-and-export";
        sessionId: string;
        archive: ReturnType<typeof createSessionArchive>;
        cloudRequired?: boolean;
        cloudAuthToken?: string;
      }
    | {
        type: "jl/offscreen-retry-cloud-upload";
        sessionId: string;
        cloudAuthToken: string;
      }
) {
  const rawResponse = await chrome.runtime.sendMessage(message);

  if (rawResponse === undefined) {
    throw new Error("Offscreen recorder did not respond.");
  }

  return offscreenResponseSchema.parse(rawResponse);
}

async function queueDraftMutation<T>(operation: () => Promise<T>): Promise<T> {
  const nextOperation = draftMutationQueue.then(operation, operation);
  draftMutationQueue = nextOperation.then(
    () => undefined,
    () => undefined
  );
  return nextOperation;
}

async function flushDraftMutations(): Promise<void> {
  await queueDraftMutation(async () => undefined);
}

async function resetForTests(options?: { preserveStorage?: boolean }): Promise<void> {
  networkRequestsByTab.clear();
  stoppingTabIds.clear();
  draftMutationQueue = Promise.resolve();
  offscreenCreationPromise = null;
  activeDraftCache = null;
  activeDraftEventCount = 0;
  pendingRecoveryCheckScheduled = false;
  cloudAuthSessionCache = null;

  const recoveryTabId = activeRecoveryState?.tabId;
  activeRecoveryState = null;
  await clearMaxRecordingDurationAlarm();

  if (typeof recoveryTabId === "number") {
    await clearPendingRecoveryAlarm(recoveryTabId);
  }

  if (!options?.preserveStorage) {
    await Promise.all([
      chrome.storage.local.remove([sessionStorageKey, sessionStorageMetaKey]),
      chrome.storage.session.remove([sessionStorageKey, sessionStorageMetaKey])
    ]);
  }
}

export const __backgroundTest = {
  sessionStorageKey,
  sessionStorageMetaKey,
  pendingRecoveryTimeoutMs,
  maxRecordingDurationMs,
  maxRecordingDurationAlarmName,
  getPendingRecoveryAlarmName,
  handleAlarm,
  handleMaxRecordingDurationAlarm,
  handleDebuggerDetach,
  handleCompletedTabUpdate,
  handlePendingRecoveryAlarm,
  readDraft,
  saveDraft,
  clearDraft,
  flushDraftMutations,
  resetForTests
};
