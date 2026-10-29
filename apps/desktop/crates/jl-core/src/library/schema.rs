/// The tables `companion/sessions-db.ts` creates; both apps open the same file.
pub const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS session_writes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  artifact_name TEXT NOT NULL,
  destination_path TEXT NOT NULL,
  session_folder TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_writes_session_id
ON session_writes (session_id);
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (session_id, tag)
);
CREATE TABLE IF NOT EXISTS session_meta (
  session_id TEXT PRIMARY KEY,
  notes TEXT NOT NULL DEFAULT ''
);
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
);
CREATE INDEX IF NOT EXISTS idx_session_events_session_section_seq
ON session_events (session_id, section, seq);
CREATE TABLE IF NOT EXISTS session_annotations (
  session_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS session_remote_syncs (
  session_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
";
