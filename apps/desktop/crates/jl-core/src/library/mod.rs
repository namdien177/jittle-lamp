//! The local session library: session folders under the output dir plus the SQLite catalog in
//! `~/.jittle-lamp/sessions.db` (port of `companion/sessions-db.ts`).

mod scan;
mod schema;
mod sessions;
mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::{Mutex, RwLock};
use rusqlite::{Connection, OptionalExtension, params};

use crate::archive::{ArtifactKind, RecorderKind, SessionArchive};
use crate::{config, paths};

pub use sessions::load_folder;

#[derive(Clone)]
pub struct Library {
    conn: Arc<Mutex<Connection>>,
    output_dir: Arc<RwLock<PathBuf>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionRecord {
    pub session_id: String,
    pub session_folder: PathBuf,
    pub name: String,
    pub page_url: String,
    pub page_title: String,
    pub recorder_kind: RecorderKind,
    pub recorded_at: String,
    pub duration_ms: Option<f64>,
    pub action_count: u64,
    pub request_count: u64,
    pub console_error_count: u64,
    pub video_path: PathBuf,
    pub video_mime: &'static str,
    pub artifacts: Vec<ArtifactFile>,
    pub total_bytes: u64,
    pub tags: Vec<String>,
    pub notes: String,
    pub remote: Option<RemoteSync>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactFile {
    pub artifact_name: String,
    pub path: PathBuf,
    pub bytes: u64,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSync {
    pub evidence_id: String,
    pub org_id: String,
    pub synced_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactWrite {
    pub id: String,
    pub at: String,
    pub session_id: String,
    pub artifact_name: String,
    pub destination_path: PathBuf,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionSource {
    Library,
    Local,
    Zip { temp_id: String },
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoadedSession {
    pub archive: SessionArchive,
    pub folder: PathBuf,
    pub video_path: PathBuf,
    pub video_mime: &'static str,
    pub notes: String,
    pub source: SessionSource,
}

/// The recording in a session folder: `recording.webm`, else `recording.mp4`.
pub fn find_video(folder: &Path) -> Option<(PathBuf, ArtifactKind)> {
    [ArtifactKind::RecordingWebm, ArtifactKind::RecordingMp4]
        .into_iter()
        .find_map(|kind| {
            let path = folder.join(kind.file_name());
            path.is_file().then_some((path, kind))
        })
}

impl Library {
    pub fn open(db_path: impl AsRef<Path>, output_dir: impl Into<PathBuf>) -> Result<Self> {
        let db_path = db_path.as_ref();
        if db_path != Path::new(":memory:")
            && let Some(dir) = db_path.parent()
        {
            std::fs::create_dir_all(dir).with_context(|| format!("Creating {}", dir.display()))?;
        }
        let conn =
            Connection::open(db_path).with_context(|| format!("Opening {}", db_path.display()))?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(schema::SCHEMA)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            output_dir: Arc::new(RwLock::new(paths::resolve(output_dir.into()))),
        })
    }

    /// `~/.jittle-lamp/sessions.db` with the output dir from `companion.json`.
    pub fn open_default() -> Result<Self> {
        Self::open(config::default_db_path(), config::load().output_dir)
    }

    pub fn output_dir(&self) -> PathBuf {
        self.output_dir.read().clone()
    }

    pub fn set_output_dir(&self, output_dir: impl Into<PathBuf>) {
        *self.output_dir.write() = paths::resolve(output_dir.into());
    }

    pub fn notes(&self, session_id: &str) -> Result<String> {
        let conn = self.conn.lock();
        let notes = conn
            .query_row(
                "SELECT notes FROM session_meta WHERE session_id = ?",
                [session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(notes.unwrap_or_default())
    }

    pub fn set_notes(&self, session_id: &str, notes: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO session_meta (session_id, notes) VALUES (?, ?)
             ON CONFLICT(session_id) DO UPDATE SET notes = excluded.notes",
            params![session_id, notes],
        )?;
        Ok(())
    }

    pub fn tags(&self, session_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut statement =
            conn.prepare("SELECT tag FROM session_tags WHERE session_id = ? ORDER BY tag ASC")?;
        let tags = statement
            .query_map([session_id], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(tags)
    }

    pub fn add_tag(&self, session_id: &str, tag: &str) -> Result<()> {
        self.conn.lock().execute(
            "INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)",
            params![session_id, tag],
        )?;
        Ok(())
    }

    pub fn remove_tag(&self, session_id: &str, tag: &str) -> Result<()> {
        self.conn.lock().execute(
            "DELETE FROM session_tags WHERE session_id = ? AND tag = ?",
            params![session_id, tag],
        )?;
        Ok(())
    }

    pub fn all_tags(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut statement =
            conn.prepare("SELECT DISTINCT tag FROM session_tags ORDER BY tag ASC")?;
        let tags = statement
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(tags)
    }

    pub fn remote_sync(&self, session_id: &str) -> Result<Option<RemoteSync>> {
        Ok(self.remote_syncs()?.remove(session_id))
    }

    pub fn mark_remote_synced(
        &self,
        session_id: &str,
        evidence_id: &str,
        org_id: &str,
        synced_at: Option<&str>,
    ) -> Result<()> {
        let synced_at = synced_at.map_or_else(crate::now_iso, str::to_owned);
        self.conn.lock().execute(
            "INSERT INTO session_remote_syncs (session_id, evidence_id, org_id, synced_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               evidence_id = excluded.evidence_id,
               org_id = excluded.org_id,
               synced_at = excluded.synced_at",
            params![session_id, evidence_id, org_id, synced_at],
        )?;
        Ok(())
    }

    /// `insertSessionWrite` for an artifact the companion (or the recorder) just wrote.
    pub fn record_artifact_write(
        &self,
        session_id: &str,
        artifact_name: &str,
        destination_path: &Path,
        bytes: u64,
    ) -> Result<ArtifactWrite> {
        let write = ArtifactWrite {
            id: format!(
                "{session_id}:{artifact_name}:{}",
                chrono::Utc::now().timestamp_millis()
            ),
            at: crate::now_iso(),
            session_id: session_id.to_owned(),
            artifact_name: artifact_name.to_owned(),
            destination_path: destination_path.to_path_buf(),
            bytes,
        };
        let folder = destination_path.parent().unwrap_or(destination_path);
        self.conn.lock().execute(
            "INSERT OR REPLACE INTO session_writes
             (id, session_id, artifact_name, destination_path, session_folder, bytes, at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                write.id,
                write.session_id,
                write.artifact_name,
                path_str(&write.destination_path),
                path_str(folder),
                write.bytes as i64,
                write.at
            ],
        )?;
        Ok(write)
    }

    pub fn recent_artifact_writes(&self, limit: usize) -> Result<Vec<ArtifactWrite>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT id, at, session_id, artifact_name, destination_path, bytes
             FROM session_writes ORDER BY at DESC LIMIT ?",
        )?;
        let writes = statement
            .query_map([limit as i64], |row| {
                Ok(ArtifactWrite {
                    id: row.get(0)?,
                    at: row.get(1)?,
                    session_id: row.get(2)?,
                    artifact_name: row.get(3)?,
                    destination_path: PathBuf::from(row.get::<_, String>(4)?),
                    bytes: row.get::<_, i64>(5)?.max(0) as u64,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(writes)
    }

    fn tags_by_session(&self) -> Result<HashMap<String, Vec<String>>> {
        let conn = self.conn.lock();
        let mut statement =
            conn.prepare("SELECT session_id, tag FROM session_tags ORDER BY tag ASC")?;
        let mut tags: HashMap<String, Vec<String>> = HashMap::new();
        for row in statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })? {
            let (session_id, tag) = row?;
            tags.entry(session_id).or_default().push(tag);
        }
        Ok(tags)
    }

    fn notes_by_session(&self) -> Result<HashMap<String, String>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare("SELECT session_id, notes FROM session_meta")?;
        let notes = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(notes)
    }

    fn remote_syncs(&self) -> Result<HashMap<String, RemoteSync>> {
        let conn = self.conn.lock();
        let mut statement = conn.prepare(
            "SELECT session_id, evidence_id, org_id, synced_at FROM session_remote_syncs",
        )?;
        let syncs = statement
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    RemoteSync {
                        evidence_id: row.get(1)?,
                        org_id: row.get(2)?,
                        synced_at: row.get(3)?,
                    },
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(syncs)
    }
}

fn path_str(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests;
