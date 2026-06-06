import { popupResponseSchema, type PopupResponse, type PopupState } from "@jittle-lamp/shared";
import { CircleStop, createIcons, Play } from "lucide";

const refreshIntervalMs = 1_500;

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
const startButton = requireElement<HTMLButtonElement>("[data-role='start-button']");
const stopButton = requireElement<HTMLButtonElement>("[data-role='stop-button']");

let requestInFlight = false;
let lastRenderedTitle = "";

createIcons({ icons: { CircleStop, Play } });
void refreshState();
setInterval(() => {
  void refreshState();
}, refreshIntervalMs);

startButton.addEventListener("click", () => {
  void performAction("jl/popup-start-recording");
});

stopButton.addEventListener("click", () => {
  void performAction("jl/popup-stop-recording");
});

statusBadge.addEventListener("click", () => {
  if (statusBadge.dataset.phase === "failed") {
    void performAction("jl/popup-retry-upload");
  }
});

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
    | "jl/popup-retry-upload"
    | "jl/popup-open-evidence-list"
    | "jl/popup-logout-cloud"
): Promise<void> {
  if (requestInFlight) {
    return;
  }

  requestInFlight = true;
  setButtonsDisabled(true);
  let transientError: string | undefined;

  try {
    if (type === "jl/popup-start-recording") {
      const granted = await chrome.permissions.request({
        permissions: ["webRequest"],
        origins: ["http://*/*", "https://*/*"]
      });

      if (!granted) {
        transientError = "Grant recording access to capture active-tab interactions, console output, and network evidence.";
        return;
      }
    }

    const response = await sendPopupMessage(type);

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

async function refreshState(errorOverride?: string): Promise<void> {
  if (requestInFlight) {
    return;
  }

  try {
    const response = await sendPopupMessage("jl/popup-get-state");
    renderState(response.state, errorOverride ?? response.error);
  } catch (error: unknown) {
    renderState(emptyPopupState(), errorOverride ?? (error instanceof Error ? error.message : String(error)));
  }
}

async function sendPopupMessage(
  type:
    | "jl/popup-get-state"
    | "jl/popup-start-recording"
    | "jl/popup-stop-recording"
    | "jl/popup-retry-upload"
    | "jl/popup-open-evidence-list"
    | "jl/popup-logout-cloud"
): Promise<PopupResponse> {
  return popupResponseSchema.parse(
    await chrome.runtime.sendMessage({
      type
    })
  );
}

async function persistTitleEdit(): Promise<void> {
  const nextName = titleValue.value.trim();

  if (!nextName || nextName === lastRenderedTitle || requestInFlight) {
    titleValue.value = lastRenderedTitle;
    return;
  }

  requestInFlight = true;
  setButtonsDisabled(true);
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
  const activeSession = state.activeSession;

  statusBadge.textContent = activeSession?.phase ?? "idle";
  statusBadge.dataset.phase = activeSession?.phase ?? "idle";

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
  urlValue.textContent = urlText;
  urlValue.title = urlText;
  sessionValue.textContent = activeSession?.sessionId ?? "—";
  eventsValue.textContent = String(activeSession?.eventCount ?? 0);
  const artifactText = (activeSession?.artifacts ?? [])
    .map((artifact) => artifact.relativePath)
    .join("\n") || "—";
  artifactValue.textContent = artifactText;
  artifactValue.title = artifactText;

  if (error) {
    setStatusMessage(error);
    messageValue.dataset.tone = "error";
  } else if (activeSession?.statusText) {
    setStatusMessage(activeSession.statusText);
    messageValue.dataset.tone = "neutral";
  } else if (activeSession?.phase === "recording") {
    setStatusMessage(
      state.cloud.status === "signed-in"
        ? "Recording the active tab. Stop to upload directly to cloud."
        : state.companion.status === "online"
        ? `Recording the active tab. Stop to save directly into ${state.companion.outputDir ?? "the desktop companion folder"}.`
        : "Recording the active tab. Stop to download the session through Chromium."
    );
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

  startButton.disabled = requestInFlight || !state.canStart;
  stopButton.disabled = requestInFlight || !state.canStop;
  startButton.hidden = !state.canStart;
  stopButton.hidden = !state.canStop;
}

function setButtonsDisabled(disabled: boolean): void {
  startButton.disabled = disabled;
  stopButton.disabled = disabled;
  cloudMenuButton.disabled = disabled;
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
    canStart: true,
    canStop: false
  };
}
