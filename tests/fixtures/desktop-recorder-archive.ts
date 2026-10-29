import { sessionArchiveSchema, type DesktopRecorderInfo, type SessionArchive } from "@jittle-lamp/shared";

// A schema-v5 archive as the native macOS app writes it (apps/desktop-native/DESIGN.md, "Session
// archive"): ScreenCaptureKit source, H.264 MP4, unified-log lines as console entries, clicks and
// app switches as actions, no network section.
export const DESKTOP_T0 = "2026-10-29T09:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(DESKTOP_T0) + ms).toISOString();

export const safariSource: DesktopRecorderInfo["source"] = {
  type: "application",
  name: "Safari",
  bundleId: "com.apple.Safari",
  pid: 4242
};

export function makeDesktopRecorderArchive(
  input: { source?: DesktopRecorderInfo["source"]; pageUrl?: string; consoleLines?: number } = {}
): SessionArchive {
  const sessionId = "jl_desktop_fixture";
  const source = input.source ?? safariSource;
  const consoleLines = input.consoleLines ?? 2;
  return sessionArchiveSchema.parse({
    schemaVersion: 5,
    sessionId,
    name: `${source.name} checkout`,
    createdAt: DESKTOP_T0,
    updatedAt: at(8000),
    phase: "ready",
    page: { url: input.pageUrl ?? `app://${source.bundleId ?? "com.apple.Safari"}`, title: source.name },
    recorder: {
      kind: "desktop-recorder",
      recorder: { name: "jittle-lamp-desktop", version: "0.1.0", os: "macOS 26.1", source }
    },
    summary: { videoDurationMs: 8000, actionCount: 2, requestCount: null },
    artifacts: [
      { kind: "recording.mp4", relativePath: `${sessionId}/recording.mp4`, mimeType: "video/mp4", bytes: 8 },
      { kind: "session.archive.json", relativePath: `${sessionId}/session.archive.json`, mimeType: "application/json" }
    ],
    sections: {
      actions: [
        {
          id: `${sessionId}:actions:000000`,
          seq: 0,
          at: at(1000),
          payload: { kind: "interaction", type: "click", x: 640, y: 360, button: 0 }
        },
        {
          id: `${sessionId}:actions:000001`,
          seq: 1,
          at: at(2000),
          payload: {
            kind: "interaction",
            type: "keyboard",
            eventType: "keydown",
            key: "r",
            modifiers: { alt: false, ctrl: false, meta: true, shift: false }
          }
        }
      ],
      console: Array.from({ length: consoleLines }, (_, index) => ({
        id: `${sessionId}:console:${String(index).padStart(6, "0")}`,
        seq: 2 + index,
        at: at(3000 + index),
        payload: {
          kind: "console",
          level: index === consoleLines - 1 ? "error" : "info",
          message: index === consoleLines - 1 ? "WebContent: failed to load checkout" : "WebContent: networking idle"
        }
      })),
      network: []
    }
  });
}

// The first bytes of an ISO BMFF file: a `ftyp` box header.
export const mp4Bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
