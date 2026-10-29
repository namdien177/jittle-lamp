//! `scanLibrarySessions`: every `<outputDir>/<id>/` with an archive and a recording.

use std::path::Path;

use anyhow::Result;

use super::{ArtifactFile, Library, SessionRecord, find_video};
use crate::archive::parse_archive;

impl Library {
    /// Newest first. Folders without a recording or with an invalid archive are skipped.
    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>> {
        let output_dir = self.output_dir();
        let Ok(entries) = std::fs::read_dir(&output_dir) else {
            return Ok(Vec::new());
        };

        let mut tags = self.tags_by_session()?;
        let notes = self.notes_by_session()?;
        let mut remotes = self.remote_syncs()?;
        let mut sessions = Vec::new();

        for entry in entries.flatten() {
            let folder = entry.path();
            if !folder.is_dir() {
                continue;
            }
            let Some(session_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Some(mut record) = read_session_folder(&folder, &session_id) else {
                continue;
            };
            record.tags = tags.remove(&session_id).unwrap_or_default();
            record.notes = notes.get(&session_id).cloned().unwrap_or_default();
            record.remote = remotes.remove(&session_id);
            sessions.push(record);
        }

        sessions.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at));
        Ok(sessions)
    }
}

fn read_session_folder(folder: &Path, session_id: &str) -> Option<SessionRecord> {
    let archive_path = folder.join(crate::SESSION_ARCHIVE_FILE);
    let (video_path, video_kind) = find_video(folder)?;
    let video_bytes = std::fs::metadata(&video_path).ok()?.len();
    let archive_bytes = std::fs::read(&archive_path).ok()?;
    let archive = match parse_archive(&archive_bytes) {
        Ok(archive) => archive,
        Err(error) => {
            log::warn!("Skipping {}: {error:#}", folder.display());
            return None;
        }
    };

    let artifact = |name: &str, path: &Path, bytes: u64| ArtifactFile {
        artifact_name: name.to_owned(),
        path: path.to_path_buf(),
        bytes,
        at: archive.created_at.clone(),
    };
    let artifacts = vec![
        artifact(video_kind.file_name(), &video_path, video_bytes),
        artifact(
            crate::SESSION_ARCHIVE_FILE,
            &archive_path,
            archive_bytes.len() as u64,
        ),
    ];

    Some(SessionRecord {
        session_id: session_id.to_owned(),
        session_folder: folder.to_path_buf(),
        page_url: archive.page.url.clone(),
        page_title: archive.page.title.clone(),
        recorder_kind: archive.recorder.kind(),
        recorded_at: archive.created_at.clone(),
        duration_ms: archive.duration_ms(),
        action_count: archive.action_count(),
        request_count: archive.request_count(),
        console_error_count: archive.console_error_count(),
        video_path,
        video_mime: video_kind.mime_type(),
        total_bytes: video_bytes + archive_bytes.len() as u64,
        artifacts,
        tags: Vec::new(),
        notes: String::new(),
        remote: None,
        name: archive.name,
    })
}
