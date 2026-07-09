import {
  backgroundToContentMessageSchema,
  popupResponseSchema,
  sanitizeCapturedUrl,
  type PopupResponse,
  type PopupState,
  type RecordingOperation
} from "@jittle-lamp/shared";
import {
  BookOpen,
  CircleStop,
  Copy,
  ExternalLink,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Move,
  PanelTop,
  Pause,
  Play,
  User,
  X,
  createElement
} from "lucide";

import { deriveRecordingControlState } from "./recording-control-state";

declare const __JITTLE_LAMP_WEB_ORIGIN__: string | undefined;

let activeSessionId: string | null = null;
let floatingWidget: FloatingWidgetController | null = null;
const configuredCloudWebOrigin = (
  typeof __JITTLE_LAMP_WEB_ORIGIN__ === "string" ? __JITTLE_LAMP_WEB_ORIGIN__.trim() : "https://jittlelamp.dev"
).replace(/\/+$/, "");
const selectionCaptureDebounceMs = 180;

type NetworkProbeBody = {
  disposition: "captured" | "truncated" | "omitted" | "unavailable";
  encoding?: "utf8";
  mimeType?: string;
  value?: string;
  byteLength?: number;
  omittedByteLength?: number;
  reason?: string;
};

type NetworkProbePayload = {
  requestId: string;
  method: string;
  url: string;
  subtype: "xhr" | "fetch";
  status?: number;
  statusText?: string;
  durationMs?: number;
  requestHeaders: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  requestBody?: NetworkProbeBody;
  responseBody?: NetworkProbeBody;
  failureText?: string;
};

type CaptureTarget = "tab" | "desktop";

let selectionCaptureTimer: number | null = null;
let lastSelectionFingerprint = "";

function bootContentBridge(): void {
  if (window.__jittleLampBootstrapped__) {
    return;
  }

  window.__jittleLampBootstrapped__ = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !isNetworkProbeMessage(event.data)) {
      return;
    }

    void sendNetworkEvent(event.data.payload);
  });

  chrome.runtime.onMessage.addListener((rawMessage) => {
    const parsed = backgroundToContentMessageSchema.safeParse(rawMessage);

    if (!parsed.success) {
      return;
    }

    switch (parsed.data.type) {
      case "jl/content-begin-capture":
        activeSessionId = parsed.data.sessionId;
        showFloatingWidget();
        void announceContentReady(parsed.data.sessionId);
        return;

      case "jl/content-end-capture":
        if (activeSessionId === parsed.data.sessionId) {
          activeSessionId = null;
        }
        floatingWidget?.refresh();
        return;

      case "jl/content-toggle-widget":
        toggleFloatingWidget(parsed.data.state);
        return;

      case "jl/content-refresh-widget":
        floatingWidget?.renderIfVisible(parsed.data.state);
        return;

      case "jl/content-widget-ping":
        if (floatingWidget && !floatingWidget.isMounted()) {
          floatingWidget = null;
        }
        return;
    }
  });

  window.addEventListener(
    "click",
    (event) => {
      if (isFloatingWidgetEvent(event)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const descriptor = describeElementTarget(target);
      const page = collectPageMetrics();

      void sendInteraction({
        kind: "interaction",
        type: "click",
        ...(descriptor.selector ? { selector: descriptor.selector } : {}),
        ...(descriptor.target ? { target: descriptor.target } : {}),
        page,
        x: event.clientX,
        y: event.clientY,
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        button: event.button,
        buttons: event.buttons,
        clickCount: event.detail,
        modifiers: collectModifierState(event),
        ...(event instanceof PointerEvent && event.pointerType ? { pointerType: normalizePointerType(event.pointerType) } : {})
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    "input",
    (event) => {
      if (isFloatingWidgetEvent(event)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const field = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
        ? target
        : target instanceof HTMLSelectElement
          ? target
          : null;

      if (!field) {
        return;
      }

      const descriptor = describeElementTarget(field);
      const snapshot = snapshotFieldValue(field);

      void sendInteraction({
        kind: "interaction",
        type: "input",
        ...(descriptor.selector ? { selector: descriptor.selector } : {}),
        ...(descriptor.target ? { target: descriptor.target } : {}),
        page: collectPageMetrics(),
        ...snapshot
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (isFloatingWidgetEvent(event)) {
        return;
      }

      if (shouldSkipKeyboardEvent(event)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const descriptor = describeElementTarget(target);
      const keyInfo = snapshotKeyboardEvent(event, target);

      void sendInteraction({
        kind: "interaction",
        type: "keyboard",
        ...(descriptor.selector ? { selector: descriptor.selector } : {}),
        ...(descriptor.target ? { target: descriptor.target } : {}),
        page: collectPageMetrics(),
        eventType: "keydown",
        ...keyInfo
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    "keyup",
    (event) => {
      if (isFloatingWidgetEvent(event)) {
        return;
      }

      if (shouldSkipKeyboardEvent(event)) {
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      const descriptor = describeElementTarget(target);
      const keyInfo = snapshotKeyboardEvent(event, target);

      void sendInteraction({
        kind: "interaction",
        type: "keyboard",
        ...(descriptor.selector ? { selector: descriptor.selector } : {}),
        ...(descriptor.target ? { target: descriptor.target } : {}),
        page: collectPageMetrics(),
        eventType: "keyup",
        ...keyInfo
      });
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    "submit",
    (event) => {
      if (isFloatingWidgetEvent(event)) {
        return;
      }

      const form = event.target instanceof HTMLFormElement ? event.target : null;
      const descriptor = describeElementTarget(form);
      const submitter = event instanceof SubmitEvent && event.submitter instanceof Element
        ? describeElementTarget(event.submitter)
        : { selector: undefined };

      void sendInteraction({
        kind: "interaction",
        type: "submit",
        ...(descriptor.selector ? { selector: descriptor.selector } : {}),
        ...(descriptor.target ? { target: descriptor.target } : {}),
        page: collectPageMetrics(),
        ...(descriptor.selector ? { formSelector: descriptor.selector } : {}),
        ...(submitter.selector ? { submitterSelector: submitter.selector } : {}),
        method: form?.method?.toLowerCase() || undefined,
        action: form?.action ? sanitizeCapturedUrl(form.action) : undefined
      });
    },
    { capture: true, passive: true }
  );

  document.addEventListener(
    "selectionchange",
    () => {
      scheduleSelectionCapture();
    },
    { passive: true }
  );

  window.addEventListener("popstate", () => {
    void announceNavigation("popstate");
  });

  window.addEventListener("hashchange", () => {
    void announceNavigation("hashchange");
  });

  patchHistoryMethod("pushState");
  patchHistoryMethod("replaceState");
}

async function announceContentReady(sessionId: string): Promise<void> {
  await chrome.runtime.sendMessage({
    type: "jl/content-ready",
    sessionId,
    page: {
      url: sanitizeCapturedUrl(window.location.href),
      title: document.title || window.location.href
    }
  });
}

async function announceNavigation(navigationType: "pushState" | "replaceState" | "popstate" | "hashchange" | "location"): Promise<void> {
  const url = sanitizeCapturedUrl(window.location.href);
  await sendInteraction({
    kind: "interaction",
    type: "navigation",
    selector: url,
    url,
    title: document.title || window.location.href,
    navigationType,
    page: collectPageMetrics()
  });

  if (activeSessionId) {
    await announceContentReady(activeSessionId);
  }
}

async function sendInteraction(payload: Record<string, unknown>): Promise<void> {
  if (!activeSessionId) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "jl/interaction",
    sessionId: activeSessionId,
    payload
  });
}

async function sendNetworkEvent(payload: NetworkProbePayload): Promise<void> {
  if (!activeSessionId) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "jl/network",
    sessionId: activeSessionId,
    payload: {
      kind: "network",
      method: payload.method,
      url: sanitizeCapturedUrl(payload.url),
      subtype: payload.subtype,
      ...(typeof payload.status === "number" ? { status: payload.status } : {}),
      ...(payload.statusText ? { statusText: payload.statusText } : {}),
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {}),
      ...(payload.requestId ? { requestId: payload.requestId } : {}),
      request: {
        headers: payload.requestHeaders,
        cookies: [],
        ...(payload.requestBody ? { body: payload.requestBody } : {})
      },
      ...(payload.responseHeaders.length > 0 || payload.responseBody
        ? {
            response: {
              headers: payload.responseHeaders,
              setCookieHeaders: [],
              setCookies: [],
              ...(payload.responseBody ? { body: payload.responseBody } : {})
            }
          }
        : {}),
      ...(payload.failureText ? { failureText: payload.failureText } : {})
    }
  });
}

function scheduleSelectionCapture(): void {
  if (!activeSessionId) {
    return;
  }

  if (selectionCaptureTimer !== null) {
    window.clearTimeout(selectionCaptureTimer);
  }

  selectionCaptureTimer = window.setTimeout(() => {
    selectionCaptureTimer = null;
    void captureSelectionInteraction();
  }, selectionCaptureDebounceMs);
}

async function captureSelectionInteraction(): Promise<void> {
  if (!activeSessionId) {
    return;
  }

  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    lastSelectionFingerprint = "";
    return;
  }

  const selectedText = sanitizeSelectedText(selection.toString());
  if (!selectedText) {
    lastSelectionFingerprint = "";
    return;
  }

  const range = selection.getRangeAt(0);
  const anchorElement = nodeToElement(selection.anchorNode);
  const focusElement = nodeToElement(selection.focusNode);
  const commonElement = nodeToElement(range.commonAncestorContainer);
  const descriptor = describeElementTarget(commonElement);
  const anchorSelector = describeElement(anchorElement);
  const focusSelector = describeElement(focusElement);
  const fingerprint = [
    selectedText,
    descriptor.selector ?? "",
    anchorSelector ?? "",
    focusSelector ?? "",
    String(selection.anchorOffset),
    String(selection.focusOffset)
  ].join("|");

  if (fingerprint === lastSelectionFingerprint) {
    return;
  }
  lastSelectionFingerprint = fingerprint;

  await sendInteraction({
    kind: "interaction",
    type: "selection",
    ...(descriptor.selector ? { selector: descriptor.selector } : {}),
    ...(descriptor.target ? { target: descriptor.target } : {}),
    page: collectPageMetrics(),
    selectedText,
    selectedTextLength: selectedText.length,
    ...(anchorSelector ? { anchorSelector } : {}),
    ...(focusSelector ? { focusSelector } : {})
  });
}

const floatingWidgetHostId = "jittle-lamp-floating-widget";
const floatingWidgetRefreshMs = 1_200;

class FloatingWidgetController {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly titleText: HTMLSpanElement;
  private readonly accountText: HTMLSpanElement;
  private readonly sessionText: HTMLSpanElement;
  private readonly destinationText: HTMLSpanElement;
  private readonly accountButton: HTMLButtonElement;
  private readonly accountIconSlot: HTMLSpanElement;
  private readonly logoutButton: HTMLButtonElement;
  private readonly outputCopyButton: HTMLButtonElement;
  private readonly collapseButtons: HTMLButtonElement[];
  private readonly compactPhasePill: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly phasePill: HTMLSpanElement;
  private readonly startButton: HTMLButtonElement;
  private readonly startLabel: HTMLSpanElement;
  private readonly tabAudioToggleLabel: HTMLLabelElement;
  private readonly tabAudioToggle: HTMLInputElement;
  private readonly targetButtons: HTMLButtonElement[];
  private readonly stopButton: HTMLButtonElement;
  private readonly stopLabel: HTMLSpanElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly pauseLabel: HTMLSpanElement;
  private readonly abortButton: HTMLButtonElement;
  private readonly recordingActions: HTMLDivElement;
  private readonly signInButton: HTMLButtonElement;
  private readonly linkChip: HTMLButtonElement;
  private readonly linkChipLabel: HTMLSpanElement;
  private readonly openLinkButton: HTMLButtonElement;
  private readonly closeButtons: HTMLButtonElement[];
  private readonly dragHandles: HTMLElement[];
  private refreshTimer: number | null = null;
  private refreshInFlight = false;
  private requestRevision = 0;
  private actionInFlight = false;
  private renderedState: PopupState | null = null;
  private localRecordingOperation: RecordingOperation | null = null;
  private lastTitle = "";
  private compact = true;

  constructor() {
    const existing = document.getElementById(floatingWidgetHostId);
    if (existing) {
      existing.remove();
    }

    this.host = document.createElement("div");
    this.host.id = floatingWidgetHostId;
    this.host.dataset.jittleLampWidget = "true";
    this.host.style.position = "fixed";
    this.host.style.left = "50%";
    this.host.style.right = "auto";
    this.host.style.bottom = "18px";
    this.host.style.top = "auto";
    this.host.style.transform = "translateX(-50%)";
    this.host.style.zIndex = "2147483647";
    this.host.style.width = "480px";
    this.host.style.maxWidth = "calc(100vw - 16px)";
    this.host.style.pointerEvents = "auto";
    this.host.hidden = true;

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = floatingWidgetTemplate();
    hydrateFloatingWidgetIcons(this.shadow);
    document.documentElement.append(this.host);

    this.titleText = this.require<HTMLSpanElement>("[data-role='title']");
    this.accountText = this.require<HTMLSpanElement>("[data-role='account']");
    this.sessionText = this.require<HTMLSpanElement>("[data-role='session']");
    this.destinationText = this.require<HTMLSpanElement>("[data-role='destination']");
    this.accountButton = this.require<HTMLButtonElement>("[data-role='account-link']");
    this.accountIconSlot = this.require<HTMLSpanElement>("[data-role='account-icon']");
    this.logoutButton = this.require<HTMLButtonElement>("[data-role='logout']");
    this.outputCopyButton = this.require<HTMLButtonElement>("[data-role='output-copy']");
    this.collapseButtons = this.requireAll<HTMLButtonElement>("[data-role='collapse']");
    this.compactPhasePill = this.require<HTMLSpanElement>("[data-role='compact-phase']");
    this.statusText = this.require<HTMLSpanElement>("[data-role='status']");
    this.phasePill = this.require<HTMLSpanElement>("[data-role='phase']");
    this.startButton = this.require<HTMLButtonElement>("[data-role='start']");
    this.startLabel = this.require<HTMLSpanElement>("[data-role='start-label']");
    this.tabAudioToggleLabel = this.require<HTMLLabelElement>("[data-role='tab-audio-toggle']");
    this.tabAudioToggle = this.require<HTMLInputElement>("[data-role='tab-audio']");
    this.targetButtons = this.requireAll<HTMLButtonElement>("[data-capture-target]");
    this.stopButton = this.require<HTMLButtonElement>("[data-role='stop']");
    this.stopLabel = this.require<HTMLSpanElement>("[data-role='stop-label']");
    this.pauseButton = this.require<HTMLButtonElement>("[data-role='pause']");
    this.pauseLabel = this.require<HTMLSpanElement>("[data-role='pause-label']");
    this.abortButton = this.require<HTMLButtonElement>("[data-role='abort']");
    this.recordingActions = this.require<HTMLDivElement>("[data-role='recording-actions']");
    this.signInButton = this.require<HTMLButtonElement>("[data-role='sign-in']");
    this.linkChip = this.require<HTMLButtonElement>("[data-role='link-chip']");
    this.linkChipLabel = this.require<HTMLSpanElement>("[data-role='link-label']");
    this.openLinkButton = this.require<HTMLButtonElement>("[data-role='open-link']");
    this.closeButtons = this.requireAll<HTMLButtonElement>("[data-role='close']");
    this.dragHandles = this.requireAll<HTMLElement>("[data-role='drag']");
    this.host.dataset.compact = "true";
    this.syncCollapseButton();

    this.bind();
    this.syncRecordingControls(null);
  }

  show(initialState?: PopupState): void {
    if (!this.isMounted()) {
      floatingWidget = new FloatingWidgetController();
      floatingWidget.show(initialState);
      return;
    }

    this.host.hidden = false;
    if (initialState) {
      this.render(initialState);
    }
    void this.refresh();

    if (this.refreshTimer === null) {
      this.refreshTimer = window.setInterval(() => {
        void this.refresh();
      }, floatingWidgetRefreshMs);
    }
  }

  renderIfVisible(state: PopupState): void {
    if (this.host.hidden) {
      return;
    }

    this.render(state);
  }

  toggle(initialState?: PopupState): void {
    if (!this.isMounted()) {
      floatingWidget = new FloatingWidgetController();
      floatingWidget.show(initialState);
      return;
    }

    if (this.host.hidden) {
      this.show(initialState);
      return;
    }

    this.hide();
  }

  hide(): void {
    this.host.hidden = true;

    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async refresh(error?: string): Promise<void> {
    if (this.refreshInFlight || this.localRecordingOperation) {
      return;
    }

    this.refreshInFlight = true;
    const revision = ++this.requestRevision;

    try {
      const response = await sendPopupRequest("jl/popup-get-state");

      if (revision === this.requestRevision) {
        this.render(response.state, error ?? response.error);
      }
    } catch (refreshError: unknown) {
      if (revision === this.requestRevision) {
        this.renderError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        if (!this.renderedState) {
          this.syncRecordingControls(null);
        }
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  private bind(): void {
    this.startButton.addEventListener("click", () => {
      void this.performAction("jl/popup-start-recording", {
        playTabAudio: this.tabAudioToggle.checked,
        captureTarget: this.selectedCaptureTarget()
      });
    });

    for (const recorderOptionElement of [this.tabAudioToggleLabel, this.tabAudioToggle, ...this.targetButtons]) {
      recorderOptionElement.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      recorderOptionElement.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });
    }

    for (const targetButton of this.targetButtons) {
      targetButton.addEventListener("click", () => {
        const target = targetButton.dataset.captureTarget;
        if (target === "tab" || target === "desktop") {
          this.setCaptureTarget(target);
        }
      });
    }

    this.stopButton.addEventListener("click", () => {
      void this.performAction("jl/popup-stop-recording");
    });

    this.pauseButton.addEventListener("click", () => {
      void this.performAction(
        this.pauseButton.dataset.mode === "resume"
          ? "jl/popup-resume-recording"
          : "jl/popup-pause-recording"
      );
    });

    this.abortButton.addEventListener("click", () => {
      void this.performAction("jl/popup-abort-recording");
    });

    this.signInButton.addEventListener("click", () => {
      void this.performAction("jl/popup-start-cloud-sign-in");
    });

    this.accountButton.addEventListener("click", () => {
      openJittleLampWeb("/evidence");
    });

    this.logoutButton.addEventListener("click", () => {
      void this.performAction("jl/popup-logout-cloud");
    });

    this.linkChip.addEventListener("click", () => {
      const cloudUrl = this.linkChip.dataset.cloudUrl;

      if (!cloudUrl) {
        return;
      }

      void copyTextToClipboard(cloudUrl).then((copied) => {
        this.linkChipLabel.textContent = copied ? "Copied" : "Copy failed";
        window.setTimeout(() => {
          if (this.linkChip.dataset.cloudUrl === cloudUrl) {
            this.linkChipLabel.textContent = "Copy URL";
          }
        }, 1_200);
      });
    });

    this.openLinkButton.addEventListener("click", () => {
      const cloudUrl = this.openLinkButton.dataset.cloudUrl;

      if (!cloudUrl) {
        return;
      }

      window.open(cloudUrl, "_blank", "noopener,noreferrer");
    });

    this.outputCopyButton.addEventListener("click", () => {
      const cloudUrl = this.outputCopyButton.dataset.cloudUrl;

      if (!cloudUrl) {
        return;
      }

      void copyTextToClipboard(cloudUrl).then((copied) => {
        this.outputCopyButton.title = copied ? "Copied evidence link" : "Copy failed";
        this.outputCopyButton.setAttribute("aria-label", copied ? "Copied evidence link" : "Copy failed");
        window.setTimeout(() => {
          if (this.outputCopyButton.dataset.cloudUrl === cloudUrl) {
            this.outputCopyButton.title = `Copy ${cloudUrl}`;
            this.outputCopyButton.setAttribute("aria-label", "Copy evidence link");
          }
        }, 1_200);
      });
    });

    for (const collapseButton of this.collapseButtons) {
      collapseButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.compact = !this.compact;
        this.host.dataset.compact = String(this.compact);
        this.syncCollapseButton();
      });
      collapseButton.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    for (const closeButton of this.closeButtons) {
      closeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.destroy();
        floatingWidget = null;
      });
      closeButton.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    }

    for (const dragHandle of this.dragHandles) {
      dragHandle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.beginDrag(event, dragHandle);
      });
    }
  }

  private async performAction(
    type:
      | "jl/popup-start-recording"
      | "jl/popup-stop-recording"
      | "jl/popup-pause-recording"
      | "jl/popup-resume-recording"
      | "jl/popup-abort-recording"
      | "jl/popup-start-cloud-sign-in"
      | "jl/popup-logout-cloud",
    options: { playTabAudio?: boolean; captureTarget?: CaptureTarget } = {}
  ): Promise<void> {
    if (this.actionInFlight) {
      return;
    }

    this.actionInFlight = true;
    this.localRecordingOperation = operationForAction(type);
    const revision = ++this.requestRevision;
    this.syncRecordingControls(this.renderedState);

    try {
      const response = await sendPopupRequest(type, options);

      if (revision === this.requestRevision) {
        this.localRecordingOperation = null;
        this.render(response.state, response.error);
      }
    } catch (error: unknown) {
      this.localRecordingOperation = null;
      await this.refresh(error instanceof Error ? error.message : String(error));
    } finally {
      this.actionInFlight = false;
      this.syncRecordingControls(this.renderedState);
    }
  }

  private render(state: PopupState, error?: string): void {
    this.renderedState = state;
    const activeSession = state.activeSession;
    const phase = activeSession?.phase ?? "idle";
    const visiblePhase = state.recordingOperation ?? phase;
    const title = activeSession?.name ?? pageFallbackTitle();
    const account = describeAccount(state);
    const destination = describeDestination(state);
    const session = activeSession?.name ?? "No active session";

    this.lastTitle = title;
    this.titleText.textContent = title;
    this.titleText.title = title;
    this.accountText.textContent = account;
    this.accountText.title = account;
    this.sessionText.textContent = session;
    this.sessionText.title = session;
    this.destinationText.textContent = destination;
    this.destinationText.title = destination;
    const phaseLabel = statusPhaseLabel(visiblePhase, error);
    this.phasePill.textContent = phaseLabel;
    this.phasePill.dataset.phase = visiblePhase;
    this.phasePill.title = phaseLabel;
    this.phasePill.setAttribute("aria-label", phaseLabel);
    this.compactPhasePill.textContent = phaseLabel;
    this.compactPhasePill.dataset.phase = visiblePhase;
    this.compactPhasePill.title = phaseLabel;
    this.compactPhasePill.setAttribute("aria-label", phaseLabel);
    const status = error ?? widgetStatusText(state);
    this.statusText.textContent = status;
    this.statusText.dataset.tone = error ? "error" : "neutral";
    this.statusText.setAttribute("role", error ? "alert" : "status");
    this.accountButton.title = "Open evidence list";
    this.accountButton.setAttribute("aria-label", "Open evidence list");
    hydrateIconSlot(this.accountIconSlot, state.cloud.status === "signed-in" ? "User" : "Monitor");

    const cloudUrl = activeSession?.statusText ? extractFirstUrl(activeSession.statusText) : undefined;
    this.linkChip.hidden = false;
    this.linkChip.disabled = !cloudUrl;
    this.linkChipLabel.textContent = cloudUrl ? "Copy URL" : "No recent session";
    this.linkChip.title = cloudUrl ? `Copy ${cloudUrl}` : "No recent evidence session.";
    this.linkChip.setAttribute("aria-label", cloudUrl ? "Copy evidence URL" : "No recent evidence session");
    this.linkChip.dataset.cloudUrl = cloudUrl ?? "";
    this.openLinkButton.hidden = !cloudUrl;
    this.openLinkButton.disabled = !cloudUrl;
    this.openLinkButton.title = cloudUrl ? `Open ${cloudUrl}` : "No recent evidence session.";
    this.openLinkButton.setAttribute("aria-label", cloudUrl ? "Open evidence link" : "No recent evidence session");
    this.openLinkButton.dataset.cloudUrl = cloudUrl ?? "";
    this.outputCopyButton.hidden = !cloudUrl;
    this.outputCopyButton.disabled = !cloudUrl;
    this.outputCopyButton.title = cloudUrl ? `Copy ${cloudUrl}` : "No recent evidence session.";
    this.outputCopyButton.setAttribute("aria-label", cloudUrl ? "Copy evidence link" : "No recent evidence session");
    this.outputCopyButton.dataset.cloudUrl = cloudUrl ?? "";

    this.signInButton.hidden = state.cloud.status === "signed-in";
    this.logoutButton.hidden = state.cloud.status !== "signed-in";
    this.logoutButton.disabled = state.cloud.status !== "signed-in";
    this.syncRecordingControls(state);
  }

  private renderError(message: string): void {
    this.statusText.textContent = message;
    this.statusText.dataset.tone = "error";
    this.phasePill.textContent = "FAILED";
    this.phasePill.dataset.phase = "failed";
    this.phasePill.title = "FAILED";
    this.phasePill.setAttribute("aria-label", "FAILED");
    this.compactPhasePill.textContent = "FAILED";
    this.compactPhasePill.dataset.phase = "failed";
    this.compactPhasePill.title = "FAILED";
    this.compactPhasePill.setAttribute("aria-label", "FAILED");
  }

  private syncRecordingControls(state: PopupState | null): void {
    const controls = deriveRecordingControlState(state, this.localRecordingOperation);
    const forceDisabled = this.actionInFlight;

    this.syncControlButton(this.startButton, this.startLabel, controls.start, forceDisabled);
    this.syncControlButton(this.stopButton, this.stopLabel, controls.finish, forceDisabled);
    this.syncControlButton(this.pauseButton, this.pauseLabel, controls.pause, forceDisabled);
    this.syncIconControlButton(this.abortButton, controls.abort, forceDisabled);

    this.recordingActions.hidden =
      !controls.finish.visible && !controls.pause.visible && !controls.abort.visible;
    this.tabAudioToggle.disabled = forceDisabled || controls.busy || !state?.canStart;
    for (const targetButton of this.targetButtons) {
      targetButton.disabled = forceDisabled || controls.busy || !state?.canStart;
    }
    this.syncCaptureTargetButtons();

    this.pauseButton.dataset.mode = controls.pause.mode;
    this.pauseButton.title = controls.pause.label;
    this.pauseButton.setAttribute("aria-label", controls.pause.label);
    hydrateButtonIcon(this.pauseButton, controls.pause.mode === "resume" ? "Play" : "Pause");

    this.signInButton.disabled = forceDisabled || this.signInButton.hidden === true;
    this.logoutButton.disabled = forceDisabled || this.logoutButton.hidden === true;
    this.outputCopyButton.disabled = forceDisabled || this.outputCopyButton.hidden === true;
    this.host.dataset.busy = String(controls.busy || forceDisabled);
    this.host.dataset.operation = this.localRecordingOperation ?? state?.recordingOperation ?? "";
  }

  private syncControlButton(
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

  private syncIconControlButton(
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

  private syncCollapseButton(): void {
    const title = this.compact ? "Expand details" : "Minimize";
    for (const collapseButton of this.collapseButtons) {
      collapseButton.title = title;
      collapseButton.setAttribute("aria-label", title);
      hydrateButtonIcon(collapseButton, this.compact ? "Maximize2" : "Minimize2");
    }
  }

  private selectedCaptureTarget(): CaptureTarget {
    const activeButton = this.targetButtons.find((button) => button.dataset.active === "true");
    return activeButton?.dataset.captureTarget === "desktop" ? "desktop" : "tab";
  }

  private setCaptureTarget(captureTarget: CaptureTarget): void {
    for (const targetButton of this.targetButtons) {
      const active = targetButton.dataset.captureTarget === captureTarget;
      targetButton.dataset.active = String(active);
      targetButton.setAttribute("aria-pressed", String(active));
    }
  }

  private syncCaptureTargetButtons(): void {
    this.setCaptureTarget(this.selectedCaptureTarget());
  }

  private destroy(): void {
    this.hide();
    this.host.remove();
  }

  isMounted(): boolean {
    return this.host.isConnected && document.getElementById(floatingWidgetHostId) === this.host;
  }

  private beginDrag(event: PointerEvent, dragHandle: HTMLElement): void {
    if (event.button !== 0) {
      return;
    }

    const rect = this.host.getBoundingClientRect();
    const pointerOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };

    dragHandle.setPointerCapture(event.pointerId);
    this.host.style.right = "auto";
    this.host.style.bottom = "auto";
    this.host.style.transform = "none";
    this.host.style.left = `${rect.left}px`;
    this.host.style.top = `${rect.top}px`;

    const move = (moveEvent: PointerEvent): void => {
      const nextLeft = clamp(moveEvent.clientX - pointerOffset.x, 8, window.innerWidth - rect.width - 8);
      const nextTop = clamp(moveEvent.clientY - pointerOffset.y, 8, window.innerHeight - rect.height - 8);
      this.host.style.left = `${nextLeft}px`;
      this.host.style.top = `${nextTop}px`;
    };

    const stop = (upEvent: PointerEvent): void => {
      dragHandle.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", stop, true);
    };

    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", stop, true);
  }

  private require<ElementType extends Element>(selector: string): ElementType {
    const element = this.shadow.querySelector<ElementType>(selector);

    if (!element) {
      throw new Error(`Missing floating widget element: ${selector}`);
    }

    return element;
  }

  private requireAll<ElementType extends Element>(selector: string): ElementType[] {
    const elements = Array.from(this.shadow.querySelectorAll<ElementType>(selector));

    if (elements.length === 0) {
      throw new Error(`Missing floating widget elements: ${selector}`);
    }

    return elements;
  }
}

async function sendPopupRequest(
  type:
    | "jl/popup-get-state"
    | "jl/popup-start-recording"
    | "jl/popup-stop-recording"
    | "jl/popup-pause-recording"
    | "jl/popup-resume-recording"
    | "jl/popup-abort-recording"
    | "jl/popup-start-cloud-sign-in"
    | "jl/popup-logout-cloud",
  options: { playTabAudio?: boolean; captureTarget?: CaptureTarget } = {}
): Promise<PopupResponse> {
  return popupResponseSchema.parse(
    await chrome.runtime.sendMessage({
      type,
      ...(type === "jl/popup-start-recording"
        ? {
            playTabAudio: options.playTabAudio ?? false,
            captureTarget: options.captureTarget ?? "tab",
            requestSiteAccess: true
          }
        : {})
    })
  );
}

function showFloatingWidget(initialState?: PopupState): void {
  ensureFloatingWidget().show(initialState);
}

function toggleFloatingWidget(initialState?: PopupState): void {
  ensureFloatingWidget().toggle(initialState);
}

function ensureFloatingWidget(): FloatingWidgetController {
  if (!floatingWidget || !floatingWidget.isMounted()) {
    floatingWidget = new FloatingWidgetController();
  }

  return floatingWidget;
}

function isFloatingWidgetEvent(event: Event): boolean {
  return event.composedPath().some(
    (target) => target instanceof HTMLElement && target.dataset.jittleLampWidget === "true"
  );
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
    default:
      return null;
  }
}

function widgetStatusText(state: PopupState): string {
  switch (state.recordingOperation) {
    case "starting":
      return "Starting capture…";
    case "stopping":
      return "Stopping capture and saving the session…";
    case "pausing":
      return "Pausing capture…";
    case "resuming":
      return "Resuming capture…";
    case "aborting":
      return "Discarding this recording…";
    case "retrying-upload":
      return "Retrying cloud upload…";
  }

  if (state.activeSession?.phase === "recording") {
    return state.cloud.status === "signed-in"
      ? "Recording. Finish to upload to cloud, or abort to discard."
      : state.companion.status === "online"
        ? "Recording. Finish to save locally, or abort to discard."
        : "Recording. Finish to download locally, or abort to discard.";
  }

  if (state.activeSession?.phase === "paused") {
    return "Recording paused. Resume, finish, or abort the session.";
  }

  if (state.cloud.status === "signed-in") {
    return "Ready to record. Cloud upload is enabled.";
  }

  if (state.companion.status === "online") {
    return "Ready to record. Companion save is enabled.";
  }

  return "Ready to record. Output will download in the browser.";
}

function statusPhaseLabel(phase: string, error?: string): string {
  if (phase === "failed") {
    return "FAILED";
  }

  if (phase === "processing" || phase === "stopping" || phase === "retrying-upload") {
    return "SAVING";
  }

  if (phase === "armed" || phase === "starting") {
    return "STARTING";
  }

  if (phase === "pausing") {
    return "PAUSING";
  }

  if (phase === "paused") {
    return "PAUSED";
  }

  if (phase === "resuming") {
    return "RESUMING";
  }

  if (phase === "aborting") {
    return "DISCARDING";
  }

  if (phase === "recording") {
    return "RECORDING";
  }

  if (error) {
    return "FAILED";
  }

  return "READY";
}

function describeAccount(state: PopupState): string {
  if (state.cloud.status === "signed-in") {
    return state.cloud.accountLabel
      ? `Signed in · ${state.cloud.accountLabel}`
      : `Signed in · ${state.cloud.origin ? new URL(state.cloud.origin).host : "Jittle Lamp web"}`;
  }

  if (state.cloud.status === "signed-out") {
    return state.cloud.error ?? "Not signed in";
  }

  return state.cloud.error ?? "Checking sign-in";
}

function describeDestination(state: PopupState): string {
  if (state.cloud.status === "signed-in") {
    return "Cloud upload";
  }

  if (state.companion.status === "online") {
    return state.companion.outputDir ? `Companion · ${state.companion.outputDir}` : "Desktop companion";
  }

  return "Browser download";
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 14 ? `${sessionId.slice(0, 7)}…${sessionId.slice(-4)}` : sessionId;
}

function pageFallbackTitle(): string {
  return document.title.trim() || new URL(window.location.href).hostname || "Jittle Lamp session";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const floatingWidgetIcons = {
  BookOpen,
  CircleStop,
  Copy,
  ExternalLink,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Move,
  PanelTop,
  Play,
  User,
  X
};

type FloatingWidgetIconName = keyof typeof floatingWidgetIcons;

function hydrateFloatingWidgetIcons(root: ShadowRoot): void {
  for (const slot of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const iconName = slot.dataset.icon;
    if (isFloatingWidgetIconName(iconName)) {
      hydrateIconSlot(slot, iconName);
    }
  }
}

function hydrateButtonIcon(button: HTMLButtonElement, iconName: FloatingWidgetIconName): void {
  const slot = button.querySelector<HTMLElement>("[data-icon]");
  if (slot) {
    hydrateIconSlot(slot, iconName);
  }
}

function hydrateIconSlot(slot: HTMLElement, iconName: FloatingWidgetIconName): void {
  slot.dataset.icon = iconName;
  const svg = createElement(floatingWidgetIcons[iconName]);
  svg.classList.add("jl-icon-svg");
  svg.setAttribute("aria-hidden", "true");
  slot.replaceChildren(svg);
}

function isFloatingWidgetIconName(value: unknown): value is FloatingWidgetIconName {
  return typeof value === "string" && value in floatingWidgetIcons;
}

function openJittleLampWeb(path: string): void {
  const url = new URL(path, `${configuredCloudWebOrigin}/`);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "true");
    input.style.position = "fixed";
    input.style.top = "-1000px";
    input.style.left = "-1000px";
    document.body.append(input);
    input.select();

    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      input.remove();
    }
  }
}

function extractFirstUrl(message: string): string | undefined {
  return message.match(/https?:\/\/[^\s)]+/)?.[0];
}

function floatingWidgetTemplate(): string {
  return `
    <style>
      :host {
        all: initial;
      }

      .jl-float {
        box-sizing: border-box;
        width: 100%;
        max-width: calc(100vw - 24px);
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 6px;
        background: #0f0f0f;
        color: #efefef;
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(0, 0, 0, 0.42);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.4;
        opacity: 0.62;
        transition: opacity 140ms ease, box-shadow 140ms ease;
      }

      .jl-float:hover,
      .jl-float:focus-within {
        opacity: 1;
      }

      .jl-head {
        display: none;
        justify-content: flex-end;
        padding: 4px 6px 0;
        cursor: grab;
        user-select: none;
      }

      .jl-head:active {
        cursor: grabbing;
      }

      .jl-brand {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 8px;
        color: #efefef;
        font-size: 12px;
        font-weight: 700;
      }

      .jl-dot {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        background: #22c55e;
        box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(34, 197, 94, 0.35);
      }

      .jl-tools {
        display: flex;
        gap: 4px;
      }

      .jl-icon {
        width: 24px;
        height: 24px;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: #888888;
        cursor: pointer;
        font: inherit;
        font-size: 15px;
        line-height: 1;
      }

      .jl-icon:hover {
        background: #181818;
        color: #efefef;
      }

      .jl-body {
        display: grid;
        gap: 8px;
        padding: 8px;
      }

      [hidden] {
        display: none !important;
      }

      .jl-compact-status {
        display: none;
      }

      .jl-compact {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .jl-widget-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-left: auto;
      }

      .jl-drag-zone {
        position: relative;
        display: inline-grid;
        place-items: center;
        flex: 0 0 32px;
        width: 32px;
        height: 32px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 4px;
        background: #151515;
        color: #888888;
        cursor: grab;
        font: inherit;
        user-select: none;
      }

      .jl-drag-zone:hover {
        border-color: rgba(34, 197, 94, 0.28);
        background: #181818;
        color: #22c55e;
      }

      .jl-drag-zone:active {
        cursor: grabbing;
      }

      .jl-tool-button {
        display: inline-grid;
        place-items: center;
        width: 32px;
        height: 32px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 4px;
        background: #181818;
        color: #888888;
        cursor: pointer;
      }

      .jl-tool-button:hover {
        border-color: rgba(34, 197, 94, 0.4);
        color: #22c55e;
      }

      .jl-icon-svg {
        width: 16px;
        height: 16px;
        stroke-width: 2.2;
      }

      .jl-title {
        display: none;
      }

      .jl-meta {
        display: none;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .jl-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        flex: 0 0 92px;
        width: 92px;
        height: 32px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 4px;
        padding: 0 8px;
        background: #181818;
        color: #888888;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        line-height: 1;
        text-align: center;
        white-space: nowrap;
      }

      .jl-pill::before {
        content: "";
        flex: 0 0 auto;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #888888;
      }

      .jl-pill[data-phase="recording"],
      .jl-pill[data-phase="ready"] {
        border-color: rgba(34, 197, 94, 0.4);
        background: rgba(34, 197, 94, 0.16);
        color: #22c55e;
      }

      .jl-pill[data-phase="recording"]::before,
      .jl-pill[data-phase="ready"]::before {
        background: #22c55e;
        animation: jl-status-blink 1.15s ease-in-out infinite;
      }

      .jl-pill[data-phase="processing"],
      .jl-pill[data-phase="armed"] {
        border-color: rgba(245, 158, 11, 0.34);
        background: rgba(245, 158, 11, 0.14);
        color: #f59e0b;
      }

      .jl-pill[data-phase="processing"]::before,
      .jl-pill[data-phase="armed"]::before {
        background: #f59e0b;
        animation: jl-status-blink 0.75s ease-in-out infinite;
      }

      .jl-pill[data-phase="failed"] {
        border-color: rgba(239, 68, 68, 0.32);
        background: rgba(239, 68, 68, 0.14);
        color: #ef4444;
      }

      .jl-pill[data-phase="failed"]::before {
        background: #ef4444;
        animation: jl-status-blink 0.55s ease-in-out infinite;
      }

      @keyframes jl-status-blink {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.82); }
      }

      .jl-muted {
        color: #888888;
      }

      .jl-grid {
        display: grid;
        gap: 6px;
      }

      .jl-row {
        display: grid;
        grid-template-columns: 82px minmax(0, 1fr);
        gap: 12px;
        align-items: baseline;
        padding: 2px 0;
        background: transparent;
      }

      .jl-row-action {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        min-width: 0;
      }

      .jl-row-action .jl-value {
        flex: 1 1 auto;
      }

      .jl-label {
        color: #888888;
        font-size: 11px;
      }

      .jl-value,
      .jl-status {
        min-width: 0;
        color: #efefef;
        overflow-wrap: anywhere;
      }

      .jl-status {
        color: #888888;
      }

      .jl-status[data-tone="error"] {
        color: #ef4444;
      }

      .jl-inline-button {
        display: inline-grid;
        place-items: center;
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 4px;
        background: #181818;
        color: #888888;
        cursor: pointer;
      }

      .jl-inline-button:hover:not(:disabled) {
        border-color: rgba(239, 68, 68, 0.36);
        color: #ef4444;
      }

      .jl-inline-button[data-role="output-copy"]:hover:not(:disabled) {
        border-color: rgba(34, 197, 94, 0.4);
        color: #22c55e;
      }

      .jl-inline-button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .jl-actions {
        display: grid;
        gap: 8px;
      }

      .jl-record-panel {
        display: grid;
        grid-template-columns: minmax(0, 1fr) max-content;
        align-items: center;
        gap: 8px;
      }

      .jl-button {
        width: 100%;
        min-height: 56px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 6px;
        padding: 0 12px;
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        font-weight: 700;
        text-align: left;
        transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
      }

      .jl-button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .jl-start {
        position: relative;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr);
        align-items: center;
        gap: 10px;
        background: #181818;
        color: #efefef;
      }

      .jl-rec-options {
        display: grid;
        grid-template-columns: max-content max-content;
        grid-template-rows: 10px 30px;
        align-items: center;
        column-gap: 10px;
        row-gap: 5px;
        justify-items: start;
      }

      .jl-rec-option {
        display: contents;
      }

      .jl-rec-label {
        color: #505050;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0;
        line-height: 1;
        text-transform: uppercase;
      }

      .jl-audio-toggle .jl-rec-label {
        grid-column: 1;
        grid-row: 1;
      }

      .jl-audio-toggle input {
        grid-column: 1;
        grid-row: 2;
      }

      .jl-rec-option:not(.jl-audio-toggle) .jl-rec-label {
        grid-column: 2;
        grid-row: 1;
      }

      .jl-target-segment {
        grid-column: 2;
        grid-row: 2;
      }

      .jl-audio-toggle {
        display: contents;
        color: #888888;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        user-select: none;
      }

      .jl-audio-toggle input {
        appearance: none;
        align-self: center;
        position: relative;
        width: 38px;
        height: 22px;
        margin: 0;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        background: #0f0f0f;
        cursor: pointer;
      }

      .jl-audio-toggle input::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 14px;
        height: 14px;
        border-radius: 999px;
        background: #888888;
        transition: transform 120ms ease, background-color 120ms ease;
      }

      .jl-audio-toggle input:checked {
        border-color: rgba(34, 197, 94, 0.55);
        background: rgba(34, 197, 94, 0.18);
      }

      .jl-audio-toggle input:checked::after {
        transform: translateX(16px);
        background: #22c55e;
      }

      .jl-audio-toggle input:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .jl-target-segment {
        display: inline-grid;
        align-self: center;
        grid-template-columns: repeat(2, 30px);
        gap: 2px;
        padding: 2px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 6px;
        background: #0f0f0f;
      }

      .jl-target-button {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: #888888;
        cursor: pointer;
      }

      .jl-target-button[data-active="true"] {
        background: rgba(34, 197, 94, 0.18);
        color: #22c55e;
      }

      .jl-target-button:hover:not(:disabled) {
        color: #efefef;
      }

      .jl-target-button:disabled {
        cursor: default;
        opacity: 0.55;
      }

      .jl-start:hover:not(:disabled) {
        border-color: rgba(34, 197, 94, 0.4);
        background: #1f1f1f;
      }

      .jl-action-icon {
        display: inline-grid;
        place-items: center;
        width: 30px;
        height: 30px;
        border-radius: 3px;
        background: rgba(34, 197, 94, 0.16);
        color: #22c55e;
        font-size: 18px;
        line-height: 1;
      }

      .jl-start::after {
        content: none;
      }

      .jl-recording-actions {
        display: flex;
        gap: 8px;
        min-width: 0;
      }

      .jl-recording-actions[hidden] {
        display: none;
      }

      .jl-record-action {
        display: inline-grid;
        place-items: center;
        min-height: 56px;
        padding: 0;
      }

      .jl-finish {
        flex: 1 1 auto;
        grid-template-columns: 34px minmax(0, 1fr);
        align-items: center;
        justify-items: start;
        gap: 10px;
        min-width: 0;
        width: auto;
        max-width: none;
        padding: 0 12px;
        background: rgba(34, 197, 94, 0.12);
        color: #efefef;
        border-color: rgba(34, 197, 94, 0.32);
        text-align: left;
      }

      .jl-abort {
        flex: 0 0 56px;
        width: 56px;
        min-width: 56px;
        max-width: 56px;
        background: rgba(239, 68, 68, 0.14);
        color: #efefef;
        border-color: rgba(239, 68, 68, 0.32);
      }

      .jl-finish .jl-action-icon {
        background: rgba(34, 197, 94, 0.14);
        color: #22c55e;
      }

      .jl-abort .jl-action-icon {
        background: rgba(239, 68, 68, 0.14);
        color: #ef4444;
      }

      .jl-record-action::after {
        content: none;
      }

      .jl-button[hidden] {
        display: none;
      }

      .jl-record-panel:has(.jl-start[hidden]) {
        display: none;
      }

      .jl-expanded {
        display: grid;
        gap: 8px;
      }

      .jl-expanded-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .jl-expanded-brand {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 8px;
      }

      .jl-request-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 32px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 4px;
        background: #181818;
        color: #efefef;
        font-weight: 700;
      }

      .jl-link-copy {
        flex: 1 1 0;
        min-width: 96px;
      }

      .jl-request-chip .jl-action-icon {
        width: 14px;
        height: 14px;
      }

      .jl-request-chip:not(:disabled) {
        cursor: pointer;
      }

      .jl-request-chip:hover:not(:disabled) {
        border-color: rgba(34, 197, 94, 0.4);
        color: #22c55e;
      }

      .jl-sign-in {
        cursor: pointer;
      }

      .jl-sign-in:hover:not(:disabled) {
        border-color: rgba(34, 197, 94, 0.4);
        color: #22c55e;
      }

      .jl-sign-in[hidden] {
        display: none;
      }

      .jl-request-chip[hidden] {
        display: none;
      }

      .jl-request-chip:disabled {
        cursor: default;
        opacity: 0.75;
      }

      .jl-open-link {
        width: 32px;
        min-width: 32px;
        padding: 0;
      }

      .jl-evidence-link {
        flex: 0 0 32px;
      }

      :host([data-compact="true"]) .jl-expanded {
        display: none;
      }

      :host([data-compact="true"]) .jl-expanded-head {
        display: none;
      }

      :host([data-compact="false"]) {
        width: min(480px, calc(100vw - 16px));
      }

      :host([data-compact="false"]) .jl-compact {
        display: none;
      }
    </style>
    <section class="jl-float" aria-label="Jittle Lamp recorder">
      <header class="jl-head" data-role="drag">
        <div class="jl-brand"><span class="jl-dot"></span><span>Jittle Lamp</span></div>
        <div class="jl-tools">
          <button class="jl-icon" data-role="close" type="button" title="Hide" aria-label="Hide">
            <span data-icon="X"></span>
          </button>
        </div>
      </header>
      <div class="jl-body">
        <div class="jl-compact">
          <span class="jl-pill" data-role="compact-phase" data-phase="idle">READY</span>
          <button class="jl-tool-button jl-evidence-link" data-role="account-link" type="button" title="Open evidence list" aria-label="Open evidence list">
            <span data-role="account-icon" data-icon="User"></span>
          </button>
          <button class="jl-request-chip jl-open-link" data-role="open-link" type="button" disabled aria-label="No recent evidence session">
            <span class="jl-action-icon" data-icon="ExternalLink"></span>
          </button>
          <button class="jl-request-chip jl-link-copy" data-role="link-chip" type="button" disabled>
            <span class="jl-action-icon" data-icon="Copy"></span>
            <span data-role="link-label">No recent session</span>
          </button>
          <div class="jl-widget-actions">
            <button class="jl-drag-zone" data-role="drag" type="button" title="Drag recorder" aria-label="Drag recorder">
              <span data-icon="Move"></span>
            </button>
            <button class="jl-tool-button" data-role="collapse" type="button" title="Expand details" aria-label="Expand details">
              <span data-icon="Maximize2"></span>
            </button>
            <button class="jl-tool-button" data-role="close" type="button" title="Close overlay" aria-label="Close overlay">
              <span data-icon="X"></span>
            </button>
          </div>
        </div>
        <div class="jl-expanded-head">
          <div class="jl-expanded-brand">
            <span class="jl-dot"></span>
            <span class="jl-brand">Jittle Lamp</span>
          </div>
          <div class="jl-widget-actions">
            <span class="jl-pill" data-role="phase" data-phase="idle">READY</span>
            <button class="jl-drag-zone" data-role="drag" type="button" title="Drag recorder" aria-label="Drag recorder">
              <span data-icon="Move"></span>
            </button>
            <button class="jl-tool-button" data-role="collapse" type="button" title="Minimize" aria-label="Minimize">
              <span data-icon="Minimize2"></span>
            </button>
            <button class="jl-tool-button" data-role="close" type="button" title="Close overlay" aria-label="Close overlay">
              <span data-icon="X"></span>
            </button>
          </div>
        </div>
        <div class="jl-actions">
          <div class="jl-record-panel">
            <button class="jl-button jl-start" data-role="start" type="button">
              <span class="jl-action-icon" data-icon="Play"></span>
              <span>Start capture</span>
            </button>
            <div class="jl-rec-options" aria-label="Recording options">
              <label class="jl-audio-toggle jl-rec-option" data-role="tab-audio-toggle" title="Play captured sound while recording">
                <span class="jl-rec-label">Sound</span>
                <input data-role="tab-audio" type="checkbox" aria-label="Play captured sound while recording" />
              </label>
              <div class="jl-rec-option">
                <span class="jl-rec-label">Target</span>
                <div class="jl-target-segment" role="group" aria-label="Recording target">
                  <button
                    class="jl-target-button"
                    data-capture-target="tab"
                    data-active="true"
                    type="button"
                    title="Record active tab"
                    aria-label="Record active tab"
                    aria-pressed="true"
                  >
                    <span data-icon="PanelTop"></span>
                  </button>
                  <button
                    class="jl-target-button"
                    data-capture-target="desktop"
                    data-active="false"
                    type="button"
                    title="Record selected screen or window"
                    aria-label="Record selected screen or window"
                    aria-pressed="false"
                  >
                    <span data-icon="Monitor"></span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div class="jl-recording-actions" data-role="recording-actions" hidden>
            <button class="jl-button jl-record-action jl-finish" data-role="stop" type="button" title="Finish recording" aria-label="Finish recording" hidden>
              <span class="jl-action-icon" data-icon="CircleStop"></span>
              <span>Finish recording</span>
            </button>
            <button class="jl-button jl-record-action jl-abort" data-role="abort" type="button" title="Abort recording" aria-label="Abort recording" hidden>
              <span class="jl-action-icon" data-icon="X"></span>
            </button>
          </div>
        </div>
        <div class="jl-expanded">
          <span class="jl-title" data-role="title">Jittle Lamp session</span>
          <div class="jl-grid">
            <div class="jl-row">
              <span class="jl-label">Account</span>
              <div class="jl-row-action">
                <span class="jl-value" data-role="account">Checking sign-in</span>
                <button class="jl-inline-button" data-role="logout" type="button" title="Log out" aria-label="Log out" hidden>
                  <span data-icon="LogOut"></span>
                </button>
              </div>
            </div>
            <div class="jl-row">
              <span class="jl-label">Session</span>
              <span class="jl-value" data-role="session">No active session</span>
            </div>
            <div class="jl-row">
              <span class="jl-label">Output</span>
              <div class="jl-row-action">
                <span class="jl-value" data-role="destination">Browser download</span>
                <button class="jl-inline-button" data-role="output-copy" type="button" title="No recent evidence session." aria-label="No recent evidence session" hidden>
                  <span data-icon="Copy"></span>
                </button>
              </div>
            </div>
          </div>
          <span class="jl-status" data-role="status" hidden>Ready.</span>
        </div>
        <button class="jl-request-chip jl-sign-in" data-role="sign-in" type="button">Sign in</button>
      </div>
    </section>
  `;
}

function isNetworkProbeMessage(value: unknown): value is { source: "jittle-lamp-network-probe"; payload: NetworkProbePayload } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { source?: unknown; payload?: unknown };
  const payload = candidate.payload as Partial<NetworkProbePayload> | undefined;

  return (
    candidate.source === "jittle-lamp-network-probe" &&
    Boolean(payload) &&
    typeof payload?.method === "string" &&
    typeof payload.url === "string" &&
    Array.isArray(payload.requestHeaders) &&
    Array.isArray(payload.responseHeaders)
  );
}

function patchHistoryMethod(methodName: "pushState" | "replaceState"): void {
  const original = history[methodName];

  history[methodName] = function patchedHistoryMethod(...args) {
    const result = original.apply(this, args);
    void announceNavigation(methodName);
    return result;
  };
}

function describeElement(element: Element | null): string | undefined {
  if (!element) {
    return undefined;
  }

  const testId = getTestId(element);
  if (testId) {
    return `[${testId.attribute}="${escapeAttributeValue(testId.value)}"]`;
  }

  if (element.id) {
    return `#${cssEscape(element.id)}`;
  }

  return buildRelativeDomSelector(element);
}

function nodeToElement(node: Node | null): Element | null {
  if (!node) {
    return null;
  }

  if (node instanceof Element) {
    return node;
  }

  return node.parentElement;
}

function sanitizeSelectedText(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 500);
}

function buildRelativeDomSelector(element: Element): string | undefined {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.documentElement && segments.length < 5) {
    segments.unshift(buildRelativeSegment(current));
    current = current.parentElement;
  }

  return segments.join(" > ") || undefined;
}

function buildRelativeSegment(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const inputType = element instanceof HTMLInputElement && element.type ? `[type="${escapeAttributeValue(element.type)}"]` : "";
  const parent = element.parentElement;

  if (!parent) {
    return `${tagName}${inputType}`;
  }

  const sameTagSiblings = Array.from(parent.children).filter((sibling) => sibling.tagName === element.tagName);

  if (sameTagSiblings.length <= 1) {
    return `${tagName}${inputType}`;
  }

  const position = sameTagSiblings.indexOf(element) + 1;
  return `${tagName}${inputType}:nth-of-type(${position})`;
}

function describeElementTarget(element: Element | null): {
  selector?: string;
  target?: {
    selector?: string;
    selectorAlternates: string[];
    tagName?: string;
    dataTestId?: string;
    id?: string;
    name?: string;
    role?: string | null;
    href?: string;
    textPreview?: string;
    inputType?: string;
    rect?: { left: number; top: number; width: number; height: number };
  };
} {
  if (!element) {
    return {};
  }

  const selector = describeElement(element);
  const selectorAlternates = buildSelectorAlternates(element, selector);
  const rect = element.getBoundingClientRect();
  const textPreview = describeElementText(element);
  const href = element instanceof HTMLAnchorElement && element.href ? sanitizeCapturedUrl(element.href) : undefined;
  const inputType = element instanceof HTMLInputElement && element.type ? element.type : undefined;
  const testId = getTestId(element)?.value;

  return {
    ...(selector ? { selector } : {}),
    target: {
      ...(selector ? { selector } : {}),
      selectorAlternates,
      tagName: element.tagName.toLowerCase(),
      ...(testId ? { dataTestId: testId } : {}),
      ...(element.id ? { id: element.id } : {}),
      ...(element.getAttribute("name") ? { name: element.getAttribute("name")! } : {}),
      role: element.getAttribute("role"),
      ...(href ? { href } : {}),
      ...(textPreview ? { textPreview } : {}),
      ...(inputType ? { inputType } : {}),
      rect: {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }
    }
  };
}

function buildSelectorAlternates(element: Element, primarySelector?: string): string[] {
  const alternates = new Set<string>();

  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test-id");
  if (testId) {
    const attribute = element.hasAttribute("data-testid") ? "data-testid" : "data-test-id";
    alternates.add(`[${attribute}="${escapeAttributeValue(testId)}"]`);
  }

  if (element.id) {
    alternates.add(`#${cssEscape(element.id)}`);
  }

  if (primarySelector) {
    alternates.add(primarySelector);
  }

  const name = element.getAttribute("name");
  if (name) {
    alternates.add(`${element.tagName.toLowerCase()}[name="${escapeAttributeValue(name)}"]`);
  }

  return Array.from(alternates).slice(0, 6);
}

function getTestId(element: Element): { attribute: "data-testid" | "data-test-id"; value: string } | undefined {
  const dataTestId = element.getAttribute("data-testid");

  if (dataTestId) {
    return { attribute: "data-testid", value: dataTestId };
  }

  const dataTestDashId = element.getAttribute("data-test-id");

  if (dataTestDashId) {
    return { attribute: "data-test-id", value: dataTestDashId };
  }

  return undefined;
}

function describeElementText(element: Element): string | undefined {
  const candidates = [
    element.getAttribute("aria-label"),
    element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) ? element.value : undefined,
    element.textContent,
    element.getAttribute("title"),
    element.getAttribute("alt"),
    element.getAttribute("placeholder")
  ];

  for (const candidate of candidates) {
    const normalized = candidate?.trim().replace(/\s+/g, " ").slice(0, 240);

    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function cssEscape(value: string): string {
  const stringValue = String(value);
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(stringValue)
    : stringValue.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function collectPageMetrics() {
  const documentElement = document.documentElement;
  const body = document.body;

  return {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight
    },
    document: {
      width: Math.max(documentElement?.scrollWidth ?? 0, body?.scrollWidth ?? 0, window.innerWidth),
      height: Math.max(documentElement?.scrollHeight ?? 0, body?.scrollHeight ?? 0, window.innerHeight)
    },
    scroll: {
      x: window.scrollX,
      y: window.scrollY
    },
    devicePixelRatio: window.devicePixelRatio,
    url: sanitizeCapturedUrl(window.location.href),
    ...(document.title ? { title: document.title } : {})
  };
}

function collectModifierState(event: MouseEvent | KeyboardEvent) {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey
  };
}

function snapshotFieldValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const redacted = isSensitiveField(field);
  const inputKind = inferInputKind(field);
  const stringValue = "value" in field ? String(field.value ?? "") : "";

  return {
    inputType: undefined,
    inputKind,
    valuePreview: redacted ? `[redacted ${stringValue.length} chars]` : stringValue.slice(0, 240),
    ...(redacted ? { redacted: true } : { value: stringValue }),
    valueLength: stringValue.length,
    ...(field instanceof HTMLInputElement && (field.type === "checkbox" || field.type === "radio") ? { checked: field.checked } : {}),
    ...(field instanceof HTMLSelectElement ? { selectedIndex: field.selectedIndex } : {}),
    ...((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && typeof field.selectionStart === "number" ? { selectionStart: field.selectionStart } : {}),
    ...((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && typeof field.selectionEnd === "number" ? { selectionEnd: field.selectionEnd } : {}),
    ...(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? { isComposing: false } : {})
  };
}

function snapshotKeyboardEvent(event: KeyboardEvent, target: Element | null) {
  const redacted = isSensitiveField(target);
  const printable = event.key.length === 1;

  return {
    key: redacted && printable ? "[redacted]" : event.key,
    ...(event.code ? { code: event.code } : {}),
    location: event.location,
    repeat: event.repeat,
    isComposing: event.isComposing,
    ...(redacted && printable ? { redacted: true } : {}),
    modifiers: collectModifierState(event)
  };
}

function shouldSkipKeyboardEvent(event: KeyboardEvent): boolean {
  if (event.key === "Unidentified") {
    return true;
  }

  return ["Alt", "Control", "Meta", "Shift"].includes(event.key);
}

function normalizePointerType(pointerType: string): "mouse" | "pen" | "touch" | undefined {
  return pointerType === "mouse" || pointerType === "pen" || pointerType === "touch" ? pointerType : undefined;
}

function inferInputKind(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): "text" | "textarea" | "select" | "checkbox" | "radio" | "contenteditable" | "other" {
  if (field instanceof HTMLTextAreaElement) return "textarea";
  if (field instanceof HTMLSelectElement) return "select";
  if (field.type === "checkbox") return "checkbox";
  if (field.type === "radio") return "radio";
  return "text";
}

function isSensitiveField(target: Element | null): boolean {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
    return false;
  }

  if (target instanceof HTMLInputElement) {
    if (["password", "email", "tel", "search"].includes(target.type)) {
      return true;
    }
  }

  const probe = [target.getAttribute("name"), target.id, target.getAttribute("autocomplete")].filter(Boolean).join(" ").toLowerCase();
  return /(pass|pwd|secret|token|otp|code|ssn|card|cvv)/.test(probe);
}

declare global {
  interface Window {
    __jittleLampBootstrapped__?: boolean;
  }
}

bootContentBridge();

export {};
