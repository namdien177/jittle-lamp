import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, unzipSync, zipSync } from "fflate";
import { sessionArchiveSchema } from "@jittle-lamp/shared";
import {
  CANONICAL_NOW,
  canonicalArchiveBundles,
  canonicalCorruptedZipBundles,
  canonicalRecordingBytes,
  createFixtureZip
} from "./fixtures/canonical-fixtures";

import { _testOverrideDb, getSessionNotes, loadLibrarySession, saveLibrarySessionReviewState, scanLibrarySessions, setSessionNotes } from "../apps/desktop/src/companion/sessions-db";
import { buildSessionZip, clearTempSession, importZipBundle, loadLocalSession } from "../apps/desktop/src/session/zip-import";
import { buildReviewedArchive, buildReviewedSessionZip } from "../apps/evidence-web/src/archive-export";

const NOW = CANONICAL_NOW;
const VALID_BUNDLE = canonicalArchiveBundles.small;
const SESSION_ID = VALID_BUNDLE.sessionId;

function makeZip(bundleOverride?: object): Uint8Array {
  if (!bundleOverride) return createFixtureZip(VALID_BUNDLE);
  const merged = { ...VALID_BUNDLE, ...(bundleOverride as object) };
  const eventsBytes = strToU8(JSON.stringify(merged));
  return zipSync({
    "session.archive.json": eventsBytes,
    "recording.webm": canonicalRecordingBytes
  });
}

describe("scanLibrarySessions", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `jl-test-scan-${Date.now()}`);
    await mkdir(outputDir, { recursive: true });
    _testOverrideDb(":memory:");
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  test("returns a SessionRecord for a valid session folder", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const records = await scanLibrarySessions(outputDir);

    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe(SESSION_ID);
    expect(records[0]!.recordedAt).toBe(NOW);
    expect(records[0]!.tags).toEqual([]);
    expect(records[0]!.notes).toBe("");
    expect(records[0]!.artifacts).toHaveLength(2);
  });

  test("skips folders missing recording.webm", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify(VALID_BUNDLE));

    const records = await scanLibrarySessions(outputDir);
    expect(records).toHaveLength(0);
  });

  test("skips folders with invalid session.archive.json", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify({ bad: "data" }));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const records = await scanLibrarySessions(outputDir);
    expect(records).toHaveLength(0);
  });

  test("skips folders with malformed JSON", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), "not json {{{{");
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const records = await scanLibrarySessions(outputDir);
    expect(records).toHaveLength(0);
  });

  test("returns empty array when outputDir does not exist", async () => {
    const records = await scanLibrarySessions(join(tmpdir(), "jl-nonexistent-dir-xyz"));
    expect(records).toHaveLength(0);
  });

  test("joins notes from SQLite when present", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    setSessionNotes(SESSION_ID, "My test note");

    const records = await scanLibrarySessions(outputDir);
    expect(records[0]!.notes).toBe("My test note");
  });
});

describe("loadLibrarySession", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `jl-test-load-${Date.now()}`);
    await mkdir(outputDir, { recursive: true });
    _testOverrideDb(":memory:");
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  test("returns a ViewerPayload with source=library for a valid session", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const payload = await loadLibrarySession(SESSION_ID, outputDir);

    expect(payload.source).toBe("library");
    expect(payload.archive.sessionId).toBe(SESSION_ID);
    expect(payload.archive.schemaVersion).toBe(4);
    expect(payload.videoPath).toEndWith("recording.webm");
    expect(payload.notes).toBe("");
    expect(payload.tempId).toBeUndefined();
  });

  test("includes persisted notes in the payload", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    setSessionNotes(SESSION_ID, "Reviewer note here");

    const payload = await loadLibrarySession(SESSION_ID, outputDir);
    expect(payload.notes).toBe("Reviewer note here");
  });

  test("falls back to archive notes and hydrates SQLite when DB notes are empty", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(
      join(sessionFolder, "session.archive.json"),
      JSON.stringify({
        ...VALID_BUNDLE,
        notes: ["Archive note"]
      })
    );
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const payload = await loadLibrarySession(SESSION_ID, outputDir);

    expect(payload.notes).toBe("Archive note");
    expect(getSessionNotes(SESSION_ID)).toBe("Archive note");
  });

  test("throws when session folder does not exist", async () => {
    try {
      await loadLibrarySession("nonexistent-session", outputDir);
      throw new Error("Expected loadLibrarySession to throw for a missing session.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  test("throws when session.archive.json is invalid", async () => {
    const sessionFolder = join(outputDir, SESSION_ID);
    await mkdir(sessionFolder, { recursive: true });
    await writeFile(join(sessionFolder, "session.archive.json"), JSON.stringify({ bad: true }));
    await writeFile(join(sessionFolder, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    try {
      await loadLibrarySession(SESSION_ID, outputDir);
      throw new Error("Expected loadLibrarySession to reject invalid bundle JSON.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("validation failed");
    }
  });

  test("rejects path traversal sessionId", async () => {
    try {
      await loadLibrarySession("../etc/passwd", outputDir);
      throw new Error("Expected loadLibrarySession to reject path traversal.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("path traversal");
    }
  });
});

describe("setSessionNotes / getSessionNotes", () => {
  beforeEach(() => {
    _testOverrideDb(":memory:");
  });

  test("returns empty string for unknown session", () => {
    expect(getSessionNotes("unknown-session")).toBe("");
  });

  test("stores and retrieves notes", () => {
    setSessionNotes("sess-1", "Hello notes");
    expect(getSessionNotes("sess-1")).toBe("Hello notes");
  });

  test("overwrites existing notes on second call", () => {
    setSessionNotes("sess-1", "First");
    setSessionNotes("sess-1", "Second");
    expect(getSessionNotes("sess-1")).toBe("Second");
  });

  test("notes are isolated per session", () => {
    setSessionNotes("sess-a", "Note A");
    setSessionNotes("sess-b", "Note B");
    expect(getSessionNotes("sess-a")).toBe("Note A");
    expect(getSessionNotes("sess-b")).toBe("Note B");
  });
});

describe("saveLibrarySessionReviewState", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = join(tmpdir(), `jl-test-review-${Date.now()}`);
    await mkdir(join(outputDir, SESSION_ID), { recursive: true });
    await writeFile(join(outputDir, SESSION_ID, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(outputDir, SESSION_ID, "recording.webm"), new Uint8Array([0x1a, 0x45]));
    _testOverrideDb(":memory:");
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  test("writes notes and annotations back into the portable archive", async () => {
    const nextArchive = await saveLibrarySessionReviewState({
      sessionId: SESSION_ID,
      outputDir,
      notes: "Saved reviewer note",
      annotations: [
        {
          id: "merge-1",
          kind: "merge-group",
          memberIds: [`${SESSION_ID}:actions:000000`, `${SESSION_ID}:actions:000001`],
          tags: ["greeting"],
          label: "Entering hello",
          createdAt: NOW
        }
      ]
    });

    expect(nextArchive.notes).toEqual(["Saved reviewer note"]);
    expect(nextArchive.annotations).toHaveLength(1);
    expect(getSessionNotes(SESSION_ID)).toBe("Saved reviewer note");

    const persistedText = await Bun.file(join(outputDir, SESSION_ID, "session.archive.json")).text();
    const persisted = JSON.parse(persistedText) as { notes: string[]; annotations: unknown[] };
    expect(persisted.notes).toEqual(["Saved reviewer note"]);
    expect(persisted.annotations).toHaveLength(1);
  });
});

describe("importZipBundle", () => {
  test("returns a ViewerPayload with source=zip", async () => {
    const zip = makeZip();
    const payload = await importZipBundle(zip);

    expect(payload.source).toBe("zip");
    expect(payload.archive.sessionId).toBe(SESSION_ID);
    expect(payload.archive.schemaVersion).toBe(4);
    expect(payload.videoPath).toContain("jittle-lamp-temp");
    expect(payload.videoPath).toEndWith(".webm");
    expect(payload.notes).toBe("");
    expect(payload.tempId).toBeString();
    expect(payload.tempId!.length).toBeGreaterThan(0);

    const fileStat = await stat(payload.videoPath);
    expect(fileStat.isFile()).toBe(true);

    await clearTempSession(payload.tempId!);
  });

  test("throws when session.archive.json is missing from ZIP", async () => {
    const zip = canonicalCorruptedZipBundles.missingArchive;

    try {
      await importZipBundle(zip);
      throw new Error("Expected importZipBundle to reject when session.archive.json is missing.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("ZIP is missing session.archive.json");
    }
  });

  test("throws when recording.webm is missing from ZIP", async () => {
    const zip = canonicalCorruptedZipBundles.missingRecording;

    try {
      await importZipBundle(zip);
      throw new Error("Expected importZipBundle to reject when recording.webm is missing.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("ZIP is missing recording.webm");
    }
  });

  test("accepts nested archive and video entries inside ZIPs", async () => {
    const nestedZip = zipSync({
      [`${SESSION_ID}/session.archive.json`]: strToU8(JSON.stringify(VALID_BUNDLE)),
      [`${SESSION_ID}/recording.webm`]: canonicalRecordingBytes
    });

    const payload = await importZipBundle(nestedZip);
    expect(payload.archive.sessionId).toBe(SESSION_ID);
    await clearTempSession(payload.tempId!);
  });

  test("throws when session.archive.json fails schema validation", async () => {
    const zip = canonicalCorruptedZipBundles.schemaInvalidArchive;
    try {
      await importZipBundle(zip);
      throw new Error("Expected importZipBundle to reject invalid session bundle JSON.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Invalid session bundle");
    }
  });

  test("throws when session.archive.json is corrupted JSON", async () => {
    try {
      await importZipBundle(canonicalCorruptedZipBundles.invalidArchiveJson);
      throw new Error("Expected importZipBundle to reject malformed JSON.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Invalid session bundle");
    }
  });

  test("each import gets a unique tempId", async () => {
    const zip = makeZip();
    const [a, b] = await Promise.all([importZipBundle(zip), importZipBundle(zip)]);

    expect(a.tempId).not.toBe(b.tempId);

    await Promise.all([clearTempSession(a.tempId!), clearTempSession(b.tempId!)]);
  });

  test("ZIP payload has no notes and is not editable via setSessionNotes", async () => {
    const zip = makeZip();
    const payload = await importZipBundle(zip);
    expect(payload.source).toBe("zip");
    expect(payload.notes).toBe("");
    await clearTempSession(payload.tempId!);
  });
});

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

describe("clearTempSession", () => {
  test("deletes the temp video file", async () => {
    const zip = makeZip();
    const payload = await importZipBundle(zip);
    const { videoPath } = payload;

    const before = await stat(videoPath).catch(() => null);
    expect(before?.isFile()).toBe(true);

    await clearTempSession(payload.tempId!);

    const after = await stat(videoPath).catch(() => null);
    expect(after).toBeNull();
  });

  test("is a no-op for an unknown tempId", async () => {
    await clearTempSession("nonexistent-id");
    expect(true).toBeTrue();
  });
});

describe("loadLocalSession", () => {
  let folderPath: string;

  beforeEach(async () => {
    folderPath = join(tmpdir(), `jl-test-local-${Date.now()}`);
    await mkdir(folderPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(folderPath, { recursive: true, force: true });
  });

  test("returns a ViewerPayload with source=local for a valid folder", async () => {
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(folderPath, "recording.webm"), canonicalRecordingBytes);

    const payload = await loadLocalSession(folderPath);

    expect(payload.source).toBe("local");
    expect(payload.archive.sessionId).toBe(SESSION_ID);
    expect(payload.archive.schemaVersion).toBe(4);
    expect(payload.videoPath).toEndWith("recording.webm");
    expect(payload.notes).toBe("");
    expect(payload.tempId).toBeUndefined();
  });

  test("videoPath points to the original file, no temp copy created", async () => {
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(folderPath, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const payload = await loadLocalSession(folderPath);

    expect(payload.videoPath).toBe(join(folderPath, "recording.webm"));
    expect(payload.videoPath).not.toContain("jittle-lamp-temp");
  });

  test("notes are always empty for local sessions", async () => {
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(folderPath, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    const payload = await loadLocalSession(folderPath);

    expect(payload.notes).toBe("");
  });

  test("throws when session.archive.json is missing", async () => {
    await writeFile(join(folderPath, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    try {
      await loadLocalSession(folderPath);
      throw new Error("Expected loadLocalSession to throw for missing session.archive.json.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("missing session.archive.json");
    }
  });

  test("throws when recording.webm is missing", async () => {
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify(VALID_BUNDLE));

    try {
      await loadLocalSession(folderPath);
      throw new Error("Expected loadLocalSession to throw for missing recording.webm.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("missing recording.webm");
    }
  });

  test("throws when session.archive.json fails schema validation", async () => {
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify({ bad: "data" }));
    await writeFile(join(folderPath, "recording.webm"), new Uint8Array([0x1a, 0x45]));

    try {
      await loadLocalSession(folderPath);
      throw new Error("Expected loadLocalSession to reject invalid bundle JSON.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("Invalid session bundle");
    }
  });
});

describe("buildSessionZip / export round-trip", () => {
  let folderPath: string;

  beforeEach(async () => {
    folderPath = join(tmpdir(), `jl-test-export-${Date.now()}`);
    await mkdir(folderPath, { recursive: true });
    await writeFile(join(folderPath, "session.archive.json"), JSON.stringify(VALID_BUNDLE));
    await writeFile(join(folderPath, "recording.webm"), canonicalRecordingBytes);
  });

  afterEach(async () => {
    await rm(folderPath, { recursive: true, force: true });
  });

  test("produces a non-empty Uint8Array with a valid ZIP signature", async () => {
    const zipBytes = await buildSessionZip(folderPath);

    expect(zipBytes).toBeInstanceOf(Uint8Array);
    expect(zipBytes.length).toBeGreaterThan(0);
    expect(zipBytes[0]).toBe(0x50);
    expect(zipBytes[1]).toBe(0x4b);
  });

  test("exported ZIP contains exactly recording.webm and session.archive.json at root", async () => {
    const zipBytes = await buildSessionZip(folderPath);

    const files = unzipSync(zipBytes);
    const keys = Object.keys(files).sort();

    expect(keys).toEqual(["recording.webm", "session.archive.json"]);
  });

  test("export round-trip: buildSessionZip then importZipBundle produces identical bundle", async () => {
    const zipBytes = await buildSessionZip(folderPath);
    const payload = await importZipBundle(zipBytes);

    expect(payload.source).toBe("zip");
    expect(payload.archive.sessionId).toBe(SESSION_ID);
    expect(payload.archive.schemaVersion).toBe(4);
    expect(payload.archive.createdAt).toBe(NOW);

    const videoStat = await stat(payload.videoPath);
    expect(videoStat.size).toBe(4);

    await clearTempSession(payload.tempId!);
  });

  test("round-trip preserves the original webm bytes exactly", async () => {
    const originalBytes = canonicalRecordingBytes;

    const zipBytes = await buildSessionZip(folderPath);
    const files = unzipSync(zipBytes);

    expect(files["recording.webm"]).toEqual(originalBytes);
  });

  test("throws when recording.webm is missing from the source folder", async () => {
    await rm(join(folderPath, "recording.webm"), { force: true });

    try {
      await buildSessionZip(folderPath);
      throw new Error("Expected buildSessionZip to throw for missing recording.webm.");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
