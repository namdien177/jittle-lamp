import { describe, expect, test } from "bun:test";

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
