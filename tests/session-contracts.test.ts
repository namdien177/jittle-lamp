import { describe, expect, test } from "bun:test";

import {
  appendDraftEvent,
  createSessionArchive,
  createSessionDraft,
  sanitizeCapturedUrl,
  sessionArchiveSchema,
  sessionSchemaVersion,
  transitionDraftPhase
} from "@jittle-lamp/shared";

describe("session contracts", () => {
  test("creates a draft with local artifact paths", () => {
    const draft = createSessionDraft({
      page: {
        tabId: 7,
        title: "Example",
        url: "https://example.com"
      },
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(draft.artifacts.map((artifact) => artifact.kind)).toEqual([
      "recording.webm",
      "session.archive.json"
    ]);
    expect(draft.name).toBe("Example");
    expect(draft.page.tabId).toBe(7);
  });

  test("parses a bundle built from draft events", () => {
    const draft = transitionDraftPhase(
      appendDraftEvent(
        createSessionDraft({
          page: {
            title: "Example",
            url: "https://example.com"
          },
          now: new Date("2026-01-01T00:00:00.000Z")
        }),
        {
          kind: "interaction",
          type: "click",
          selector: "button.primary",
          x: 40,
          y: 24
        },
        new Date("2026-01-01T00:00:01.000Z")
      ),
      "ready",
      "Exported locally.",
      new Date("2026-01-01T00:00:02.000Z")
    );

    const archive = sessionArchiveSchema.parse(createSessionArchive(draft));

    expect(archive.schemaVersion).toBe(sessionSchemaVersion);
    expect(archive.phase).toBe("ready");
    expect(archive.sections.actions).toHaveLength(3);
    expect(archive.sections.console).toHaveLength(0);
    expect(archive.sections.network).toHaveLength(0);
    expect(archive.artifacts[0]?.relativePath.endsWith("recording.webm")).toBeTrue();
  });

  test("preserves richer network payloads in exported bundles", () => {
    const draft = appendDraftEvent(
      createSessionDraft({
        page: {
          title: "Example",
          url: "https://example.com"
        },
        now: new Date("2026-01-01T00:00:00.000Z")
      }),
      {
        kind: "network",
        method: "POST",
        url: "https://example.com/api/login",
        status: 200,
        statusText: "OK",
        durationMs: 240,
        requestId: "123.45",
        request: {
          headers: [
            { name: "authorization", value: "Basic dXNlcjpzZWNyZXQ=" },
            { name: "cookie", value: "session=abc123; theme=dark" },
            { name: "content-type", value: "application/json" }
          ],
          cookies: [
            {
              cookie: {
                name: "session",
                value: "abc123",
                domain: "example.com",
                path: "/",
                httpOnly: true,
                secure: true
              },
              blockedReasons: []
            }
          ],
          body: {
            disposition: "captured",
            encoding: "utf8",
            mimeType: "application/json",
            value: '{"username":"user","password":"secret"}',
            byteLength: 39
          }
        },
        response: {
          headers: [
            { name: "content-type", value: "application/json" },
            { name: "set-cookie", value: "session=abc123; Path=/; HttpOnly; Secure" }
          ],
          setCookieHeaders: ["session=abc123; Path=/; HttpOnly; Secure"],
          setCookies: [
            {
              raw: "session=abc123; Path=/; HttpOnly; Secure",
              name: "session",
              value: "abc123",
              path: "/",
              httpOnly: true,
              secure: true,
              session: true
            }
          ],
          body: {
            disposition: "truncated",
            encoding: "base64",
            mimeType: "application/octet-stream",
            value: "YWJjZA==",
            byteLength: 2048,
            omittedByteLength: 2040,
            reason: "Body exceeded 65536 bytes and was truncated locally."
          }
        }
      },
      new Date("2026-01-01T00:00:01.000Z")
    );

    const archive = sessionArchiveSchema.parse(createSessionArchive(draft));
    const networkEvent = archive.sections.network[0]?.payload;

    if (!networkEvent) {
      throw new Error("Expected a network event in the exported bundle.");
    }

    expect(networkEvent.request.headers[0]?.value).toBe("Basic dXNlcjpzZWNyZXQ=");
    expect(networkEvent.request.cookies[0]?.cookie.value).toBe("abc123");
    expect(networkEvent.request.body?.value).toContain("secret");
    expect(networkEvent.response?.setCookieHeaders[0]).toContain("session=abc123");
    expect(networkEvent.response?.body?.encoding).toBe("base64");
    expect(networkEvent.response?.body?.disposition).toBe("truncated");
  });

  test("preserves tab context in exported rows", () => {
    const draft = appendDraftEvent(
      createSessionDraft({
        page: {
          tabId: 7,
          title: "Checkout",
          url: "https://example.com/checkout"
        },
        now: new Date("2026-01-01T00:00:00.000Z")
      }),
      {
        kind: "interaction",
        type: "click",
        selector: "#submit"
      },
      new Date("2026-01-01T00:00:01.000Z"),
      {
        tab: {
          id: 7,
          title: "Checkout",
          url: "https://example.com/checkout"
        }
      }
    );

    const archive = sessionArchiveSchema.parse(createSessionArchive(draft));
    const action = archive.sections.actions.find((entry) => entry.payload.kind === "interaction");

    expect(action?.tab).toEqual({
      id: 7,
      title: "Checkout",
      url: "https://example.com/checkout"
    });
  });

  test("preserves replay-capable interaction metadata in exported actions", () => {
    const draft = appendDraftEvent(
      createSessionDraft({
        page: {
          title: "Example",
          url: "https://example.com/form"
        },
        now: new Date("2026-01-01T00:00:00.000Z")
      }),
      {
        kind: "interaction",
        type: "click",
        selector: "button > span",
        x: 40,
        y: 24,
        clientX: 40,
        clientY: 24,
        pageX: 120,
        pageY: 144,
        button: 0,
        buttons: 1,
        clickCount: 1,
        pointerType: "mouse",
        modifiers: { alt: false, ctrl: false, meta: false, shift: true },
        page: {
          viewport: { width: 1440, height: 900 },
          document: { width: 1440, height: 2200 },
          scroll: { x: 0, y: 120 },
          devicePixelRatio: 2,
          url: "https://example.com/form",
          title: "Example"
        },
        target: {
          selector: "button > span",
          selectorAlternates: ['[data-testid="submit-label"]', "#submit", "button[name=submit]"],
          tagName: "span",
          dataTestId: "submit-label",
          role: null,
          textPreview: "Submit",
          rect: { left: 20, top: 12, width: 100, height: 32 }
        }
      },
      new Date("2026-01-01T00:00:01.000Z")
    );

    const archive = sessionArchiveSchema.parse(createSessionArchive(draft));
    const action = archive.sections.actions.find((entry) => entry.payload.kind === "interaction" && entry.payload.type === "click");

    if (!action || action.payload.kind !== "interaction" || action.payload.type !== "click") {
      throw new Error("Expected a click interaction in the exported actions.");
    }

    expect(action.payload.target?.rect?.width).toBe(100);
    expect(action.payload.target?.dataTestId).toBe("submit-label");
    expect(action.payload.page?.scroll.y).toBe(120);
    expect(action.payload.modifiers?.shift).toBeTrue();
    expect(action.payload.pointerType).toBe("mouse");
  });

  test("sanitizes captured urls before storing them", () => {
    expect(sanitizeCapturedUrl("https://example.com/path?q=secret#frag")).toBe("https://example.com/path");

    const draft = createSessionDraft({
      page: {
        title: "Example",
        url: "https://example.com/path?q=secret#frag"
      },
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    expect(draft.page.url).toBe("https://example.com/path");
  });
});
