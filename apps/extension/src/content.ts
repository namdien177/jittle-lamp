import {
  backgroundToContentMessageSchema,
  popupResponseSchema,
  sanitizeCapturedUrl,
  type PopupResponse,
  type PopupState
} from "@jittle-lamp/shared";

let activeSessionId: string | null = null;
let floatingWidget: FloatingWidgetController | null = null;

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
        toggleFloatingWidget();
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

const floatingWidgetHostId = "jittle-lamp-floating-widget";
const floatingWidgetRefreshMs = 1_200;

class FloatingWidgetController {
  private readonly host: HTMLDivElement;
  private readonly shadow: ShadowRoot;
  private readonly titleInput: HTMLInputElement;
  private readonly statusText: HTMLSpanElement;
  private readonly routeText: HTMLSpanElement;
  private readonly phasePill: HTMLSpanElement;
  private readonly eventText: HTMLSpanElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly dragHandle: HTMLElement;
  private refreshTimer: number | null = null;
  private lastTitle = "";
  private collapsed = false;

  constructor() {
    const existing = document.getElementById(floatingWidgetHostId);
    if (existing) {
      existing.remove();
    }

    this.host = document.createElement("div");
    this.host.id = floatingWidgetHostId;
    this.host.dataset.jittleLampWidget = "true";
    this.host.style.position = "fixed";
    this.host.style.top = "20px";
    this.host.style.right = "20px";
    this.host.style.zIndex = "2147483647";
    this.host.style.width = "286px";
    this.host.style.maxWidth = "calc(100vw - 24px)";
    this.host.style.pointerEvents = "auto";

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = floatingWidgetTemplate();
    document.documentElement.append(this.host);

    this.titleInput = this.require<HTMLInputElement>("[data-role='title']");
    this.statusText = this.require<HTMLSpanElement>("[data-role='status']");
    this.routeText = this.require<HTMLSpanElement>("[data-role='route']");
    this.phasePill = this.require<HTMLSpanElement>("[data-role='phase']");
    this.eventText = this.require<HTMLSpanElement>("[data-role='events']");
    this.startButton = this.require<HTMLButtonElement>("[data-role='start']");
    this.stopButton = this.require<HTMLButtonElement>("[data-role='stop']");
    this.collapseButton = this.require<HTMLButtonElement>("[data-role='collapse']");
    this.closeButton = this.require<HTMLButtonElement>("[data-role='close']");
    this.dragHandle = this.require<HTMLElement>("[data-role='drag']");

    this.bind();
  }

  show(): void {
    this.host.hidden = false;
    void this.refresh();

    if (this.refreshTimer === null) {
      this.refreshTimer = window.setInterval(() => {
        void this.refresh();
      }, floatingWidgetRefreshMs);
    }
  }

  toggle(): void {
    if (this.host.hidden) {
      this.show();
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
    try {
      const response = await sendPopupRequest("jl/popup-get-state");
      this.render(response.state, error ?? response.error);
    } catch (refreshError: unknown) {
      this.renderError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }

  private bind(): void {
    this.startButton.addEventListener("click", () => {
      void this.performAction("jl/popup-start-recording");
    });

    this.stopButton.addEventListener("click", () => {
      void this.performAction("jl/popup-stop-recording");
    });

    this.closeButton.addEventListener("click", () => {
      this.hide();
    });

    this.collapseButton.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.host.dataset.collapsed = String(this.collapsed);
      this.collapseButton.textContent = this.collapsed ? "▣" : "−";
      this.collapseButton.title = this.collapsed ? "Expand" : "Minimize";
    });

    this.titleInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        this.titleInput.blur();
      }

      if (event.key === "Escape") {
        this.titleInput.value = this.lastTitle;
        this.titleInput.blur();
      }
    });

    this.titleInput.addEventListener("blur", () => {
      void this.persistTitle();
    });

    this.dragHandle.addEventListener("pointerdown", (event) => {
      this.beginDrag(event);
    });
  }

  private async performAction(type: "jl/popup-start-recording" | "jl/popup-stop-recording"): Promise<void> {
    this.setBusy(true);
    try {
      const response = await sendPopupRequest(type);
      this.render(response.state, response.error);
    } catch (error: unknown) {
      await this.refresh(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private async persistTitle(): Promise<void> {
    const nextTitle = this.titleInput.value.trim();

    if (!nextTitle || nextTitle === this.lastTitle) {
      this.titleInput.value = this.lastTitle;
      return;
    }

    this.setBusy(true);
    try {
      const response = popupResponseSchema.parse(
        await chrome.runtime.sendMessage({
          type: "jl/popup-update-session-name",
          name: nextTitle
        })
      );
      this.render(response.state, response.error);
    } catch (error: unknown) {
      await this.refresh(error instanceof Error ? error.message : String(error));
    } finally {
      this.setBusy(false);
    }
  }

  private render(state: PopupState, error?: string): void {
    const activeSession = state.activeSession;
    const phase = activeSession?.phase ?? "idle";
    const title = activeSession?.name ?? pageFallbackTitle();
    const route = state.cloud.status === "signed-in"
      ? "Cloud upload ready"
      : state.companion.status === "online"
        ? "Desktop companion ready"
        : "Companion app recommended";

    this.lastTitle = title;

    if (this.shadow.activeElement !== this.titleInput) {
      this.titleInput.value = title;
    }

    this.titleInput.disabled = !activeSession || phase === "processing";
    this.phasePill.textContent = phase;
    this.phasePill.dataset.phase = phase;
    this.eventText.textContent = `${activeSession?.eventCount ?? 0} events`;
    this.routeText.textContent = route;
    this.statusText.textContent = error ?? activeSession?.statusText ?? widgetStatusText(state);
    this.statusText.dataset.tone = error ? "error" : "neutral";

    this.startButton.hidden = !state.canStart;
    this.stopButton.hidden = !state.canStop;
    this.startButton.disabled = !state.canStart;
    this.stopButton.disabled = !state.canStop;
  }

  private renderError(message: string): void {
    this.statusText.textContent = message;
    this.statusText.dataset.tone = "error";
    this.phasePill.textContent = "offline";
    this.phasePill.dataset.phase = "failed";
  }

  private setBusy(busy: boolean): void {
    this.startButton.disabled = busy || this.startButton.hidden === true;
    this.stopButton.disabled = busy || this.stopButton.hidden === true;
    this.host.dataset.busy = String(busy);
  }

  private beginDrag(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }

    const rect = this.host.getBoundingClientRect();
    const pointerOffset = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };

    this.dragHandle.setPointerCapture(event.pointerId);
    this.host.style.right = "auto";
    this.host.style.left = `${rect.left}px`;
    this.host.style.top = `${rect.top}px`;

    const move = (moveEvent: PointerEvent): void => {
      const nextLeft = clamp(moveEvent.clientX - pointerOffset.x, 8, window.innerWidth - rect.width - 8);
      const nextTop = clamp(moveEvent.clientY - pointerOffset.y, 8, window.innerHeight - rect.height - 8);
      this.host.style.left = `${nextLeft}px`;
      this.host.style.top = `${nextTop}px`;
    };

    const stop = (upEvent: PointerEvent): void => {
      this.dragHandle.releasePointerCapture(upEvent.pointerId);
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
}

async function sendPopupRequest(
  type: "jl/popup-get-state" | "jl/popup-start-recording" | "jl/popup-stop-recording"
): Promise<PopupResponse> {
  return popupResponseSchema.parse(
    await chrome.runtime.sendMessage({
      type
    })
  );
}

function showFloatingWidget(): void {
  floatingWidget ??= new FloatingWidgetController();
  floatingWidget.show();
}

function toggleFloatingWidget(): void {
  floatingWidget ??= new FloatingWidgetController();
  floatingWidget.toggle();
}

function isFloatingWidgetEvent(event: Event): boolean {
  return event.composedPath().some(
    (target) => target instanceof HTMLElement && target.dataset.jittleLampWidget === "true"
  );
}

function widgetStatusText(state: PopupState): string {
  if (state.activeSession?.phase === "recording") {
    return state.cloud.status === "signed-in"
      ? "Recording. Stop to upload directly to cloud."
      : state.companion.status === "online"
        ? "Recording. Stop to save through the companion."
        : "Recording. Stop to download locally.";
  }

  if (state.cloud.status === "signed-in") {
    return "Signed in on web. Cloud upload is enabled.";
  }

  if (state.companion.status === "online") {
    return "Desktop companion is available.";
  }

  return "Sign in on web for cloud upload, or install the companion app.";
}

function pageFallbackTitle(): string {
  return document.title.trim() || new URL(window.location.href).hostname || "Jittle Lamp session";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function floatingWidgetTemplate(): string {
  return `
    <style>
      :host {
        all: initial;
      }

      .jl-float {
        box-sizing: border-box;
        width: 286px;
        max-width: calc(100vw - 24px);
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        background: #101211;
        color: #f2f4f0;
        box-shadow: 0 20px 54px rgba(0, 0, 0, 0.36), 0 0 0 1px rgba(0, 0, 0, 0.2);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.4;
      }

      .jl-head {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 10px 10px 8px;
        background: linear-gradient(180deg, #151816, #101211);
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
        gap: 7px;
        color: #8a938b;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }

      .jl-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #22c55e;
        box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12);
      }

      .jl-tools {
        display: flex;
        gap: 4px;
      }

      .jl-icon {
        width: 22px;
        height: 22px;
        border: 0;
        border-radius: 5px;
        background: rgba(255, 255, 255, 0.06);
        color: #abb2ac;
        cursor: pointer;
        font: inherit;
        line-height: 1;
      }

      .jl-icon:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #f2f4f0;
      }

      .jl-body {
        display: grid;
        gap: 8px;
        padding: 0 10px 10px;
      }

      :host([data-collapsed="true"]) .jl-body,
      :host([data-collapsed="true"]) .jl-route,
      :host([data-collapsed="true"]) .jl-status {
        display: none;
      }

      .jl-title {
        width: 100%;
        box-sizing: border-box;
        border: 1px solid transparent;
        border-radius: 5px;
        padding: 5px 6px;
        background: rgba(255, 255, 255, 0.05);
        color: #f2f4f0;
        font: inherit;
        font-size: 13px;
        font-weight: 650;
        outline: none;
      }

      .jl-title:focus {
        border-color: rgba(34, 197, 94, 0.55);
        background: rgba(255, 255, 255, 0.08);
      }

      .jl-title:disabled {
        color: #8a938b;
      }

      .jl-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .jl-pill {
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 5px;
        padding: 3px 7px;
        background: rgba(255, 255, 255, 0.06);
        color: #aab1ac;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .jl-pill[data-phase="recording"],
      .jl-pill[data-phase="ready"] {
        border-color: rgba(34, 197, 94, 0.24);
        background: rgba(34, 197, 94, 0.12);
        color: #22c55e;
      }

      .jl-pill[data-phase="processing"],
      .jl-pill[data-phase="armed"] {
        border-color: rgba(245, 158, 11, 0.26);
        background: rgba(245, 158, 11, 0.12);
        color: #f59e0b;
      }

      .jl-pill[data-phase="failed"] {
        border-color: rgba(239, 68, 68, 0.26);
        background: rgba(239, 68, 68, 0.12);
        color: #ef4444;
      }

      .jl-muted,
      .jl-route,
      .jl-status {
        color: #8a938b;
        overflow-wrap: anywhere;
      }

      .jl-status[data-tone="error"] {
        color: #ef4444;
      }

      .jl-actions {
        display: flex;
        gap: 7px;
      }

      .jl-button {
        flex: 1;
        min-height: 34px;
        border: 0;
        border-radius: 6px;
        padding: 7px 10px;
        cursor: pointer;
        font: inherit;
        font-weight: 750;
      }

      .jl-button:disabled {
        cursor: default;
        opacity: 0.45;
      }

      .jl-start {
        background: #22c55e;
        color: #07100a;
      }

      .jl-stop {
        background: #262a27;
        color: #f2f4f0;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .jl-button[hidden] {
        display: none;
      }
    </style>
    <section class="jl-float" aria-label="Jittle Lamp recorder">
      <header class="jl-head" data-role="drag">
        <div class="jl-brand"><span class="jl-dot"></span><span>Jittle Lamp</span></div>
        <div class="jl-tools">
          <button class="jl-icon" data-role="collapse" type="button" title="Minimize">−</button>
          <button class="jl-icon" data-role="close" type="button" title="Hide">×</button>
        </div>
      </header>
      <div class="jl-body">
        <input class="jl-title" data-role="title" type="text" maxlength="160" />
        <div class="jl-meta">
          <span class="jl-pill" data-role="phase" data-phase="idle">idle</span>
          <span class="jl-muted" data-role="events">0 events</span>
        </div>
        <span class="jl-route" data-role="route">Checking route…</span>
        <span class="jl-status" data-role="status">Ready.</span>
        <div class="jl-actions">
          <button class="jl-button jl-start" data-role="start" type="button">Start capture</button>
          <button class="jl-button jl-stop" data-role="stop" type="button" hidden>Stop</button>
        </div>
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
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
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
