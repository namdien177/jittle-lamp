import { describe, expect, test } from "bun:test";

import {
  appendDraftEvent,
  createSessionDraft,
  renameSessionDraft,
  updateDraftPage,
  type CaptureSessionDraft
} from "@jittle-lamp/shared";

import { createDraftStorageCheckpoint, estimateSerializedBytes } from "../apps/extension/src/draft-storage";

function buildLargeDraft(): CaptureSessionDraft {
  let draft = createSessionDraft({
    page: {
      title: "Example",
      url: "https://example.com"
    },
    now: new Date("2026-01-01T00:00:00.000Z")
  });

  draft = appendDraftEvent(
    draft,
    {
      kind: "lifecycle",
      phase: "recording",
      detail: "Started recording."
    },
    new Date("2026-01-01T00:00:01.000Z")
  );

  for (let index = 0; index < 12; index += 1) {
    draft = appendDraftEvent(
      draft,
      {
        kind: "network",
        method: "POST",
        url: `https://example.com/api/${index}`,
        request: {
          headers: [{ name: "content-type", value: "application/json" }],
          cookies: [],
          body: {
            disposition: "captured",
            encoding: "utf8",
            mimeType: "application/json",
            value: JSON.stringify({ index, payload: "x".repeat(6000) }),
            byteLength: 6000
          }
        }
      },
      new Date(`2026-01-01T00:00:${String(index + 10).padStart(2, "0")}.000Z`)
    );
  }

  return draft;
}

describe("createDraftStorageCheckpoint", () => {
  test("returns the original draft when it already fits", () => {
    const draft = createSessionDraft({
      page: {
        title: "Example",
        url: "https://example.com"
      },
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    const checkpoint = createDraftStorageCheckpoint(draft, 1024 * 1024);

    expect(checkpoint).toEqual(draft);
  });

  test("trims oversized drafts below the requested budget", () => {
    const draft = buildLargeDraft();

    const checkpoint = createDraftStorageCheckpoint(draft, 24 * 1024);

    expect(estimateSerializedBytes(checkpoint)).toBeLessThanOrEqual(24 * 1024);
    expect(checkpoint.events.length).toBeLessThan(draft.events.length);
  });

  test("keeps the initial scaffold event and latest event when trimming", () => {
    const draft = buildLargeDraft();
    const checkpoint = createDraftStorageCheckpoint(draft, 24 * 1024);

    expect(checkpoint.events[0]?.at).toBe(draft.events[0]?.at);
    expect(checkpoint.events.at(-1)?.at).toBe(draft.events.at(-1)?.at);
  });

  test("keeps the recording lifecycle anchor when present", () => {
    const draft = buildLargeDraft();
    const checkpoint = createDraftStorageCheckpoint(draft, 24 * 1024);

    expect(
      checkpoint.events.some(
        (event) => event.payload.kind === "lifecycle" && event.payload.phase === "recording"
      )
    ).toBeTrue();
  });
});

describe("session draft naming", () => {
  test("preserves edited session names across page updates", () => {
    const draft = createSessionDraft({
      page: {
        title: "Initial page",
        url: "https://example.com/initial"
      },
      now: new Date("2026-01-01T00:00:00.000Z")
    });

    const renamed = renameSessionDraft(draft, "Checkout regression", new Date("2026-01-01T00:00:01.000Z"));
    const updated = updateDraftPage(
      renamed,
      {
        title: "Updated page",
        url: "https://example.com/updated"
      },
      new Date("2026-01-01T00:00:02.000Z")
    );

    expect(updated.name).toBe("Checkout regression");
    expect(updated.nameEdited).toBeTrue();
    expect(updated.page.title).toBe("Updated page");
  });
});
