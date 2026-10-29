use serde::{Deserialize, Serialize};

use super::serde_util::{literal, num, opt_num};

literal!(MergeGroupKind, "merge-group");
literal!(StepKind, "step");

/// `kind` is the second key in both shapes, so the enum is untagged and each struct carries a
/// literal `kind` field in schema order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Annotation {
    MergeGroup(MergeGroup),
    Step(StepAnnotation),
}

impl Annotation {
    pub fn id(&self) -> &str {
        match self {
            Self::MergeGroup(group) => &group.id,
            Self::Step(step) => &step.id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeGroup {
    pub id: String,
    pub kind: MergeGroupKind,
    pub member_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub label: String,
    pub created_at: String,
}

impl MergeGroup {
    pub fn new(
        id: impl Into<String>,
        member_ids: Vec<String>,
        label: impl Into<String>,
        created_at: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            kind: MergeGroupKind,
            member_ids,
            tags: Vec::new(),
            label: label.into(),
            created_at: created_at.into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Passed,
    Failed,
    Blocked,
    Skipped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepMode {
    Agent,
    Replayed,
    Handoff,
    Deterministic,
    ApiReplayed,
    ApiHandoff,
    Query,
}

/// One executed test-case step; entries recorded during it carry the tag `step:<stepId>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepAnnotation {
    pub id: String,
    pub kind: StepKind,
    pub step_id: String,
    pub ordinal: u32,
    #[serde(rename = "type")]
    pub step_type: String,
    pub label: String,
    #[serde(default)]
    pub checkpoint_id: Option<String>,
    #[serde(default)]
    pub checkpoint_label: Option<String>,
    #[serde(default)]
    pub parent_step_id: Option<String>,
    pub status: StepStatus,
    #[serde(default)]
    pub mode: Option<StepMode>,
    pub started_at: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(serialize_with = "num")]
    pub video_offset_ms: f64,
    #[serde(default, serialize_with = "opt_num")]
    pub video_end_offset_ms: Option<f64>,
    #[serde(default)]
    pub detail: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

pub fn step_tag(step_id: &str) -> String {
    format!("step:{step_id}")
}

/// Review edits replace merge groups only; step annotations written by the runner are kept.
pub fn replace_merge_groups(
    annotations: &[Annotation],
    merge_groups: &[Annotation],
) -> Vec<Annotation> {
    annotations
        .iter()
        .filter(|annotation| !matches!(annotation, Annotation::MergeGroup(_)))
        .chain(
            merge_groups
                .iter()
                .filter(|annotation| matches!(annotation, Annotation::MergeGroup(_))),
        )
        .cloned()
        .collect()
}
