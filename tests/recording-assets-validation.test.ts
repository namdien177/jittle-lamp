import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSessionArchive, createSessionDraft } from "@jittle-lamp/shared";

import { validateRecordingAssets } from "../scripts/dev/validate-recording-assets";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recording asset validation", () => {
  test("accepts a structurally complete local recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "jl-recording-assets-"));
    temporaryRoots.push(root);
    const sessionId = "jl_recording_validation_001";
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir);

    const draft = createSessionDraft({
      page: { title: "Validation", url: "https://example.com" },
      now: new Date("2026-07-15T00:00:00.000Z")
    });
    const recording = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    let archive = createSessionArchive({ ...draft, sessionId, phase: "ready" }, { videoDurationMs: 2_500 });
    archive = {
      ...archive,
      artifacts: archive.artifacts.map((artifact) => ({
        ...artifact,
        relativePath: `${sessionId}/${artifact.kind}`,
        bytes: artifact.kind === "recording.webm" ? recording.byteLength : 0
      }))
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const archiveText = `${JSON.stringify(archive, null, 2)}\n`;
      archive = {
        ...archive,
        artifacts: archive.artifacts.map((artifact) =>
          artifact.kind === "session.archive.json" ? { ...artifact, bytes: Buffer.byteLength(archiveText) } : artifact
        )
      };
    }
    const archiveText = `${JSON.stringify(archive, null, 2)}\n`;
    await Promise.all([
      writeFile(join(sessionDir, "recording.webm"), recording),
      writeFile(join(sessionDir, "session.archive.json"), archiveText)
    ]);

    const report = await validateRecordingAssets(root);
    expect(report.sessionId).toBe(sessionId);
    expect(report.recordingBytes).toBe(recording.byteLength);
  });

  test("rejects a non-WebM recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "jl-recording-assets-bad-"));
    temporaryRoots.push(root);
    const sessionDir = join(root, "jl_recording_validation_002");
    await mkdir(sessionDir);
    await Promise.all([
      writeFile(join(sessionDir, "recording.webm"), "not-webm"),
      writeFile(join(sessionDir, "session.archive.json"), "{}")
    ]);

    expect(validateRecordingAssets(sessionDir)).rejects.toThrow();
  });
});
