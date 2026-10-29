//! Writes `session.archive.json` (schema v5, recorder kind `desktop-recorder`) with serde_json.
//!
//! Self-contained on purpose so it can be swapped for `jl-core::archive` later. The shapes follow
//! `packages/shared/src/session.ts` and the "Session archive" section of `DESIGN.md`.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::{DateTime, FixedOffset, SecondsFormat};
use serde_json::{Map, Value, json};

use crate::logs::ConsoleLevel;

pub const SCHEMA_VERSION: u64 = 5;
pub const RECORDER_NAME: &str = "jittle-lamp-desktop";
pub const VIDEO_FILE: &str = "recording.mp4";
pub const ARCHIVE_FILE: &str = "session.archive.json";
/// Tag on lifecycle actions that are user markers.
pub const MARKER_TAG: &str = "marker";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceKind {
    Display,
    Window,
    Application,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Display => "display",
            Self::Window => "window",
            Self::Application => "application",
        }
    }
}

/// `recorder.recorder.source`.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureSource {
    pub kind: SourceKind,
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: Option<i32>,
    /// Display id for display captures, used for `page.url`.
    pub display_id: Option<u32>,
}

impl CaptureSource {
    /// `app://<bundle id>` for app/window captures, `screen://display/<id>` for displays.
    pub fn page_url(&self) -> String {
        match (self.kind, &self.bundle_id) {
            (SourceKind::Display, _) => {
                format!("screen://display/{}", self.display_id.unwrap_or(0))
            }
            (_, Some(bundle_id)) if !bundle_id.is_empty() => app_url(bundle_id),
            (_, _) => format!("app://pid-{}", self.pid.unwrap_or(0)),
        }
    }
}

pub fn app_url(bundle_id: &str) -> String {
    // Hosts cannot carry spaces or slashes; bundle ids never should, but be safe.
    let host: String = bundle_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("app://{host}")
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Modifiers {
    pub alt: bool,
    pub ctrl: bool,
    pub meta: bool,
    pub shift: bool,
}

impl Modifiers {
    fn to_json(self) -> Value {
        json!({ "alt": self.alt, "ctrl": self.ctrl, "meta": self.meta, "shift": self.shift })
    }
}

/// Size of the captured area in points, sent as `page` metrics so click coordinates can be laid
/// over the video.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The accessibility element under a click, when it could be read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ClickTarget {
    pub role: Option<String>,
    pub text: Option<String>,
    /// Element frame relative to the captured area, in points.
    pub rect: Option<(f64, f64, f64, f64)>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ActionPayload {
    /// Coordinates are points relative to the captured area's top-left corner.
    Click {
        x: f64,
        y: f64,
        button: i64,
        click_count: i64,
        modifiers: Modifiers,
        target: Option<ClickTarget>,
        viewport: Option<Viewport>,
        page_url: Option<String>,
        page_title: Option<String>,
    },
    /// A shortcut (modifier + key) or a special key. Never typed characters.
    Keyboard {
        key: String,
        code: Option<String>,
        modifiers: Modifiers,
    },
    /// App switch or window-title change.
    Navigation {
        url: String,
        title: Option<String>,
        app_switch: bool,
    },
    Lifecycle {
        phase: &'static str,
        detail: String,
    },
    Error {
        message: String,
    },
}

impl ActionPayload {
    pub fn is_interaction(&self) -> bool {
        matches!(
            self,
            Self::Click { .. } | Self::Keyboard { .. } | Self::Navigation { .. }
        )
    }

    pub fn to_json(&self) -> Value {
        match self {
            Self::Click {
                x,
                y,
                button,
                click_count,
                modifiers,
                target,
                viewport,
                page_url,
                page_title,
            } => {
                let mut value = json!({
                    "kind": "interaction",
                    "type": "click",
                    "x": x, "y": y, "clientX": x, "clientY": y, "pageX": x, "pageY": y,
                    "button": button,
                    "clickCount": click_count,
                    "pointerType": "mouse",
                    "modifiers": modifiers.to_json(),
                });
                let obj = value.as_object_mut().expect("object");
                if let Some(target) = target {
                    let mut t = Map::new();
                    t.insert("selectorAlternates".into(), json!([]));
                    if let Some(role) = target.role.as_deref().filter(|r| !r.is_empty()) {
                        t.insert("role".into(), json!(web_role(role)));
                    }
                    if let Some(text) = target.text.as_deref().filter(|t| !t.is_empty()) {
                        t.insert("textPreview".into(), json!(truncate(text, 240)));
                    }
                    if let Some((left, top, width, height)) = target.rect {
                        t.insert(
                            "rect".into(),
                            json!({ "left": left, "top": top, "width": width, "height": height }),
                        );
                    }
                    obj.insert("target".into(), Value::Object(t));
                }
                if let Some(vp) = viewport {
                    let (w, h) = (
                        vp.width.round().max(0.0) as u64,
                        vp.height.round().max(0.0) as u64,
                    );
                    let mut page = json!({
                        "viewport": { "width": w, "height": h },
                        "document": { "width": w, "height": h },
                        "scroll": { "x": 0, "y": 0 },
                    });
                    let p = page.as_object_mut().expect("object");
                    if vp.scale > 0.0 {
                        p.insert("devicePixelRatio".into(), json!(vp.scale));
                    }
                    if let Some(url) = page_url {
                        p.insert("url".into(), json!(url));
                    }
                    if let Some(title) = page_title.as_deref().filter(|t| !t.is_empty()) {
                        p.insert("title".into(), json!(title));
                    }
                    obj.insert("page".into(), page);
                }
                value
            }
            Self::Keyboard {
                key,
                code,
                modifiers,
            } => {
                let mut value = json!({
                    "kind": "interaction",
                    "type": "keyboard",
                    "eventType": "keydown",
                    "key": key,
                    "repeat": false,
                    "isComposing": false,
                    "modifiers": modifiers.to_json(),
                });
                if let Some(code) = code {
                    value["code"] = json!(code);
                }
                value
            }
            Self::Navigation {
                url,
                title,
                app_switch,
            } => {
                let mut value = json!({ "kind": "interaction", "type": "navigation", "url": url });
                if let Some(title) = title.as_deref().filter(|t| !t.is_empty()) {
                    value["title"] = json!(title);
                }
                if *app_switch {
                    value["navigationType"] = json!("location");
                }
                value
            }
            Self::Lifecycle { phase, detail } => {
                json!({ "kind": "lifecycle", "phase": phase, "detail": non_empty(detail) })
            }
            Self::Error { message } => {
                json!({ "kind": "error", "message": non_empty(message), "source": "runtime" })
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum EntryPayload {
    Action(ActionPayload),
    Console {
        level: ConsoleLevel,
        message: String,
        args: Vec<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub at: DateTime<FixedOffset>,
    /// Arrival order; breaks ties between entries with the same timestamp.
    pub order: u64,
    pub tags: Vec<String>,
    pub payload: EntryPayload,
}

#[derive(Clone, Debug)]
pub struct ArchiveInput {
    pub session_id: String,
    pub name: String,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    pub page_title: String,
    pub source: CaptureSource,
    pub recorder_version: String,
    pub os: String,
    pub video_bytes: Option<u64>,
    pub video_duration_ms: Option<f64>,
    pub entries: Vec<Entry>,
    pub notes: Vec<String>,
}

pub fn iso(at: &DateTime<FixedOffset>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// Builds the archive value. Entries are ordered by time (then arrival) and `seq` runs across all
/// sections in that order; ids follow `generateArchiveEntryId`.
pub fn build_archive(input: &ArchiveInput) -> Value {
    let mut entries: Vec<&Entry> = input.entries.iter().collect();
    entries.sort_by(|a, b| a.at.cmp(&b.at).then(a.order.cmp(&b.order)));

    let mut actions = Vec::new();
    let mut console = Vec::new();
    let mut interaction_count = 0u64;
    for (seq, entry) in entries.iter().enumerate() {
        match &entry.payload {
            EntryPayload::Action(action) => {
                if action.is_interaction() {
                    interaction_count += 1;
                }
                actions.push(json!({
                    "id": entry_id(&input.session_id, "actions", actions.len()),
                    "seq": seq,
                    "at": iso(&entry.at),
                    "tags": entry.tags,
                    "payload": action.to_json(),
                }));
            }
            EntryPayload::Console {
                level,
                message,
                args,
            } => {
                let mut value = json!({
                    "id": entry_id(&input.session_id, "console", console.len()),
                    "seq": seq,
                    "at": iso(&entry.at),
                    "payload": { "kind": "console", "level": level.as_str(), "message": message, "args": args },
                });
                if !entry.tags.is_empty() {
                    value["tags"] = json!(entry.tags);
                }
                console.push(value);
            }
        }
    }

    let source = &input.source;
    let mut source_json = json!({ "type": source.kind.as_str(), "name": non_empty(&source.name) });
    if let Some(bundle_id) = source.bundle_id.as_deref().filter(|b| !b.is_empty()) {
        source_json["bundleId"] = json!(bundle_id);
    }
    if let Some(pid) = source.pid {
        source_json["pid"] = json!(pid);
    }

    let mut video = json!({
        "kind": VIDEO_FILE,
        "relativePath": format!("{}/{VIDEO_FILE}", input.session_id),
        "mimeType": "video/mp4",
    });
    if let Some(bytes) = input.video_bytes {
        video["bytes"] = json!(bytes);
    }

    json!({
        "schemaVersion": SCHEMA_VERSION,
        "sessionId": input.session_id,
        "name": non_empty(&input.name),
        "createdAt": iso(&input.created_at),
        "updatedAt": iso(&input.updated_at),
        "phase": "ready",
        "page": { "url": source.page_url(), "title": non_empty(&input.page_title) },
        "recorder": {
            "kind": "desktop-recorder",
            "recorder": {
                "name": RECORDER_NAME,
                "version": non_empty(&input.recorder_version),
                "os": non_empty(&input.os),
                "source": source_json,
            },
        },
        "summary": {
            "videoDurationMs": input.video_duration_ms,
            "actionCount": interaction_count,
            "requestCount": 0,
        },
        "artifacts": [
            video,
            {
                "kind": ARCHIVE_FILE,
                "relativePath": format!("{}/{ARCHIVE_FILE}", input.session_id),
                "mimeType": "application/json",
            },
        ],
        "sections": { "actions": actions, "console": console, "network": [] },
        "annotations": [],
        "notes": input.notes,
    })
}

/// Writes the archive next to the video, through a temp file so a crash never leaves half a file.
pub fn write_archive(path: &Path, archive: &Value) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(archive)?;
    std::fs::write(&tmp, bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path).with_context(|| format!("renaming to {}", path.display()))?;
    Ok(())
}

fn entry_id(session_id: &str, section: &str, index: usize) -> String {
    format!("{session_id}:{section}:{index:06}")
}

// The schema requires `min(1)` for names, titles and details.
fn non_empty(value: &str) -> &str {
    if value.trim().is_empty() {
        "Untitled"
    } else {
        value
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_owned();
    }
    value.chars().take(max_chars - 1).collect::<String>() + "…"
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use chrono::TimeZone;

    pub(crate) fn sample_input() -> ArchiveInput {
        let tz = FixedOffset::east_opt(7 * 3600).unwrap();
        let t = |ms: i64| tz.timestamp_millis_opt(1_761_700_000_000 + ms).unwrap();
        let entry = |ms: i64, order: u64, payload: EntryPayload| Entry {
            at: t(ms),
            order,
            tags: vec![],
            payload,
        };
        let mut marker = entry(
            900,
            5,
            EntryPayload::Action(ActionPayload::Lifecycle {
                phase: "recording",
                detail: "Bug here".into(),
            }),
        );
        marker.tags.push(MARKER_TAG.into());
        ArchiveInput {
            session_id: "jl_mhbaozr4".into(),
            name: "Safari".into(),
            created_at: t(-20),
            updated_at: t(2_000),
            page_title: "Safari".into(),
            source: CaptureSource {
                kind: SourceKind::Application,
                name: "Safari".into(),
                bundle_id: Some("com.apple.Safari".into()),
                pid: Some(501),
                display_id: Some(1),
            },
            recorder_version: "1.8.5".into(),
            os: "macOS 27.0".into(),
            video_bytes: Some(123_456),
            video_duration_ms: Some(2_000.0),
            entries: vec![
                entry(
                    2_000,
                    9,
                    EntryPayload::Action(ActionPayload::Lifecycle {
                        phase: "ready",
                        detail: "Recording stopped.".into(),
                    }),
                ),
                entry(
                    0,
                    0,
                    EntryPayload::Action(ActionPayload::Lifecycle {
                        phase: "recording",
                        detail: "Recording Safari.".into(),
                    }),
                ),
                // A log line stamped before an action that arrived earlier sorts by time.
                entry(
                    400,
                    3,
                    EntryPayload::Console {
                        level: ConsoleLevel::Error,
                        message: "boom".into(),
                        args: vec!["process=Safari[501]".into()],
                    },
                ),
                entry(
                    500,
                    2,
                    EntryPayload::Action(ActionPayload::Click {
                        x: 10.0,
                        y: 20.5,
                        button: 0,
                        click_count: 1,
                        modifiers: Modifiers::default(),
                        target: Some(ClickTarget {
                            role: Some("AXButton".into()),
                            text: Some("Save".into()),
                            rect: Some((5.0, 15.0, 60.0, 24.0)),
                        }),
                        viewport: Some(Viewport {
                            width: 1512.0,
                            height: 982.0,
                            scale: 2.0,
                        }),
                        page_url: Some("app://com.apple.Safari".into()),
                        page_title: Some("Safari".into()),
                    }),
                ),
                entry(
                    600,
                    4,
                    EntryPayload::Action(ActionPayload::Keyboard {
                        key: "s".into(),
                        code: Some("KeyS".into()),
                        modifiers: Modifiers {
                            meta: true,
                            ..Modifiers::default()
                        },
                    }),
                ),
                entry(
                    700,
                    6,
                    EntryPayload::Action(ActionPayload::Navigation {
                        url: "app://com.apple.Safari".into(),
                        title: Some("Apple".into()),
                        app_switch: false,
                    }),
                ),
                marker,
            ],
            notes: vec![],
        }
    }

    fn is_iso_with_offset(value: &Value) -> bool {
        value.as_str().is_some_and(|s| {
            DateTime::parse_from_rfc3339(s).is_ok()
                && (s.ends_with('Z') || s[s.len() - 6..].starts_with(['+', '-']))
        })
    }

    /// The parts of `sessionArchiveV5Schema` (plus the desktop recorder) a reader relies on.
    pub(crate) fn assert_archive_shape(archive: &Value) {
        assert_eq!(archive["schemaVersion"], 5);
        let session_id = archive["sessionId"].as_str().unwrap();
        assert!(crate::session_id::is_valid_session_id(session_id));
        for key in ["name", "phase"] {
            assert!(!archive[key].as_str().unwrap().is_empty(), "{key}");
        }
        assert!(
            is_iso_with_offset(&archive["createdAt"]) && is_iso_with_offset(&archive["updatedAt"])
        );
        assert!(archive["page"]["url"].as_str().unwrap().contains("://"));
        assert!(!archive["page"]["title"].as_str().unwrap().is_empty());
        let recorder = &archive["recorder"];
        assert_eq!(recorder["kind"], "desktop-recorder");
        assert_eq!(recorder["recorder"]["name"], RECORDER_NAME);
        assert!(
            ["display", "window", "application"]
                .contains(&recorder["recorder"]["source"]["type"].as_str().unwrap())
        );
        let summary = &archive["summary"];
        assert!(
            summary["videoDurationMs"].is_null()
                || summary["videoDurationMs"].as_f64().unwrap() >= 0.0
        );
        assert!(summary["actionCount"].as_u64().is_some());
        let artifacts = archive["artifacts"].as_array().unwrap();
        assert!(
            artifacts
                .iter()
                .any(|a| a["kind"] == VIDEO_FILE && a["mimeType"] == "video/mp4")
        );
        assert!(
            artifacts
                .iter()
                .all(|a| a["relativePath"].as_str().unwrap().starts_with(session_id))
        );

        let mut seqs = Vec::new();
        for (section, kind) in [("actions", None), ("console", Some("console"))] {
            for (index, entry) in archive["sections"][section]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                assert_eq!(entry["id"], format!("{session_id}:{section}:{index:06}"));
                assert!(is_iso_with_offset(&entry["at"]));
                seqs.push((
                    entry["seq"].as_u64().unwrap(),
                    entry["at"].as_str().unwrap().to_owned(),
                ));
                let payload_kind = entry["payload"]["kind"].as_str().unwrap();
                match kind {
                    Some(kind) => assert_eq!(payload_kind, kind),
                    None => {
                        assert!(["interaction", "lifecycle", "error"].contains(&payload_kind));
                        assert!(entry["tags"].is_array());
                    }
                }
            }
        }
        // seq is unique across sections and follows time.
        seqs.sort();
        assert!(seqs.windows(2).all(|w| w[0].0 < w[1].0));
        let times: Vec<_> = seqs
            .iter()
            .map(|(_, at)| DateTime::parse_from_rfc3339(at).unwrap())
            .collect();
        assert!(times.windows(2).all(|w| w[0] <= w[1]));
        assert!(
            archive["sections"]["network"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(archive["annotations"].is_array() && archive["notes"].is_array());
    }

    #[test]
    fn writes_v5_desktop_archive() {
        let archive = build_archive(&sample_input());
        assert_archive_shape(&archive);

        let actions = archive["sections"]["actions"].as_array().unwrap();
        // The recording lifecycle comes first so the viewer anchors offsets on it.
        assert_eq!(actions[0]["payload"]["phase"], "recording");
        assert_eq!(actions[0]["at"], "2025-10-29T08:06:40.000+07:00");
        assert_eq!(archive["sections"]["console"][0]["seq"], 1);
        assert_eq!(actions[1]["seq"], 2);
        assert_eq!(actions[1]["payload"]["type"], "click");
        assert_eq!(actions[1]["payload"]["target"]["textPreview"], "Save");
        assert_eq!(actions[1]["payload"]["page"]["viewport"]["width"], 1512);
        assert_eq!(actions[2]["payload"]["key"], "s");
        assert_eq!(actions[2]["payload"]["modifiers"]["meta"], true);
        assert_eq!(actions[4]["tags"], json!([MARKER_TAG]));
        assert_eq!(archive["summary"]["actionCount"], 3);
        assert_eq!(archive["page"]["url"], "app://com.apple.Safari");
        assert_eq!(
            archive["recorder"]["recorder"]["source"]["bundleId"],
            "com.apple.Safari"
        );
        assert_eq!(
            archive["artifacts"][0]["relativePath"],
            "jl_mhbaozr4/recording.mp4"
        );
    }

    #[test]
    fn display_sources_use_screen_urls() {
        let source = CaptureSource {
            kind: SourceKind::Display,
            name: "Built-in".into(),
            bundle_id: None,
            pid: None,
            display_id: Some(3),
        };
        assert_eq!(source.page_url(), "screen://display/3");
        let window = CaptureSource {
            kind: SourceKind::Window,
            name: "x".into(),
            bundle_id: None,
            pid: Some(9),
            display_id: None,
        };
        assert_eq!(window.page_url(), "app://pid-9");
    }

    #[test]
    fn write_is_atomic_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(ARCHIVE_FILE);
        let archive = build_archive(&sample_input());
        write_archive(&path, &archive).unwrap();
        let read: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(read, archive);
        assert!(!path.with_extension("json.tmp").exists());
    }
}

/// macOS accessibility roles ("AXButton") in the ARIA vocabulary the shared timeline labels and the
/// web viewer already understand ("button"), so a desktop click reads like a browser one.
pub fn web_role(ax_role: &str) -> String {
    let role = ax_role.strip_prefix("AX").unwrap_or(ax_role);
    match role {
        "Button" | "PopUpButton" | "MenuButton" | "DisclosureTriangle" => "button",
        "CheckBox" => "checkbox",
        "RadioButton" => "radio",
        "Link" => "link",
        "TextField" | "TextArea" | "ComboBox" | "SearchField" => "textbox",
        "MenuItem" | "MenuBarItem" => "menuitem",
        "Tab" | "TabGroup" => "tab",
        "Row" | "Cell" | "Outline" => "row",
        "Slider" => "slider",
        "Image" => "img",
        "StaticText" => "text",
        "Window" | "Sheet" | "Dialog" => "dialog",
        "Toolbar" => "toolbar",
        other => return other.to_ascii_lowercase(),
    }
    .to_string()
}

#[cfg(test)]
mod web_role_tests {
    #[test]
    fn ax_roles_read_like_aria() {
        assert_eq!(super::web_role("AXButton"), "button");
        assert_eq!(super::web_role("AXMenuItem"), "menuitem");
        assert_eq!(super::web_role("AXTextField"), "textbox");
        assert_eq!(super::web_role("AXSplitter"), "splitter");
    }
}
