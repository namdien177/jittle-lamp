// Desktop session upload, ported from apps/desktop/src/mainview/session-sync.ts and the
// `prepareSessionUpload` handler in apps/desktop/src/electron/main.ts:
//
//   1. hash every artifact file (sha256, streamed from disk)
//   2. POST /evidences/desktop-sessions/sync/start with checksums and sourceMetadata
//   3. for each artifact: PUT the file to its upload URL, then POST /evidences/uploads/:id/complete
//
// Files are streamed for both hashing and upload; only the session archive is read into memory
// (for its summary counts). The backend uploads into the session's active organisation.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ureq::SendBody;
use ureq::http::Request;

use crate::error::ApiError;
use crate::http::{ApiClient, encode_component, error_for};
use crate::remote::is_allowed_artifact_url;

pub const SESSION_ARCHIVE_FILE_NAME: &str = "session.archive.json";
/// `thumbnailBase64` is limited to 20 000 characters; larger thumbnails are left out.
pub const MAX_THUMBNAIL_BASE64_LEN: usize = 20_000;
const MAX_ARCHIVE_STATS_BYTES: u64 = 64 * 1024 * 1024;
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;
const READ_CHUNK_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKey {
    /// The primary recording (`recording.webm`, or `recording.mp4` for native captures).
    Recording,
    /// `session.archive.json`.
    Archive,
    /// An MP4 copy uploaded next to a WebM recording.
    Playback,
}

impl ArtifactKey {
    pub fn as_str(self) -> &'static str {
        match self {
            ArtifactKey::Recording => "recording",
            ArtifactKey::Archive => "archive",
            ArtifactKey::Playback => "playback",
        }
    }

    /// The evidence artifact kind the backend stores.
    pub fn kind(self) -> &'static str {
        match self {
            ArtifactKey::Recording | ArtifactKey::Playback => "recording",
            ArtifactKey::Archive => "network-log",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncFile {
    pub path: PathBuf,
    pub mime_type: String,
}

impl SyncFile {
    /// Picks the MIME type from the extension (`.webm`, `.mp4`, `.json`).
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mime_type = mime_for_path(&path).to_string();
        Self { path, mime_type }
    }
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("json") => "application/json",
        _ => "video/webm",
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SyncInput {
    pub session_id: String,
    pub title: String,
    pub recording: SyncFile,
    pub playback: Option<SyncFile>,
    /// Path of `session.archive.json`.
    pub archive: PathBuf,
    /// JPEG bytes; sent as `thumbnailBase64` when the encoding fits the backend's limit.
    pub thumbnail_jpeg: Option<Vec<u8>>,
    /// Used for `durationMs` only when the archive has neither a video duration nor timestamps.
    pub video_duration_ms: Option<f64>,
    /// Re-sync into this evidence instead of creating a new one.
    pub replace_evidence_id: Option<String>,
}

impl SyncInput {
    /// Builds the input from a session folder: `recording.webm` (with `recording.mp4` as the
    /// playback copy when both exist) or `recording.mp4` alone, plus `session.archive.json`.
    pub fn from_session_folder(
        folder: &Path,
        session_id: &str,
        title: &str,
    ) -> Result<Self, ApiError> {
        let webm = folder.join("recording.webm");
        let mp4 = folder.join("recording.mp4");
        let (recording, playback) = match (webm.is_file(), mp4.is_file()) {
            (true, true) => (SyncFile::new(webm), Some(SyncFile::new(mp4))),
            (true, false) => (SyncFile::new(webm), None),
            (false, true) => (SyncFile::new(mp4), None),
            (false, false) => {
                return Err(ApiError::Invalid(format!(
                    "No recording found in {}.",
                    folder.display()
                )));
            }
        };
        let archive = folder.join(SESSION_ARCHIVE_FILE_NAME);
        if !archive.is_file() {
            return Err(ApiError::Invalid(format!(
                "No session archive found in {}.",
                folder.display()
            )));
        }
        Ok(Self {
            session_id: session_id.into(),
            title: title.into(),
            recording,
            playback,
            archive,
            thumbnail_jpeg: None,
            video_duration_ms: None,
            replace_evidence_id: None,
        })
    }

    fn files(&self) -> Vec<(ArtifactKey, &Path, &str)> {
        let mut files = vec![(
            ArtifactKey::Recording,
            self.recording.path.as_path(),
            self.recording.mime_type.as_str(),
        )];
        if let Some(playback) = &self.playback {
            files.push((
                ArtifactKey::Playback,
                playback.path.as_path(),
                playback.mime_type.as_str(),
            ));
        }
        files.push((
            ArtifactKey::Archive,
            self.archive.as_path(),
            "application/json",
        ));
        files
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncPhase {
    Hashing,
    Starting,
    Uploading,
    Completing,
    Done,
}

/// Progress across the whole sync; `bytes_total` is the size of all artifacts together, and
/// `bytes_done` restarts from 0 when uploading begins after hashing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncProgress {
    pub phase: SyncPhase,
    pub artifact: Option<ArtifactKey>,
    pub bytes_done: u64,
    pub bytes_total: u64,
}

impl SyncProgress {
    pub fn fraction(&self) -> f32 {
        if self.bytes_total == 0 {
            1.0
        } else {
            (self.bytes_done as f64 / self.bytes_total as f64) as f32
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedArtifact {
    pub key: ArtifactKey,
    pub path: PathBuf,
    pub mime_type: String,
    pub bytes: u64,
    /// `sha256:<lowercase hex>`.
    pub checksum: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncResult {
    pub evidence_id: String,
    pub organization_id: String,
    pub source_metadata: String,
    pub thumbnail_sent: bool,
    pub artifacts: Vec<PreparedArtifact>,
}

/// The `sourceMetadata` JSON string sent with a desktop session (session-sync.ts).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMetadata {
    pub local_session_id: String,
    pub artifact_format: String,
    pub duration_ms: Option<serde_json::Number>,
    pub action_count: Option<serde_json::Number>,
    pub request_count: Option<serde_json::Number>,
    pub artifacts: Vec<ArtifactManifest>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactManifest {
    pub key: ArtifactKey,
    pub kind: String,
    pub mime_type: String,
    pub bytes: u64,
    pub checksum: String,
}

impl From<&PreparedArtifact> for ArtifactManifest {
    fn from(artifact: &PreparedArtifact) -> Self {
        Self {
            key: artifact.key,
            kind: artifact.key.kind().into(),
            mime_type: artifact.mime_type.clone(),
            bytes: artifact.bytes,
            checksum: artifact.checksum.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartSyncBody<'a> {
    session_id: &'a str,
    title: &'a str,
    source_metadata: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_mime_type: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    replace_evidence_id: Option<&'a str>,
    artifacts: Vec<ArtifactManifest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedSync {
    pub evidence_id: String,
    pub organization_id: String,
    pub upload_sessions: Vec<UploadSession>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadSession {
    pub key: String,
    pub upload_id: String,
    pub upload_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteBody<'a> {
    bytes: u64,
    checksum: &'a str,
    mime_type: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Completed {
    #[allow(dead_code)]
    upload_id: String,
}

/// `sha256:` + lowercase hex, the format the backend's checksum check accepts.
pub fn checksum_bytes(bytes: &[u8]) -> String {
    format_checksum(&Sha256::digest(bytes))
}

/// Streams `path` through sha256; returns `(size, checksum)`.
pub fn checksum_file(path: &Path, mut on_bytes: impl FnMut(u64)) -> io::Result<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; READ_CHUNK_BYTES];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
        on_bytes(read as u64);
    }
    Ok((total, format_checksum(&hasher.finalize())))
}

fn format_checksum(digest: &[u8]) -> String {
    let mut out = String::with_capacity(7 + digest.len() * 2);
    out.push_str("sha256:");
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Summary counts read from a session archive (session-sync.ts `readArchiveStats`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ArchiveStats {
    pub duration_ms: Option<serde_json::Number>,
    pub action_count: Option<serde_json::Number>,
    pub request_count: Option<serde_json::Number>,
}

pub fn read_archive_stats(bytes: &[u8]) -> ArchiveStats {
    let Ok(archive) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return ArchiveStats::default();
    };
    let summary_number = |field: &str| {
        archive
            .pointer(&format!("/summary/{field}"))
            .and_then(finite_number)
    };
    let timestamp = |field: &str| {
        archive
            .get(field)
            .and_then(|value| value.as_str())
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
    };
    let fallback_duration = match (timestamp("createdAt"), timestamp("updatedAt")) {
        (Some(start), Some(end)) => Some(serde_json::Number::from(
            (end - start).num_milliseconds().max(0),
        )),
        _ => None,
    };
    let fallback_actions = archive
        .pointer("/sections/actions")
        .and_then(|value| value.as_array())
        .map(|actions| {
            let interactions = actions.iter().filter(|entry| {
                entry
                    .pointer("/payload/kind")
                    .and_then(|kind| kind.as_str())
                    == Some("interaction")
            });
            serde_json::Number::from(interactions.count())
        });
    let fallback_requests = archive
        .pointer("/sections/network")
        .and_then(|value| value.as_array())
        .map(|network| serde_json::Number::from(network.len()));
    ArchiveStats {
        duration_ms: summary_number("videoDurationMs").or(fallback_duration),
        action_count: summary_number("actionCount").or(fallback_actions),
        request_count: summary_number("requestCount").or(fallback_requests),
    }
}

fn finite_number(value: &serde_json::Value) -> Option<serde_json::Number> {
    match value {
        serde_json::Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
            Some(number.clone())
        }
        _ => None,
    }
}

pub fn build_source_metadata(
    session_id: &str,
    stats: &ArchiveStats,
    video_duration_ms: Option<f64>,
    artifacts: &[PreparedArtifact],
) -> SourceMetadata {
    SourceMetadata {
        local_session_id: session_id.into(),
        artifact_format: "split".into(),
        duration_ms: stats
            .duration_ms
            .clone()
            .or_else(|| video_duration_ms.and_then(js_number)),
        action_count: stats.action_count.clone(),
        request_count: stats.request_count.clone(),
        artifacts: artifacts.iter().map(ArtifactManifest::from).collect(),
    }
}

/// Whole numbers serialize without a fraction, as `JSON.stringify` writes them.
fn js_number(value: f64) -> Option<serde_json::Number> {
    if value.fract() == 0.0 && value.abs() < 9e15 {
        Some((value as i64).into())
    } else {
        serde_json::Number::from_f64(value)
    }
}

fn encode_thumbnail(jpeg: Option<&[u8]>) -> Option<String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(jpeg?);
    if encoded.len() > MAX_THUMBNAIL_BASE64_LEN {
        log::warn!(
            "thumbnail is {} base64 characters; the backend accepts {MAX_THUMBNAIL_BASE64_LEN}, sending none",
            encoded.len()
        );
        return None;
    }
    Some(encoded)
}

/// Reports progress at most every `PROGRESS_STEP_BYTES`, plus once at the end of each file.
struct Reporter<'a> {
    progress: &'a dyn Fn(SyncProgress),
    phase: SyncPhase,
    artifact: Option<ArtifactKey>,
    done: u64,
    total: u64,
    last_reported: u64,
}

impl Reporter<'_> {
    fn emit(&mut self) {
        self.last_reported = self.done;
        (self.progress)(SyncProgress {
            phase: self.phase,
            artifact: self.artifact,
            bytes_done: self.done,
            bytes_total: self.total,
        });
    }

    fn enter(&mut self, phase: SyncPhase, artifact: Option<ArtifactKey>) {
        self.phase = phase;
        self.artifact = artifact;
        self.emit();
    }

    fn advance(&mut self, bytes: u64) {
        self.done += bytes;
        if self.done - self.last_reported >= PROGRESS_STEP_BYTES {
            self.emit();
        }
    }
}

struct ProgressReader<'a, 'b, R> {
    inner: R,
    reporter: &'a mut Reporter<'b>,
}

impl<R: Read> Read for ProgressReader<'_, '_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.reporter.advance(read as u64);
        Ok(read)
    }
}

impl ApiClient {
    /// Uploads a local session as desktop-session evidence. Blocks until every artifact is
    /// committed; `progress` is called from the calling thread.
    pub fn sync_session(
        &self,
        input: &SyncInput,
        progress: impl Fn(SyncProgress),
    ) -> Result<SyncResult, ApiError> {
        if input.session_id.trim().is_empty() || input.title.trim().is_empty() {
            return Err(ApiError::Invalid(
                "A session ID and title are required to upload.".into(),
            ));
        }
        // Fail before hashing when signed out.
        self.token()?;

        let files = input.files();
        let mut sizes = Vec::with_capacity(files.len());
        for (_, path, _) in &files {
            let metadata = std::fs::metadata(path).map_err(|error| {
                ApiError::Invalid(format!("Cannot read {}: {error}", path.display()))
            })?;
            sizes.push(metadata.len());
        }
        let total: u64 = sizes.iter().sum();
        let mut reporter = Reporter {
            progress: &progress,
            phase: SyncPhase::Hashing,
            artifact: None,
            done: 0,
            total,
            last_reported: 0,
        };

        let mut artifacts = Vec::with_capacity(files.len());
        for (key, path, mime_type) in &files {
            reporter.enter(SyncPhase::Hashing, Some(*key));
            let (bytes, checksum) = checksum_file(path, |read| reporter.advance(read))?;
            artifacts.push(PreparedArtifact {
                key: *key,
                path: path.to_path_buf(),
                mime_type: mime_type.to_string(),
                bytes,
                checksum,
            });
        }
        reporter.total = artifacts.iter().map(|artifact| artifact.bytes).sum();

        let stats = match std::fs::metadata(&input.archive) {
            Ok(metadata) if metadata.len() <= MAX_ARCHIVE_STATS_BYTES => {
                read_archive_stats(&std::fs::read(&input.archive)?)
            }
            _ => ArchiveStats::default(),
        };
        let metadata = build_source_metadata(
            &input.session_id,
            &stats,
            input.video_duration_ms,
            &artifacts,
        );
        let source_metadata = serde_json::to_string(&metadata)
            .map_err(|error| ApiError::Invalid(error.to_string()))?;
        let thumbnail = encode_thumbnail(input.thumbnail_jpeg.as_deref());
        let thumbnail_sent = thumbnail.is_some();

        reporter.enter(SyncPhase::Starting, None);
        let body = StartSyncBody {
            session_id: &input.session_id,
            title: &input.title,
            source_metadata: &source_metadata,
            thumbnail_mime_type: thumbnail.as_ref().map(|_| "image/jpeg"),
            thumbnail_base64: thumbnail,
            replace_evidence_id: input.replace_evidence_id.as_deref(),
            artifacts: metadata.artifacts.clone(),
        };
        let started: StartedSync =
            self.post("/evidences/desktop-sessions/sync/start", Some(&body))?;

        reporter.done = 0;
        reporter.last_reported = 0;
        for artifact in &artifacts {
            let session = started
                .upload_sessions
                .iter()
                .find(|session| session.key == artifact.key.as_str())
                .ok_or_else(|| {
                    ApiError::contract(
                        "upload session list",
                        format!("missing upload session for {}", artifact.key.as_str()),
                    )
                })?;
            reporter.enter(SyncPhase::Uploading, Some(artifact.key));
            self.upload_blob(&session.upload_url, artifact, &mut reporter)?;
            reporter.enter(SyncPhase::Completing, Some(artifact.key));
            let path = format!(
                "/evidences/uploads/{}/complete",
                encode_component(&session.upload_id)
            );
            let complete = CompleteBody {
                bytes: artifact.bytes,
                checksum: &artifact.checksum,
                mime_type: &artifact.mime_type,
            };
            self.post::<Completed>(&path, Some(&complete))?;
        }
        reporter.enter(SyncPhase::Done, None);

        Ok(SyncResult {
            evidence_id: started.evidence_id,
            organization_id: started.organization_id,
            source_metadata,
            thumbnail_sent,
            artifacts,
        })
    }

    /// PUT the file to the backend's upload URL with the session token (the URL is the API's own
    /// `/evidences/uploads/:id/blob`, so the token never goes to third-party storage).
    fn upload_blob(
        &self,
        upload_url: &str,
        artifact: &PreparedArtifact,
        reporter: &mut Reporter<'_>,
    ) -> Result<(), ApiError> {
        if !is_allowed_artifact_url(upload_url, &self.config.api_origin) {
            return Err(ApiError::Invalid(
                "The backend returned an upload URL that is not HTTPS.".into(),
            ));
        }
        let token = self.token()?;
        let file = BufReader::with_capacity(READ_CHUNK_BYTES, File::open(&artifact.path)?);
        let mut reader = ProgressReader {
            inner: file.take(artifact.bytes),
            reporter,
        };
        let request = Request::builder()
            .method("PUT")
            .uri(upload_url)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", &artifact.mime_type)
            .header("content-length", artifact.bytes.to_string())
            .body(SendBody::from_reader(&mut reader))
            .map_err(|error| ApiError::Invalid(error.to_string()))?;
        log::debug!(
            "PUT upload blob {} ({} bytes)",
            artifact.key.as_str(),
            artifact.bytes
        );
        let response = self.agent.run(request)?;
        if !response.status().is_success() {
            return Err(error_for(response, "Upload failed"));
        }
        reader.reporter.emit();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_matches_backend_format() {
        // sha256("hello")
        assert_eq!(
            checksum_bytes(b"hello"),
            "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        let payload: Vec<u8> = (0..400_000u32).map(|value| (value % 251) as u8).collect();
        std::fs::write(&path, &payload).unwrap();
        let mut seen = 0;
        let (bytes, checksum) = checksum_file(&path, |read| seen += read).unwrap();
        assert_eq!((bytes, seen), (400_000, 400_000));
        assert_eq!(checksum, checksum_bytes(&payload));
    }

    #[test]
    fn archive_stats_prefer_summary() {
        let stats = read_archive_stats(
            br#"{"createdAt":"2026-10-29T10:00:00.000Z","updatedAt":"2026-10-29T10:00:05.000Z",
                "summary":{"videoDurationMs":4321.5,"actionCount":7,"requestCount":null},
                "sections":{"actions":[],"network":[{},{}]}}"#,
        );
        assert_eq!(stats.duration_ms.unwrap().as_f64(), Some(4321.5));
        assert_eq!(stats.action_count.unwrap().as_u64(), Some(7));
        assert_eq!(stats.request_count.unwrap().as_u64(), Some(2));
    }

    #[test]
    fn archive_stats_fall_back_to_timestamps_and_sections() {
        let stats = read_archive_stats(
            br#"{"createdAt":"2026-10-29T10:00:00.000Z","updatedAt":"2026-10-29T10:00:05.250Z",
                "sections":{"actions":[{"payload":{"kind":"interaction"}},{"payload":{"kind":"marker"}},{"payload":{"kind":"interaction"}}]}}"#,
        );
        assert_eq!(stats.duration_ms.unwrap().as_i64(), Some(5250));
        assert_eq!(stats.action_count.unwrap().as_u64(), Some(2));
        assert_eq!(stats.request_count, None);
        assert_eq!(read_archive_stats(b"not json"), ArchiveStats::default());
    }

    #[test]
    fn source_metadata_matches_session_sync_shape() {
        let artifacts = vec![
            PreparedArtifact {
                key: ArtifactKey::Recording,
                path: "r.webm".into(),
                mime_type: "video/webm".into(),
                bytes: 10,
                checksum: "sha256:aa".into(),
            },
            PreparedArtifact {
                key: ArtifactKey::Archive,
                path: "a.json".into(),
                mime_type: "application/json".into(),
                bytes: 2,
                checksum: "sha256:bb".into(),
            },
        ];
        let stats = ArchiveStats {
            duration_ms: None,
            action_count: Some(3.into()),
            request_count: None,
        };
        let metadata = build_source_metadata("s1", &stats, Some(1500.0), &artifacts);
        assert_eq!(
            serde_json::to_string(&metadata).unwrap(),
            r#"{"localSessionId":"s1","artifactFormat":"split","durationMs":1500,"actionCount":3,"requestCount":null,"artifacts":[{"key":"recording","kind":"recording","mimeType":"video/webm","bytes":10,"checksum":"sha256:aa"},{"key":"archive","kind":"network-log","mimeType":"application/json","bytes":2,"checksum":"sha256:bb"}]}"#
        );
    }

    #[test]
    fn oversized_thumbnails_are_dropped() {
        assert_eq!(encode_thumbnail(None), None);
        assert_eq!(
            encode_thumbnail(Some(b"\xff\xd8\xff")).as_deref(),
            Some("/9j/")
        );
        assert_eq!(encode_thumbnail(Some(&vec![0u8; 16_000])), None);
    }

    #[test]
    fn session_folder_layouts() {
        let dir = tempfile::tempdir().unwrap();
        assert!(SyncInput::from_session_folder(dir.path(), "s", "t").is_err());
        std::fs::write(dir.path().join("recording.mp4"), b"mp4").unwrap();
        std::fs::write(dir.path().join(SESSION_ARCHIVE_FILE_NAME), b"{}").unwrap();
        let native = SyncInput::from_session_folder(dir.path(), "s", "t").unwrap();
        assert_eq!(native.recording.mime_type, "video/mp4");
        assert_eq!(native.playback, None);
        std::fs::write(dir.path().join("recording.webm"), b"webm").unwrap();
        let extension = SyncInput::from_session_folder(dir.path(), "s", "t").unwrap();
        assert_eq!(extension.recording.mime_type, "video/webm");
        assert_eq!(extension.playback.unwrap().mime_type, "video/mp4");
        let keys: Vec<_> = native.files().iter().map(|(key, _, _)| *key).collect();
        assert_eq!(keys, [ArtifactKey::Recording, ArtifactKey::Archive]);
    }
}
