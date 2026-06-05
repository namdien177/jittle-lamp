import {
  backgroundToContentMessageSchema,
  popupResponseSchema,
  sanitizeCapturedUrl,
  type PopupResponse,
  type PopupState
} from "@jittle-lamp/shared";
import {
  BookOpen,
  CircleStop,
  Cloud,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  Play,
  User,
  X,
  createElement
} from "lucide";

declare const __JITTLE_LAMP_WEB_ORIGIN__: string | undefined;

let activeSessionId: string | null = null;
let floatingWidget: FloatingWidgetController | null = null;
const configuredCloudWebOrigin = (
  typeof __JITTLE_LAMP_WEB_ORIGIN__ === "string" ? __JITTLE_LAMP_WEB_ORIGIN__.trim() : "https://jittlelamp.dev"
).replace(/\/+$/, "");

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
        toggleFloatingWidget(parsed.data.state);
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
  private readonly titleText: HTMLSpanElement;
  private readonly accountText: HTMLSpanElement;
  private readonly sessionText: HTMLSpanElement;
  private readonly destinationText: HTMLSpanElement;
  private readonly accountButton: HTMLButtonElement;
  private readonly outputButton: HTMLButtonElement;
  private readonly outputIconSlot: HTMLSpanElement;
  private readonly compactPhasePill: HTMLSpanElement;
  private readonly compactEventText: HTMLSpanElement;
  private readonly compactStatusText: HTMLSpanElement;
  private readonly statusText: HTMLSpanElement;
  private readonly phasePill: HTMLSpanElement;
  private readonly eventText: HTMLSpanElement;
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly signInButton: HTMLButtonElement;
  private readonly linkChip: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly dragHandle: HTMLElement;
  private refreshTimer: number | null = null;
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
    this.host.style.top = "20px";
    this.host.style.right = "20px";
    this.host.style.zIndex = "2147483647";
    this.host.style.width = "360px";
    this.host.style.maxWidth = "calc(100vw - 24px)";
    this.host.style.pointerEvents = "auto";

    this.shadow = this.host.attachShadow({ mode: "closed" });
    this.shadow.innerHTML = floatingWidgetTemplate();
    hydrateFloatingWidgetIcons(this.shadow);
    document.documentElement.append(this.host);

    this.titleText = this.require<HTMLSpanElement>("[data-role='title']");
    this.accountText = this.require<HTMLSpanElement>("[data-role='account']");
    this.sessionText = this.require<HTMLSpanElement>("[data-role='session']");
    this.destinationText = this.require<HTMLSpanElement>("[data-role='destination']");
    this.accountButton = this.require<HTMLButtonElement>("[data-role='account-link']");
    this.outputButton = this.require<HTMLButtonElement>("[data-role='output-link']");
    this.outputIconSlot = this.require<HTMLSpanElement>("[data-role='output-icon']");
    this.compactPhasePill = this.require<HTMLSpanElement>("[data-role='compact-phase']");
    this.compactEventText = this.require<HTMLSpanElement>("[data-role='compact-events']");
    this.compactStatusText = this.require<HTMLSpanElement>("[data-role='compact-status']");
    this.statusText = this.require<HTMLSpanElement>("[data-role='status']");
    this.phasePill = this.require<HTMLSpanElement>("[data-role='phase']");
    this.eventText = this.require<HTMLSpanElement>("[data-role='events']");
    this.startButton = this.require<HTMLButtonElement>("[data-role='start']");
    this.stopButton = this.require<HTMLButtonElement>("[data-role='stop']");
    this.signInButton = this.require<HTMLButtonElement>("[data-role='sign-in']");
    this.linkChip = this.require<HTMLButtonElement>("[data-role='link-chip']");
    this.collapseButton = this.require<HTMLButtonElement>("[data-role='collapse']");
    this.closeButton = this.require<HTMLButtonElement>("[data-role='close']");
    this.dragHandle = this.require<HTMLElement>("[data-role='drag']");
    this.host.dataset.compact = "true";

    this.bind();
  }

  show(initialState?: PopupState): void {
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

  toggle(initialState?: PopupState): void {
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

    this.signInButton.addEventListener("click", () => {
      void this.performAction("jl/popup-start-cloud-sign-in");
    });

    this.accountButton.addEventListener("click", () => {
      openJittleLampWeb("/");
    });

    this.outputButton.addEventListener("click", () => {
      if (this.outputButton.dataset.destination === "cloud") {
        openJittleLampWeb("/");
      }
    });

    this.linkChip.addEventListener("click", () => {
      const cloudUrl = this.linkChip.dataset.cloudUrl;

      if (!cloudUrl) {
        return;
      }

      void navigator.clipboard?.writeText(cloudUrl).catch(() => undefined);
      window.open(cloudUrl, "_blank", "noopener,noreferrer");
    });

    this.closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.destroy();
      floatingWidget = null;
    });
    this.closeButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    this.collapseButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.compact = !this.compact;
      this.host.dataset.compact = String(this.compact);
      this.collapseButton.title = this.compact ? "Expand details" : "Compact menu";
      hydrateButtonIcon(this.collapseButton, this.compact ? "Maximize2" : "Minimize2");
    });
    this.collapseButton.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    this.dragHandle.addEventListener("pointerdown", (event) => {
      this.beginDrag(event);
    });
  }

  private async performAction(
    type: "jl/popup-start-recording" | "jl/popup-stop-recording" | "jl/popup-start-cloud-sign-in"
  ): Promise<void> {
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

  private render(state: PopupState, error?: string): void {
    const activeSession = state.activeSession;
    const phase = activeSession?.phase ?? "idle";
    const title = activeSession?.name ?? pageFallbackTitle();
    const account = describeAccount(state);
    const destination = describeDestination(state);
    const session = activeSession
      ? `${shortSessionId(activeSession.sessionId)} · ${activeSession.page.title || new URL(activeSession.page.url).hostname}`
      : "No active session";

    this.lastTitle = title;
    this.titleText.textContent = title;
    this.titleText.title = title;
    this.accountText.textContent = account;
    this.accountText.title = account;
    this.sessionText.textContent = session;
    this.sessionText.title = session;
    this.destinationText.textContent = destination;
    this.destinationText.title = destination;
    this.phasePill.textContent = phase;
    this.phasePill.dataset.phase = phase;
    this.compactPhasePill.textContent = phase;
    this.compactPhasePill.dataset.phase = phase;
    this.eventText.textContent = `${activeSession?.eventCount ?? 0}`;
    this.compactEventText.textContent = `${activeSession?.eventCount ?? 0}`;
    const status = error ?? activeSession?.statusText ?? widgetStatusText(state);
    this.statusText.textContent = status;
    this.statusText.dataset.tone = error ? "error" : "neutral";
    this.compactStatusText.textContent = status;
    this.compactStatusText.title = status;
    this.compactStatusText.dataset.tone = error ? "error" : "neutral";
    this.accountButton.title = account;
    this.accountButton.setAttribute("aria-label", `${account}. Open Jittle Lamp.`);
    const outputKind = getDestinationKind(state);
    this.outputButton.dataset.destination = outputKind;
    this.outputButton.title = `${destination}${outputKind === "cloud" ? ". Open cloud library." : ""}`;
    this.outputButton.setAttribute("aria-label", this.outputButton.title);
    hydrateIconSlot(this.outputIconSlot, outputIconName(outputKind));

    const cloudUrl = activeSession?.statusText ? extractFirstUrl(activeSession.statusText) : undefined;
    this.linkChip.hidden = state.cloud.status !== "signed-in";
    this.linkChip.disabled = !cloudUrl;
    this.linkChip.textContent = cloudUrl ? "Open link" : "Link after stop";
    this.linkChip.title = cloudUrl ? `Open and copy ${cloudUrl}` : "A cloud link appears after upload.";
    this.linkChip.dataset.cloudUrl = cloudUrl ?? "";

    this.startButton.hidden = !state.canStart;
    this.stopButton.hidden = !state.canStop;
    this.signInButton.hidden = state.cloud.status === "signed-in";
    this.startButton.disabled = !state.canStart;
    this.stopButton.disabled = !state.canStop;
  }

  private renderError(message: string): void {
    this.statusText.textContent = message;
    this.statusText.dataset.tone = "error";
    this.compactStatusText.textContent = message;
    this.compactStatusText.title = message;
    this.compactStatusText.dataset.tone = "error";
    this.phasePill.textContent = "offline";
    this.phasePill.dataset.phase = "failed";
  }

  private setBusy(busy: boolean): void {
    this.startButton.disabled = busy || this.startButton.hidden === true;
    this.stopButton.disabled = busy || this.stopButton.hidden === true;
    this.signInButton.disabled = busy || this.signInButton.hidden === true;
    this.host.dataset.busy = String(busy);
  }

  private destroy(): void {
    this.hide();
    this.host.remove();
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
  type:
    | "jl/popup-get-state"
    | "jl/popup-start-recording"
    | "jl/popup-stop-recording"
    | "jl/popup-start-cloud-sign-in"
): Promise<PopupResponse> {
  return popupResponseSchema.parse(
    await chrome.runtime.sendMessage({
      type
    })
  );
}

function showFloatingWidget(initialState?: PopupState): void {
  floatingWidget ??= new FloatingWidgetController();
  floatingWidget.show(initialState);
}

function toggleFloatingWidget(initialState?: PopupState): void {
  floatingWidget ??= new FloatingWidgetController();
  floatingWidget.toggle(initialState);
}

function isFloatingWidgetEvent(event: Event): boolean {
  return event.composedPath().some(
    (target) => target instanceof HTMLElement && target.dataset.jittleLampWidget === "true"
  );
}

function widgetStatusText(state: PopupState): string {
  if (state.activeSession?.phase === "recording") {
    return state.cloud.status === "signed-in"
      ? "Recording. Stop to upload to cloud."
      : state.companion.status === "online"
        ? "Recording. Stop to save locally."
        : "Recording. Stop to download locally.";
  }

  if (state.cloud.status === "signed-in") {
    return "Ready to record. Cloud upload is enabled.";
  }

  if (state.companion.status === "online") {
    return "Ready to record. Companion save is enabled.";
  }

  return "Ready to record. Output will download in the browser.";
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
  Cloud,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  Monitor,
  Play,
  User,
  X
};

type FloatingWidgetIconName = keyof typeof floatingWidgetIcons;
type DestinationKind = "cloud" | "desktop" | "download";

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

function getDestinationKind(state: PopupState): DestinationKind {
  if (state.cloud.status === "signed-in") {
    return "cloud";
  }

  if (state.companion.status === "online") {
    return "desktop";
  }

  return "download";
}

function outputIconName(kind: DestinationKind): FloatingWidgetIconName {
  if (kind === "cloud") {
    return "Cloud";
  }

  if (kind === "desktop") {
    return "Monitor";
  }

  return "Download";
}

function openJittleLampWeb(path: string): void {
  const url = new URL(path, `${configuredCloudWebOrigin}/`);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
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
        width: 300px;
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
      }

      .jl-head {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
        padding: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        background: #0a0a0a;
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
        width: 18px;
        height: 18px;
        border-radius: 3px;
        background: #22c55e;
        box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(34, 197, 94, 0.35);
      }

      .jl-tools {
        display: flex;
        gap: 4px;
      }

      .jl-icon {
        width: 28px;
        height: 28px;
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
        gap: 10px;
        padding: 12px;
      }

      :host([data-compact="true"]) .jl-expanded {
        display: none;
      }

      :host([data-compact="false"]) .jl-compact {
        display: none;
      }

      :host([data-compact="false"]) .jl-compact-only {
        display: none;
      }

      :host([data-compact="false"]) .jl-float {
        width: 360px;
      }

      .jl-compact {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        align-items: center;
        gap: 8px;
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

      .jl-tool-button[data-destination="desktop"],
      .jl-tool-button[data-destination="download"] {
        cursor: default;
      }

      .jl-tool-button[data-destination="desktop"]:hover,
      .jl-tool-button[data-destination="download"]:hover {
        border-color: rgba(255, 255, 255, 0.13);
        color: #888888;
      }

      .jl-icon-svg {
        width: 16px;
        height: 16px;
        stroke-width: 2.2;
      }

      .jl-compact-stats {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 6px;
      }

      .jl-compact-status {
        min-width: 0;
        overflow: hidden;
        color: #888888;
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .jl-compact-status[data-tone="error"] {
        color: #ef4444;
      }

      .jl-title {
        min-width: 0;
        overflow: hidden;
        color: #efefef;
        font-size: 14px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .jl-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .jl-pill {
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 2px;
        padding: 3px 7px;
        background: #181818;
        color: #888888;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .jl-pill[data-phase="recording"],
      .jl-pill[data-phase="ready"] {
        border-color: rgba(34, 197, 94, 0.4);
        background: rgba(34, 197, 94, 0.16);
        color: #22c55e;
      }

      .jl-pill[data-phase="processing"],
      .jl-pill[data-phase="armed"] {
        border-color: rgba(245, 158, 11, 0.34);
        background: rgba(245, 158, 11, 0.14);
        color: #f59e0b;
      }

      .jl-pill[data-phase="failed"] {
        border-color: rgba(239, 68, 68, 0.32);
        background: rgba(239, 68, 68, 0.14);
        color: #ef4444;
      }

      .jl-muted {
        color: #888888;
      }

      .jl-grid {
        display: grid;
        gap: 1px;
        overflow: hidden;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 4px;
        background: rgba(255, 255, 255, 0.07);
      }

      .jl-row {
        display: grid;
        grid-template-columns: 70px minmax(0, 1fr);
        gap: 10px;
        align-items: baseline;
        padding: 8px 10px;
        background: #131313;
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

      .jl-actions {
        display: grid;
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
        grid-template-columns: 34px minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        background: #181818;
        color: #efefef;
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
        content: "Mic on";
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        padding: 0 9px;
        border-radius: 3px;
        background: rgba(34, 197, 94, 0.16);
        color: #22c55e;
        font-size: 12px;
        font-weight: 700;
      }

      .jl-stop {
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        background: rgba(239, 68, 68, 0.14);
        color: #efefef;
        border-color: rgba(239, 68, 68, 0.32);
      }

      .jl-stop .jl-action-icon {
        background: rgba(239, 68, 68, 0.14);
        color: #ef4444;
      }

      .jl-stop::after {
        content: "Recording";
        display: inline-flex;
        align-items: center;
        min-height: 26px;
        padding: 0 9px;
        border-radius: 3px;
        background: rgba(239, 68, 68, 0.14);
        color: #ef4444;
        font-size: 12px;
        font-weight: 700;
      }

      .jl-button[hidden] {
        display: none;
      }

      .jl-expanded {
        display: grid;
        gap: 10px;
      }

      .jl-request {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        min-height: 42px;
        padding: 8px 10px;
        border: 1px solid rgba(255, 255, 255, 0.07);
        border-radius: 4px;
        background: #131313;
      }

      .jl-request-label {
        min-width: 0;
        overflow: hidden;
        color: #888888;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .jl-request-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 28px;
        padding: 0 10px;
        border: 1px solid rgba(255, 255, 255, 0.13);
        border-radius: 4px;
        background: #181818;
        color: #efefef;
        font-weight: 700;
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
    </style>
    <section class="jl-float" aria-label="Jittle Lamp recorder">
      <header class="jl-head" data-role="drag">
        <div class="jl-brand"><span class="jl-dot"></span><span>Jittle Lamp</span></div>
        <div class="jl-tools">
          <button class="jl-icon" data-role="collapse" type="button" title="Expand details" aria-label="Expand details">
            <span data-icon="Maximize2"></span>
          </button>
          <button class="jl-icon" data-role="close" type="button" title="Hide" aria-label="Hide">
            <span data-icon="X"></span>
          </button>
        </div>
      </header>
      <div class="jl-body">
        <div class="jl-compact">
          <button class="jl-tool-button" data-role="account-link" type="button" title="Open Jittle Lamp" aria-label="Open Jittle Lamp account">
            <span data-icon="User"></span>
          </button>
          <button class="jl-tool-button" data-role="output-link" type="button" title="Output" aria-label="Output">
            <span data-role="output-icon" data-icon="Download"></span>
          </button>
          <div class="jl-compact-stats">
            <span class="jl-pill" data-role="compact-phase" data-phase="idle">idle</span>
            <span class="jl-muted"><span data-role="compact-events">0</span> events</span>
          </div>
        </div>
        <span class="jl-compact-only jl-compact-status" data-role="compact-status">Ready.</span>
        <div class="jl-actions">
          <button class="jl-button jl-start" data-role="start" type="button">
            <span class="jl-action-icon" data-icon="Play"></span>
            <span>Record tab</span>
          </button>
          <button class="jl-button jl-stop" data-role="stop" type="button" hidden>
            <span class="jl-action-icon" data-icon="CircleStop"></span>
            <span>Stop recording</span>
          </button>
        </div>
        <div class="jl-expanded">
          <span class="jl-title" data-role="title">Jittle Lamp session</span>
          <div class="jl-meta">
            <span class="jl-pill" data-role="phase" data-phase="idle">idle</span>
            <span class="jl-muted"><span data-role="events">0</span> events</span>
          </div>
          <div class="jl-grid">
            <div class="jl-row">
              <span class="jl-label">Account</span>
              <span class="jl-value" data-role="account">Checking sign-in</span>
            </div>
            <div class="jl-row">
              <span class="jl-label">Session</span>
              <span class="jl-value" data-role="session">No active session</span>
            </div>
            <div class="jl-row">
              <span class="jl-label">Output</span>
              <span class="jl-value" data-role="destination">Browser download</span>
            </div>
          </div>
          <span class="jl-status" data-role="status">Ready.</span>
        </div>
        <div class="jl-request">
          <span class="jl-request-label">Developer evidence</span>
          <button class="jl-request-chip" data-role="link-chip" type="button" disabled>Link after stop</button>
          <button class="jl-request-chip jl-sign-in" data-role="sign-in" type="button">Sign in</button>
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
