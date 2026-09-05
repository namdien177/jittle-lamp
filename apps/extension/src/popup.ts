import {
  popupResponseSchema,
  type PopupResponse,
  type PopupState,
  type RecordingOperation
} from "@jittle-lamp/shared";

import { deriveRecordingControlState } from "./recording-control-state";

type CaptureTarget = "tab" | "desktop";

const refreshIntervalMs = 1_500;
const networkFallbackPermissions: chrome.permissions.Permissions = {
  permissions: ["webRequest"],
  origins: ["http://*/*", "https://*/*"]
};

const retryButton = requireElement<HTMLButtonElement>("[data-role='retry-button']");
const saveLocalButton = requireElement<HTMLButtonElement>("[data-role='save-local-button']");

const statusBadge = requireElement<HTMLSpanElement>("[data-role='status-badge']");
const companionStatus = requireElement<HTMLElement>("[data-role='companion-status']");
const companionRoute = requireElement<HTMLParagraphElement>("[data-role='companion-route']");
const companionPill = requireElement<HTMLSpanElement>("[data-role='companion-pill']");
const companionDownload = requireElement<HTMLAnchorElement>("[data-role='companion-download']");
const cloudStatus = requireElement<HTMLElement>("[data-role='cloud-status']");
const cloudRoute = requireElement<HTMLParagraphElement>("[data-role='cloud-route']");
const cloudPill = requireElement<HTMLSpanElement>("[data-role='cloud-pill']");
const cloudMenuButton = requireElement<HTMLButtonElement>("[data-role='cloud-menu-button']");
const cloudMenu = requireElement<HTMLDivElement>("[data-role='cloud-menu']");
const openEvidenceButton = requireElement<HTMLButtonElement>("[data-role='open-evidence-button']");
const logoutButton = requireElement<HTMLButtonElement>("[data-role='logout-button']");
const titleValue = requireElement<HTMLInputElement>("[data-role='title-value']");
const urlValue = requireElement<HTMLSpanElement>("[data-role='url-value']");
const sessionValue = requireElement<HTMLSpanElement>("[data-role='session-value']");
const eventsValue = requireElement<HTMLSpanElement>("[data-role='events-value']");
const artifactValue = requireElement<HTMLSpanElement>("[data-role='artifact-value']");
const messageValue = requireElement<HTMLParagraphElement>("[data-role='message-value']");
const soundToggle = requireElement<HTMLInputElement>("[data-role='sound-toggle']");
const targetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-capture-target]"));
const startButton = requireElement<HTMLButtonElement>("[data-role='start-button']");
const startLabel = requireElement<HTMLSpanElement>("[data-role='start-label']");
const stopButton = requireElement<HTMLButtonElement>("[data-role='stop-button']");
const stopLabel = requireElement<HTMLSpanElement>("[data-role='stop-label']");
const pauseButton = requireElement<HTMLButtonElement>("[data-role='pause-button']");
const pauseIcon = requireElement<SVGElement>("[data-role='pause-icon']");
const resumeIcon = requireElement<SVGElement>("[data-role='resume-icon']");
const pauseLabel = requireElement<HTMLSpanElement>("[data-role='pause-label']");
const abortButton = requireElement<HTMLButtonElement>("[data-role='abort-button']");
const draftTitleValue = requireElement<HTMLInputElement>("[data-role='draft-title-value']");

let requestInFlight = false;
let refreshInFlight = false;
let requestRevision = 0;
let renderedState: PopupState | null = null;
let localRecordingOperation: RecordingOperation | null = null;
let lastRenderedTitle = "";
let draftTitleEdited = false;
let selectedCaptureTarget: CaptureTarget = "tab";
const targetTabId = parseTargetTabId();
const targetPage = parseTargetPage();

syncCaptureTargetButtons();
syncRecordingControls(null);
void refreshState();
setInterval(() => {
  void refreshState();
}, refreshIntervalMs);

startButton.addEventListener("click", () => {
  void performAction("jl/popup-start-recording");
});

for (const button of targetButtons) {
  button.addEventListener("click", () => {
    const target = button.dataset.captureTarget;
    if (target === "tab" || target === "desktop") {
      setCaptureTarget(target);
    }
  });
}

draftTitleValue.addEventListener("input", () => {
  draftTitleEdited = true;
});

stopButton.addEventListener("click", () => {
  void performAction("jl/popup-stop-recording");
});

pauseButton.addEventListener("click", () => {
  void performAction(
    pauseButton.dataset.mode === "resume"
      ? "jl/popup-resume-recording"
      : "jl/popup-pause-recording"
  );
});

abortButton.addEventListener("click", () => {
  void performAction("jl/popup-abort-recording");
});

retryButton.addEventListener("click", () => void performAction("jl/popup-retry-upload"));
saveLocalButton.addEventListener("click", () => void performAction("jl/popup-save-local"));

cloudMenuButton.addEventListener("click", () => {
  if (cloudMenuButton.disabled) {
    return;
  }

  cloudMenu.hidden = !cloudMenu.hidden;
});

openEvidenceButton.addEventListener("click", () => {
  cloudMenu.hidden = true;
  void performAction("jl/popup-open-evidence-list");
});

logoutButton.addEventListener("click", () => {
  cloudMenu.hidden = true;
  void performAction("jl/popup-logout-cloud");
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) {
    return;
  }

  if (!cloudMenu.hidden && !cloudMenu.contains(target) && !cloudMenuButton.contains(target)) {
    cloudMenu.hidden = true;
  }
});

titleValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    titleValue.blur();
  }

  if (event.key === "Escape") {
    titleValue.value = lastRenderedTitle;
    titleValue.blur();
  }
});

titleValue.addEventListener("blur", () => {
  void persistTitleEdit();
});

async function performAction(
  type:
    | "jl/popup-start-recording"
    | "jl/popup-stop-recording"
    | "jl/popup-pause-recording"
    | "jl/popup-resume-recording"
    | "jl/popup-abort-recording"
    | "jl/popup-retry-upload"
    | "jl/popup-save-local"
    | "jl/popup-open-evidence-list"
    | "jl/popup-logout-cloud"
): Promise<void> {
  if (requestInFlight) {
    return;
  }

  requestInFlight = true;
  localRecordingOperation = operationForAction(type);
  const revision = ++requestRevision;
  syncRecordingControls(renderedState);
  let transientError: string | undefined;
  let response: PopupResponse | undefined;

  try {
    if (type === "jl/popup-start-recording") {
      await requestOptionalNetworkFallbackPermission();
    }

    response = await sendPopupMessage(type);

    if (response.error) {
      transientError = response.error;
    }
  } catch (error: unknown) {
    transientError = error instanceof Error ? error.message : String(error);
  } finally {
    requestInFlight = false;
  }

  if (revision !== requestRevision) {
    return;
  }

  if (response) {
    localRecordingOperation = null;
    renderState(response.state, transientError);
    return;
  }

  renderState(renderedState ?? emptyPopupState(), transientError);
  await refreshState(transientError);
}

async function requestOptionalNetworkFallbackPermission(): Promise<void> {
  if (!("permissions" in chrome) || !chrome.permissions?.request) {
    return;
  }

  try {
    const alreadyGranted = await chrome.permissions.contains(networkFallbackPermissions);

    if (alreadyGranted) {
      return;
    }

    await chrome.permissions.request(networkFallbackPermissions);
  } catch (error: unknown) {
    console.warn("Unable to request optional network fallback permission.", error);
  }
}

async function refreshState(errorOverride?: string): Promise<void> {
  if (requestInFlight || refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  const revision = ++requestRevision;

  try {
    const response = await sendPopupMessage("jl/popup-get-state");

    if (revision === requestRevision) {
      localRecordingOperation = null;
      renderState(response.state, errorOverride ?? response.error);
    }
  } catch (error: unknown) {
    if (revision === requestRevision) {
      renderState(
        renderedState ?? emptyPopupState(),
        errorOverride ?? (error instanceof Error ? error.message : String(error))
      );
    }
  } finally {
    refreshInFlight = false;
  }
}

async function sendPopupMessage(
  type:
    | "jl/popup-get-state"
    | "jl/popup-start-recording"
    | "jl/popup-stop-recording"
    | "jl/popup-pause-recording"
    | "jl/popup-resume-recording"
    | "jl/popup-abort-recording"
    | "jl/popup-retry-upload"
    | "jl/popup-save-local"
    | "jl/popup-open-evidence-list"
    | "jl/popup-logout-cloud"
): Promise<PopupResponse> {
  const message =
    type === "jl/popup-start-recording" && typeof targetTabId === "number"
      ? {
          type,
          tabId: targetTabId,
          page: targetPage,
          captureTarget: selectedCaptureTarget,
          playTabAudio: soundToggle.checked,
          ...readDraftSessionName()
        }
      : type === "jl/popup-start-recording"
        ? {
            type,
            captureTarget: selectedCaptureTarget,
            playTabAudio: soundToggle.checked,
            ...readDraftSessionName()
          }
        : { type };

  return popupResponseSchema.parse(
    await chrome.runtime.sendMessage(message)
  );
}

function parseTargetPage(): { title?: string; url?: string } | undefined {
  const params = new URLSearchParams(window.location.search);
  const title = params.get("targetTitle")?.trim();
  const url = params.get("targetUrl")?.trim();
  const page = {
    ...(title ? { title } : {}),
    ...(url ? { url } : {})
  };

  return Object.keys(page).length > 0 ? page : undefined;
}

function parseTargetTabId(): number | undefined {
  const rawValue = new URLSearchParams(window.location.search).get("targetTabId");

  if (!rawValue) {
    return undefined;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function persistTitleEdit(): Promise<void> {
  const nextName = titleValue.value.trim();

  if (!nextName || nextName === lastRenderedTitle || requestInFlight) {
    titleValue.value = lastRenderedTitle;
    return;
  }

  requestInFlight = true;
  syncRecordingControls(renderedState);
  let transientError: string | undefined;

  try {
    const response = popupResponseSchema.parse(
      await chrome.runtime.sendMessage({
        type: "jl/popup-update-session-name",
        name: nextName
      })
    );

    if (response.error) {
      transientError = response.error;
    }
  } catch (error: unknown) {
    transientError = error instanceof Error ? error.message : String(error);
  } finally {
    requestInFlight = false;
  }

  await refreshState(transientError);
}

function renderState(state: PopupState, error?: string): void {
  renderedState = state;
  const activeSession = state.activeSession;
  const canEditDraftTitle = state.canStart && !requestInFlight;
  const visiblePhase = state.recordingOperation ?? activeSession?.phase ?? "idle";

  statusBadge.textContent = visiblePhase;
  statusBadge.dataset.phase = visiblePhase;

  cloudStatus.textContent =
    state.cloud.status === "signed-in"
      ? "Web session signed in"
      : state.cloud.status === "signed-out"
        ? "Web sign-in not detected"
        : "Cloud auth unknown";
  const cloudRouteText =
    state.cloud.status === "signed-in"
      ? state.cloud.origin ?? "Jittle Lamp web"
      : state.cloud.error ?? "Open Jittle Lamp web and sign in for direct cloud uploads.";
  cloudRoute.textContent = cloudRouteText;
  cloudRoute.title = cloudRouteText;
  cloudPill.textContent = state.cloud.status;
  cloudMenuButton.dataset.status = state.cloud.status;
  cloudMenuButton.disabled = requestInFlight || state.cloud.status !== "signed-in";
  cloudMenuButton.title = state.cloud.status === "signed-in" ? "Cloud account options" : "Sign in from Jittle Lamp web";
  if (state.cloud.status !== "signed-in") {
    cloudMenu.hidden = true;
  }

  companionStatus.textContent =
    state.companion.status === "online" ? "Desktop companion online" : "Desktop companion offline";
  const companionRouteText =
    state.companion.status === "online"
      ? state.companion.outputDir ?? state.companion.origin
      : `${state.companion.origin} unavailable`;
  companionRoute.textContent = companionRouteText;
  companionRoute.title = companionRouteText;
  companionDownload.hidden = state.companion.status === "online" || state.cloud.status === "signed-in";
  companionPill.textContent = state.companion.status;
  companionPill.dataset.status = state.companion.status;

  const titleText = activeSession?.name ?? "No session yet";
  const urlText = activeSession?.page.url ?? "Open an http(s) page to start recording.";
  lastRenderedTitle = titleText;
  if (document.activeElement !== titleValue) {
    titleValue.value = titleText;
  }
  titleValue.title = titleText;
  titleValue.disabled = !activeSession || activeSession.phase === "processing";
  if (!draftTitleEdited && !activeSession) {
    draftTitleValue.value = targetPage?.title ?? "";
  }
  draftTitleValue.disabled = !canEditDraftTitle;
  urlValue.textContent = urlText;
  urlValue.title = urlText;
  sessionValue.textContent = activeSession?.sessionId ?? "—";
  eventsValue.textContent = String(activeSession?.eventCount ?? 0);
  const artifactText = (activeSession?.artifacts ?? [])
    .map((artifact) => artifact.relativePath)
    .join("\n") || "—";
  artifactValue.textContent = artifactText;
  artifactValue.title = artifactText;
  error ??= activeSession?.phase === "failed" ? activeSession.statusText : undefined;
  messageValue.setAttribute("role", error ? "alert" : "status");

  if (error) {
    setStatusMessage(error);
    messageValue.dataset.tone = "error";
  } else if (activeSession?.statusText) {
    setStatusMessage(activeSession.statusText);
    messageValue.dataset.tone = "neutral";
  } else if (activeSession?.phase === "recording") {
    setStatusMessage(
      state.cloud.status === "signed-in"
        ? "Recording the active tab. Finish to upload directly to cloud."
        : state.companion.status === "online"
        ? `Recording the active tab. Finish to save directly into ${state.companion.outputDir ?? "the desktop companion folder"}.`
        : "Recording the active tab. Finish to download the session through Chromium."
    );
    messageValue.dataset.tone = "neutral";
  } else if (activeSession?.phase === "paused") {
    setStatusMessage("Recording paused. Resume to continue capture, or finish to save the session.");
    messageValue.dataset.tone = "neutral";
  } else if (state.cloud.status === "signed-in") {
    setStatusMessage("Cloud upload ready. New stopped sessions upload directly from the extension.");
    messageValue.dataset.tone = "neutral";
  } else if (state.companion.status === "online") {
    setStatusMessage(
      `Desktop companion ready. New stopped sessions will save into ${state.companion.outputDir ?? state.companion.origin}.`
    );
    messageValue.dataset.tone = "neutral";
  } else {
    setStatusMessage("Desktop companion offline. Stopped sessions will download through Chromium.");
    messageValue.dataset.tone = "neutral";
  }

  syncRecordingControls(state);
}

function setCaptureTarget(captureTarget: CaptureTarget): void {
  selectedCaptureTarget = captureTarget;
  syncCaptureTargetButtons();
}

function syncCaptureTargetButtons(): void {
  for (const button of targetButtons) {
    const active = button.dataset.captureTarget === selectedCaptureTarget;
    button.dataset.active = String(active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function readDraftSessionName(): { name?: string } {
  const name = draftTitleValue.value.trim();
  return name ? { name } : {};
}

function syncRecordingControls(state: PopupState | null): void {
  const controls = deriveRecordingControlState(state, localRecordingOperation);
  const forceDisabled = requestInFlight;

  syncButton(startButton, startLabel, controls.start, forceDisabled);
  syncButton(stopButton, stopLabel, controls.finish, forceDisabled);
  syncButton(pauseButton, pauseLabel, controls.pause, forceDisabled);
  syncIconButton(abortButton, controls.abort, forceDisabled);

  for (const button of [retryButton, saveLocalButton]) {
    button.hidden = state?.activeSession?.phase !== "failed";
    button.disabled = forceDisabled || controls.busy;
  }
  soundToggle.disabled = forceDisabled || controls.busy || !state?.canStart;
  for (const targetButton of targetButtons) {
    targetButton.disabled = forceDisabled || controls.busy || !state?.canStart;
  }
  syncCaptureTargetButtons();

  pauseButton.dataset.mode = controls.pause.mode;
  pauseButton.title = controls.pause.label;
  pauseButton.setAttribute("aria-label", controls.pause.label);
  pauseIcon.toggleAttribute("hidden", controls.pause.mode === "resume" || controls.pause.loading);
  resumeIcon.toggleAttribute("hidden", controls.pause.mode === "pause" || controls.pause.loading);
  statusBadge.setAttribute("aria-busy", String(controls.busy));
}

function syncButton(
  button: HTMLButtonElement,
  label: HTMLSpanElement,
  control: { visible: boolean; disabled: boolean; loading: boolean; label: string },
  forceDisabled: boolean
): void {
  button.hidden = !control.visible;
  button.disabled = forceDisabled || control.disabled;
  button.dataset.loading = String(control.loading);
  button.setAttribute("aria-busy", String(control.loading));
  label.textContent = control.label;
}

function syncIconButton(
  button: HTMLButtonElement,
  control: { visible: boolean; disabled: boolean; loading: boolean; label: string },
  forceDisabled: boolean
): void {
  button.hidden = !control.visible;
  button.disabled = forceDisabled || control.disabled;
  button.dataset.loading = String(control.loading);
  button.setAttribute("aria-busy", String(control.loading));
  button.title = control.label;
  button.setAttribute("aria-label", control.label);
}

function operationForAction(type: string): RecordingOperation | null {
  switch (type) {
    case "jl/popup-start-recording":
      return "starting";
    case "jl/popup-stop-recording":
      return "stopping";
    case "jl/popup-pause-recording":
      return "pausing";
    case "jl/popup-resume-recording":
      return "resuming";
    case "jl/popup-abort-recording":
      return "aborting";
    case "jl/popup-save-local":
      return "saving-local";
    case "jl/popup-retry-upload":
      return "retrying-upload";
    default:
      return null;
  }
}

function setStatusMessage(message: string): void {
  messageValue.textContent = compactStatusUrls(message);
  messageValue.title = message;
}

function compactStatusUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s)]+/g, (url) => compactUrl(url));
}

function compactUrl(input: string): string {
  try {
    const url = new URL(input);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPathPart = pathParts.at(-1);

    if (!lastPathPart) {
      return url.hostname;
    }

    return `${url.hostname}/.../${lastPathPart}`;
  } catch {
    return input;
  }
}

function requireElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);

  if (!element) {
    throw new Error(`Missing popup element: ${selector}`);
  }

  return element;
}

function emptyPopupState(): PopupState {
  return {
    activeSession: null,
    companion: {
      status: "offline",
      origin: "http://127.0.0.1:48115",
      checkedAt: new Date().toISOString()
    },
    cloud: {
      status: "unknown",
      checkedAt: new Date().toISOString()
    },
    recordingOperation: null,
    canStart: false,
    canStop: false
  };
}
