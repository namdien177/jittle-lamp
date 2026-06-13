import { describe, expect, test } from "bun:test";
import {
  defaultOutputDir,
  isTrustedCompanionOrigin,
  normalizeOutputDir,
  resolveArtifactDestinationPath
} from "../apps/desktop/src/companion/config";

import {
  backgroundToContentMessageSchema,
  contentRuntimeMessageSchema,
  createSessionArchive,
  createSessionDraft,
  offscreenResponseSchema,
  offscreenRequestSchema,
  popupRequestSchema,
  popupResponseSchema,
  transitionDraftPhase
} from "@jittle-lamp/shared";

describe("extension contracts", () => {
  test("parses popup state responses with no active session", () => {
    const response = popupResponseSchema.parse({
      ok: true,
      state: {
        activeSession: null,
        companion: {
          status: "offline",
          origin: "http://127.0.0.1:48115",
          checkedAt: "2026-01-01T00:00:00.000Z"
        },
        canStart: true,
        canStop: false
      }
    });

    expect(response.state.activeSession).toBeNull();
    expect(response.state.canStart).toBeTrue();
  });

  test("parses popup state responses with typed active-session summaries", () => {
    const response = popupResponseSchema.parse({
      ok: true,
      state: {
        activeSession: {
          sessionId: "jl_test1234",
          name: "Example",
          phase: "recording",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:05.000Z",
          page: {
            tabId: 7,
            title: "Example",
            url: "https://example.com"
          },
          artifacts: [
            {
              kind: "recording.webm",
              relativePath: "jl_test1234/recording.webm",
              mimeType: "video/webm"
            },
            {
              kind: "session.archive.json",
              relativePath: "jl_test1234/session.archive.json",
              mimeType: "application/json"
            }
          ],
          eventCount: 42,
          statusText: "Started active-tab recording in the offscreen document."
        },
        companion: {
          status: "online",
          origin: "http://127.0.0.1:48115",
          outputDir: "/tmp/jittle-lamp",
          checkedAt: "2026-01-01T00:00:05.000Z"
        },
        canStart: false,
        canStop: true
      }
    });

    expect(response.state.activeSession?.eventCount).toBe(42);
    expect(response.state.activeSession?.page.tabId).toBe(7);
    expect(response.state.companion.outputDir).toBe("/tmp/jittle-lamp");
  });

  test("parses session-scoped content runtime messages", () => {
    const message = contentRuntimeMessageSchema.parse({
      type: "jl/interaction",
      sessionId: "jl_test1234",
      payload: {
        kind: "interaction",
        type: "click",
        selector: "button.primary",
        x: 12,
        y: 24,
        clientX: 12,
        clientY: 24,
        pageX: 12,
        pageY: 48,
        button: 0,
        buttons: 1,
        clickCount: 1,
        modifiers: {
          alt: false,
          ctrl: true,
          meta: false,
          shift: false
        },
        page: {
          viewport: { width: 1280, height: 720 },
          document: { width: 1280, height: 1600 },
          scroll: { x: 0, y: 24 }
        },
        target: {
          selector: "button.primary",
          selectorAlternates: ["#submit"],
          tagName: "button",
          textPreview: "Submit",
          rect: { left: 10, top: 20, width: 120, height: 32 }
        }
      }
    });

    expect(message.sessionId).toBe("jl_test1234");
    if (message.type !== "jl/interaction") {
      throw new Error("Expected an interaction message.");
    }

    expect(message.payload.type).toBe("click");
  });

  test("parses richer keyboard interaction runtime messages", () => {
    const message = contentRuntimeMessageSchema.parse({
      type: "jl/interaction",
      sessionId: "jl_test1234",
      payload: {
        kind: "interaction",
        type: "keyboard",
        selector: "form > input:text",
        eventType: "keydown",
        key: "Enter",
        code: "Enter",
        location: 0,
        repeat: false,
        isComposing: false,
        modifiers: {
          alt: false,
          ctrl: false,
          meta: false,
          shift: false
        },
        page: {
          viewport: { width: 1280, height: 720 },
          document: { width: 1280, height: 1600 },
          scroll: { x: 0, y: 24 }
        },
        target: {
          selector: "form > input:text",
          selectorAlternates: ["input[name=email]"],
          tagName: "input",
          inputType: "email",
          rect: { left: 100, top: 200, width: 280, height: 36 }
        }
      }
    });

    if (message.type !== "jl/interaction") {
      throw new Error("Expected an interaction message.");
    }

    expect(message.payload.type).toBe("keyboard");
    if (message.payload.type !== "keyboard") {
      throw new Error("Expected a keyboard payload.");
    }
    expect(message.payload.key).toBe("Enter");
    expect(message.payload.target?.inputType).toBe("email");
  });

  test("parses text selection highlight interaction messages", () => {
    const message = contentRuntimeMessageSchema.parse({
      type: "jl/interaction",
      sessionId: "jl_test1234",
      payload: {
        kind: "interaction",
        type: "selection",
        selector: "main > p:nth-of-type(1)",
        selectedText: "Important highlighted text",
        selectedTextLength: 26,
        anchorSelector: "main > p:nth-of-type(1)",
        focusSelector: "main > p:nth-of-type(1)",
        page: {
          viewport: { width: 1280, height: 720 },
          document: { width: 1280, height: 1600 },
          scroll: { x: 0, y: 24 }
        },
        target: {
          selector: "main > p:nth-of-type(1)",
          selectorAlternates: ["main > p:nth-of-type(1)"],
          tagName: "p",
          textPreview: "Important highlighted text in a paragraph."
        }
      }
    });

    if (message.type !== "jl/interaction" || message.payload.type !== "selection") {
      throw new Error("Expected a selection interaction message.");
    }

    expect(message.payload.selectedText).toBe("Important highlighted text");
    expect(message.payload.anchorSelector).toBe("main > p:nth-of-type(1)");
  });

  test("parses content-captured API network responses with payloads", () => {
    const message = contentRuntimeMessageSchema.parse({
      type: "jl/network",
      sessionId: "jl_test1234",
      payload: {
        kind: "network",
        method: "POST",
        url: "https://example.com/api/login",
        subtype: "fetch",
        status: 200,
        statusText: "OK",
        durationMs: 125,
        requestId: "page-fetch-123",
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
    });

    if (message.type !== "jl/network") {
      throw new Error("Expected a network message.");
    }

    expect(message.payload.request.body?.value).toContain("demo");
    expect(message.payload.response?.body?.value).toContain("true");
  });

  test("parses floating widget state refresh messages", () => {
    const message = backgroundToContentMessageSchema.parse({
      type: "jl/content-refresh-widget",
      state: {
        activeSession: null,
        companion: {
          status: "offline",
          origin: "http://127.0.0.1:48115",
          checkedAt: "2026-01-01T00:00:00.000Z"
        },
        cloud: {
          status: "signed-in",
          origin: "https://jl-api.monthlyparty.com",
          checkedAt: "2026-01-01T00:00:00.000Z"
        },
        canStart: true,
        canStop: false
      }
    });

    expect(message.type).toBe("jl/content-refresh-widget");
  });

  test("parses tab audio playback preference on recorder start requests", () => {
    const popupRequest = popupRequestSchema.parse({
      type: "jl/popup-start-recording",
      playTabAudio: false,
      requestSiteAccess: true
    });
    const offscreenRequest = offscreenRequestSchema.parse({
      type: "jl/offscreen-start-recording",
      sessionId: "jl_test1234",
      tabId: 7,
      streamId: "stream-123",
      playTabAudio: true
    });

    expect(popupRequest.type).toBe("jl/popup-start-recording");
    if (popupRequest.type !== "jl/popup-start-recording" || offscreenRequest.type !== "jl/offscreen-start-recording") {
      throw new Error("Expected recorder start requests.");
    }

    expect(popupRequest.playTabAudio).toBe(false);
    expect(popupRequest.requestSiteAccess).toBe(true);
    expect(offscreenRequest.playTabAudio).toBe(true);
  });

  test("parses optional recorder start names", () => {
    const popupRequest = popupRequestSchema.parse({
      type: "jl/popup-start-recording",
      name: "Checkout failure repro"
    });

    expect(popupRequest.type).toBe("jl/popup-start-recording");
    if (popupRequest.type !== "jl/popup-start-recording") {
      throw new Error("Expected recorder start request.");
    }
    expect(popupRequest.name).toBe("Checkout failure repro");
  });

  test("parses abort recording requests", () => {
    const popupRequest = popupRequestSchema.parse({
      type: "jl/popup-abort-recording"
    });
    const offscreenRequest = offscreenRequestSchema.parse({
      type: "jl/offscreen-abort-recording",
      sessionId: "jl_test1234"
    });

    expect(popupRequest.type).toBe("jl/popup-abort-recording");
    expect(offscreenRequest.type).toBe("jl/offscreen-abort-recording");
  });

  test("parses offscreen export requests with full session archives", () => {
    const draft = transitionDraftPhase(
      createSessionDraft({
        page: {
          title: "Example",
          url: "https://example.com"
        },
        now: new Date("2026-01-01T00:00:00.000Z")
      }),
      "ready",
      "Queued local export.",
      new Date("2026-01-01T00:00:02.000Z")
    );

    const request = offscreenRequestSchema.parse({
      type: "jl/offscreen-stop-and-export",
      sessionId: draft.sessionId,
      archive: createSessionArchive(draft),
      cloudRequired: true,
      cloudAuthToken: "extension-session-token"
    });

    if (!("archive" in request)) {
      throw new Error("Expected an export request.");
    }

    expect(request.archive.phase).toBe("ready");
    expect(request.archive.artifacts).toHaveLength(2);
    expect(request.cloudRequired).toBe(true);
  });

  test("resolves companion artifact destinations inside the configured output directory", () => {
    const outputDir = normalizeOutputDir(defaultOutputDir());
    const artifactPath = resolveArtifactDestinationPath({
      outputDir,
      sessionId: "jl_test1234",
      artifactName: "recording.webm"
    });

    expect(artifactPath.startsWith(outputDir)).toBeTrue();
    expect(artifactPath.endsWith("jl_test1234/recording.webm")).toBeTrue();
  });

  test("accepts only extension origins for companion writes", () => {
    expect(isTrustedCompanionOrigin("chrome-extension://abcdefghijklmnop")).toBeTrue();
    expect(isTrustedCompanionOrigin("https://example.com")).toBeFalse();
    expect(isTrustedCompanionOrigin(null)).toBeFalse();
  });

  test("parses richer offscreen export responses", () => {
    const companionResponse = offscreenResponseSchema.parse({
      ok: true,
      recordingBytes: 1024,
      eventBytes: 512,
      destination: "companion",
      outputDir: "/tmp/jittle-lamp"
    });

    const cloudResponse = offscreenResponseSchema.parse({
      ok: true,
      recordingBytes: 1024,
      eventBytes: 512,
      destination: "cloud",
      cloudUrl: "https://jittlelamp.dev/evidence/ev_123"
    });

    expect(companionResponse.destination).toBe("companion");
    expect(companionResponse.outputDir).toBe("/tmp/jittle-lamp");
    expect(cloudResponse.destination).toBe("cloud");
    expect(cloudResponse.cloudUrl).toBe("https://jittlelamp.dev/evidence/ev_123");
  });
});
