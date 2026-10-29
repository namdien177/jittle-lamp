//! One sorted list of everything on a recording's timeline, for the viewer's lanes and inspector.

mod labels;

pub use labels::{integration_label, truncate_label_text, url_hostname};

use crate::archive::{
    ActionPayload, Annotation, CapturePhase, ConsoleLevel, Interaction, NetworkEvent,
    SessionArchive, StepAnnotation, StepStatus, parse_timestamp_ms,
};
use labels::{action_label, js_round, prefix_tab_label, tab_labels};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    Action,
    Network,
    Console,
    Step,
    Marker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    Debug,
    Info,
    Warn,
    Error,
}

/// Where an item came from: the section and the index into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    Action(usize),
    Console(usize),
    Network(usize),
    Annotation(usize),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineItem {
    pub id: String,
    pub lane: Lane,
    /// Milliseconds from the recording start (`deriveAnchorMs`); negative before it.
    pub offset_ms: i64,
    /// Steps and finished requests span time.
    pub end_offset_ms: Option<i64>,
    pub seq: Option<u64>,
    pub label: String,
    pub secondary: String,
    pub severity: Severity,
    pub tags: Vec<String>,
    pub tab_label: Option<String>,
    pub source: Source,
    pub method: Option<String>,
    pub status: Option<u16>,
    pub duration_ms: Option<f64>,
}

impl TimelineItem {
    fn new(id: &str, lane: Lane, offset_ms: i64, label: String, source: Source) -> Self {
        Self {
            id: id.to_owned(),
            lane,
            offset_ms,
            end_offset_ms: None,
            seq: None,
            label,
            secondary: String::new(),
            severity: Severity::Info,
            tags: Vec::new(),
            tab_label: None,
            source,
            method: None,
            status: None,
            duration_ms: None,
        }
    }
}

/// `buildTimeline` plus step annotations, sorted by offset then sequence.
pub fn build_timeline(archive: &SessionArchive) -> Vec<TimelineItem> {
    let anchor = archive.recording_start_ms();
    let tabs = tab_labels(archive);
    let show_tabs = tabs.len() > 1;
    let offset = |at: &str| parse_timestamp_ms(at).map_or(0, |ms| ms - anchor);
    let tab_label =
        |tab: Option<&crate::archive::TabContext>| tab.and_then(|tab| tabs.get(&tab.id)).cloned();

    let mut items = Vec::new();

    for (index, annotation) in archive.annotations.iter().enumerate() {
        if let Annotation::Step(step) = annotation {
            items.push(step_item(step, index));
        }
    }

    for (index, entry) in archive.sections.actions.iter().enumerate() {
        let tab = tab_label(entry.tab.as_ref());
        let marker = entry.is_marker();
        let label = match (&entry.payload, marker) {
            (ActionPayload::Lifecycle(event), true) => event.detail.clone(),
            (payload, _) => action_label(payload),
        };
        let is_lifecycle = matches!(entry.payload, ActionPayload::Lifecycle(_));
        let label = prefix_tab_label(label, tab.as_deref(), show_tabs && !is_lifecycle);
        let (lane, severity, secondary) = classify_action(&entry.payload, marker);
        let mut item = TimelineItem::new(
            &entry.id,
            lane,
            offset(&entry.at),
            label,
            Source::Action(index),
        );
        item.seq = Some(entry.seq);
        item.severity = severity;
        item.secondary = secondary.or_else(|| tab.clone()).unwrap_or_default();
        item.tags = entry.tags.clone();
        item.tab_label = tab;
        if let ActionPayload::Integration(event) = &entry.payload {
            item.duration_ms = Some(event.duration_ms);
        }
        items.push(item);
    }

    for (index, entry) in archive.sections.console.iter().enumerate() {
        let tab = tab_label(entry.tab.as_ref());
        let label = prefix_tab_label(entry.payload.message.clone(), tab.as_deref(), show_tabs);
        let mut item = TimelineItem::new(
            &entry.id,
            Lane::Console,
            offset(&entry.at),
            label,
            Source::Console(index),
        );
        item.seq = Some(entry.seq);
        item.severity = match entry.payload.level {
            ConsoleLevel::Debug => Severity::Debug,
            ConsoleLevel::Info => Severity::Info,
            ConsoleLevel::Warn => Severity::Warn,
            ConsoleLevel::Error => Severity::Error,
        };
        item.secondary = tab.clone().unwrap_or_default();
        item.tags = entry.tags.clone().unwrap_or_default();
        item.tab_label = tab;
        items.push(item);
    }

    for (index, entry) in archive.sections.network.iter().enumerate() {
        let payload = &entry.payload;
        let tab = tab_label(entry.tab.as_ref());
        let label = prefix_tab_label(
            format!("{} {}", payload.method, payload.url),
            tab.as_deref(),
            show_tabs,
        );
        let start = offset(&entry.at);
        let mut item = TimelineItem::new(
            &entry.id,
            Lane::Network,
            start,
            label,
            Source::Network(index),
        );
        item.seq = Some(entry.seq);
        item.severity = network_severity(payload);
        item.secondary = network_secondary(payload);
        item.tags = entry.tags.clone().unwrap_or_default();
        item.tab_label = tab;
        item.method = Some(payload.method.clone());
        item.status = payload.status;
        item.duration_ms = payload.duration_ms;
        item.end_offset_ms = payload.duration_ms.map(|ms| start + js_round(ms));
        items.push(item);
    }

    items.sort_by_key(|item| (item.offset_ms, item.seq.unwrap_or(0)));
    items
}

fn classify_action(payload: &ActionPayload, marker: bool) -> (Lane, Severity, Option<String>) {
    match payload {
        ActionPayload::Interaction(event) => {
            let secondary = match &event.detail {
                Interaction::Navigation(navigation) => Some(navigation.url.clone()),
                _ => event
                    .selector
                    .clone()
                    .or_else(|| event.target.as_ref().and_then(|t| t.selector.clone())),
            };
            (Lane::Action, Severity::Info, secondary)
        }
        ActionPayload::Error(event) => {
            let location = event
                .stack
                .as_deref()
                .and_then(|stack| stack.lines().next())
                .map(str::trim)
                .map(str::to_owned);
            (
                Lane::Console,
                Severity::Error,
                location.or_else(|| Some(event.source.clone())),
            )
        }
        ActionPayload::Lifecycle(event) => {
            let severity = if event.phase == CapturePhase::Failed {
                Severity::Error
            } else {
                Severity::Info
            };
            let secondary = if marker {
                "Marker".to_owned()
            } else {
                event.phase.as_str().to_owned()
            };
            (Lane::Marker, severity, Some(secondary))
        }
        ActionPayload::Integration(event) => {
            (Lane::Action, Severity::Info, Some(event.profile.clone()))
        }
    }
}

fn network_severity(payload: &NetworkEvent) -> Severity {
    match payload.status {
        _ if payload.failure_text.is_some() => Severity::Error,
        Some(status) if status >= 500 => Severity::Error,
        Some(status) if status >= 400 => Severity::Warn,
        _ => Severity::Info,
    }
}

fn network_secondary(payload: &NetworkEvent) -> String {
    let mut parts = Vec::new();
    match (payload.status, &payload.status_text) {
        (Some(status), Some(text)) => parts.push(format!("{status} {text}")),
        (Some(status), None) => parts.push(status.to_string()),
        _ => {}
    }
    if let Some(ms) = payload.duration_ms {
        parts.push(format!("{} ms", js_round(ms)));
    }
    if let Some(failure) = &payload.failure_text {
        parts.push(failure.clone());
    }
    parts.join(" · ")
}

fn step_item(step: &StepAnnotation, index: usize) -> TimelineItem {
    let start = js_round(step.video_offset_ms);
    let mut item = TimelineItem::new(
        &step.id,
        Lane::Step,
        start,
        step.label.clone(),
        Source::Annotation(index),
    );
    item.end_offset_ms = step.video_end_offset_ms.map(js_round);
    item.severity = match step.status {
        StepStatus::Failed => Severity::Error,
        StepStatus::Blocked => Severity::Warn,
        StepStatus::Skipped => Severity::Debug,
        StepStatus::Running | StepStatus::Passed => Severity::Info,
    };
    let status = serde_json::to_value(step.status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    item.secondary = format!("Step {} · {status}", step.ordinal);
    item.tags = step.tags.clone();
    item
}

/// `findActiveIndex`: the last item at or before `current_ms` in a sorted list.
pub fn find_active_index(items: &[TimelineItem], current_ms: i64) -> Option<usize> {
    items
        .iter()
        .take_while(|item| item.offset_ms <= current_ms)
        .count()
        .checked_sub(1)
}

/// `formatOffset`: `mm:ss`, with a leading `-` before the recording start.
pub fn format_offset(offset_ms: i64) -> String {
    let sign = if offset_ms < 0 { "-" } else { "" };
    let total_seconds = offset_ms.unsigned_abs() / 1000;
    format!("{sign}{:02}:{:02}", total_seconds / 60, total_seconds % 60)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisibleActionRow {
    pub id: String,
    pub member_action_ids: Vec<String>,
}

/// `buildVisibleActionRows`: Actions-tab rows with merge groups folded into one row each.
pub fn visible_action_rows(archive: &SessionArchive) -> Vec<VisibleActionRow> {
    let groups: Vec<_> = archive.merge_groups().collect();
    let mut rows = Vec::new();
    let mut seen_groups = std::collections::HashSet::new();

    for item in build_timeline(archive) {
        let Source::Action(index) = item.source else {
            continue;
        };
        if !matches!(
            archive.sections.actions[index].payload,
            ActionPayload::Interaction(_) | ActionPayload::Error(_)
        ) {
            continue;
        }
        match groups
            .iter()
            .find(|group| group.member_ids.contains(&item.id))
        {
            Some(group) => {
                if seen_groups.insert(group.id.clone()) {
                    rows.push(VisibleActionRow {
                        id: group.id.clone(),
                        member_action_ids: group.member_ids.clone(),
                    });
                }
            }
            None => rows.push(VisibleActionRow {
                member_action_ids: vec![item.id.clone()],
                id: item.id,
            }),
        }
    }
    rows
}

#[cfg(test)]
mod tests;
