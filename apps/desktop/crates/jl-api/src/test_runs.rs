// Test runs as the desktop test-runs page reads them (apps/desktop/src/mainview/test-runs/
// test-api.ts; contract in packages/shared/src/test-api.ts, routes in
// apps/backend/src/routes/test-runs.ts). Enumerations that grow over time are kept as strings or
// carry an `Unknown` variant so a newer backend does not break the list.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::error::ApiError;
use crate::http::{ApiClient, encode_component, query_string};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestRunStatus {
    Queued,
    Claimed,
    Running,
    Paused,
    Completed,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

impl TestRunStatus {
    /// Queued or executing (live-run.ts `isRunActive`).
    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Queued | Self::Claimed | Self::Running | Self::Paused
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Claimed => "claimed",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestRunOutcome {
    Passed,
    Failed,
    Blocked,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSubscriber {
    pub user_id: String,
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TestRunMetrics {
    pub model_id: Option<String>,
    pub judge_model_id: Option<String>,
    pub provider: Option<String>,
    pub model_calls: u64,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64,
    pub cost_usd: Option<f64>,
    pub price_table_version: Option<String>,
    pub duration_ms: Option<f64>,
    pub steps_total: u64,
    pub steps_replayed: u64,
    pub steps_agent: u64,
    pub steps_handoff: u64,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunSummary {
    pub id: String,
    pub test_case_id: String,
    pub test_case_key: String,
    pub test_case_title: String,
    pub transcript_version: u32,
    pub environment_id: Option<String>,
    pub environment_name: Option<String>,
    pub status: TestRunStatus,
    pub outcome: Option<TestRunOutcome>,
    /// `NO_RUNNER`, `BUDGET_EXCEEDED`, `MISSING_CREDENTIAL`, … (shared `blockedReasonSchema`).
    pub blocked_reason: Option<String>,
    pub flaky: bool,
    /// `manual`, `cli`, `mcp`, `ci`, `webhook`, `repair`.
    pub trigger: String,
    pub runner_pool: String,
    pub created_by: Option<String>,
    pub created_by_name: Option<String>,
    pub queued_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub evidence_id: Option<String>,
    pub batch_id: Option<String>,
    /// Runs ahead of this one in its pool (0 = next); null once it left the queue.
    pub queue_position: Option<u32>,
    #[serde(default)]
    pub queue_depth: Option<u32>,
    pub estimated_start_at: Option<i64>,
    #[serde(default)]
    pub subscribers: Vec<RunSubscriber>,
    #[serde(default)]
    pub metrics: TestRunMetrics,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct StepError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunStep {
    pub step_id: String,
    pub parent_step_id: Option<String>,
    pub ordinal: u32,
    #[serde(rename = "type")]
    pub step_type: String,
    pub label: String,
    pub checkpoint_id: Option<String>,
    /// `passed`, `failed`, `blocked`, `skipped`, `running` or `pending`.
    pub status: String,
    pub mode: Option<String>,
    pub cache_reason: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<f64>,
    /// Where the step starts in the run's recording.
    pub video_offset_ms: Option<f64>,
    pub observed: Option<String>,
    pub error: Option<StepError>,
    pub screenshot_url: Option<String>,
    #[serde(default)]
    pub usage: serde_json::Value,
    #[serde(default)]
    pub outputs: BTreeMap<String, String>,
    #[serde(default)]
    pub requests: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunViewport {
    pub width: u32,
    pub height: u32,
}

/// Set while a runner streams frames and accepts take-over.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLiveState {
    pub available: bool,
    pub takeover_by: Option<String>,
    pub paused: bool,
    /// API path of the latest JPEG (GET /test-runs/:id/live/frame).
    pub frame_url: Option<String>,
    pub frame_at: Option<i64>,
    #[serde(default)]
    pub frames_hidden: bool,
    #[serde(default)]
    pub viewport: Option<RunViewport>,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunDetail {
    #[serde(flatten)]
    pub summary: TestRunSummary,
    #[serde(default)]
    pub params: BTreeMap<String, String>,
    /// `read-write`, `read-only`, `off`, `strict`.
    pub cache_mode: String,
    /// Absent from older backends; read it as `full`.
    #[serde(default)]
    pub execution_mode: Option<String>,
    #[serde(default)]
    pub outputs: BTreeMap<String, String>,
    #[serde(default)]
    pub reused_from_run_ids: Vec<String>,
    #[serde(default)]
    pub runner_info: Option<serde_json::Value>,
    pub error: Option<String>,
    pub steps: Vec<TestRunStep>,
    pub transcript: String,
    pub current_step_id: Option<String>,
    #[serde(default)]
    pub repair_run_id: Option<String>,
    #[serde(default)]
    pub live: Option<RunLiveState>,
}

impl std::ops::Deref for TestRunDetail {
    type Target = TestRunSummary;

    fn deref(&self) -> &TestRunSummary {
        &self.summary
    }
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRunPage {
    pub items: Vec<TestRunSummary>,
    /// Pass back as `cursor` for the next (older) page.
    pub next_cursor: Option<String>,
}

/// Filters for GET /test-runs. The desktop lists 50 runs, or 20 for one test case.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TestRunQuery {
    pub test_case_id: Option<String>,
    pub batch_id: Option<String>,
    pub status: Vec<TestRunStatus>,
    pub mine: bool,
    /// 1..=200; defaults to 50 (20 with `test_case_id`).
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl TestRunQuery {
    pub fn for_case(test_case_id: impl Into<String>) -> Self {
        Self {
            test_case_id: Some(test_case_id.into()),
            ..Self::default()
        }
    }

    pub(crate) fn to_path(&self) -> String {
        let default_limit = if self.test_case_id.is_some() { 20 } else { 50 };
        let status = self
            .status
            .iter()
            .filter(|status| **status != TestRunStatus::Unknown)
            .map(|status| status.as_str())
            .collect::<Vec<_>>();
        let query = query_string([
            ("testCaseId", self.test_case_id.clone()),
            ("batchId", self.batch_id.clone()),
            ("status", (!status.is_empty()).then(|| status.join(","))),
            ("mine", self.mine.then(|| "true".to_string())),
            (
                "limit",
                Some(
                    self.limit
                        .unwrap_or(default_limit)
                        .clamp(1, 200)
                        .to_string(),
                ),
            ),
            ("cursor", self.cursor.clone()),
        ]);
        format!("/test-runs{query}")
    }
}

impl ApiClient {
    pub fn list_test_runs(&self, query: &TestRunQuery) -> Result<TestRunPage, ApiError> {
        self.get(&query.to_path())
    }

    pub fn get_test_run(&self, run_id: &str) -> Result<TestRunDetail, ApiError> {
        self.get(&format!("/test-runs/{}", encode_component(run_id)))
    }

    pub fn cancel_test_run(&self, run_id: &str) -> Result<(), ApiError> {
        let path = format!("/test-runs/{}/cancel", encode_component(run_id));
        self.post::<serde_json::Value>(&path, None::<&()>)
            .map(|_| ())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn summary_json(id: &str, status: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "testCaseId": "tc_1", "testCaseKey": "TC-1", "testCaseTitle": "Login works",
            "transcriptVersion": 3, "environmentId": "env_1", "environmentName": "UAT",
            "status": status, "outcome": null, "blockedReason": null, "flaky": false, "trigger": "manual",
            "runnerPool": "cloud", "createdBy": "u_1", "createdByName": "Dana",
            "queuedAt": 1761700000000i64, "startedAt": null, "finishedAt": null,
            "evidenceId": null, "batchId": null, "queuePosition": 2, "queueDepth": 5,
            "estimatedStartAt": null, "subscribers": [{"userId": "u_1", "name": null}],
            "metrics": {"modelId": null, "judgeModelId": null, "provider": null, "modelCalls": 0, "inputTokens": 0,
                "cachedInputTokens": 0, "outputTokens": 0, "reasoningTokens": 0, "costUsd": null, "priceTableVersion": null,
                "durationMs": null, "stepsTotal": 4, "stepsReplayed": 0, "stepsAgent": 0, "stepsHandoff": 0}
        })
    }

    pub(crate) fn detail_json(id: &str, status: &str) -> serde_json::Value {
        let mut value = summary_json(id, status);
        let extra = serde_json::json!({
            "params": {"user": "qa"}, "cacheMode": "read-write", "executionMode": "full", "runnerInfo": null,
            "error": null, "transcript": "# Login", "currentStepId": "s1", "repairRunId": null,
            "steps": [{"stepId": "s1", "parentStepId": null, "ordinal": 1, "type": "action", "label": "Open login",
                "checkpointId": null, "status": "running", "mode": "agent", "cacheReason": null, "startedAt": 1, "finishedAt": null,
                "durationMs": null, "videoOffsetMs": 0, "observed": null, "error": null, "screenshotUrl": null,
                "usage": {"inputTokens": 1}}],
            "live": {"available": true, "takeoverBy": null, "paused": false, "frameUrl": "/test-runs/run_1/live/frame",
                "frameAt": 5, "framesHidden": false, "viewport": {"width": 1280, "height": 720}}
        });
        value
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        value
    }

    #[test]
    fn builds_run_list_paths() {
        assert_eq!(TestRunQuery::default().to_path(), "/test-runs?limit=50");
        assert_eq!(
            TestRunQuery::for_case("tc 1").to_path(),
            "/test-runs?testCaseId=tc+1&limit=20"
        );
        let query = TestRunQuery {
            status: vec![TestRunStatus::Queued, TestRunStatus::Running],
            mine: true,
            limit: Some(500),
            cursor: Some("1761700000000".into()),
            ..TestRunQuery::default()
        };
        assert_eq!(
            query.to_path(),
            "/test-runs?status=queued%2Crunning&mine=true&limit=200&cursor=1761700000000"
        );
    }

    #[test]
    fn parses_run_list_and_detail() {
        let page: TestRunPage =
            serde_json::from_value(serde_json::json!({"items": [summary_json("run_1", "queued"), summary_json("run_2", "teleported")], "nextCursor": "17"}))
                .unwrap();
        assert_eq!(page.items[0].status, TestRunStatus::Queued);
        assert_eq!(page.items[1].status, TestRunStatus::Unknown);
        assert_eq!(page.items[0].metrics.steps_total, 4);

        let detail: TestRunDetail =
            serde_json::from_value(detail_json("run_1", "running")).unwrap();
        assert_eq!(detail.id, "run_1");
        assert!(detail.status.is_active());
        assert_eq!(detail.steps[0].step_type, "action");
        let live = detail.live.unwrap();
        assert_eq!(
            live.viewport,
            Some(RunViewport {
                width: 1280,
                height: 720
            })
        );
        assert_eq!(detail.params["user"], "qa");
    }
}
