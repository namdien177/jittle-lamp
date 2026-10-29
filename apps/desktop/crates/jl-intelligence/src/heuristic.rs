//! Deterministic title and description, for when Apple Intelligence can't be used.

use crate::input::{SuggestionInput, clip};
use crate::{MAX_TITLE_CHARS, Suggestion, SuggestionSource, clean_title};

/// `<App>: <first error | first marker | last action>` and one line of what happened.
pub fn heuristic_suggestion(input: &SuggestionInput) -> Suggestion {
    let subject = subject(input);
    let first_error = first_error(input);
    let headline = first_error
        .as_ref()
        .map(|(_, text)| text.clone())
        .or_else(|| input.markers.first().cloned())
        .or_else(|| last_action(input, i64::MAX).map(str::to_owned));
    let title = match headline {
        Some(headline) => format!("{subject}: {headline}"),
        None => format!("{subject} walkthrough"),
    };

    let error_count = input
        .console
        .iter()
        .filter(|line| line.level == "error")
        .count()
        + input.failed_requests.len();
    let description = match first_error {
        Some((at_ms, error)) => {
            let lead = match last_action(input, at_ms) {
                Some(action) => format!("After {} ({})", gerund(action), clock(at_ms)),
                None => format!("At {}", clock(at_ms)),
            };
            let more = match error_count.saturating_sub(1) {
                0 => String::new(),
                1 => " 1 more error was captured.".into(),
                n => format!(" {n} more errors were captured."),
            };
            format!("{lead}: {}{more}", sentence(&clip(&error, 160)))
        }
        None => {
            let actions = input.actions.iter().filter(|a| !a.is_gap()).count();
            let duration = input
                .duration_ms
                .map(|ms| format!(" over {}", format_duration(ms)))
                .unwrap_or_default();
            format!(
                "{} in {subject}{duration}; no console errors or failed requests were captured.",
                plural(actions, "action")
            )
        }
    };

    Suggestion {
        title: clean_title(&title),
        description,
        source: SuggestionSource::Heuristic,
        fallback_reason: None,
    }
}

/// The app or site the recording is about.
fn subject(input: &SuggestionInput) -> String {
    let name = input.source.name.trim();
    let title = input.page_title.trim();
    let subject = match input.source.kind.as_str() {
        // A display name says little; the window in front says more.
        "display" => input
            .window_titles
            .first()
            .map(String::as_str)
            .or(Some(title).filter(|t| !t.is_empty() && *t != name))
            .unwrap_or(name),
        "application" | "window" => name,
        _ => Some(title).filter(|t| !t.is_empty()).unwrap_or(name),
    };
    let subject = if subject.is_empty() {
        "Recording"
    } else {
        subject
    };
    clip(subject, MAX_TITLE_CHARS / 2)
}

/// The earliest console error or failed request, as (offset, text).
fn first_error(input: &SuggestionInput) -> Option<(i64, String)> {
    let console = input
        .console
        .iter()
        .filter(|line| line.level == "error")
        .map(|line| (line.at_ms, line.message.clone()));
    let requests = input
        .failed_requests
        .iter()
        .map(|request| (request.at_ms, request.summary()));
    console.chain(requests).min_by_key(|(at, _)| *at)
}

/// The last user action at or before `at_ms` that says something, without its tab prefix or
/// repeat count. Integration checks (`SQL …`, `HTTP …`) and rows without a target (`click`)
/// are skipped.
fn last_action(input: &SuggestionInput, at_ms: i64) -> Option<&str> {
    input
        .actions
        .iter()
        .rev()
        .filter(|action| !action.is_gap() && action.at_ms <= at_ms)
        .map(|action| {
            let label = action.label.as_str();
            let label = label
                .strip_prefix('[')
                .and_then(|rest| rest.split_once("] "))
                .map_or(label, |(_, rest)| rest);
            label.rsplit_once(" (×").map_or(label, |(base, _)| base)
        })
        .find(|label| {
            !matches!(*label, "click" | "input" | "keyboard")
                && !label.starts_with("SQL ")
                && !label.starts_with("HTTP ")
        })
}

/// `Click "Save" button` → `clicking "Save" button`, for "After …".
fn gerund(action: &str) -> String {
    let (verb, rest) = action.split_once(' ').unwrap_or((action, ""));
    let verb = match verb.to_lowercase().as_str() {
        "click" => "clicking",
        "press" | "key" => "pressing",
        "input" => "typing in",
        "submit" => "submitting",
        "navigate" => "navigating",
        "navigation" => "navigating to",
        "highlight" => "selecting",
        _ => return action.to_owned(),
    };
    if rest.is_empty() {
        verb.to_owned()
    } else {
        format!("{verb} {rest}")
    }
}

/// Ends the text with a period unless it already ends a sentence.
fn sentence(text: &str) -> String {
    match text.chars().last() {
        Some('.' | '!' | '?' | '…') => text.to_owned(),
        _ => format!("{text}."),
    }
}

fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn plural(count: usize, noun: &str) -> String {
    match count {
        0 => format!("No {noun}s"),
        1 => format!("1 {noun}"),
        n => format!("{n} {noun}s"),
    }
}

fn format_duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round() as u64;
    if seconds < 60 {
        format!("{seconds} s")
    } else {
        format!("{} min {} s", seconds / 60, seconds % 60)
    }
}
