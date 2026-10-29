//! Platform-independent description of the status item menu. `StatusItem` turns this into
//! `NSMenu`s; keeping it pure lets the layout be unit-tested.

use std::time::Duration;

/// Shortcut shown next to Start/Stop Recording (it is also the default global hotkey).
pub const TOGGLE_RECORDING_SHORTCUT: &str = "alt+shift+r";
/// Shortcut shown next to Add Marker.
pub const ADD_MARKER_SHORTCUT: &str = "cmd+shift+m";

/// What the app wants the menu to show. Ids are opaque to this crate and come back in events.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StatusMenu {
    pub recording: bool,
    /// Capture sources offered under Start Recording ▸, as `(id, title)`.
    pub sources: Vec<(String, String)>,
    /// Recent recordings, newest first, as `(id, title)`. The menu shows at most three.
    pub recent: Vec<(String, String)>,
    pub signed_in_as: Option<String>,
}

/// Events emitted by the status item menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StatusEvent {
    StartRecording { source_id: String },
    StopRecording,
    AddMarker,
    OpenRecent { id: String },
    OpenApp,
    Quit,
    /// Left click on the menu bar icon: the app shows its quick recorder under it. The anchor is
    /// the icon's frame in global top-left-origin points (x, y, width, height).
    Clicked { anchor: (i32, i32, i32, i32) },
}

/// Maximum number of recent recordings listed in the menu.
pub const MAX_RECENT: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuEntry {
    Item(MenuItem),
    /// Non-interactive section title ("Recent").
    Header(String),
    /// Disabled informational line ("Signed in as …").
    Info(String),
    Submenu {
        title: String,
        symbol: Option<&'static str>,
        items: Vec<MenuEntry>,
    },
    Separator,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuItem {
    pub title: String,
    pub event: Option<StatusEvent>,
    /// Shortcut string understood by [`crate::Shortcut::parse`].
    pub shortcut: Option<&'static str>,
    /// SF Symbol name shown as the item image.
    pub symbol: Option<&'static str>,
}

impl MenuItem {
    fn new(title: impl Into<String>, event: StatusEvent) -> Self {
        Self {
            title: title.into(),
            event: Some(event),
            shortcut: None,
            symbol: None,
        }
    }

    fn disabled(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            event: None,
            shortcut: None,
            symbol: None,
        }
    }

    fn shortcut(mut self, shortcut: &'static str) -> Self {
        self.shortcut = Some(shortcut);
        self
    }

    fn symbol(mut self, symbol: &'static str) -> Self {
        self.symbol = Some(symbol);
        self
    }
}

impl StatusMenu {
    /// The menu layout:
    ///
    /// ```text
    /// Start Recording ▸ (sources)   ⌥⇧R     | Stop Recording  ⌥⇧R
    /// Add Marker                     ⌘⇧M    (disabled unless recording)
    /// ───
    /// Recent
    ///   <up to three recordings>
    /// ───
    /// Open Jittle Lamp
    /// Signed in as …                         (only when signed in)
    /// ───
    /// Quit Jittle Lamp               ⌘Q
    /// ```
    pub fn entries(&self) -> Vec<MenuEntry> {
        let mut entries = Vec::new();

        if self.recording {
            entries.push(MenuEntry::Item(
                MenuItem::new("Stop Recording", StatusEvent::StopRecording)
                    .shortcut(TOGGLE_RECORDING_SHORTCUT)
                    .symbol("stop.circle"),
            ));
        } else if self.sources.is_empty() {
            entries.push(MenuEntry::Item(
                MenuItem::disabled("Start Recording").symbol("record.circle"),
            ));
        } else {
            let items = self
                .sources
                .iter()
                .map(|(id, title)| {
                    MenuEntry::Item(MenuItem::new(
                        title.clone(),
                        StatusEvent::StartRecording {
                            source_id: id.clone(),
                        },
                    ))
                })
                .collect();
            entries.push(MenuEntry::Submenu {
                title: "Start Recording".into(),
                symbol: Some("record.circle"),
                items,
            });
        }

        let marker = if self.recording {
            MenuItem::new("Add Marker", StatusEvent::AddMarker)
        } else {
            MenuItem::disabled("Add Marker")
        };
        entries.push(MenuEntry::Item(
            marker.shortcut(ADD_MARKER_SHORTCUT).symbol("bookmark"),
        ));

        if !self.recent.is_empty() {
            entries.push(MenuEntry::Separator);
            entries.push(MenuEntry::Header("Recent".into()));
            for (id, title) in self.recent.iter().take(MAX_RECENT) {
                entries.push(MenuEntry::Item(MenuItem::new(
                    title.clone(),
                    StatusEvent::OpenRecent { id: id.clone() },
                )));
            }
        }

        entries.push(MenuEntry::Separator);
        entries.push(MenuEntry::Item(MenuItem::new(
            "Open Jittle Lamp",
            StatusEvent::OpenApp,
        )));
        if let Some(who) = &self.signed_in_as {
            entries.push(MenuEntry::Info(format!("Signed in as {who}")));
        }
        entries.push(MenuEntry::Separator);
        entries.push(MenuEntry::Item(
            MenuItem::new("Quit Jittle Lamp", StatusEvent::Quit).shortcut("cmd+q"),
        ));
        entries
    }
}

/// Elapsed time for the status item title: `0:42`, `12:05`, `1:02:03`.
pub fn format_elapsed(elapsed: Duration) -> String {
    let secs = elapsed.as_secs();
    let (h, m, s) = (secs / 3600, (secs / 60) % 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(entries: &[MenuEntry]) -> Vec<String> {
        entries
            .iter()
            .map(|e| match e {
                MenuEntry::Item(i) => i.title.clone(),
                MenuEntry::Header(t) => format!("# {t}"),
                MenuEntry::Info(t) => format!("i {t}"),
                MenuEntry::Submenu { title, .. } => format!("{title} ▸"),
                MenuEntry::Separator => "---".into(),
            })
            .collect()
    }

    fn sources() -> Vec<(String, String)> {
        vec![
            ("display:1".into(), "Entire Screen".into()),
            ("app:com.apple.Safari".into(), "Safari".into()),
        ]
    }

    #[test]
    fn idle_menu_offers_sources_and_disables_marker() {
        let menu = StatusMenu {
            sources: sources(),
            ..Default::default()
        };
        let entries = menu.entries();
        assert_eq!(
            titles(&entries),
            [
                "Start Recording ▸",
                "Add Marker",
                "---",
                "Open Jittle Lamp",
                "---",
                "Quit Jittle Lamp"
            ]
        );
        let MenuEntry::Submenu { items, .. } = &entries[0] else {
            panic!()
        };
        assert_eq!(
            items[1],
            MenuEntry::Item(MenuItem::new(
                "Safari",
                StatusEvent::StartRecording {
                    source_id: "app:com.apple.Safari".into()
                }
            ))
        );
        let MenuEntry::Item(marker) = &entries[1] else {
            panic!()
        };
        assert_eq!(marker.event, None);
        assert_eq!(marker.shortcut, Some(ADD_MARKER_SHORTCUT));
    }

    #[test]
    fn recording_menu_stops_and_marks() {
        let menu = StatusMenu {
            recording: true,
            sources: sources(),
            recent: (0..5)
                .map(|i| (format!("s{i}"), format!("Session {i}")))
                .collect(),
            signed_in_as: Some("qa@example.com".into()),
        };
        let entries = menu.entries();
        assert_eq!(
            titles(&entries),
            [
                "Stop Recording",
                "Add Marker",
                "---",
                "# Recent",
                "Session 0",
                "Session 1",
                "Session 2",
                "---",
                "Open Jittle Lamp",
                "i Signed in as qa@example.com",
                "---",
                "Quit Jittle Lamp"
            ]
        );
        let MenuEntry::Item(stop) = &entries[0] else {
            panic!()
        };
        assert_eq!(stop.event, Some(StatusEvent::StopRecording));
        assert_eq!(stop.shortcut, Some(TOGGLE_RECORDING_SHORTCUT));
        let MenuEntry::Item(marker) = &entries[1] else {
            panic!()
        };
        assert_eq!(marker.event, Some(StatusEvent::AddMarker));
        let MenuEntry::Item(recent) = &entries[4] else {
            panic!()
        };
        assert_eq!(
            recent.event,
            Some(StatusEvent::OpenRecent { id: "s0".into() })
        );
    }

    #[test]
    fn no_sources_disables_start() {
        let entries = StatusMenu::default().entries();
        let MenuEntry::Item(start) = &entries[0] else {
            panic!()
        };
        assert_eq!(start.title, "Start Recording");
        assert_eq!(start.event, None);
    }

    #[test]
    fn menu_shortcuts_parse() {
        for s in [TOGGLE_RECORDING_SHORTCUT, ADD_MARKER_SHORTCUT, "cmd+q"] {
            crate::Shortcut::parse(s).unwrap();
        }
    }

    #[test]
    fn formats_elapsed() {
        assert_eq!(format_elapsed(Duration::from_millis(999)), "0:00");
        assert_eq!(format_elapsed(Duration::from_secs(42)), "0:42");
        assert_eq!(format_elapsed(Duration::from_secs(12 * 60 + 5)), "12:05");
        assert_eq!(format_elapsed(Duration::from_secs(3723)), "1:02:03");
    }
}
