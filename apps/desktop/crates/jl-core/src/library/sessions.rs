//! Opening, editing and deleting single sessions.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

use super::{Library, LoadedSession, SessionSource, find_video};
use crate::archive::{
    Annotation, SessionArchive, parse_archive, replace_merge_groups, to_pretty_json,
};
use crate::paths;

impl Library {
    /// `loadLibrarySession`: reads the archive, mirrors it into SQLite and resolves notes.
    pub fn load_session(&self, session_id: &str) -> Result<LoadedSession> {
        let folder = paths::session_folder(&self.output_dir(), session_id)?;
        let archive_path = folder.join(crate::SESSION_ARCHIVE_FILE);
        if !archive_path.is_file() {
            bail!(
                "Session not found or missing {}: {session_id}",
                crate::SESSION_ARCHIVE_FILE
            );
        }
        let Some((video_path, video_kind)) = find_video(&folder) else {
            bail!("Session not found or missing a recording: {session_id}");
        };
        let archive = read_archive(&archive_path)
            .with_context(|| format!("Session archive validation failed for {session_id}"))?;

        self.persist_archive(&archive)?;
        let stored_notes = self.notes(session_id)?;
        let notes = if stored_notes.is_empty() {
            let archive_notes = archive.notes_text();
            if !archive_notes.is_empty() {
                self.set_notes(session_id, &archive_notes)?;
            }
            archive_notes
        } else {
            stored_notes
        };

        Ok(LoadedSession {
            archive,
            folder,
            video_path,
            video_mime: video_kind.mime_type(),
            notes,
            source: SessionSource::Library,
        })
    }

    /// `deleteSession`: removes the folder and its catalog rows.
    pub fn delete_session(&self, session_id: &str) -> Result<()> {
        if !paths::is_valid_session_id(session_id) {
            bail!("Invalid session id: {session_id}");
        }
        let root = paths::resolve(self.output_dir());
        let folder = paths::resolve(root.join(session_id));
        if !paths::is_strictly_within(&root, &folder) {
            bail!("Resolved session folder escapes the configured output directory.");
        }
        match std::fs::remove_dir_all(&folder) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error).with_context(|| format!("Deleting {}", folder.display()));
            }
            _ => {}
        }
        self.remove_records(session_id)
    }

    /// `saveLibrarySessionReviewState`: notes and merge groups go into the archive and the catalog.
    pub fn save_review_state(
        &self,
        session_id: &str,
        notes: &str,
        annotations: &[Annotation],
    ) -> Result<SessionArchive> {
        let archive = self.update_archive(session_id, |archive| {
            let trimmed = notes.trim();
            archive.notes = if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![trimmed.to_owned()]
            };
            archive.annotations = replace_merge_groups(&archive.annotations, annotations);
            Ok(())
        })?;
        self.set_notes(session_id, notes)?;
        Ok(archive)
    }

    pub fn rename_session(&self, session_id: &str, name: &str) -> Result<SessionArchive> {
        let name = name.trim();
        if name.is_empty() {
            bail!("Session name cannot be empty.");
        }
        self.update_archive(session_id, |archive| {
            archive.name = name.to_owned();
            Ok(())
        })
    }

    fn update_archive(
        &self,
        session_id: &str,
        edit: impl FnOnce(&mut SessionArchive) -> Result<()>,
    ) -> Result<SessionArchive> {
        let folder = paths::session_folder(&self.output_dir(), session_id)?;
        let archive_path = folder.join(crate::SESSION_ARCHIVE_FILE);
        let mut archive = read_archive(&archive_path)
            .with_context(|| format!("Session archive validation failed for {session_id}"))?;
        edit(&mut archive)?;
        archive.updated_at = crate::now_iso();
        write_archive(&archive_path, &archive)?;
        self.persist_archive(&archive)?;
        Ok(archive)
    }
}

/// An ad-hoc folder holding `session.archive.json` and a recording, outside the library.
pub fn load_folder(folder: impl AsRef<Path>) -> Result<LoadedSession> {
    let folder = paths::resolve(folder);
    let archive_path = folder.join(crate::SESSION_ARCHIVE_FILE);
    if !archive_path.is_file() {
        bail!("Folder is missing {}", crate::SESSION_ARCHIVE_FILE);
    }
    let Some((video_path, video_kind)) = find_video(&folder) else {
        bail!(
            "Folder is missing {} or {}",
            crate::RECORDING_WEBM_FILE,
            crate::RECORDING_MP4_FILE
        );
    };
    let archive = read_archive(&archive_path).context("Invalid session bundle")?;
    Ok(LoadedSession {
        archive,
        folder,
        video_path,
        video_mime: video_kind.mime_type(),
        notes: String::new(),
        source: SessionSource::Local,
    })
}

impl Library {
    pub fn load_folder(&self, folder: impl AsRef<Path>) -> Result<LoadedSession> {
        load_folder(folder)
    }
}

pub(crate) fn read_archive(path: &Path) -> Result<SessionArchive> {
    let bytes = std::fs::read(path).with_context(|| format!("Reading {}", path.display()))?;
    parse_archive(&bytes)
}

/// Writes through a sibling temp file so readers never see a half-written archive.
pub(crate) fn write_archive(path: &Path, archive: &SessionArchive) -> Result<()> {
    let temp: PathBuf = path.with_extension("json.tmp");
    std::fs::write(&temp, to_pretty_json(archive))
        .with_context(|| format!("Writing {}", temp.display()))?;
    std::fs::rename(&temp, path).with_context(|| format!("Replacing {}", path.display()))?;
    Ok(())
}
