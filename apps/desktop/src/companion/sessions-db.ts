import { mkdirSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import Database from "libsql";

import {
  replaceMergeGroups,
  archiveActionSchema,
  archiveAnnotationSchema,
  archiveConsoleEntrySchema,
  archiveNetworkEntrySchema,
  sessionArchiveSchema,
  type ArchiveAction,
  type ArchiveAnnotation,
  type ArchiveConsoleEntry,
  type ArchiveNetworkEntry,
  type SessionArchive
} from "@jittle-lamp/shared";

import type { ViewerPayload } from "../rpc";

type ArtifactName = "recording.webm" | "session.archive.json";

export type SessionArtifact = {
  artifactName: string;
  destinationPath: string;
  bytes: number;
  at: string;
};

export type SessionRecord = {
  sessionId: string;
  sessionFolder: string;
  artifacts: SessionArtifact[];
  totalBytes: number;
  recordedAt: string;
  tags: string[];
  notes: string;
  remoteEvidenceId?: string | undefined;
  remoteOrgId?: string | undefined;
  remoteSyncedAt?: string | undefined;
};

type SessionWriteRow = {
  id: string;
  session_id: string;
  artifact_name: string;
  destination_path: string;
  session_folder: string;
  bytes: number;
  at: string;
};

type StoredSessionEventRow = {
  id: string;
  section: "actions" | "console" | "network";
  at: string;
  seq: number;
  subtype: string | null;
  tags_json: string;
  payload_json: string;
};

type StoredAnnotationRow = {
  session_id: string;
  id: string;
  payload_json: string;
};

function notesTextFromArchive(archive: SessionArchive): string {
  return archive.notes.join("\n\n").trim();
}

function notesArrayFromText(notes: string): string[] {
  const trimmed = notes.trim();
  return trimmed ? [trimmed] : [];
}

function stringifyArchive(archive: SessionArchive): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

const defaultDbDir = join(homedir(), ".jittle-lamp");
const defaultDbPath = join(defaultDbDir, "sessions.db");

let _overrideDbPath: string | null = null;
let db: Database.Database | null = null;

export function _testOverrideDb(path: string): void {
  if (db) {
    db.close();
    db = null;
  }
  _overrideDbPath = path;
}

function resolvedDbPath(): string {
  return _overrideDbPath ?? defaultDbPath;
}

function getDb(): Database.Database {
  if (db) return db;

  if (resolvedDbPath() !== ":memory:") {
    mkdirSync(dirname(resolvedDbPath()), { recursive: true });
  }

  db = new Database(resolvedDbPath());
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_writes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      artifact_name TEXT NOT NULL,
      destination_path TEXT NOT NULL,
      session_folder TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_writes_session_id
    ON session_writes (session_id)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (session_id, tag)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      notes TEXT NOT NULL DEFAULT ''
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_events (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      section TEXT NOT NULL,
      at TEXT NOT NULL,
      seq INTEGER NOT NULL,
      subtype TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_session_events_session_section_seq
    ON session_events (session_id, section, seq)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_annotations (
      session_id TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (session_id, id)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_remote_syncs (
      session_id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      synced_at TEXT NOT NULL
    )
  `);

  return db;
}

export async function initSessionsDb(): Promise<void> {
  if (resolvedDbPath() !== ":memory:") {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(resolvedDbPath()), { recursive: true }));
  }
  getDb();
}

export function insertSessionWrite(input: {
  id: string;
  sessionId: string;
  artifactName: ArtifactName;
  destinationPath: string;
  sessionFolder: string;
  bytes: number;
  at: string;
}): void {
  getDb().prepare(
    `INSERT OR REPLACE INTO session_writes
     (id, session_id, artifact_name, destination_path, session_folder, bytes, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(input.id, input.sessionId, input.artifactName, input.destinationPath, input.sessionFolder, input.bytes, input.at);
}

export function persistSessionArchive(archive: SessionArchive): void {
  const database = getDb();

  database.prepare(`DELETE FROM session_events WHERE session_id = ?`).run(archive.sessionId);
  database.prepare(`DELETE FROM session_annotations WHERE session_id = ?`).run(archive.sessionId);

  const insertEvent = database.prepare(
    `INSERT OR REPLACE INTO session_events
      (session_id, id, section, at, seq, subtype, tags_json, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const insertAnnotation = database.prepare(
    `INSERT OR REPLACE INTO session_annotations (session_id, id, payload_json)
     VALUES (?, ?, ?)`
  );

  const transaction = database.transaction((input: SessionArchive) => {
    for (const entry of input.sections.actions) {
      insertEvent.run(input.sessionId, entry.id, "actions", entry.at, entry.seq, null, JSON.stringify(entry.tags), JSON.stringify(entry.payload));
    }

    for (const entry of input.sections.console) {
      insertEvent.run(input.sessionId, entry.id, "console", entry.at, entry.seq, null, "[]", JSON.stringify(entry.payload));
    }

    for (const entry of input.sections.network) {
      insertEvent.run(
        input.sessionId,
        entry.id,
        "network",
        entry.at,
        entry.seq,
        entry.subtype,
        "[]",
        JSON.stringify(entry.payload)
      );
    }

    for (const annotation of input.annotations) {
      insertAnnotation.run(input.sessionId, annotation.id, JSON.stringify(annotation));
    }
  });

  transaction(archive);
}

function buildArchiveFromDb(sessionId: string, seed: SessionArchive): SessionArchive {
  const database = getDb();
  const rows = database
    .prepare<[string]>(
      `SELECT id, section, at, seq, subtype, tags_json, payload_json
       FROM session_events
       WHERE session_id = ?
       ORDER BY seq ASC`
    )
    .all(sessionId) as StoredSessionEventRow[];

  const annotations = database
    .prepare<[string]>(
      `SELECT session_id, id, payload_json FROM session_annotations WHERE session_id = ? ORDER BY id ASC`
    )
    .all(sessionId) as StoredAnnotationRow[];

  const parsedAnnotations = annotations
    .map((row) => archiveAnnotationSchema.parse(JSON.parse(row.payload_json)) as ArchiveAnnotation);

  const actions: ArchiveAction[] = [];
  const consoleEntries: ArchiveConsoleEntry[] = [];
  const networkEntries: ArchiveNetworkEntry[] = [];

  for (const row of rows) {
    if (row.section === "actions") {
      actions.push(
        archiveActionSchema.parse({
          id: row.id,
          seq: row.seq,
          at: row.at,
          tags: JSON.parse(row.tags_json) as string[],
          payload: JSON.parse(row.payload_json)
        })
      );
      continue;
    }

    if (row.section === "console") {
      consoleEntries.push(
        archiveConsoleEntrySchema.parse({
          id: row.id,
          seq: row.seq,
          at: row.at,
          payload: JSON.parse(row.payload_json)
        })
      );
      continue;
    }

    networkEntries.push(
      archiveNetworkEntrySchema.parse({
        id: row.id,
        seq: row.seq,
        at: row.at,
        subtype: row.subtype ?? "other",
        payload: JSON.parse(row.payload_json)
      })
    );
  }

  return sessionArchiveSchema.parse({
    ...seed,
    sections: {
      actions,
      console: consoleEntries,
      network: networkEntries
    },
    annotations: parsedAnnotations
  });
}

export async function scanLibrarySessions(outputDir: string): Promise<SessionRecord[]> {
  const names: string[] = [];

  try {
    names.push(...(await readdir(outputDir)));
  } catch {
    return [];
  }

  const tagRows = getDb()
    .prepare<[]>(`SELECT session_id, tag FROM session_tags ORDER BY tag ASC`)
    .all() as { session_id: string; tag: string }[];

  const metaRows = getDb()
    .prepare<[]>(`SELECT session_id, notes FROM session_meta`)
    .all() as { session_id: string; notes: string }[];

  const tagsBySession = new Map<string, string[]>();
  for (const row of tagRows) {
    const existing = tagsBySession.get(row.session_id);
    if (existing) {
      existing.push(row.tag);
    } else {
      tagsBySession.set(row.session_id, [row.tag]);
    }
  }

  const notesBySession = new Map<string, string>();
  for (const row of metaRows) {
    notesBySession.set(row.session_id, row.notes);
  }
  const remoteBySession = getRemoteSyncsBySession();

  const sessions: SessionRecord[] = [];

  for (const name of names) {
    const folderPath = join(outputDir, name);
    const folderStat = await stat(folderPath).catch(() => null);
    if (!folderStat?.isDirectory()) continue;

    const sessionId = name;
    const webmPath = join(folderPath, "recording.webm");
    const archivePath = join(folderPath, "session.archive.json");

    let webmBytes: number;
    let archiveBytes: number;

    try {
      const [webmStat, archiveStat] = await Promise.all([stat(webmPath), stat(archivePath)]);
      webmBytes = webmStat.size;
      archiveBytes = archiveStat.size;
    } catch {
      continue;
    }

    let archive: SessionArchive;

    try {
      const raw = JSON.parse(await readFile(archivePath, "utf8")) as unknown;
      const result = sessionArchiveSchema.safeParse(raw);
      if (!result.success) continue;
      archive = result.data;
    } catch {
      continue;
    }

    const remote = remoteBySession.get(sessionId);
    sessions.push({
      sessionId,
      sessionFolder: folderPath,
      artifacts: [
        {
          artifactName: "recording.webm",
          destinationPath: webmPath,
          bytes: webmBytes,
          at: archive.createdAt
        },
        {
          artifactName: "session.archive.json",
          destinationPath: archivePath,
          bytes: archiveBytes,
          at: archive.createdAt
        }
      ],
      totalBytes: webmBytes + archiveBytes,
      recordedAt: archive.createdAt,
      tags: tagsBySession.get(sessionId) ?? [],
      notes: notesBySession.get(sessionId) ?? "",
      remoteEvidenceId: remote?.evidenceId,
      remoteOrgId: remote?.orgId,
      remoteSyncedAt: remote?.syncedAt
    });
  }

  return sessions.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function listSessionRecords(): SessionRecord[] {
  const rows = getDb()
    .prepare<[]>(
      `SELECT id, session_id, artifact_name, destination_path, session_folder, bytes, at
       FROM session_writes
       ORDER BY at ASC`
    )
    .all() as SessionWriteRow[];

  const tagRows = getDb()
    .prepare<[]>(`SELECT session_id, tag FROM session_tags ORDER BY tag ASC`)
    .all() as { session_id: string; tag: string }[];

  const metaRows = getDb()
    .prepare<[]>(`SELECT session_id, notes FROM session_meta`)
    .all() as { session_id: string; notes: string }[];

  const tagsBySession = new Map<string, string[]>();
  for (const row of tagRows) {
    const existing = tagsBySession.get(row.session_id);
    if (existing) {
      existing.push(row.tag);
    } else {
      tagsBySession.set(row.session_id, [row.tag]);
    }
  }

  const notesBySession = new Map<string, string>();
  for (const row of metaRows) {
    notesBySession.set(row.session_id, row.notes);
  }
  const remoteBySession = getRemoteSyncsBySession();

  const sessionMap = new Map<string, SessionRecord>();

  for (const row of rows) {
    const artifact: SessionArtifact = {
      artifactName: row.artifact_name,
      destinationPath: row.destination_path,
      bytes: row.bytes,
      at: row.at
    };

    const existing = sessionMap.get(row.session_id);
    if (existing) {
      existing.artifacts.push(artifact);
      existing.totalBytes += row.bytes;
      if (row.at > existing.recordedAt) existing.recordedAt = row.at;
      continue;
    }

    const remote = remoteBySession.get(row.session_id);
    sessionMap.set(row.session_id, {
      sessionId: row.session_id,
      sessionFolder: row.session_folder,
      artifacts: [artifact],
      totalBytes: row.bytes,
      recordedAt: row.at,
      tags: tagsBySession.get(row.session_id) ?? [],
      notes: notesBySession.get(row.session_id) ?? "",
      remoteEvidenceId: remote?.evidenceId,
      remoteOrgId: remote?.orgId,
      remoteSyncedAt: remote?.syncedAt
    });
  }

  return Array.from(sessionMap.values()).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}

export function addSessionTag(sessionId: string, tag: string): void {
  getDb().prepare(`INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)`).run(sessionId, tag);
}

export function removeSessionTag(sessionId: string, tag: string): void {
  getDb().prepare(`DELETE FROM session_tags WHERE session_id = ? AND tag = ?`).run(sessionId, tag);
}

export function listAllTags(): string[] {
  return getDb()
    .prepare<[]>(`SELECT DISTINCT tag FROM session_tags ORDER BY tag ASC`)
    .all()
    .map((row) => row as { tag: string })
    .map((row) => row.tag);
}

export function setSessionNotes(sessionId: string, notes: string): void {
  getDb().prepare(
    `INSERT INTO session_meta (session_id, notes)
     VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET notes = excluded.notes`
  ).run(sessionId, notes);
}

export async function saveLibrarySessionReviewState(input: {
  sessionId: string;
  outputDir: string;
  notes: string;
  annotations: ArchiveAnnotation[];
}): Promise<SessionArchive> {
  const sessionFolder = resolve(join(resolve(input.outputDir), input.sessionId));
  const archivePath = join(sessionFolder, "session.archive.json");

  const raw = JSON.parse(await readFile(archivePath, "utf8")) as unknown;
  const result = sessionArchiveSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Session archive validation failed for ${input.sessionId}: ${result.error.message}`);
  }

  const nextArchive = sessionArchiveSchema.parse({
    ...result.data,
    updatedAt: new Date().toISOString(),
    notes: notesArrayFromText(input.notes),
    annotations: replaceMergeGroups(result.data.annotations, input.annotations)
  });

  await writeFile(archivePath, stringifyArchive(nextArchive), "utf8");
  setSessionNotes(input.sessionId, input.notes);
  persistSessionArchive(nextArchive);
  return nextArchive;
}

export function getSessionNotes(sessionId: string): string {
  const row = getDb().prepare<[string]>(`SELECT notes FROM session_meta WHERE session_id = ?`).get(sessionId) as
    | { notes: string }
    | undefined;
  return row?.notes ?? "";
}

export function removeSessionRecords(sessionId: string): void {
  getDb().prepare(`DELETE FROM session_writes WHERE session_id = ?`).run(sessionId);
  getDb().prepare(`DELETE FROM session_tags WHERE session_id = ?`).run(sessionId);
  getDb().prepare(`DELETE FROM session_meta WHERE session_id = ?`).run(sessionId);
  getDb().prepare(`DELETE FROM session_events WHERE session_id = ?`).run(sessionId);
  getDb().prepare(`DELETE FROM session_annotations WHERE session_id = ?`).run(sessionId);
}

type RemoteSyncRow = {
  session_id: string;
  evidence_id: string;
  org_id: string;
  synced_at: string;
};

function getRemoteSyncsBySession(): Map<string, { evidenceId: string; orgId: string; syncedAt: string }> {
  const rows = getDb()
    .prepare<[]>(`SELECT session_id, evidence_id, org_id, synced_at FROM session_remote_syncs`)
    .all() as RemoteSyncRow[];

  return new Map(
    rows.map((row) => [
      row.session_id,
      {
        evidenceId: row.evidence_id,
        orgId: row.org_id,
        syncedAt: row.synced_at
      }
    ])
  );
}

export function markSessionRemoteSynced(input: {
  sessionId: string;
  evidenceId: string;
  orgId: string;
  syncedAt?: string;
}): void {
  getDb().prepare(
    `INSERT INTO session_remote_syncs (session_id, evidence_id, org_id, synced_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       evidence_id = excluded.evidence_id,
       org_id = excluded.org_id,
       synced_at = excluded.synced_at`
  ).run(input.sessionId, input.evidenceId, input.orgId, input.syncedAt ?? new Date().toISOString());
}

export async function loadLibrarySession(sessionId: string, outputDir: string): Promise<ViewerPayload> {
  const safeOutputDir = resolve(outputDir);
  const sessionFolder = resolve(join(safeOutputDir, sessionId));

  if (!sessionFolder.startsWith(safeOutputDir + "/") && sessionFolder !== safeOutputDir) {
    throw new Error("Invalid sessionId: path traversal detected.");
  }

  const archivePath = join(sessionFolder, "session.archive.json");
  const videoPath = join(sessionFolder, "recording.webm");

  const [archiveStat, videoStat] = await Promise.all([
    stat(archivePath).catch(() => null),
    stat(videoPath).catch(() => null)
  ]);

  if (!archiveStat?.isFile()) {
    throw new Error(`Session not found or missing session.archive.json: ${sessionId}`);
  }
  if (!videoStat?.isFile()) {
    throw new Error(`Session not found or missing recording.webm: ${sessionId}`);
  }

  const raw = JSON.parse(await readFile(archivePath, "utf8")) as unknown;
  const result = sessionArchiveSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`Session archive validation failed for ${sessionId}: ${result.error.message}`);
  }

  persistSessionArchive(result.data);

  const storedNotes = getSessionNotes(sessionId);
  const archiveNotes = notesTextFromArchive(result.data);
  const notes = storedNotes || archiveNotes;

  if (!storedNotes && archiveNotes) {
    setSessionNotes(sessionId, archiveNotes);
  }

  return {
    source: "library",
    archive: buildArchiveFromDb(sessionId, result.data),
    videoPath,
    notes
  };
}
