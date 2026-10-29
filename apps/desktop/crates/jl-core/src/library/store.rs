//! `session_events` / `session_annotations` mirrors of an archive (`persistSessionArchive`).

use anyhow::Result;
use rusqlite::params;

use super::Library;
use crate::archive::SessionArchive;

impl Library {
    pub(crate) fn persist_archive(&self, archive: &SessionArchive) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM session_events WHERE session_id = ?",
            [&archive.session_id],
        )?;
        tx.execute(
            "DELETE FROM session_annotations WHERE session_id = ?",
            [&archive.session_id],
        )?;
        {
            let mut insert_event = tx.prepare(
                "INSERT OR REPLACE INTO session_events
                 (session_id, id, section, at, seq, subtype, tags_json, payload_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )?;
            let id = &archive.session_id;
            for entry in &archive.sections.actions {
                let tags = serde_json::to_string(&entry.tags)?;
                let payload = serde_json::to_string(&entry.payload)?;
                insert_event.execute(params![
                    id,
                    entry.id,
                    "actions",
                    entry.at,
                    entry.seq as i64,
                    None::<String>,
                    tags,
                    payload
                ])?;
            }
            for entry in &archive.sections.console {
                let tags = serde_json::to_string(entry.tags.as_deref().unwrap_or_default())?;
                let payload = serde_json::to_string(&entry.payload)?;
                insert_event.execute(params![
                    id,
                    entry.id,
                    "console",
                    entry.at,
                    entry.seq as i64,
                    None::<String>,
                    tags,
                    payload
                ])?;
            }
            for entry in &archive.sections.network {
                let tags = serde_json::to_string(entry.tags.as_deref().unwrap_or_default())?;
                let subtype = serde_json::to_value(entry.subtype)?;
                let payload = serde_json::to_string(&entry.payload)?;
                insert_event.execute(params![
                    id,
                    entry.id,
                    "network",
                    entry.at,
                    entry.seq as i64,
                    subtype.as_str(),
                    tags,
                    payload
                ])?;
            }

            let mut insert_annotation =
                tx.prepare("INSERT OR REPLACE INTO session_annotations (session_id, id, payload_json) VALUES (?, ?, ?)")?;
            for annotation in &archive.annotations {
                insert_annotation.execute(params![
                    id,
                    annotation.id(),
                    serde_json::to_string(annotation)?
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn remove_records(&self, session_id: &str) -> Result<()> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for table in [
            "session_writes",
            "session_tags",
            "session_meta",
            "session_events",
            "session_annotations",
        ] {
            tx.execute(
                &format!("DELETE FROM {table} WHERE session_id = ?"),
                [session_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}
