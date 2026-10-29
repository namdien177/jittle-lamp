//! Row labels, ported from `packages/shared/src/timeline.ts` so both viewers read the same.

use std::collections::HashMap;

use crate::archive::{
    ActionPayload, IntegrationEvent, Interaction, InteractionEvent, SessionArchive, TabContext,
};

pub fn action_label(payload: &ActionPayload) -> String {
    match payload {
        ActionPayload::Lifecycle(event) => format!("{}: {}", event.phase.as_str(), event.detail),
        ActionPayload::Interaction(event) => interaction_label(event),
        ActionPayload::Error(event) => event.message.clone(),
        ActionPayload::Integration(event) => integration_label(event),
    }
}

/// `formatIntegrationLabel`: header line, statement, then the sample rows as JSON.
pub fn integration_label(event: &IntegrationEvent) -> String {
    let rows = if event.row_count == 1 {
        "1 row".to_owned()
    } else {
        format!("{} rows", event.row_count)
    };
    let sample = serde_json::to_string(&event.sample).unwrap_or_else(|_| "[]".into());
    format!(
        "{} {} · {rows} · {}ms\n{}\n{sample}",
        event.integration.to_uppercase(),
        event.profile,
        js_round(event.duration_ms),
        event.statement
    )
}

fn interaction_label(event: &InteractionEvent) -> String {
    let target = event.target.as_ref();
    let target_text = target
        .and_then(|t| t.text_preview.as_deref())
        .or(event.value_preview.as_deref())
        .filter(|t| !t.is_empty());
    let selector = event
        .selector
        .as_deref()
        .or(target.and_then(|t| t.selector.as_deref()));
    let target_type = describe_target(event);
    let fallback = |verb: &str| {
        selector.map_or_else(|| verb.to_owned(), |selector| format!("{verb} {selector}"))
    };

    match &event.detail {
        Interaction::Click(_) => match target_text {
            Some(text) => format!("Click \"{}\" {target_type}", truncate_label_text(text)),
            None => fallback("click"),
        },
        Interaction::Input(_) => match target_text {
            Some(text) => format!("Input \"{}\" {target_type}", truncate_label_text(text)),
            None => fallback("input"),
        },
        Interaction::Submit(_) => match target_text {
            Some(text) => format!("Submit \"{}\" {target_type}", truncate_label_text(text)),
            None => fallback("submit"),
        },
        Interaction::Keyboard(keyboard) => match target_text {
            Some(text) => format!(
                "Key {} in \"{}\" {target_type}",
                keyboard.key,
                truncate_label_text(text)
            ),
            None => fallback("keyboard"),
        },
        Interaction::Selection(selection) => format!(
            "Highlight \"{}\"",
            truncate_label_text(&selection.selected_text)
        ),
        Interaction::Navigation(navigation) => match &navigation.title {
            Some(title) if !title.is_empty() => {
                format!("Navigate to \"{}\"", truncate_label_text(title))
            }
            _ => format!("navigation {}", navigation.url),
        },
    }
}

fn describe_target(event: &InteractionEvent) -> String {
    let target = event.target.as_ref();
    let tag_name = target
        .and_then(|t| t.tag_name.as_deref())
        .map(str::to_lowercase);
    let role = target
        .and_then(|t| t.role.clone().flatten())
        .map(|role| role.to_lowercase());
    let input_type = target
        .and_then(|t| t.input_type.as_deref())
        .map(str::to_lowercase);
    let tag = tag_name.as_deref();

    if tag == Some("button")
        || role.as_deref() == Some("button")
        || matches!(input_type.as_deref(), Some("button" | "submit"))
    {
        return "button".into();
    }
    if tag == Some("a")
        || role.as_deref() == Some("link")
        || target.is_some_and(|t| t.href.as_deref().is_some_and(|h| !h.is_empty()))
    {
        return "link".into();
    }
    if matches!(tag, Some("input" | "textarea" | "select")) {
        return "field".into();
    }
    if let Some(role) = role.filter(|role| !role.is_empty()) {
        return role;
    }
    tag_name.unwrap_or_else(|| "element".into())
}

/// Collapses whitespace and cuts at 64 UTF-16 units, as JS string lengths count.
pub fn truncate_label_text(value: &str) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.encode_utf16().count() <= 64 {
        return normalized;
    }
    let mut units = 0;
    let mut cut: String = normalized
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 61
        })
        .collect();
    cut.push_str("...");
    cut
}

/// `Math.round`: halves round up, including negatives.
pub fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

pub fn prefix_tab_label(label: String, tab_label: Option<&str>, enabled: bool) -> String {
    match tab_label {
        Some(tab) if enabled => format!("[{tab}] {label}"),
        _ => label,
    }
}

/// `buildArchiveTabLabels`: tab id → title, numbered when titles repeat.
pub fn tab_labels(archive: &SessionArchive) -> HashMap<u64, String> {
    let sections = &archive.sections;
    let tabs = sections
        .actions
        .iter()
        .filter_map(|e| e.tab.as_ref())
        .chain(sections.console.iter().filter_map(|e| e.tab.as_ref()))
        .chain(sections.network.iter().filter_map(|e| e.tab.as_ref()));

    let mut unique: Vec<&TabContext> = Vec::new();
    for tab in tabs {
        if !unique.iter().any(|seen| seen.id == tab.id) {
            unique.push(tab);
        }
    }

    let titles: Vec<String> = unique.iter().map(|tab| normalized_tab_title(tab)).collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for title in &titles {
        *counts.entry(title).or_default() += 1;
    }
    let mut indexes: HashMap<&str, usize> = HashMap::new();
    unique
        .iter()
        .zip(&titles)
        .map(|(tab, title)| {
            let label = if counts[title.as_str()] > 1 {
                let index = indexes.entry(title).or_default();
                *index += 1;
                format!("{title} {index}")
            } else {
                title.clone()
            };
            (tab.id, label)
        })
        .collect()
}

fn normalized_tab_title(tab: &TabContext) -> String {
    if let Some(title) = tab
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    {
        return title.to_owned();
    }
    match tab.url.as_deref() {
        Some(url) => match url_hostname(url) {
            Some(host) if !host.is_empty() => host,
            Some(_) => format!("Tab {}", tab.id),
            None => url.to_owned(),
        },
        None => format!("Tab {}", tab.id),
    }
}

/// `new URL(url).hostname`, or `None` where the URL constructor would throw.
pub fn url_hostname(url: &str) -> Option<String> {
    let (scheme, rest) = url.split_once(':')?;
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic()
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let Some(authority) = rest.strip_prefix("//") else {
        return Some(String::new());
    };
    let authority = authority.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = match host_port.rsplit_once(':') {
        Some((host, port))
            if !host_port.ends_with(']') && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            host
        }
        _ => host_port,
    };
    let special = matches!(
        scheme.to_ascii_lowercase().as_str(),
        "http" | "https" | "ws" | "wss" | "ftp" | "file"
    );
    Some(if special {
        host.to_lowercase()
    } else {
        host.to_owned()
    })
}
