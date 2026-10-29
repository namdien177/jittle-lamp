//! The local side of the app: the session library on disk, the companion server the Chrome
//! extension uploads to, and turning archives into what the viewer shows.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use crossbeam_channel::{Receiver, unbounded};
use gpui_kit::*;
use jl_core::archive::RecorderKind;
use jl_core::companion::{self, CompanionEvent};
use jl_core::library::{Library, LoadedSession, SessionRecord};
use jl_core::timeline::{self, Lane as CoreLane, Severity as CoreSeverity};

use crate::app::{InspectorTab, JlApp, Viewer};
use crate::model::{Event, Lane, Origin, Session, Severity, Sync};

/// `JITTLE_LAMP_HOME` points the app at another config folder (tests, demos); the default is
/// `~/.jittle-lamp`, shared with the Electron app it replaces.
fn home_override() -> Option<PathBuf> {
    std::env::var_os("JITTLE_LAMP_HOME").map(PathBuf::from)
}

pub fn config_file() -> PathBuf {
    home_override().map(|h| h.join("companion.json")).unwrap_or_else(jl_core::config::config_file_path)
}

pub fn load_config() -> jl_core::config::ResolvedConfig {
    jl_core::config::load_from(&config_file(), std::env::var(jl_core::config::OUTPUT_DIR_ENV).ok().as_deref())
}

pub fn open_library() -> anyhow::Result<(Library, jl_core::config::ResolvedConfig)> {
    match home_override() {
        Some(home) => {
            let config = jl_core::config::load_from(&home.join("companion.json"), std::env::var(jl_core::config::OUTPUT_DIR_ENV).ok().as_deref());
            let library = Library::open(home.join("sessions.db"), config.output_dir.clone())?;
            Ok((library, config))
        }
        None => {
            let config = jl_core::config::load();
            let library = Library::open(jl_core::config::default_db_path(), config.output_dir.clone())?;
            Ok((library, config))
        }
    }
}

fn origin_of(r: &SessionRecord) -> Origin {
    match r.recorder_kind {
        RecorderKind::E2eRunner => Origin::Runner,
        RecorderKind::Desktop if r.page_url.starts_with("screen://") => Origin::Screen { display: r.page_title.clone().into() },
        RecorderKind::Desktop => Origin::App { name: r.page_title.clone().into() },
        RecorderKind::BrowserExtension => {
            let host = r.page_url.split("://").nth(1).and_then(|rest| rest.split(['/', '?', '#']).next()).unwrap_or(&r.page_url);
            Origin::Browser { host: host.to_string().into() }
        }
    }
}

fn parse_local(at: &str) -> DateTime<Local> {
    DateTime::parse_from_rfc3339(at).map(|d| d.with_timezone(&Local)).unwrap_or_else(|_| Local::now())
}

pub fn to_session(r: &SessionRecord) -> Session {
    Session {
        id: r.session_id.clone().into(),
        name: r.name.clone().into(),
        origin: origin_of(r),
        recorded_at: parse_local(&r.recorded_at),
        duration_ms: r.duration_ms.unwrap_or(0.).max(0.) as u64,
        actions: r.action_count as u32,
        requests: r.request_count as u32,
        logs: 0,
        errors: r.console_error_count as u32,
        bytes: r.total_bytes,
        tags: r.tags.iter().map(|t| SharedString::from(t.clone())).collect(),
        sync: if r.remote.is_some() { Sync::Synced } else { Sync::Local },
    }
}

pub fn events_of(loaded: &LoadedSession) -> Vec<Event> {
    timeline::build_timeline(&loaded.archive)
        .into_iter()
        .filter(|i| i.offset_ms >= 0 || i.lane != CoreLane::Network)
        .map(|i| Event {
            lane: match i.lane {
                CoreLane::Action | CoreLane::Step => Lane::Action,
                CoreLane::Network => Lane::Network,
                CoreLane::Console => Lane::Console,
                CoreLane::Marker => Lane::Marker,
            },
            offset_ms: i.offset_ms.max(0) as u64,
            label: i.label.into(),
            detail: i.secondary.into(),
            severity: match i.severity {
                CoreSeverity::Debug => Severity::Debug,
                CoreSeverity::Info => Severity::Info,
                CoreSeverity::Warn => Severity::Warn,
                CoreSeverity::Error => Severity::Error,
            },
            method: i.method.map(Into::into),
            status: i.status,
            duration_ms: i.duration_ms.map(|d| d.max(0.) as u64),
            network_index: match i.source {
                timeline::Source::Network(n) => Some(n),
                _ => None,
            },
        })
        .collect()
}

impl JlApp {
    /// Shows an already-loaded session (a remote download or an imported ZIP) in the viewer.
    pub fn open_loaded(&mut self, loaded: LoadedSession, sync: Sync, remote_evidence_id: Option<String>, cx: &mut Context<Self>) {
        let library_backed = matches!(loaded.source, jl_core::library::SessionSource::Library);
        let a = &loaded.archive;
        let record_like = SessionRecord {
            session_id: a.session_id.clone(),
            session_folder: loaded.folder.clone(),
            name: a.name.clone(),
            page_url: a.page.url.clone(),
            page_title: a.page.title.clone(),
            recorder_kind: a.recorder.kind(),
            recorded_at: a.created_at.clone(),
            duration_ms: a.duration_ms(),
            action_count: a.action_count(),
            request_count: a.request_count(),
            console_error_count: a.console_error_count(),
            video_path: loaded.video_path.clone(),
            video_mime: loaded.video_mime,
            artifacts: Vec::new(),
            total_bytes: 0,
            tags: Vec::new(),
            notes: loaded.notes.clone(),
            remote: None,
        };
        let mut session = to_session(&record_like);
        session.sync = sync;
        let events = events_of(&loaded);
        let video = (loaded.video_path.clone(), loaded.video_mime);
        self.viewer = Some(Viewer {
            session,
            events,
            position_ms: 0,
            playing: false,
            tab: InspectorTab::Actions,
            selected_event: None,
            scrubbing: false,
            last_tick: Instant::now(),
            rate: 1.0,
            loaded: Some(loaded),
            player: None,
            notes: None,
            notes_sub: None,
            library_backed,
            remote_evidence_id,
            notes_status: None,
            notes_generation: 0,
        });
        self.load_player(video.0, video.1, cx);
        cx.notify();
    }

    /// Indexing a long WebM takes a moment, so it runs in the background; the player itself is
    /// created on the main thread (AVPlayer is main-thread only).
    fn load_player(&mut self, path: PathBuf, mime: &'static str, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let probe_path = path.clone();
            let source = cx.background_executor().spawn(async move { jl_media::MediaSource::open(&probe_path, Some(mime)) }).await;
            this.update(cx, |this, cx| {
                let Some(v) = this.viewer.as_mut().filter(|v| v.loaded.as_ref().is_some_and(|l| l.video_path == path)) else { return };
                match source.and_then(jl_media::Player::from_source) {
                    Ok(player) => {
                        let weak = cx.entity().downgrade();
                        // Paused seeks land on another thread; repaint when the frame arrives.
                        let (tx, rx) = crossbeam_channel::bounded::<()>(1);
                        player.set_frame_listener(Some(std::sync::Arc::new(move || {
                            let _ = tx.try_send(());
                        })));
                        cx.spawn(async move |_, cx| {
                            loop {
                                cx.background_executor().timer(Duration::from_millis(16)).await;
                                match rx.try_recv() {
                                    Ok(()) => {
                                        if weak.update(cx, |_, cx| cx.notify()).is_err() {
                                            break;
                                        }
                                    }
                                    Err(crossbeam_channel::TryRecvError::Empty) => {}
                                    // The player (and its listener) is gone: this viewer closed.
                                    Err(crossbeam_channel::TryRecvError::Disconnected) => break,
                                }
                            }
                        })
                        .detach();
                        if v.position_ms > 0 {
                            player.seek(v.position_ms, jl_media::SeekMode::Exact);
                        }
                        v.session.duration_ms = player.duration_ms().max(v.session.duration_ms);
                        v.player = Some(player);
                    }
                    Err(err) => this.toast("circle-alert", "Couldn't play the recording", format!("{err:#}"), None, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Poster frames, one at a time in the background, partway in (past the blank first frames
    /// most recordings start with). Rows show a tinted placeholder until theirs lands.
    fn load_thumbnails(&mut self, cx: &mut Context<Self>) {
        let todo: Vec<(SharedString, PathBuf, u64)> = self
            .records
            .iter()
            .filter(|r| !self.thumbs.contains_key(r.session_id.as_str()))
            .map(|r| (SharedString::from(r.session_id.clone()), r.video_path.clone(), r.duration_ms.unwrap_or(0.) as u64))
            .collect();
        if todo.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            for (id, path, duration) in todo {
                let at = (duration * 2 / 5).min(8_000);
                // Decoded here, in BGRA, so rows paint it on the very next frame with no async decode.
                let frame = cx
                    .background_executor()
                    .spawn(async move {
                        jl_media::thumbnail(&path, at, 240).map(|mut img| {
                            for px in img.pixels_mut() {
                                px.0.swap(0, 2);
                            }
                            RenderImage::new([image::Frame::new(img)])
                        })
                    })
                    .await;
                let ok = this.update(cx, |this, cx| {
                    if let Ok(image) = frame {
                        this.thumbs.insert(id, std::sync::Arc::new(image));
                        cx.notify();
                    }
                });
                if ok.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Opens the library, lists it, and starts the companion server for the extension.
    pub fn start_local(&mut self, cx: &mut Context<Self>) {
        match open_library() {
            Ok((library, config)) => {
                self.output_dir = config.output_dir.display().to_string().replace(&std::env::var("HOME").unwrap_or_default(), "~").into();
                self.auto_sync = config.auto_sync_to_cloud;
                let (tx, rx) = unbounded();
                match companion::start(library.clone(), tx) {
                    Ok(handle) => self.companion = Some(handle),
                    Err(err) => log::warn!("companion server did not start: {err:#}"),
                }
                self.library = Some(library);
                self.watch_companion(rx, cx);
                self.reload_library(cx);
            }
            Err(err) => {
                log::error!("library unavailable: {err:#}");
                self.toast("circle-alert", "Library unavailable", err.to_string(), None, cx);
            }
        }
    }

    pub fn reload_library(&mut self, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else { return };
        self.scan_generation += 1;
        let generation = self.scan_generation;
        cx.spawn(async move |this, cx| {
            let records = cx.background_executor().spawn(async move { library.list_sessions() }).await;
            this.update(cx, |this, cx| {
                // Only the newest scan wins; an older one could bring back a row just trashed.
                if generation != this.scan_generation {
                    return;
                }
                match records {
                    Ok(records) => {
                        this.sessions = records.iter().map(to_session).collect();
                        this.records = records;
                        let n = this.filtered_sessions().len();
                        this.library_selected = this.library_selected.min(n.saturating_sub(1));
                        this.menu_dirty = true;
                        this.load_thumbnails(cx);
                        this.sync_system();
                        if let Some(id) = this.pending_saved_id.take() {
                            this.open_quick(crate::quick::QuickMode::Saved { session_id: id }, None, cx);
                        }
                        if let Some(id) = this.pending_upload_id.take() {
                            this.upload_in_background(id, cx);
                        }
                        if let Some(id) = this.pending_open_id.take()
                            && let Some(i) = this.records.iter().position(|r| r.session_id == id) {
                                this.open_record(i, cx);
                            }
                        if let Some(i) = this.pending_open.take() {
                            this.open_record(i, cx);
                        }
                    }
                    Err(err) => log::warn!("library scan failed: {err:#}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn watch_companion(&mut self, rx: Receiver<CompanionEvent>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let events: Vec<CompanionEvent> = rx.try_iter().collect();
                if rx.is_empty() && events.is_empty() {
                    if this.upgrade().is_none() {
                        break;
                    }
                    continue;
                }
                let alive = this.update(cx, |this, cx| {
                    for ev in events {
                        log::debug!("companion event: {ev:?} (window visible: {})", this.main_visible);
                        match ev {
                            CompanionEvent::Listening { .. } => this.companion_listening = true,
                            CompanionEvent::Error { message } => {
                                this.companion_listening = false;
                                log::warn!("companion: {message}");
                            }
                            CompanionEvent::SessionReady { session_id } => {
                                // A browser recording gets the same saved card as a native one:
                                // suggested title, Copy link, Review. The full window, when it's
                                // open, gets a toast instead.
                                if this.main_visible {
                                    this.toast("globe", "New browser recording", "The extension saved a recording to your Library.", None, cx);
                                } else {
                                    this.pending_saved_id = Some(session_id.clone());
                                }
                                this.request_suggestion(session_id.clone(), cx);
                                this.reload_library(cx);
                            }
                            CompanionEvent::OpenRequested { session_id } => {
                                this.show_main_window(cx);
                                this.viewer = None;
                                this.page = crate::model::Page::Library;
                                this.pending_open_id = session_id;
                                this.reload_library(cx);
                            }
                            CompanionEvent::ArtifactWritten { .. } => {}
                        }
                    }
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Opens a session from the library in the viewer. The list row shows instantly; the archive
    /// loads in the background and the viewer fills in when it lands.
    pub fn open_record(&mut self, index: usize, cx: &mut Context<Self>) {
        let (Some(library), Some(record)) = (self.library.clone(), self.records.get(index).cloned()) else { return };
        let session = to_session(&record);
        self.viewer = Some(Viewer {
            session,
            events: Vec::new(),
            position_ms: 0,
            playing: false,
            tab: InspectorTab::Actions,
            selected_event: None,
            scrubbing: false,
            last_tick: Instant::now(),
            rate: 1.0,
            loaded: None,
            player: None,
            notes: None,
            notes_sub: None,
            library_backed: true,
            remote_evidence_id: None,
            notes_status: None,
            notes_generation: 0,
        });
        cx.notify();
        let id = record.session_id.clone();
        cx.spawn(async move |this, cx| {
            let loaded = cx.background_executor().spawn(async move { library.load_session(&id) }).await;
            this.update(cx, |this, cx| {
                match loaded {
                    Ok(loaded) => {
                        if let Some(v) = this.viewer.as_mut().filter(|v| v.session.id.as_ref() == loaded.archive.session_id) {
                            v.events = events_of(&loaded);
                            if v.session.duration_ms == 0 {
                                v.session.duration_ms = v.events.iter().map(|e| e.offset_ms + e.duration_ms.unwrap_or(0)).max().unwrap_or(0);
                            }
                            let video = (loaded.video_path.clone(), loaded.video_mime);
                            v.loaded = Some(loaded);
                            this.load_player(video.0, video.1, cx);
                        }
                    }
                    Err(err) => this.toast("circle-alert", "Couldn't open the recording", format!("{err:#}"), None, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use gpui_kit::SharedString;
    use jl_core::archive::RecorderKind;
    use jl_core::library::{LoadedSession, SessionRecord};

    use super::{events_of, origin_of, to_session};
    use crate::model::{Lane, Origin, Sync};

    fn record(kind: RecorderKind, url: &str, title: &str) -> SessionRecord {
        SessionRecord {
            session_id: "jl_test0001".into(),
            session_folder: PathBuf::from("/tmp/x"),
            name: "Test".into(),
            page_url: url.into(),
            page_title: title.into(),
            recorder_kind: kind,
            recorded_at: "2026-10-29T10:00:00.000Z".into(),
            duration_ms: Some(1500.0),
            action_count: 3,
            request_count: 2,
            console_error_count: 1,
            video_path: PathBuf::from("/tmp/x/recording.mp4"),
            video_mime: "video/mp4",
            artifacts: vec![],
            total_bytes: 10,
            tags: vec!["p1".into()],
            notes: String::new(),
            remote: None,
        }
    }

    #[test]
    fn origins_follow_the_recorder() {
        assert_eq!(origin_of(&record(RecorderKind::BrowserExtension, "https://shop.example.com/cart?x=1", "Cart")), Origin::Browser { host: "shop.example.com".into() });
        assert_eq!(origin_of(&record(RecorderKind::Desktop, "screen://display/1", "Studio Display")), Origin::Screen { display: "Studio Display".into() });
        assert_eq!(origin_of(&record(RecorderKind::Desktop, "app://com.apple.Notes", "Notes")), Origin::App { name: "Notes".into() });
        assert_eq!(origin_of(&record(RecorderKind::E2eRunner, "https://uat.example.test", "x")), Origin::Runner);
    }

    #[test]
    fn sessions_carry_counts_and_sync_state() {
        let s = to_session(&record(RecorderKind::Desktop, "app://com.apple.Notes", "Notes"));
        assert_eq!((s.duration_ms, s.actions, s.requests, s.errors), (1500, 3, 2, 1));
        assert_eq!(s.sync, Sync::Local);
        assert_eq!(s.tags, vec![SharedString::from("p1")]);
    }

    #[test]
    fn timeline_lanes_map_onto_the_viewer() {
        let fixture = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../jl-core/tests/fixtures/extension-v5.json")).unwrap();
        let archive = jl_core::parse_archive(&fixture).unwrap();
        let loaded = LoadedSession {
            archive,
            folder: PathBuf::from("/tmp"),
            video_path: PathBuf::from("/tmp/recording.webm"),
            video_mime: "video/webm",
            notes: String::new(),
            source: jl_core::library::SessionSource::Local,
        };
        let events = events_of(&loaded);
        assert!(events.iter().any(|e| e.lane == Lane::Action));
        assert!(events.iter().any(|e| e.lane == Lane::Network && e.method.is_some()));
        assert!(events.iter().any(|e| e.lane == Lane::Console));
        assert!(events.windows(2).all(|w| w[0].offset_ms <= w[1].offset_ms), "timeline is sorted");
    }
}
