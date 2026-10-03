import { describe, expect, test } from "bun:test";

import { parseSessionArchiveJson } from "@jittle-lamp/shared";

import {
  InvalidEvidenceUploadError,
  MAX_MANUAL_VIDEO_UPLOAD_BYTES,
  prepareManualEvidenceUploadFile,
} from "../apps/evidence-web/src/manual-upload";

describe("manual evidence upload", () => {
  test("rejects videos larger than 60 MB before reading the file", async () => {
    const file = {
      name: "oversized.mp4",
      type: "video/mp4",
      size: MAX_MANUAL_VIDEO_UPLOAD_BYTES + 1,
      arrayBuffer: () => {
        throw new Error("oversized file should not be read");
      },
    } as unknown as File;

    await expect(prepareManualEvidenceUploadFile(file)).rejects.toBeInstanceOf(
      InvalidEvidenceUploadError,
    );
    await expect(prepareManualEvidenceUploadFile(file)).rejects.toThrow(
      "Video files must be 60 MB or smaller.",
    );
  });
});

describe("manual video upload without an archive", () => {
  test("generates a valid schema-v4 archive for a raw video", async () => {
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    const file = new File([bytes], "walkthrough.webm", { type: "video/webm" });
    const prepared = await prepareManualEvidenceUploadFile(file);
    expect(prepared.generatedArchive).toBe(true);
    const archiveArtifact = prepared.artifacts.find((artifact) => artifact.key === "archive");
    expect(archiveArtifact).toBeDefined();
    const archive = parseSessionArchiveJson(archiveArtifact?.payload ?? new Uint8Array());
    expect(archive.schemaVersion).toBe(4);
    expect(archive.recorder.kind).toBe("browser-extension");
  });
});
