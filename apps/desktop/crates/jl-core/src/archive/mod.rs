//! Serde model of `packages/shared/src/session.ts` (schema v5; v3 and v4 upgrade on parse).

mod annotation;
mod events;
mod recorder;
mod serde_util;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub use annotation::*;
pub use events::*;
pub use recorder::*;

pub const SCHEMA_VERSION: u32 = 5;
pub const RUNNER_V4_SCHEMA_VERSION: u32 = 4;
pub const EXTENSION_SCHEMA_VERSION: u32 = 3;

/// Actions carrying this tag are user markers (a `lifecycle` payload whose detail is the label).
pub const MARKER_TAG: &str = "marker";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArchive {
    pub schema_version: u32,
    pub session_id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
    pub phase: CapturePhase,
    pub page: PageContext,
    #[serde(default)]
    pub recorder: Recorder,
    #[serde(default)]
    pub summary: ArchiveSummary,
    pub artifacts: Vec<SessionArtifact>,
    pub sections: Sections,
    #[serde(default)]
    pub annotations: Vec<Annotation>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageContext {
    pub url: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TabContext {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    #[serde(default, serialize_with = "serde_util::opt_num")]
    pub video_duration_ms: Option<f64>,
    #[serde(default)]
    pub action_count: Option<u64>,
    #[serde(default)]
    pub request_count: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ArtifactKind {
    #[serde(rename = "recording.webm")]
    RecordingWebm,
    #[serde(rename = "recording.mp4")]
    RecordingMp4,
    #[serde(rename = "session.archive.json")]
    SessionArchiveJson,
}

impl ArtifactKind {
    pub fn file_name(self) -> &'static str {
        match self {
            Self::RecordingWebm => crate::RECORDING_WEBM_FILE,
            Self::RecordingMp4 => crate::RECORDING_MP4_FILE,
            Self::SessionArchiveJson => crate::SESSION_ARCHIVE_FILE,
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::RecordingWebm => "video/webm",
            Self::RecordingMp4 => "video/mp4",
            Self::SessionArchiveJson => "application/json",
        }
    }

    pub fn is_video(self) -> bool {
        self != Self::SessionArchiveJson
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionArtifact {
    pub kind: ArtifactKind,
    pub relative_path: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

/// `createSessionArtifacts`, with the video kind chosen by the recorder.
pub fn session_artifacts(session_id: &str, video: ArtifactKind) -> Vec<SessionArtifact> {
    [video, ArtifactKind::SessionArchiveJson]
        .into_iter()
        .map(|kind| SessionArtifact {
            kind,
            relative_path: format!("{session_id}/{}", kind.file_name()),
            mime_type: kind.mime_type().into(),
            bytes: None,
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sections {
    #[serde(default)]
    pub actions: Vec<ArchiveAction>,
    #[serde(default)]
    pub console: Vec<ConsoleEntry>,
    #[serde(default)]
    pub network: Vec<NetworkEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchiveAction {
    pub id: String,
    pub seq: u64,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<TabContext>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub payload: ActionPayload,
}

impl ArchiveAction {
    pub fn is_marker(&self) -> bool {
        self.tags.iter().any(|tag| tag == MARKER_TAG)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConsoleEntry {
    pub id: String,
    pub seq: u64,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<TabContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    pub payload: ConsoleEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetworkEntry {
    pub id: String,
    pub seq: u64,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<TabContext>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    pub subtype: NetworkSubtype,
    pub payload: NetworkEvent,
}

/// `generateArchiveEntryId`.
pub fn archive_entry_id(session_id: &str, section: &str, index: usize) -> String {
    format!("{session_id}:{section}:{index:06}")
}

/// Parses a v3, v4 or v5 archive; the result is always v5.
pub fn parse_archive(bytes: &[u8]) -> Result<SessionArchive> {
    let raw: Value = serde_json::from_slice(bytes).context("Session archive is not valid JSON")?;
    parse_archive_value(raw)
}

pub fn parse_archive_value(raw: Value) -> Result<SessionArchive> {
    let upgraded = upgrade_archive_value(raw);
    match upgraded.get("schemaVersion").and_then(Value::as_u64) {
        Some(version) if version == u64::from(SCHEMA_VERSION) => {}
        Some(version) => bail!("Unsupported session archive schema version {version}"),
        None => bail!("Session archive has no schemaVersion"),
    }
    let archive: SessionArchive =
        serde_json::from_value(upgraded).context("Session archive validation failed")?;
    archive.validate()?;
    Ok(archive)
}

/// `upgradeSessionArchiveInput`: lifts a raw v3 or v4 archive to the v5 shape.
pub fn upgrade_archive_value(raw: Value) -> Value {
    let Value::Object(mut map) = raw else {
        return raw;
    };
    let version = map.get("schemaVersion").and_then(Value::as_u64);
    if version == Some(u64::from(EXTENSION_SCHEMA_VERSION)) {
        if let Some(Value::Object(recorder)) = map.get_mut("recorder")
            && !recorder.contains_key("kind")
        {
            let mut lifted = Map::with_capacity(recorder.len() + 1);
            lifted.insert("kind".into(), Value::from("browser-extension"));
            lifted.extend(std::mem::take(recorder));
            *recorder = lifted;
        }
        map.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    } else if version == Some(u64::from(RUNNER_V4_SCHEMA_VERSION)) {
        map.insert("schemaVersion".into(), Value::from(SCHEMA_VERSION));
    }
    Value::Object(map)
}

/// Pretty JSON with a trailing newline, as the TS writers produce it.
pub fn to_pretty_json(archive: &SessionArchive) -> String {
    let mut text = serde_json::to_string_pretty(archive).expect("archive serializes");
    text.push('\n');
    text
}

/// Milliseconds since the epoch for an ISO-8601 timestamp with offset.
pub fn parse_timestamp_ms(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.timestamp_millis())
}

impl SessionArchive {
    fn validate(&self) -> Result<()> {
        let id_len = self.session_id.chars().count();
        if !(8..=128).contains(&id_len) {
            bail!("Session archive validation failed: sessionId must be 8-128 characters");
        }
        if self.name.is_empty() {
            bail!("Session archive validation failed: name is empty");
        }
        let timestamps = [self.created_at.as_str(), self.updated_at.as_str()]
            .into_iter()
            .chain(self.sections.actions.iter().map(|entry| entry.at.as_str()))
            .chain(self.sections.console.iter().map(|entry| entry.at.as_str()))
            .chain(self.sections.network.iter().map(|entry| entry.at.as_str()));
        for at in timestamps {
            if parse_timestamp_ms(at).is_none() {
                bail!("Session archive validation failed: invalid timestamp {at:?}");
            }
        }
        for annotation in &self.annotations {
            if let Annotation::MergeGroup(group) = annotation
                && group.member_ids.len() < 2
            {
                bail!(
                    "Session archive validation failed: merge group {} has fewer than 2 members",
                    group.id
                );
            }
        }
        Ok(())
    }

    /// `deriveAnchorMs`: the first `recording` lifecycle action, else the earliest timestamp.
    pub fn recording_start_ms(&self) -> i64 {
        let recording = self.sections.actions.iter().find(|action| {
            matches!(&action.payload, ActionPayload::Lifecycle(event) if event.phase == CapturePhase::Recording)
        });
        if let Some(ms) = recording.and_then(|action| parse_timestamp_ms(&action.at)) {
            return ms;
        }
        std::iter::once(self.created_at.as_str())
            .chain(self.sections.actions.iter().map(|entry| entry.at.as_str()))
            .filter_map(parse_timestamp_ms)
            .min()
            .unwrap_or(0)
    }

    /// `summary.videoDurationMs`, falling back to `updatedAt - createdAt` like the upload CLI.
    pub fn duration_ms(&self) -> Option<f64> {
        if let Some(ms) = self.summary.video_duration_ms.filter(|ms| ms.is_finite()) {
            return Some(ms);
        }
        let start = parse_timestamp_ms(&self.created_at)?;
        let end = parse_timestamp_ms(&self.updated_at)?;
        Some((end - start).max(0) as f64)
    }

    pub fn action_count(&self) -> u64 {
        self.summary.action_count.unwrap_or_else(|| {
            self.sections
                .actions
                .iter()
                .filter(|action| matches!(action.payload, ActionPayload::Interaction(_)))
                .count() as u64
        })
    }

    pub fn request_count(&self) -> u64 {
        self.summary
            .request_count
            .unwrap_or(self.sections.network.len() as u64)
    }

    pub fn console_error_count(&self) -> u64 {
        self.sections
            .console
            .iter()
            .filter(|entry| entry.payload.level == ConsoleLevel::Error)
            .count() as u64
    }

    pub fn video_artifact(&self) -> Option<&SessionArtifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.kind.is_video())
    }

    pub fn notes_text(&self) -> String {
        self.notes.join("\n\n").trim().to_owned()
    }

    pub fn merge_groups(&self) -> impl Iterator<Item = &MergeGroup> {
        self.annotations
            .iter()
            .filter_map(|annotation| match annotation {
                Annotation::MergeGroup(group) => Some(group),
                Annotation::Step(_) => None,
            })
    }

    /// `getStepAnnotations`: steps by video offset, then ordinal.
    pub fn step_annotations(&self) -> Vec<&StepAnnotation> {
        let mut steps: Vec<_> = self
            .annotations
            .iter()
            .filter_map(|annotation| match annotation {
                Annotation::Step(step) => Some(step),
                Annotation::MergeGroup(_) => None,
            })
            .collect();
        steps.sort_by(|a, b| {
            a.video_offset_ms
                .total_cmp(&b.video_offset_ms)
                .then(a.ordinal.cmp(&b.ordinal))
        });
        steps
    }
}

#[cfg(test)]
mod tests;
