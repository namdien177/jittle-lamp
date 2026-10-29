//! What the model sees: a compact digest of a session archive.

use std::collections::HashSet;

use jl_core::archive::{
    ActionPayload, CaptureSourceKind, ConsoleLevel, Interaction, Recorder, SessionArchive,
};
use jl_core::timeline::{Lane, Source, url_hostname};
use jl_core::{build_timeline, mask_secrets};
use serde::{Deserialize, Serialize};

/// Caps that keep the prompt well inside the on-device model's 4096-token context.
const MAX_ACTIONS: usize = 24;
/// Of `MAX_ACTIONS`, how many come from the start; the rest are the last ones.
const LEADING_ACTIONS: usize = 6;
const MAX_CONSOLE_ERRORS: usize = 6;
const MAX_CONSOLE_WARNINGS: usize = 3;
const MAX_FAILED_REQUESTS: usize = 8;
const MAX_MARKERS: usize = 10;
const MAX_WINDOW_TITLES: usize = 8;
const MAX_LABEL_CHARS: usize = 120;
const MAX_MESSAGE_CHARS: usize = 200;

/// Prefix of the placeholder row that stands in for actions dropped from the middle.
pub(crate) const GAP_PREFIX: &str = "… ";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionInput {
    pub source: SourceInfo,
    pub page_url: String,
    pub page_title: String,
    /// App and window titles seen during the recording, excluding `page_title`.
    pub window_titles: Vec<String>,
    /// Timeline labels in order; a gap row (`… N more actions`) replaces any dropped middle.
    pub actions: Vec<ActionLine>,
    /// Errors first, then warnings, each in time order; secrets masked.
    pub console: Vec<ConsoleLine>,
    /// Requests that failed outright or returned 4xx/5xx, one per method + path + status.
    pub failed_requests: Vec<FailedRequest>,
    pub duration_ms: Option<f64>,
    pub markers: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// `application`, `window`, `display`, `browser tab` or `automated browser test`.
    pub kind: String,
    /// The app, window or display name; the site for browser recordings.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLine {
    /// Milliseconds from the recording start.
    pub at_ms: i64,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleLine {
    pub at_ms: i64,
    /// `error` or `warn`.
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedRequest {
    pub at_ms: i64,
    pub method: String,
    /// Path without query or fragment; prefixed with the host when it isn't the page's.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

impl ActionLine {
    pub(crate) fn is_gap(&self) -> bool {
        self.label.starts_with(GAP_PREFIX)
    }
}

impl FailedRequest {
    /// `POST /api/orders returned 500`, `GET /api/timeout failed (net::ERR_TIMED_OUT)`.
    pub fn summary(&self) -> String {
        match (self.status, &self.failure) {
            (Some(status), _) if status >= 400 => {
                format!("{} {} returned {status}", self.method, self.path)
            }
            (_, Some(failure)) => format!("{} {} failed ({failure})", self.method, self.path),
            _ => format!("{} {} failed", self.method, self.path),
        }
    }
}

/// Extracts the model's input from an archive, with every list capped.
pub fn input_from_archive(archive: &SessionArchive) -> SuggestionInput {
    let page_host = url_hostname(&archive.page.url).filter(|host| !host.is_empty());
    let mut input = SuggestionInput {
        source: source_info(archive, page_host.as_deref()),
        page_url: strip_query(&archive.page.url).to_owned(),
        page_title: clip(archive.page.title.trim(), MAX_LABEL_CHARS),
        duration_ms: archive.duration_ms(),
        ..SuggestionInput::default()
    };

    let mut actions: Vec<ActionLine> = Vec::new();
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut seen_messages = HashSet::new();
    let mut seen_requests = HashSet::new();

    for item in build_timeline(archive) {
        match (item.lane, item.source) {
            (Lane::Marker, Source::Action(index)) => {
                if archive.sections.actions[index].is_marker() && !item.label.trim().is_empty() {
                    input.markers.push(clip(&item.label, MAX_LABEL_CHARS));
                }
            }
            (Lane::Action, Source::Action(index)) => {
                let payload = &archive.sections.actions[index].payload;
                let label = shortcut_label(payload).unwrap_or_else(|| {
                    clip(&humanize_role(first_line(&item.label)), MAX_LABEL_CHARS)
                });
                match actions.last_mut() {
                    Some(last) if same_action(&last.label, &label) => {
                        last.label = repeat_label(&last.label);
                    }
                    _ => actions.push(ActionLine {
                        at_ms: item.offset_ms,
                        label,
                    }),
                }
            }
            // Uncaught page errors are recorded as actions; they read as console errors.
            (Lane::Console, Source::Action(_) | Source::Console(_)) => {
                let level = match item.source {
                    Source::Console(index) => archive.sections.console[index].payload.level,
                    _ => ConsoleLevel::Error,
                };
                let message = clip(&mask_secrets(first_line(&item.label)), MAX_MESSAGE_CHARS);
                if message.is_empty() || !seen_messages.insert(message.clone()) {
                    continue;
                }
                let (bucket, level) = match level {
                    ConsoleLevel::Error => (&mut errors, "error"),
                    ConsoleLevel::Warn => (&mut warnings, "warn"),
                    ConsoleLevel::Info | ConsoleLevel::Debug => continue,
                };
                bucket.push(ConsoleLine {
                    at_ms: item.offset_ms,
                    level: level.into(),
                    message,
                });
            }
            (Lane::Network, Source::Network(index)) => {
                let payload = &archive.sections.network[index].payload;
                let failed = payload.failure_text.is_some()
                    || payload.status.is_some_and(|status| status >= 400);
                if !failed || input.failed_requests.len() >= MAX_FAILED_REQUESTS {
                    continue;
                }
                let path = request_path(&payload.url, page_host.as_deref());
                if !seen_requests.insert((payload.method.clone(), path.clone(), payload.status)) {
                    continue;
                }
                input.failed_requests.push(FailedRequest {
                    at_ms: item.offset_ms,
                    method: payload.method.to_uppercase(),
                    path,
                    status: payload.status,
                    failure: payload
                        .failure_text
                        .as_deref()
                        .map(|text| clip(text, MAX_LABEL_CHARS)),
                });
            }
            _ => {}
        }
    }

    input.markers.truncate(MAX_MARKERS);
    errors.truncate(MAX_CONSOLE_ERRORS);
    warnings.truncate(MAX_CONSOLE_WARNINGS);
    input.console = errors.into_iter().chain(warnings).collect();
    input.actions = cap_actions(actions);
    input.window_titles = window_titles(archive, &input.page_title);
    input
}

/// Where in the video a frame is most telling: just after the first error, else near the end.
pub fn suggested_frame_offset_ms(input: &SuggestionInput) -> i64 {
    let end = input.duration_ms.map_or(0, |ms| ms as i64);
    let first_error = input
        .console
        .iter()
        .filter(|line| line.level == "error")
        .map(|line| line.at_ms)
        .chain(input.failed_requests.iter().map(|request| request.at_ms))
        .min();
    match first_error {
        Some(at) => (at + 750).clamp(0, end.max(0)),
        None => (end - 500).max(0),
    }
}

fn source_info(archive: &SessionArchive, page_host: Option<&str>) -> SourceInfo {
    let site = || {
        page_host
            .map(str::to_owned)
            .or_else(|| Some(archive.page.title.trim().to_owned()).filter(|t| !t.is_empty()))
            .unwrap_or_else(|| "a website".into())
    };
    match &archive.recorder {
        Recorder::Desktop { recorder } => SourceInfo {
            kind: match recorder.source.kind {
                CaptureSourceKind::Application => "application",
                CaptureSourceKind::Window => "window",
                CaptureSourceKind::Display => "display",
            }
            .into(),
            name: recorder.source.name.clone(),
            bundle_id: recorder.source.bundle_id.clone(),
        },
        Recorder::BrowserExtension { .. } => SourceInfo {
            kind: "browser tab".into(),
            name: site(),
            bundle_id: None,
        },
        Recorder::E2eRunner { .. } => SourceInfo {
            kind: "automated browser test".into(),
            name: site(),
            bundle_id: None,
        },
    }
}

/// App switches and window-title changes (desktop), and tab titles (browser).
fn window_titles(archive: &SessionArchive, page_title: &str) -> Vec<String> {
    let sections = &archive.sections;
    let navigation_titles = sections
        .actions
        .iter()
        .filter_map(|action| match &action.payload {
            ActionPayload::Interaction(event) => match &event.detail {
                Interaction::Navigation(navigation) => navigation.title.as_deref(),
                _ => None,
            },
            _ => None,
        });
    let tab_titles = sections
        .actions
        .iter()
        .filter_map(|e| e.tab.as_ref())
        .chain(sections.console.iter().filter_map(|e| e.tab.as_ref()))
        .chain(sections.network.iter().filter_map(|e| e.tab.as_ref()))
        .filter_map(|tab| tab.title.as_deref());

    let mut seen = HashSet::from([page_title.to_owned()]);
    navigation_titles
        .chain(tab_titles)
        .map(|title| clip(title.trim(), MAX_LABEL_CHARS))
        .filter(|title| !title.is_empty() && seen.insert(title.clone()))
        .take(MAX_WINDOW_TITLES)
        .collect()
}

/// Desktop clicks carry Accessibility roles, which the shared labels print as `axbutton`.
fn humanize_role(label: &str) -> String {
    let Some((head, role)) = label.rsplit_once(' ') else {
        return label.to_owned();
    };
    let Some(role) = role.strip_prefix("ax").filter(|role| !role.is_empty()) else {
        return label.to_owned();
    };
    let role = match role {
        "menuitem" | "menubaritem" => "menu item",
        "popupbutton" | "menubutton" => "pop-up menu",
        "textfield" | "textarea" | "searchfield" | "combobox" => "field",
        "checkbox" => "checkbox",
        "radiobutton" => "radio button",
        "statictext" => "text",
        "disclosuretriangle" => "disclosure triangle",
        other => other,
    };
    format!("{head} {role}")
}

/// `Press Cmd+S` for key presses without a focused field, which the timeline calls `keyboard`.
fn shortcut_label(payload: &ActionPayload) -> Option<String> {
    let ActionPayload::Interaction(event) = payload else {
        return None;
    };
    let Interaction::Keyboard(keyboard) = &event.detail else {
        return None;
    };
    if event
        .target
        .as_ref()
        .is_some_and(|t| t.text_preview.is_some())
        || keyboard.key.is_empty()
    {
        return None;
    }
    let modifiers = keyboard.modifiers.unwrap_or_default();
    let mut keys: Vec<String> = [
        (modifiers.ctrl, "Ctrl"),
        (modifiers.alt, "Option"),
        (modifiers.shift, "Shift"),
        (modifiers.meta, "Cmd"),
    ]
    .into_iter()
    .filter(|(held, _)| *held)
    .map(|(_, name)| name.to_owned())
    .collect();
    keys.push(if keyboard.key.chars().count() == 1 {
        keyboard.key.to_uppercase()
    } else {
        keyboard.key.clone()
    });
    Some(format!("Press {}", keys.join("+")))
}

/// Keeps the first few and the last actions, with a gap row for what's dropped between them.
fn cap_actions(mut actions: Vec<ActionLine>) -> Vec<ActionLine> {
    if actions.len() <= MAX_ACTIONS {
        return actions;
    }
    let trailing = MAX_ACTIONS - LEADING_ACTIONS;
    let tail = actions.split_off(actions.len() - trailing);
    let omitted = actions.len() - LEADING_ACTIONS;
    actions.truncate(LEADING_ACTIONS);
    actions.push(ActionLine {
        at_ms: tail[0].at_ms,
        label: format!("{GAP_PREFIX}{omitted} more actions"),
    });
    actions.extend(tail);
    actions
}

/// Consecutive repeats fold into one row: `Click "Next" button (×3)`.
fn same_action(previous: &str, label: &str) -> bool {
    strip_repeat(previous).0 == label
}

fn repeat_label(previous: &str) -> String {
    let (base, count) = strip_repeat(previous);
    format!("{base} (×{})", count + 1)
}

fn strip_repeat(label: &str) -> (&str, u32) {
    label
        .strip_suffix(')')
        .and_then(|rest| rest.rsplit_once(" (×"))
        .and_then(|(base, count)| Some((base, count.parse().ok()?)))
        .unwrap_or((label, 1))
}

fn request_path(url: &str, page_host: Option<&str>) -> String {
    let url = strip_query(url);
    let Some((_, rest)) = url.split_once("://") else {
        return clip(url, MAX_LABEL_CHARS);
    };
    let (host, path) = rest.find('/').map_or((rest, "/"), |at| rest.split_at(at));
    // Drop userinfo; it can hold credentials.
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    let path = if page_host.is_some_and(|page| page.eq_ignore_ascii_case(host)) {
        path.to_owned()
    } else {
        format!("{host}{path}")
    };
    clip(&path, MAX_LABEL_CHARS)
}

fn strip_query(url: &str) -> &str {
    url.find(['?', '#']).map_or(url, |at| &url[..at])
}

fn first_line(text: &str) -> &str {
    text.lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim()
}

/// Collapses whitespace and cuts at `max` characters with an ellipsis.
pub(crate) fn clip(text: &str, max: usize) -> String {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max {
        return normalized;
    }
    let mut cut: String = normalized.chars().take(max - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}
