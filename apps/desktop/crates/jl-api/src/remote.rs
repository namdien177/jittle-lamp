// Opens uploaded evidence (for example a test run's recording) locally, ported from
// apps/desktop/src/session/remote-evidence.ts. Asks the API for playback links
// (GET /evidences/:id/playback), downloads only the URLs that response names (HTTPS, or the API
// origin itself for a local dev backend, no redirects, no credentials), checks the archive before
// touching the recording, and streams the recording to disk. The result is a session folder the
// viewer opens like a local one; the caller deletes it when the viewer closes.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use ureq::http::Request;

use crate::error::ApiError;
use crate::evidence::{Playback, PlaybackEvidence};
use crate::http::{ApiClient, JSON_TIMEOUT};
use crate::sync::SESSION_ARCHIVE_FILE_NAME;

pub const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_RECORDING_BYTES: u64 = 1024 * 1024 * 1024;
/// Subfolder of the temp root that holds downloaded evidence.
pub const TEMP_DIR_NAME: &str = "jittle-lamp-temp";
/// Time allowed to receive the whole recording body.
const RECORDING_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Debug, PartialEq)]
pub struct RemoteEvidence {
    pub evidence_id: String,
    /// `<temp>/jittle-lamp-temp/<uuid>/`, holding `session.archive.json` and `recording.<ext>`.
    pub folder: PathBuf,
    pub archive_path: PathBuf,
    pub recording_path: PathBuf,
    pub recording_mime_type: String,
    pub evidence: PlaybackEvidence,
}

impl RemoteEvidence {
    /// Removes the downloaded folder.
    pub fn remove(&self) -> io::Result<()> {
        match std::fs::remove_dir_all(&self.folder) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

/// `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` (apps/desktop/src/deep-link.ts `isSafeResourceId`).
pub fn is_safe_resource_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-')
}

/// Artifact URLs must be HTTPS without credentials and not loopback, or on the configured API
/// origin (a local dev backend serves artifacts and uploads from its own origin). The companion
/// server on 127.0.0.1:48115 is therefore never reachable this way.
pub fn is_allowed_artifact_url(value: &str, api_origin: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if let Ok(api) = url::Url::parse(api_origin)
        && url.origin() == api.origin()
    {
        return true;
    }
    if url.scheme() != "https" {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => !host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => !ip.is_loopback() && !ip.is_unspecified(),
        Some(url::Host::Ipv6(ip)) => !ip.is_loopback() && !ip.is_unspecified(),
        None => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedArtifacts {
    pub archive_url: String,
    pub recording_url: String,
    pub recording_mime_type: String,
}

pub fn recording_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "video/webm" => Some("webm"),
        "video/mp4" => Some("mp4"),
        _ => None,
    }
}

/// Picks the session archive and a playable recording from a playback response.
pub fn select_playback_artifacts(playback: &Playback) -> Option<SelectedArtifacts> {
    let mut archive_url = None;
    let mut recording = None;
    for read_url in &playback.read_urls {
        let Some(artifact) = playback
            .artifacts
            .iter()
            .find(|artifact| artifact.id == read_url.artifact_id)
        else {
            continue;
        };
        if artifact.kind == "network-log" {
            archive_url = Some(read_url.url.clone());
        }
        if artifact.kind == "recording" && recording_extension(&artifact.mime_type).is_some() {
            recording = Some((read_url.url.clone(), artifact.mime_type.clone()));
        }
    }
    let (recording_url, recording_mime_type) = recording?;
    Some(SelectedArtifacts {
        archive_url: archive_url?,
        recording_url,
        recording_mime_type,
    })
}

/// Cheap structural check before the recording is downloaded; full parsing belongs to the viewer.
pub fn validate_archive(bytes: &[u8]) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let version = value
        .get("schemaVersion")
        .and_then(|version| version.as_u64());
    if !matches!(version, Some(3..=5)) {
        return Err(format!(
            "unsupported schemaVersion {}",
            value
                .get("schemaVersion")
                .unwrap_or(&serde_json::Value::Null)
        ));
    }
    if !value
        .get("sessionId")
        .is_some_and(|id| id.as_str().is_some_and(|id| !id.is_empty()))
    {
        return Err("sessionId is missing".into());
    }
    Ok(())
}

impl ApiClient {
    /// Downloads a cloud evidence into `<temp_root or $TMPDIR>/jittle-lamp-temp/<uuid>/`.
    pub fn open_remote_evidence(
        &self,
        evidence_id: &str,
        temp_root: Option<&Path>,
    ) -> Result<RemoteEvidence, ApiError> {
        if !is_safe_resource_id(evidence_id) {
            return Err(ApiError::Invalid("Invalid evidence ID.".into()));
        }
        let playback = self.evidence_playback(evidence_id, None)?;
        let selected = select_playback_artifacts(&playback).ok_or_else(|| {
            ApiError::Invalid(
                "This evidence has no playable recording and session archive yet.".into(),
            )
        })?;
        let api_origin = &self.config.api_origin;
        if !is_allowed_artifact_url(&selected.archive_url, api_origin)
            || !is_allowed_artifact_url(&selected.recording_url, api_origin)
        {
            return Err(ApiError::Invalid(
                "Evidence artifacts must be served over HTTPS.".into(),
            ));
        }

        // The archive is small and checked before the recording is downloaded at all.
        let mut archive = Vec::new();
        self.download(
            &selected.archive_url,
            "session archive",
            MAX_ARCHIVE_BYTES,
            JSON_TIMEOUT,
            &mut archive,
        )?;
        validate_archive(&archive)
            .map_err(|error| ApiError::Invalid(format!("Invalid session archive: {error}")))?;

        let root = temp_root
            .map(Path::to_path_buf)
            .unwrap_or_else(std::env::temp_dir)
            .join(TEMP_DIR_NAME);
        let folder = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&folder)?;
        let extension = recording_extension(&selected.recording_mime_type).unwrap_or("webm");
        let archive_path = folder.join(SESSION_ARCHIVE_FILE_NAME);
        let recording_path = folder.join(format!("recording.{extension}"));

        let written = (|| -> Result<(), ApiError> {
            create_new(&archive_path)?.write_all(&archive)?;
            let mut file = create_new(&recording_path)?;
            self.download(
                &selected.recording_url,
                "recording",
                MAX_RECORDING_BYTES,
                RECORDING_TIMEOUT,
                &mut file,
            )?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_dir_all(&folder);
            return Err(error);
        }

        Ok(RemoteEvidence {
            evidence_id: evidence_id.into(),
            folder,
            archive_path,
            recording_path,
            recording_mime_type: selected.recording_mime_type,
            evidence: playback.evidence,
        })
    }

    /// GET a signed URL without credentials, refusing redirects and anything over `max_bytes`.
    fn download(
        &self,
        url: &str,
        label: &str,
        max_bytes: u64,
        body_timeout: Duration,
        out: &mut impl Write,
    ) -> Result<u64, ApiError> {
        let request = Request::builder()
            .method("GET")
            .uri(url)
            .body(())
            .map_err(|error| ApiError::Invalid(error.to_string()))?;
        let request = self
            .agent
            .configure_request(request)
            .timeout_recv_body(Some(body_timeout))
            .build();
        let response = self.agent.run(request)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ApiError::Api {
                status: status.as_u16(),
                code: None,
                message: format!("Unable to load the {label} ({}).", status.as_u16()),
            });
        }
        let too_large = || ApiError::Invalid(format!("The {label} is too large to open."));
        let body = response.into_body();
        if body
            .content_length()
            .is_some_and(|length| length > max_bytes)
        {
            return Err(too_large());
        }
        let mut reader = body.into_reader().take(max_bytes + 1);
        let copied = io::copy(&mut reader, out).map_err(|error| {
            ApiError::Transport(format!("Downloading the {label} failed: {error}"))
        })?;
        if copied > max_bytes {
            return Err(too_large());
        }
        if copied == 0 {
            return Err(ApiError::Invalid(format!("The {label} is empty.")));
        }
        Ok(copied)
    }
}

fn create_new(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_ids() {
        assert!(is_safe_resource_id("ev_123-abc"));
        assert!(!is_safe_resource_id(""));
        assert!(!is_safe_resource_id("-leading"));
        assert!(!is_safe_resource_id("../etc"));
        assert!(!is_safe_resource_id(&"a".repeat(129)));
        assert!(is_safe_resource_id(&"a".repeat(128)));
    }

    #[test]
    fn artifact_url_policy() {
        let api = "http://127.0.0.1:3001";
        assert!(is_allowed_artifact_url(
            "https://bucket.s3.amazonaws.com/key?sig=1",
            api
        ));
        assert!(is_allowed_artifact_url(
            "http://127.0.0.1:3001/dev-artifacts/tok",
            api
        ));
        assert!(!is_allowed_artifact_url(
            "http://bucket.example.com/key",
            api
        ));
        assert!(!is_allowed_artifact_url(
            "https://user:pw@bucket.example.com/key",
            api
        ));
        assert!(!is_allowed_artifact_url(
            "https://127.0.0.1:48115/sessions",
            api
        ));
        assert!(!is_allowed_artifact_url("https://localhost/x", api));
        assert!(!is_allowed_artifact_url("https://[::1]/x", api));
        assert!(!is_allowed_artifact_url("https://0.0.0.0/x", api));
        assert!(!is_allowed_artifact_url("http://127.0.0.1:48115/x", api));
        assert!(!is_allowed_artifact_url("not a url", api));
    }

    fn playback(artifacts: serde_json::Value, read_urls: serde_json::Value) -> Playback {
        serde_json::from_value(serde_json::json!({
            "evidence": {"id":"ev_1","orgId":"o","title":"t","sourceType":"test-run","createdBy":"u","createdAt":1,"updatedAt":1},
            "artifacts": artifacts,
            "readUrls": read_urls
        }))
        .unwrap()
    }

    fn artifact(id: &str, kind: &str, mime: &str) -> serde_json::Value {
        serde_json::json!({"id":id,"evidenceId":"ev_1","kind":kind,"mimeType":mime,"bytes":1,"checksum":"c","uploadStatus":"uploaded","createdAt":1,"updatedAt":1})
    }

    #[test]
    fn selects_archive_and_playable_recording() {
        let selected = select_playback_artifacts(&playback(
            serde_json::json!([artifact("v", "recording", "video/mp4"), artifact("a", "network-log", "application/json")]),
            serde_json::json!([{"artifactId":"v","url":"https://x/v"},{"artifactId":"a","url":"https://x/a"},{"artifactId":"zzz","url":"https://x/z"}]),
        ))
        .unwrap();
        assert_eq!(selected.archive_url, "https://x/a");
        assert_eq!(selected.recording_url, "https://x/v");
        assert_eq!(selected.recording_mime_type, "video/mp4");

        let hls_only = playback(
            serde_json::json!([
                artifact("v", "recording", "application/x-mpegURL"),
                artifact("a", "network-log", "application/json")
            ]),
            serde_json::json!([{"artifactId":"v","url":"https://x/v"},{"artifactId":"a","url":"https://x/a"}]),
        );
        assert_eq!(select_playback_artifacts(&hls_only), None);
    }

    #[test]
    fn archive_validation() {
        assert!(validate_archive(br#"{"schemaVersion":5,"sessionId":"s1"}"#).is_ok());
        assert!(validate_archive(br#"{"schemaVersion":3,"sessionId":"s1"}"#).is_ok());
        assert!(validate_archive(br#"{"schemaVersion":9,"sessionId":"s1"}"#).is_err());
        assert!(validate_archive(br#"{"schemaVersion":5}"#).is_err());
        assert!(validate_archive(b"<html>").is_err());
    }
}
