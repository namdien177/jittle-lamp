import {
  backgroundToContentMessageSchema,
  popupResponseSchema,
  sanitizeCapturedUrl,
  type PopupResponse,
  type PopupState,
  type RecordingOperation
} from "@jittle-lamp/shared";
import {
  CircleStop,
  Copy,
  Monitor,
  Move,
  PanelTop,
  Pause,
  Play,
  Trash2,
  X,
  createElement
} from "lucide";

import { deriveRecordingControlState } from "./recording-control-state";

let activeSessionId: string | null = null;
let floatingWidget: FloatingWidgetController | null = null;
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
  private readonly host = document.createElement("div");
  private readonly shadow: ShadowRoot;
  private refreshTimer: number | null = null;
  private refreshInFlight = false;
  private requestRevision = 0;
  private actionInFlight = false;
  private renderedState: PopupState | null = null;
  private localRecordingOperation: RecordingOperation | null = null;
  private transientError: string | undefined;
  private captureTarget: CaptureTarget = "tab";

  constructor() {
    document.getElementById(floatingWidgetHostId)?.remove();
    this.host.id = floatingWidgetHostId;
    this.host.dataset.jittleLampWidget = "true";
    Object.assign(this.host.style, {
      position: "fixed", left: "50%", bottom: "18px", top: "auto",
      transform: "translateX(-50%)", zIndex: "2147483647",
      width: "max-content", maxWidth: "calc(100vw - 16px)", pointerEvents: "auto"
    });
    this.host.hidden = true;
    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = floatingWidgetTemplate();
    hydrateFloatingWidgetIcons(this.shadow);
    document.documentElement.append(this.host);
    for (const button of this.shadow.querySelectorAll<HTMLButtonElement>("[data-action]")) {
      button.addEventListener("click", () => {
        const action = button.dataset.action!;
        if (action === "pause") {
          void this.performAction(this.renderedState?.activeSession?.phase === "paused"
            ? "jl/popup-resume-recording" : "jl/popup-pause-recording");
        } else {
          void this.performAction(action as Parameters<typeof sendPopupRequest>[0]);
        }
      });
    }
    this.element<HTMLButtonElement>("target").addEventListener("click", () => {
      this.captureTarget = this.captureTarget === "tab" ? "desktop" : "tab";
      this.syncRecordingControls();
    });
    this.element("close").addEventListener("click", () => {
      this.hide();
      this.host.remove();
      floatingWidget = null;
    });
    this.element<HTMLButtonElement>("copy").addEventListener("click", async () => {
      const button = this.element<HTMLButtonElement>("copy");
      const url = button.dataset.cloudUrl;
      if (url) {
        const copied = await copyTextToClipboard(url);
        this.element("status").textContent = copied ? "Evidence URL copied." : "Could not copy the URL. Try again.";
        this.element("status").hidden = false;
      }
    });
    const drag = this.element<HTMLButtonElement>("drag");
    drag.addEventListener("pointerdown", (event) => this.beginDrag(event, drag));
    drag.addEventListener("keydown", (event) => {
      const directions: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
      const delta = directions[event.key];
      if (!delta) return;
      event.preventDefault();
      const rect = this.host.getBoundingClientRect();
      this.moveTo(rect.left + delta[0], rect.top + delta[1]);
    });
    this.syncRecordingControls();
  }

  show(initialState?: PopupState): void {
    if (!this.isMounted()) {
      floatingWidget = new FloatingWidgetController();
      floatingWidget.show(initialState);
      return;
    }
    this.host.hidden = false;
    if (initialState) this.render(initialState);
    void this.refresh();
    if (this.refreshTimer === null) {
      this.refreshTimer = window.setInterval(() => void this.refresh(), floatingWidgetRefreshMs);
    }
  }

  renderIfVisible(state: PopupState): void {
    if (!this.host.hidden) this.render(state);
  }

  toggle(initialState?: PopupState): void {
    if (this.host.hidden || !this.isMounted()) this.show(initialState);
    else this.hide();
  }

  hide(): void {
    this.host.hidden = true;
    if (this.refreshTimer !== null) window.clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  async refresh(): Promise<void> {
    if (this.refreshInFlight || this.actionInFlight) return;
    this.refreshInFlight = true;
    const revision = ++this.requestRevision;
    try {
      const response = await sendPopupRequest("jl/popup-get-state");
      if (revision === this.requestRevision) this.render(response.state, response.error);
    } catch (error) {
      if (revision === this.requestRevision) this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async performAction(type: Parameters<typeof sendPopupRequest>[0]): Promise<void> {
    if (this.actionInFlight) return;
    this.actionInFlight = true;
    this.localRecordingOperation = operationForAction(type);
    this.transientError = undefined;
    ++this.requestRevision;
    this.syncRecordingControls();
    try {
      const response = await sendPopupRequest(type, { captureTarget: this.captureTarget });
      this.localRecordingOperation = null;
      this.render(response.state, response.ok ? undefined : response.error);
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.localRecordingOperation = null;
      this.actionInFlight = false;
      this.syncRecordingControls();
    }
  }

  private render(state: PopupState, error?: string): void {
    if (state.activeSession?.sessionId !== this.renderedState?.activeSession?.sessionId ||
        state.activeSession?.phase !== this.renderedState?.activeSession?.phase) this.transientError = undefined;
    this.renderedState = state;
    if (error) this.transientError = error;
    const failed = state.activeSession?.phase === "failed";
    const status = this.transientError ?? state.activeSession?.statusText ?? widgetStatusText(state);
    this.host.dataset.error = String(failed || Boolean(this.transientError));
    const message = this.element("status");
    message.textContent = status;
    message.title = status;
    message.hidden = !failed && !this.transientError && state.activeSession?.phase !== "ready";
    message.setAttribute("role", failed || this.transientError ? "alert" : "status");
    const copy = this.element<HTMLButtonElement>("copy");
    const url = state.activeSession?.phase === "ready" && state.activeSession.statusText
      ? extractFirstUrl(state.activeSession.statusText) : undefined;
    copy.dataset.cloudUrl = url ?? "";
    copy.disabled = !url;
    copy.title = url ? `Copy ${url}` : "Copy URL after cloud upload finishes";
    this.syncRecordingControls();
  }

  private showError(message: string): void {
    this.transientError = message;
    this.host.dataset.error = "true";
    const status = this.element("status");
    status.textContent = message;
    status.title = message;
    status.hidden = false;
    status.setAttribute("role", "alert");
  }

  private syncRecordingControls(): void {
    const state = this.renderedState;
    const controls = deriveRecordingControlState(state, this.localRecordingOperation);
    const operation = this.localRecordingOperation ?? state?.recordingOperation;
    const phase = operation ?? state?.activeSession?.phase ?? "idle";
    const pill = this.element("phase");
    pill.textContent = statusPhaseLabel(phase);
    pill.dataset.phase = phase;
    pill.title = state ? widgetStatusText(state) : "Checking recorder…";
    for (const [role, control, label] of [
      ["start", controls.start, "Start"], ["stop", controls.finish, "Stop"],
      ["pause", controls.pause, controls.pause.mode === "resume" ? "Resume" : "Pause"],
      ["discard", controls.abort, "Discard"]
    ] as const) {
      const button = this.element<HTMLButtonElement>(role);
      // Discard remains available on failure, away from the recording Stop button.
      button.hidden = !control.visible || (role === "discard" && state?.activeSession?.phase !== "failed");
      button.disabled = this.actionInFlight || control.disabled;
      button.title = control.label;
      button.setAttribute("aria-label", control.label);
      button.setAttribute("aria-busy", String(control.loading));
      button.dataset.loading = String(control.loading);
      this.element(`${role}-label`).textContent = label;
    }
    hydrateButtonIcon(this.element<HTMLButtonElement>("pause"), controls.pause.mode === "resume" ? "Play" : "Pause");
    for (const role of ["retry", "save"] as const) {
      const button = this.element<HTMLButtonElement>(role);
      button.hidden = state?.activeSession?.phase !== "failed";
      button.disabled = this.actionInFlight || controls.busy;
      button.setAttribute("aria-busy", String(operation === (role === "retry" ? "retrying-upload" : "saving-local")));
    }
    const target = this.element<HTMLButtonElement>("target");
    target.hidden = !controls.start.visible;
    target.disabled = this.actionInFlight || controls.busy;
    target.title = this.captureTarget === "tab" ? "Record tab. Click to record screen or window." : "Record screen or window. Click to record tab.";
    target.setAttribute("aria-label", target.title);
    hydrateButtonIcon(target, this.captureTarget === "tab" ? "PanelTop" : "Monitor");
  }

  isMounted(): boolean {
    return this.host.isConnected && document.getElementById(floatingWidgetHostId) === this.host;
  }

  private moveTo(left: number, top: number): void {
    const rect = this.host.getBoundingClientRect();
    Object.assign(this.host.style, {
      left: `${clamp(left, 8, Math.max(8, window.innerWidth - rect.width - 8))}px`,
      top: `${clamp(top, 8, Math.max(8, window.innerHeight - rect.height - 8))}px`,
      bottom: "auto", transform: "none"
    });
  }

  private beginDrag(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    const rect = this.host.getBoundingClientRect();
    const move = (next: PointerEvent): void => this.moveTo(next.clientX - event.clientX + rect.left, next.clientY - event.clientY + rect.top);
    const stop = (): void => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
  }

  private element<T extends HTMLElement = HTMLElement>(role: string): T {
    return this.shadow.querySelector<T>(`[data-role='${role}']`)!;
  }
}

async function sendPopupRequest(
  type:
    | "jl/popup-retry-upload"
    | "jl/popup-save-local"
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
    case "jl/popup-retry-upload":
      return "retrying-upload";
    case "jl/popup-save-local":
      return "saving-local";
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
    case "saving-local":
      return "Saving to your machine…";
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

  if (phase === "processing" || phase === "stopping" || phase === "retrying-upload" || phase === "saving-local") {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const floatingWidgetIcons = {
  CircleStop,
  Copy,
  Monitor,
  Move,
  PanelTop,
  Pause,
  Play,
  Trash2,
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
      :host { all: initial; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .jl-float {
        max-width: calc(100vw - 16px); padding: 6px; border: 1px solid #ffffff26;
        border-radius: 12px; background: #151918eb; color: #eef3f0;
        box-shadow: 0 4px 20px #0004; backdrop-filter: blur(12px);
        font: 12px/1.4 "Avenir Next", "Segoe UI", sans-serif;
        opacity: .55; transition: opacity 140ms ease;
      }
      .jl-float:hover, .jl-float:focus-within, :host([data-error="true"]) .jl-float { opacity: 1; }
      .jl-bar { display: flex; align-items: center; gap: 4px; height: 34px; }
      button {
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        flex: 0 0 auto; height: 32px; padding: 0 9px; border: 1px solid transparent;
        border-radius: 7px; background: transparent; color: inherit; font: inherit;
        font-weight: 600; white-space: nowrap; cursor: pointer;
      }
      button:hover:not(:disabled) { background: #ffffff18; }
      button:disabled { opacity: .4; cursor: default; }
      button:focus-visible { outline: 2px solid #8ae3b0; outline-offset: 1px; }
      .jl-icon { width: 30px; padding: 0; }
      .jl-icon-svg { width: 16px; height: 16px; display: block; }
      .jl-start { background: #9fe3b7; color: #14271c; }
      .jl-stop { background: #63332f; color: #ffded8; }
      .jl-save { background: #9fe3b7; color: #14271c; }
      .jl-phase { padding: 0 7px; font-size: 10px; font-weight: 700; letter-spacing: .04em; white-space: nowrap; }
      .jl-phase[data-phase="recording"] { color: #a6ecc0; }
      .jl-phase[data-phase="failed"] { color: #ffb4a7; }
      [data-role="drag"] { cursor: grab; touch-action: none; color: #9aa69f; }
      [data-role="drag"]:active { cursor: grabbing; }
      [data-role="close"] { color: #a7b1ab; }
      .jl-divider { width: 1px; height: 18px; background: #ffffff24; margin: 0 2px; }
      .jl-status { max-width: 450px; max-height: 34px; margin: 4px 5px 0; overflow: auto; overflow-wrap: anywhere; font-size: 11px; line-height: 16px; }
      :host([data-error="true"]) .jl-status { color: #ffb4a7; }
      [data-loading="true"] .jl-action-icon { animation: jl-pulse 800ms ease infinite alternate; }
      @keyframes jl-pulse { to { opacity: .25; } }
      @media (prefers-reduced-motion: reduce) { *, *::before { animation: none !important; transition: none !important; } }
      @media (max-width: 520px) {
        .jl-bar { gap: 2px; }
        .jl-phase { padding: 0 3px; font-size: 9px; }
        .jl-label { display: none; }
        button { padding: 0 7px; }
        .jl-divider { margin: 0; }
      }
    </style>
    <section class="jl-float" aria-label="Jittle Lamp recorder">
      <div class="jl-bar" role="toolbar" aria-label="Recording controls">
        <button class="jl-icon" data-role="drag" title="Move recorder. Use arrow keys when focused." aria-label="Move recorder"><span data-icon="Move"></span></button>
        <span class="jl-phase" data-role="phase">READY</span>
        <button class="jl-icon" data-role="target" title="Record tab" aria-label="Recording target"><span data-icon="PanelTop"></span></button>
        <button class="jl-start" data-role="start" data-action="jl/popup-start-recording" disabled><span class="jl-action-icon" data-icon="Play"></span><span class="jl-label" data-role="start-label">Start</span></button>
        <button data-role="pause" data-action="pause" hidden><span class="jl-action-icon" data-icon="Pause"></span><span class="jl-label" data-role="pause-label">Pause</span></button>
        <button class="jl-stop" data-role="stop" data-action="jl/popup-stop-recording" hidden><span class="jl-action-icon" data-icon="CircleStop"></span><span class="jl-label" data-role="stop-label">Stop</span></button>
        <button data-role="retry" data-action="jl/popup-retry-upload" hidden>Retry</button>
        <button class="jl-save" data-role="save" data-action="jl/popup-save-local" hidden>Save locally</button>
        <button class="jl-icon" data-role="discard" data-action="jl/popup-abort-recording" hidden><span data-icon="Trash2"></span><span hidden data-role="discard-label">Discard</span></button>
        <span class="jl-divider"></span>
        <button class="jl-icon" data-role="copy" title="Copy URL" aria-label="Copy evidence URL" disabled><span data-icon="Copy"></span></button>
        <button class="jl-icon" data-role="close" title="Close overlay" aria-label="Close overlay"><span data-icon="X"></span></button>
      </div>
      <p class="jl-status" data-role="status" role="status" aria-live="polite" aria-atomic="true" hidden></p>
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
