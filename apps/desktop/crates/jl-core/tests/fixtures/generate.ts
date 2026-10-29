// Regenerates the jl-core fixtures from the TS session code, the source of truth for the archive
// format and timeline labels. From the repo root:
//   bun run apps/desktop/crates/jl-core/tests/fixtures/generate.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildTimeline,
  createSessionArchive,
  createSessionDraft,
  deriveAnchorMs,
  maskSecretValue,
  sessionArchiveSchema,
  toExtensionWireArchive,
  transitionDraftPhase,
  appendDraftEvent,
  type CaptureSessionDraft,
  type SessionArchive,
  type TabContext
} from "../../../../../../packages/shared/src/index";

import { canonicalArchiveBundles } from "../../../../../../tests/fixtures/canonical-fixtures";
import { makeRunnerArchive } from "../../../../../../tests/fixtures/e2e/runner-archive";

const outDir = import.meta.dir;
const write = (name: string, value: unknown) => writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);

const T0 = Date.parse("2026-09-09T05:42:55.693Z");
const tabA: TabContext = { id: 11, title: "Báo cáo phụ huynh", url: "https://parent.example.test/reports" };
const tabB: TabContext = { id: 12, url: "https://admin.example.test/" };

let draft: CaptureSessionDraft = createSessionDraft({
  page: { tabId: 11, title: "Báo cáo phụ huynh", url: "https://parent.example.test/reports?token=abc#x" },
  now: new Date(T0)
});
draft = transitionDraftPhase(draft, "recording", "Recording started.", new Date(T0 + 120));
const push = (ms: number, payload: Parameters<typeof appendDraftEvent>[1], tab: TabContext) => {
  draft = appendDraftEvent(draft, payload, new Date(T0 + ms), { tab });
};

push(900, {
  kind: "interaction",
  type: "click",
  selector: "button.save",
  x: 120.5,
  y: 44,
  clientX: 120.5,
  clientY: 44,
  button: 0,
  clickCount: 1,
  pointerType: "mouse",
  modifiers: { meta: true },
  target: {
    selector: "button.save",
    tagName: "BUTTON",
    textPreview: "  Lưu   báo cáo  ",
    rect: { left: 100, top: 30, width: 80.25, height: 28 }
  },
  page: { viewport: { width: 1440, height: 900 }, document: { width: 1440, height: 2400 }, scroll: { x: 0, y: 312.5 }, devicePixelRatio: 2 }
}, tabA);
push(1500, { kind: "interaction", type: "input", selector: "#email", inputKind: "text", valueLength: 14, redacted: true, target: { tagName: "INPUT", inputType: "email", name: "email" } }, tabA);
push(1800, { kind: "console", level: "warn", message: "Deprecated API used", args: ["Deprecated API used", "{\"a\":1}"] }, tabA);
push(2100, { kind: "interaction", type: "keyboard", eventType: "keydown", key: "Enter", code: "Enter", modifiers: { shift: false }, valuePreview: "search box" }, tabA);
push(2400, { kind: "interaction", type: "submit", formSelector: "form#login", method: "post", action: "https://parent.example.test/login" }, tabA);
push(2600, {
  kind: "network",
  method: "POST",
  url: "https://parent.example.test/api/login",
  subtype: "fetch",
  status: 401,
  statusText: "Unauthorized",
  durationMs: 87.25,
  requestId: "req-1",
  request: {
    headers: [{ name: "authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" }],
    cookies: [{ cookie: { name: "sid", value: "s3cr3t", domain: "parent.example.test", httpOnly: true }, blockedReasons: [] }],
    body: { disposition: "captured", encoding: "utf8", mimeType: "application/json", value: "{\"email\":\"a@b.c\",\"password\":\"hunter22\"}", byteLength: 38 }
  },
  response: {
    headers: [{ name: "content-type", value: "application/json" }],
    body: { disposition: "captured", encoding: "utf8", value: "{\"error\":\"bad credentials\"}" }
  }
}, tabA);
push(3000, { kind: "error", message: "TypeError: x is undefined", stack: "at foo (app.js:1:2)", source: "page" }, tabA);
push(3300, { kind: "interaction", type: "navigation", url: "https://admin.example.test/", navigationType: "pushState" }, tabB);
push(3600, { kind: "interaction", type: "selection", selectedText: "Tổng   kết\nhọc kỳ", selectedTextLength: 16 }, tabB);
push(3700, { kind: "interaction", type: "navigation", url: "https://admin.example.test/dash", title: "Dashboard" }, tabB);
push(3900, { kind: "console", level: "error", message: "Failed to load resource" }, tabB);
push(4100, { kind: "network", method: "GET", url: "https://cdn.example.test/logo.png", subtype: "image", status: 200, request: { headers: [] } }, tabB);
draft = transitionDraftPhase(draft, "ready", "Recording stopped.", new Date(T0 + 5200));

const extension = createSessionArchive(draft, {
  recorder: { extension: { kind: "browser-extension", name: "jittle-lamp", version: "1.8.5", extensionId: "abcdef", manifestVersion: 3 } },
  videoDurationMs: 5080
});
const mergedIds = extension.sections.actions.filter((action) => action.payload.kind === "interaction").slice(0, 2).map((action) => action.id);
const extensionArchive = sessionArchiveSchema.parse({
  ...extension,
  notes: ["First note", "Second note"],
  annotations: [{ id: "merge-1", kind: "merge-group", memberIds: mergedIds, tags: ["login"], label: "Log in", createdAt: new Date(T0 + 6000).toISOString() }]
});
write("extension-v5.json", extensionArchive);
write("extension-v3.json", toExtensionWireArchive(extensionArchive));

const runner = makeRunnerArchive();
const runnerV4 = {
  ...runner,
  schemaVersion: 4,
  sections: {
    ...runner.sections,
    actions: [
      ...runner.sections.actions,
      {
        id: "jl_runner_fixture:actions:000003",
        seq: 6,
        at: "2026-10-03T08:00:05.000Z",
        tags: [],
        payload: { kind: "integration", integration: "sql", profile: "uat-db", statement: "SELECT id FROM users LIMIT 1", rowCount: 1, sample: [{ id: 42, name: "Lan" }], durationMs: 12.6 }
      }
    ]
  }
};
const runnerArchive = sessionArchiveSchema.parse(runnerV4);
write("runner-v4.json", runnerV4);
write("runner-v5-expected.json", runnerArchive);
write("canonical-medium.json", canonicalArchiveBundles.medium);

const timelines: Record<string, unknown> = {};
const timelineSources: Array<[string, SessionArchive]> = [
  ["extension-v5.json", extensionArchive],
  ["runner-v5-expected.json", runnerArchive],
  ["canonical-medium.json", canonicalArchiveBundles.medium]
];
for (const [name, archive] of timelineSources) {
  timelines[name] = {
    anchorMs: deriveAnchorMs(archive),
    items: buildTimeline(archive).map((item) => ({ id: item.id, offsetMs: item.offsetMs, section: item.section, label: item.label }))
  };
}
write("timelines.json", timelines);

write("mask-secret-value.json", ["", "short", "exactly12chr", "eyJhbGciOiJIUzI1NiJ9.payload.sig", "ab****cd"].map((value) => [value, maskSecretValue(value)]));
