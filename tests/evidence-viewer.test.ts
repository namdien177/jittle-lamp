import { describe, expect, test } from "bun:test";

import { unzipSync } from "fflate";
import { sessionArchiveSchema } from "@jittle-lamp/shared";
import { CANONICAL_NOW, canonicalArchiveBundles, canonicalRecordingBytes } from "./fixtures/canonical-fixtures";

import { buildReviewedArchive, buildReviewedSessionZip } from "../apps/evidence-web/src/archive-export";

const NOW = CANONICAL_NOW;
const VALID_BUNDLE = canonicalArchiveBundles.small;
const SESSION_ID = VALID_BUNDLE.sessionId;

describe("web review-state export helpers", () => {
  test("buildReviewedArchive updates annotations and timestamp", () => {
    const next = buildReviewedArchive({
      archive: sessionArchiveSchema.parse(VALID_BUNDLE),
      mergeGroups: [
        {
          id: "merge-1",
          kind: "merge-group",
          memberIds: [`${SESSION_ID}:actions:000000`, `${SESSION_ID}:actions:000001`],
          tags: ["greeting"],
          label: "Entering hello",
          createdAt: NOW
        }
      ],
      now: new Date("2024-06-01T12:05:00.000Z")
    });

    expect(next.annotations).toHaveLength(1);
    expect(next.updatedAt).toBe("2024-06-01T12:05:00.000Z");
  });

  test("buildReviewedSessionZip round-trips updated annotations", () => {
    const zipBytes = buildReviewedSessionZip({
      archive: sessionArchiveSchema.parse(VALID_BUNDLE),
      mergeGroups: [
        {
          id: "merge-1",
          kind: "merge-group",
          memberIds: [`${SESSION_ID}:actions:000000`, `${SESSION_ID}:actions:000001`],
          tags: [],
          label: "Merged",
          createdAt: NOW
        }
      ],
      recordingBytes: canonicalRecordingBytes,
      now: new Date("2024-06-01T12:06:00.000Z")
    });

    const files = unzipSync(zipBytes);
    const archiveText = new TextDecoder().decode(files["session.archive.json"]!);
    const archive = JSON.parse(archiveText) as { updatedAt: string; annotations: unknown[] };

    expect(files["recording.webm"]).toBeDefined();
    expect(archive.updatedAt).toBe("2024-06-01T12:06:00.000Z");
    expect(archive.annotations).toHaveLength(1);
  });
});
