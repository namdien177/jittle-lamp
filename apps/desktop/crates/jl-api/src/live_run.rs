// Live progress of one run, ported from apps/desktop/src/mainview/test-runs/live-run.ts: the run
// page polls GET /test-runs/:id every 2 s while the run is queued or executing, backs off on
// errors and stops once the run settles. Pure state machine; the app owns the timer.

use std::time::Duration;

use crate::test_runs::{TestRunDetail, TestRunOutcome, TestRunStatus, TestRunSummary};

pub const RUN_POLL_INTERVAL: Duration = Duration::from_millis(2_000);
pub const RUN_POLL_MAX_BACKOFF: Duration = Duration::from_millis(30_000);
/// Without any loaded run, give up after this many failures and show the error with a retry.
pub const RUN_POLL_MAX_INITIAL_ERRORS: u32 = 3;
/// Run lists refresh this often while any listed run is queued or executing.
pub const RUN_LIST_REFRESH: Duration = Duration::from_millis(5_000);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveRunPhase {
    Loading,
    Live,
    Settled,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LiveRunState {
    pub run_id: String,
    pub phase: LiveRunPhase,
    pub run: Option<TestRunDetail>,
    pub consecutive_errors: u32,
    pub error: Option<String>,
    /// Bumped by every event so a scheduler can re-arm on each transition.
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum LiveRunEvent {
    Loaded(Box<TestRunDetail>),
    Failed(String),
    /// Fetch now: after the user cancels a run, presses retry, or a deep link reopens the page.
    Refresh,
}

impl LiveRunState {
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            phase: LiveRunPhase::Loading,
            run: None,
            consecutive_errors: 0,
            error: None,
            revision: 0,
        }
    }

    /// Applies one event. A response for another run (stale after navigation) is ignored.
    pub fn apply(&mut self, event: LiveRunEvent) {
        let revision = self.revision + 1;
        match event {
            LiveRunEvent::Loaded(run) => {
                if run.id != self.run_id {
                    return;
                }
                self.phase = if run.status.is_active() {
                    LiveRunPhase::Live
                } else {
                    LiveRunPhase::Settled
                };
                self.run = Some(*run);
                self.consecutive_errors = 0;
                self.error = None;
            }
            LiveRunEvent::Failed(message) => {
                self.phase = LiveRunPhase::Error;
                self.consecutive_errors += 1;
                self.error = Some(message);
            }
            LiveRunEvent::Refresh => {
                self.phase = LiveRunPhase::Loading;
                self.consecutive_errors = 0;
                self.error = None;
            }
        }
        self.revision = revision;
    }

    /// Delay until the next fetch, or `None` when polling should stop.
    pub fn next_poll_delay(&self) -> Option<Duration> {
        match self.phase {
            LiveRunPhase::Loading => Some(Duration::ZERO),
            LiveRunPhase::Live => Some(RUN_POLL_INTERVAL),
            LiveRunPhase::Settled => None,
            LiveRunPhase::Error => {
                match &self.run {
                    Some(run) if !run.status.is_active() => return None,
                    None if self.consecutive_errors >= RUN_POLL_MAX_INITIAL_ERRORS => return None,
                    _ => {}
                }
                let factor = 2u32.saturating_pow(self.consecutive_errors);
                Some(
                    RUN_POLL_INTERVAL
                        .saturating_mul(factor)
                        .min(RUN_POLL_MAX_BACKOFF),
                )
            }
        }
    }
}

/// True on the transition into a finished run, so the page can refresh lists and the bell.
pub fn did_run_settle(previous: &LiveRunState, next: &LiveRunState) -> bool {
    previous.phase != LiveRunPhase::Settled
        && next.phase == LiveRunPhase::Settled
        && previous.run.is_some()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LabelTone {
    Neutral,
    Accent,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunQueueLabel {
    pub tone: LabelTone,
    pub text: String,
}

/// The status pill text for a run (live-run.ts `describeRunState`).
pub fn describe_run_state(run: &TestRunSummary) -> RunQueueLabel {
    let label = |tone, text: &str| RunQueueLabel {
        tone,
        text: text.to_string(),
    };
    match run.status {
        TestRunStatus::Queued => match (run.blocked_reason.as_deref(), run.queue_position) {
            (Some("NO_RUNNER"), _) => label(LabelTone::Warning, "Queued · waiting for a runner"),
            (Some("BUDGET_EXCEEDED"), _) => {
                label(LabelTone::Warning, "Queued · daily model budget used up")
            }
            (_, None) => label(LabelTone::Neutral, "Queued"),
            (_, Some(0)) => label(LabelTone::Neutral, "Queued · next"),
            (_, Some(ahead)) => label(LabelTone::Neutral, &format!("Queued · {ahead} ahead")),
        },
        TestRunStatus::Claimed => label(LabelTone::Accent, "Starting"),
        TestRunStatus::Running => label(LabelTone::Accent, "Running"),
        TestRunStatus::Paused => label(LabelTone::Warning, "Paused"),
        TestRunStatus::Cancelled => label(LabelTone::Neutral, "Cancelled"),
        TestRunStatus::Completed | TestRunStatus::Failed => match run.outcome {
            Some(TestRunOutcome::Passed) => label(
                LabelTone::Success,
                if run.flaky {
                    "Passed · flaky"
                } else {
                    "Passed"
                },
            ),
            Some(TestRunOutcome::Blocked) => label(LabelTone::Warning, "Blocked"),
            Some(TestRunOutcome::Failed) => label(LabelTone::Danger, "Failed"),
            _ if run.status == TestRunStatus::Failed => label(LabelTone::Danger, "Failed"),
            _ => label(LabelTone::Neutral, "Finished"),
        },
        TestRunStatus::Unknown => label(LabelTone::Neutral, "Unknown"),
    }
}

/// How often a run list should refresh, or `None` when nothing in it is still active.
pub fn run_list_refresh_interval(items: &[TestRunSummary]) -> Option<Duration> {
    items
        .iter()
        .any(|run| run.status.is_active())
        .then_some(RUN_LIST_REFRESH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_runs::tests::{detail_json, summary_json};

    fn detail(id: &str, status: &str) -> TestRunDetail {
        serde_json::from_value(detail_json(id, status)).unwrap()
    }

    #[test]
    fn polls_while_active_and_stops_when_settled() {
        let mut state = LiveRunState::new("run_1");
        assert_eq!(state.next_poll_delay(), Some(Duration::ZERO));
        state.apply(LiveRunEvent::Loaded(Box::new(detail("run_1", "running"))));
        assert_eq!(state.phase, LiveRunPhase::Live);
        assert_eq!(state.next_poll_delay(), Some(RUN_POLL_INTERVAL));
        let before = state.clone();
        state.apply(LiveRunEvent::Loaded(Box::new(detail("run_1", "completed"))));
        assert_eq!(state.next_poll_delay(), None);
        assert!(did_run_settle(&before, &state));
        assert_eq!(state.revision, 2);
    }

    #[test]
    fn ignores_other_runs() {
        let mut state = LiveRunState::new("run_1");
        state.apply(LiveRunEvent::Loaded(Box::new(detail("run_2", "running"))));
        assert_eq!(state, LiveRunState::new("run_1"));
    }

    #[test]
    fn backs_off_on_errors() {
        let mut state = LiveRunState::new("run_1");
        state.apply(LiveRunEvent::Loaded(Box::new(detail("run_1", "running"))));
        state.apply(LiveRunEvent::Failed("offline".into()));
        assert_eq!(state.next_poll_delay(), Some(Duration::from_secs(4)));
        for _ in 0..5 {
            state.apply(LiveRunEvent::Failed("offline".into()));
        }
        assert_eq!(state.next_poll_delay(), Some(RUN_POLL_MAX_BACKOFF));

        let mut fresh = LiveRunState::new("run_1");
        for _ in 0..RUN_POLL_MAX_INITIAL_ERRORS {
            fresh.apply(LiveRunEvent::Failed("404".into()));
        }
        assert_eq!(fresh.next_poll_delay(), None);
        fresh.apply(LiveRunEvent::Refresh);
        assert_eq!(fresh.next_poll_delay(), Some(Duration::ZERO));
    }

    #[test]
    fn describes_states() {
        let mut run: TestRunSummary = serde_json::from_value(summary_json("r", "queued")).unwrap();
        assert_eq!(describe_run_state(&run).text, "Queued · 2 ahead");
        run.queue_position = Some(0);
        assert_eq!(describe_run_state(&run).text, "Queued · next");
        run.blocked_reason = Some("NO_RUNNER".into());
        assert_eq!(
            describe_run_state(&run),
            RunQueueLabel {
                tone: LabelTone::Warning,
                text: "Queued · waiting for a runner".into()
            }
        );
        run.status = TestRunStatus::Completed;
        run.outcome = Some(TestRunOutcome::Passed);
        run.flaky = true;
        assert_eq!(describe_run_state(&run).text, "Passed · flaky");
        run.status = TestRunStatus::Failed;
        run.outcome = None;
        assert_eq!(describe_run_state(&run).tone, LabelTone::Danger);
        assert_eq!(run_list_refresh_interval(std::slice::from_ref(&run)), None);
        run.status = TestRunStatus::Paused;
        assert_eq!(run_list_refresh_interval(&[run]), Some(RUN_LIST_REFRESH));
    }
}
