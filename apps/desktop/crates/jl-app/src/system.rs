//! System integration: the menu bar extra, global shortcuts and notifications. These are what let
//! the app live in the background all day and still be one keystroke away.

use std::time::Duration;

use crossbeam_channel::{Receiver, unbounded};
use gpui_kit::*;
use jl_macos::{HotkeyId, Hotkeys, NotificationEvent, StatusEvent, StatusItem, StatusMenu};

use crate::app::JlApp;
use crate::model::{CaptureKind, Page};

pub struct System {
    // (anchor() reads the status item's frame for placing the quick recorder.)
    status: Option<StatusItem>,
    toggle_hotkey: Option<Hotkeys>,
    /// ⌘⇧M is only global while a recording runs; otherwise other apps keep it.
    marker_hotkey: Option<Hotkeys>,
    hotkey_tx: crossbeam_channel::Sender<HotkeyId>,
    menu_recording: Option<bool>,
}

impl JlApp {
    pub fn install_system(&mut self, cx: &mut Context<Self>) {
        let (status_tx, status_rx) = unbounded();
        let (hotkey_tx, hotkey_rx) = unbounded();
        let (note_tx, note_rx) = unbounded();
        let status = StatusItem::install(status_tx).map_err(|e| log::warn!("status item: {e:#}")).ok();
        let toggle_hotkey = Hotkeys::register(&[(HotkeyId::TOGGLE_RECORDING, jl_macos::TOGGLE_RECORDING_SHORTCUT)], hotkey_tx.clone())
            .map_err(|e| log::warn!("global shortcut: {e:#}"))
            .ok();
        if let Err(e) = jl_macos::notifications::install(note_tx) {
            log::warn!("notifications: {e:#}");
        }
        self.system = Some(System { status, toggle_hotkey, marker_hotkey: None, hotkey_tx, menu_recording: None });
        self.sync_system();
        self.poll_system(status_rx, hotkey_rx, note_rx, cx);
    }

    /// Mirrors app state into the menu bar: the elapsed time while recording, and a menu that
    /// matches what can be done right now.
    pub fn sync_system(&mut self) {
        let recording = self.recording.as_ref().map(|r| r.started.elapsed());
        let sources: Vec<(String, String)> = self
            .sources
            .iter()
            .map(|s| {
                let kind = match s.kind {
                    CaptureKind::Screen => "Screen",
                    CaptureKind::Window => "Window",
                    CaptureKind::App => "App",
                };
                (s.id.to_string(), format!("{kind} · {}", s.name))
            })
            .collect();
        let recent: Vec<(String, String)> = self.sessions.iter().take(jl_macos::MAX_RECENT).map(|s| (s.id.to_string(), s.name.to_string())).collect();
        let signed_in_as = self.account.as_ref().filter(|_| self.signed_in).map(|a| a.name.to_string());
        let Some(system) = self.system.as_mut() else { return };
        if let Some(status) = system.status.as_mut() {
            status.set_recording(recording);
            let is_recording = recording.is_some();
            if system.menu_recording != Some(is_recording) || self.menu_dirty {
                status.set_menu(&StatusMenu { recording: is_recording, sources, recent, signed_in_as });
                system.menu_recording = Some(is_recording);
                self.menu_dirty = false;
            }
        }
        match (recording.is_some(), system.marker_hotkey.is_some()) {
            (true, false) => {
                system.marker_hotkey = Hotkeys::register(&[(HotkeyId::ADD_MARKER, jl_macos::ADD_MARKER_SHORTCUT)], system.hotkey_tx.clone())
                    .map_err(|e| log::warn!("marker shortcut: {e:#}"))
                    .ok();
            }
            (false, true) => system.marker_hotkey = None,
            _ => {}
        }
        let _ = &system.toggle_hotkey;
    }

    fn poll_system(&mut self, status_rx: Receiver<StatusEvent>, hotkey_rx: Receiver<HotkeyId>, note_rx: Receiver<NotificationEvent>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let mut ticks = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                ticks += 1;
                let statuses: Vec<_> = status_rx.try_iter().collect();
                let hotkeys: Vec<_> = hotkey_rx.try_iter().collect();
                let notes: Vec<_> = note_rx.try_iter().collect();
                let alive = this.update(cx, |this, cx| {
                    for ev in statuses {
                        this.on_status_event(ev, cx);
                    }
                    for id in hotkeys {
                        if id == HotkeyId::TOGGLE_RECORDING {
                            this.toggle_recording_global(cx);
                        } else if id == HotkeyId::ADD_MARKER {
                            this.add_marker(cx);
                        }
                    }
                    for ev in notes {
                        if let NotificationEvent::Review { id } | NotificationEvent::Opened { id } = ev {
                            cx.activate(true);
                            if let Some(i) = this.sessions.iter().position(|s| s.id.as_ref() == id) {
                                this.page = Page::Library;
                                this.open_session(i, cx);
                            }
                        }
                    }
                    // The menu bar clock only needs a new string once a second.
                    if ticks.is_multiple_of(5) && this.recording.is_some() {
                        this.sync_system();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn on_status_event(&mut self, ev: StatusEvent, cx: &mut Context<Self>) {
        match ev {
            StatusEvent::StartRecording { source_id } => {
                if let Some(src) = self.sources.iter().find(|s| s.id.as_ref() == source_id).cloned() {
                    self.capture_kind = src.kind;
                    self.selected_source = self.visible_sources().iter().position(|s| s.id == src.id).unwrap_or(0);
                }
                if self.recording.is_none() {
                    self.toggle_recording_global(cx);
                }
            }
            StatusEvent::StopRecording => {
                if self.recording.is_some() {
                    self.toggle_recording_global(cx);
                }
            }
            StatusEvent::AddMarker => self.add_marker(cx),
            StatusEvent::OpenRecent { id } => {
                self.show_main_window(cx);
                if let Some(i) = self.sessions.iter().position(|s| s.id.as_ref() == id) {
                    self.page = Page::Library;
                    self.open_session(i, cx);
                }
            }
            StatusEvent::OpenApp => self.show_main_window(cx),
            StatusEvent::Quit => cx.quit(),
            StatusEvent::Clicked { anchor } => self.toggle_quick(Some(anchor), cx),
        }
    }

    /// Drops a marker on the timeline at the current recording time. The count on screen updates
    /// at once; the recorder's own stats confirm it on the next poll.
    pub fn add_marker(&mut self, cx: &mut Context<Self>) {
        let Some(rec) = self.recording.as_mut() else { return };
        rec.markers += 1;
        let label = format!("Marker {}", rec.markers);
        if rec.recorder.is_none() {
            rec.pending_markers.push(label);
        } else if let Some(recorder) = rec.recorder.clone() {
            cx.background_executor()
                .spawn(async move {
                    if let Err(err) = recorder.add_marker(&label) {
                        log::warn!("marker: {err:#}");
                    }
                })
                .detach();
        }
        cx.notify();
    }

    /// Start/stop from outside the window (menu bar, global shortcut): stopping brings the review
    /// forward; starting leaves the user where they are.
    /// ⌥⇧R from anywhere. Stops a running recording; otherwise opens the quick recorder, and a
    /// second press while it's open records the highlighted source straight away.
    fn toggle_recording_global(&mut self, cx: &mut Context<Self>) {
        if self.recording.is_some() {
            self.stop_from_hud(cx);
        } else if let Some(q) = self.quick {
            cx.defer(move |cx| {
                q.update(cx, |panel, window, cx| panel.start_from_shortcut(window, cx)).ok();
            });
        } else {
            self.open_quick(crate::quick::QuickMode::Pick, None, cx);
        }
        self.sync_system();
    }
}

impl System {
    pub fn anchor(&self) -> Option<(i32, i32, i32, i32)> {
        self.status.as_ref().and_then(|s| s.anchor())
    }
}
