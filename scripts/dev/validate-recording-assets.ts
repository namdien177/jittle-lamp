import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sessionArchiveSchema, type SessionArchive } from "../../packages/shared/src/index";

type ValidationOptions = {
  fixture?: boolean;
};

type ValidationReport = {
  sessionDir: string;
  sessionId: string;
  recordingBytes: number;
  archiveBytes: number;
  durationMs: number | null;
  actionCount: number;
  consoleCount: number;
  requestCount: number;
  interactionTypes: string[];
  networkSubtypes: string[];
};

export async function validateRecordingAssets(
  inputPath: string,
  options: ValidationOptions = {}
): Promise<ValidationReport> {
  const sessionDir = await resolveSessionDir(inputPath);
  const recordingPath = join(sessionDir, "recording.webm");
  const archivePath = join(sessionDir, "session.archive.json");
  const [recording, archiveBytes, recordingStat, archiveStat] = await Promise.all([
    readFile(recordingPath),
    readFile(archivePath),
    stat(recordingPath),
    stat(archivePath)
  ]);
  const archive = sessionArchiveSchema.parse(JSON.parse(archiveBytes.toString("utf8")));

  assert(recording.byteLength >= 4, "recording.webm is empty.");
  assert(
    recording.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
    "recording.webm does not have the WebM/EBML header."
  );
  assert(archive.phase === "ready", `Archive phase must be ready, got ${archive.phase}.`);
  assert(archive.sessionId === basename(sessionDir), "Archive sessionId does not match its folder name.");
  assertArtifact(archive, "recording.webm", recordingStat.size);
  assertArtifact(archive, "session.archive.json", archiveStat.size);

  const interactionActions = archive.sections.actions.filter((entry) => entry.payload.kind === "interaction");
  assert(
    archive.summary.actionCount === interactionActions.length,
    `summary.actionCount is ${archive.summary.actionCount}; actual count is ${interactionActions.length}.`
  );
  assert(
    archive.summary.requestCount === archive.sections.network.length,
    `summary.requestCount is ${archive.summary.requestCount}; actual count is ${archive.sections.network.length}.`
  );
  assert(
    typeof archive.summary.videoDurationMs === "number" && archive.summary.videoDurationMs > 0,
    "summary.videoDurationMs must be greater than zero."
  );
  assertUniqueEntryIds(archive);

  const interactionTypes = unique(
    interactionActions.map((entry) => entry.payload.kind === "interaction" ? entry.payload.type : "")
  );
  const networkSubtypes = unique(archive.sections.network.map((entry) => entry.subtype));

  if (options.fixture) {
    validateFixtureCapture(archive, interactionTypes);
    assert(recordingStat.size > 10_000, "Fixture recording is too small to prove real video capture.");
    assert((archive.summary.videoDurationMs ?? 0) >= 2_000, "Fixture recording must be at least 2 seconds.");
  }

  return {
    sessionDir,
    sessionId: archive.sessionId,
    recordingBytes: recordingStat.size,
    archiveBytes: archiveStat.size,
    durationMs: archive.summary.videoDurationMs,
    actionCount: interactionActions.length,
    consoleCount: archive.sections.console.length,
    requestCount: archive.sections.network.length,
    interactionTypes,
    networkSubtypes
  };
}

async function resolveSessionDir(inputPath: string): Promise<string> {
  const input = resolve(inputPath);
  if (await isCompleteSessionDir(input)) return input;

  const entries = await readdir(input, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(input, entry.name);
        return {
          path,
          complete: await isCompleteSessionDir(path),
          modifiedAt: (await stat(path)).mtimeMs
        };
      })
  );
  const latest = candidates
    .filter((candidate) => candidate.complete)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)[0];

  if (!latest) {
    throw new Error(`No complete recording session found in ${input}.`);
  }
  return latest.path;
}

async function isCompleteSessionDir(path: string): Promise<boolean> {
  try {
    const [recording, archive] = await Promise.all([
      stat(join(path, "recording.webm")),
      stat(join(path, "session.archive.json"))
    ]);
    return recording.isFile() && archive.isFile();
  } catch {
    return false;
  }
}

function assertArtifact(
  archive: SessionArchive,
  kind: "recording.webm" | "session.archive.json",
  actualBytes: number
): void {
  const matches = archive.artifacts.filter((artifact) => artifact.kind === kind);
  assert(matches.length === 1, `Expected one ${kind} artifact, got ${matches.length}.`);
  const artifact = matches[0];
  assert(artifact?.relativePath === `${archive.sessionId}/${kind}`, `${kind} has the wrong relativePath.`);
  assert(artifact?.bytes === actualBytes, `${kind} says ${artifact?.bytes ?? "no"} bytes; file has ${actualBytes}.`);
}

function assertUniqueEntryIds(archive: SessionArchive): void {
  const ids = [
    ...archive.sections.actions.map((entry) => entry.id),
    ...archive.sections.console.map((entry) => entry.id),
    ...archive.sections.network.map((entry) => entry.id)
  ];
  assert(new Set(ids).size === ids.length, "Archive section entry IDs must be unique.");
}

function validateFixtureCapture(archive: SessionArchive, interactionTypes: string[]): void {
  for (const type of ["click", "input", "keyboard", "submit", "navigation"]) {
    assert(interactionTypes.includes(type), `Fixture is missing ${type} interaction capture.`);
  }

  const consoleMessages = archive.sections.console.map((entry) => entry.payload.message).join("\n");
  for (const marker of ["jl-fixture:page-ready", "jl-fixture:console-warning", "jl-fixture:console-error"]) {
    assert(consoleMessages.includes(marker), `Fixture is missing console marker ${marker}.`);
  }

  const networkUrls = archive.sections.network.map((entry) => entry.payload.url);
  for (const marker of [
    "/fixture.css",
    "/fixture.js",
    "/fixture.svg",
    "/api/boot",
    "/api/data",
    "/api/xhr",
    "/api/submit",
    "/api/expected-error"
  ]) {
    assert(networkUrls.some((url) => new URL(url).pathname === marker), `Fixture is missing network asset ${marker}.`);
  }

  const expectedError = archive.sections.network.find(
    (entry) => new URL(entry.payload.url).pathname === "/api/expected-error"
  );
  assert(expectedError?.payload.status === 418, "Expected-error request must keep status 418.");
  assert(
    archive.page.url === "http://127.0.0.1:4399/recording-fixture/step",
    `Fixture final page URL was not captured or sanitized: ${archive.page.url}`
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const fixture = args.includes("--fixture");
  const inputPath = args.find((arg) => !arg.startsWith("--"));
  if (!inputPath) {
    throw new Error("Usage: bun run test:recording-assets -- <session-or-output-dir> [--fixture]");
  }

  const report = await validateRecordingAssets(inputPath, { fixture });
  console.table({
    session: report.sessionId,
    "video bytes": report.recordingBytes,
    "archive bytes": report.archiveBytes,
    "duration ms": report.durationMs,
    actions: report.actionCount,
    console: report.consoleCount,
    requests: report.requestCount,
    interactions: report.interactionTypes.join(", "),
    "network types": report.networkSubtypes.join(", ")
  });
  console.info(`PASS: full recording assets are valid in ${report.sessionDir}`);
}
