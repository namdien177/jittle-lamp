//! Real recording: capture sources from ScreenCaptureKit, the recorder's lifecycle, and live app
//! logs for the Logs page.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, unbounded};
use gpui_kit::*;
use jl_capture::{AppSelector, CaptureTarget, ContentOptions, LogFilter, LogStream, PermissionStatus, Recorder, RecorderEvent, RecordingOptions};

use crate::app::{JlApp, Recording};
use crate::model::{CaptureKind, CaptureSource, LogLine, Page, Severity};

/// What starting a capture needs to know about a source the picker shows.
#[derive(Clone)]
pub struct SourceTarget {
    pub target: CaptureTarget,
    /// Process whose unified log goes on the timeline (apps and windows).
    pub pid: Option<i32>,
    pub bundle_path: Option<PathBuf>,
}

pub struct LiveLogs {
    pub stream: LogStream,
    pub name: SharedString,
    pub pid: i32,
}

pub fn decode_icon(png: &[u8]) -> Option<Arc<RenderImage>> {
    let mut img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?.into_rgba8();
    for px in img.pixels_mut() {
        px.0.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new([image::Frame::new(img)])))
}

impl JlApp {
    /// Lists displays, windows and apps (with icons) in the background. Cheap enough to run every
    /// time the Record page opens, so the list is never stale.
    pub fn refresh_sources(&mut self, cx: &mut Context<Self>) {
        if self.demo || self.sources_loading {
            return;
        }
        // Listing sources is what triggers the system prompt, so wait until the user asks for it.
        if jl_capture::permissions().screen_recording != PermissionStatus::Granted {
            self.needs_screen_permission = true;
            cx.notify();
            return;
        }
        self.needs_screen_permission = false;
        self.sources_loading = true;
        cx.spawn(async move |this, cx| {
            let content = cx.background_executor().spawn(async move { jl_capture::shareable_content_with(ContentOptions { app_icons: true, icon_size: 128, offscreen_windows: false }) }).await;
            this.update(cx, |this, cx| {
                this.sources_loading = false;
                let content = match content {
                    Ok(c) => c,
                    Err(err) => {
                        log::warn!("shareable content: {err:#}");
                        this.capture_error = Some(format!("{err:#}").into());
                        cx.notify();
                        return;
                    }
                };
                this.capture_error = None;
                let mut sources = Vec::new();
                let mut targets = HashMap::new();
                for d in content.displays {
                    let id: SharedString = format!("display:{}", d.id).into();
                    sources.push(CaptureSource {
                        id: id.clone(),
                        kind: CaptureKind::Screen,
                        name: if d.is_main { format!("{} (main)", d.name).into() } else { d.name.clone().into() },
                        detail: format!("{:.0} × {:.0}", d.frame.width * d.scale, d.frame.height * d.scale).into(),
                    });
                    targets.insert(id, SourceTarget { target: CaptureTarget::Display { display_id: Some(d.id) }, pid: None, bundle_path: None });
                }
                let mut bundle_paths = HashMap::new();
                for a in content.apps {
                    let id: SharedString = format!("app:{}", a.pid).into();
                    if let Some(png) = a.icon_png.as_deref()
                        && let Some(icon) = decode_icon(png) {
                            this.source_icons.insert(id.clone(), icon.clone());
                            this.source_icons.insert(format!("pid:{}", a.pid).into(), icon);
                        }
                    bundle_paths.insert(a.pid, a.bundle_path.clone());
                    sources.push(CaptureSource {
                        id: id.clone(),
                        kind: CaptureKind::App,
                        name: a.name.clone().into(),
                        detail: crate::ui::plural(a.window_count as u32, "window", "windows").into(),
                    });
                    targets.insert(id, SourceTarget { target: CaptureTarget::Application { app: AppSelector::Pid(a.pid), display_id: None }, pid: Some(a.pid), bundle_path: a.bundle_path });
                }
                for w in content.windows.into_iter().filter(|w| w.on_screen) {
                    let id: SharedString = format!("window:{}", w.id).into();
                    let title = w.title.clone().filter(|t| !t.trim().is_empty()).unwrap_or_else(|| w.app_name.clone());
                    sources.push(CaptureSource { id: id.clone(), kind: CaptureKind::Window, name: title.into(), detail: w.app_name.clone().into() });
                    if let Some(icon) = this.source_icons.get(&SharedString::from(format!("pid:{}", w.pid))).cloned() {
                        this.source_icons.insert(id.clone(), icon);
                    }
                    targets.insert(id, SourceTarget { target: CaptureTarget::Window { window_id: w.id }, pid: Some(w.pid), bundle_path: bundle_paths.get(&w.pid).cloned().flatten() });
                }
                // Keep the selection on the same source across refreshes.
                let selected = this.visible_sources().get(this.selected_source).map(|s| s.id.clone());
                this.sources = sources;
                this.source_targets = targets;
                if let Some(id) = selected {
                    this.selected_source = this.visible_sources().iter().position(|s| s.id == id).unwrap_or(0);
                }
                this.menu_dirty = true;
                this.sync_system();
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Starts a real recording of the selected source. The pill and the HUD appear at once; the
    /// clock starts when the first frame is written.
    /// The Record page's "Allow" button: ask once, then send people to System Settings if macOS
    /// already has an answer, and re-check when the app comes back to the front.
    pub fn request_screen_permission(&mut self, cx: &mut Context<Self>) {
        if !jl_capture::permissions::request_screen_recording() {
            jl_capture::open_settings(jl_capture::SettingsPane::ScreenRecording).ok();
        }
        self.refresh_sources(cx);
    }

    pub fn start_capture(&mut self, cx: &mut Context<Self>) {
        let perms = jl_capture::permissions();
        if perms.screen_recording != PermissionStatus::Granted {
            jl_capture::permissions::request_screen_recording();
            self.toast("monitor", "Allow screen recording", "Turn on Jittle Lamp in System Settings → Privacy & Security → Screen Recording, then try again.", None, cx);
            jl_capture::open_settings(jl_capture::SettingsPane::ScreenRecording).ok();
            return;
        }
        let Some(source) = self.visible_sources().get(self.selected_source).map(|s| (*s).clone()) else {
            self.toast("circle-alert", "Pick something to record", "Choose a screen, window or app first.", None, cx);
            return;
        };
        let Some(target) = self.source_targets.get(&source.id).cloned() else { return };
        let Some(output_dir) = self.library.as_ref().map(|l| l.output_dir()) else { return };

        let mut options = RecordingOptions::new(output_dir, target.target.clone());
        options.name = Some(format!("{} — {}", source.name, chrono::Local::now().format("%-d %b %H:%M")));
        options.show_clicks = self.opt_clicks;
        options.capture_input = self.opt_clicks || self.opt_keys;
        options.capture_logs = self.opt_logs && target.pid.is_some();
        options.system_audio = self.opt_system_audio;
        options.microphone = self.opt_mic;
        options.preview = true;
        options.exclude_own_app = true;

        let (tx, rx) = unbounded();
        self.recording_generation += 1;
        let generation = self.recording_generation;
        self.recording = Some(Recording {
            started: Instant::now(),
            source: source.name.clone(),
            kind: source.kind,
            clicks: 0,
            keys: 0,
            logs: 0,
            errors: 0,
            markers: 0,
            recorder: None,
            generation,
            pending_markers: Vec::new(),
        });
        self.page = Page::Record;
        self.viewer = None;
        if self.show_hud {
            self.open_hud(cx);
        }
        cx.notify();

        let source_name = source.name.clone();
        cx.spawn(async move |this, cx| {
            let started = cx.background_executor().spawn(async move { Recorder::start(options, tx) }).await;
            this.update(cx, |this, cx| {
                let current = this.recording.as_ref().is_some_and(|r| r.generation == generation);
                match started {
                    Ok(recorder) => {
                        let recorder = Arc::new(recorder);
                        if !current {
                            // Stopped (or replaced) while starting: finish it properly, off the main thread.
                            this.finish_recorder(recorder, source_name, cx);
                            return;
                        }
                        let rec = this.recording.as_mut().expect("current recording");
                        for label in rec.pending_markers.drain(..) {
                            let r = recorder.clone();
                            cx.background_executor().spawn(async move { r.add_marker(&label).ok() }).detach();
                        }
                        rec.recorder = Some(recorder);
                        this.watch_recorder(rx, generation, cx);
                        cx.notify();
                    }
                    Err(err) => {
                        if current {
                            this.recording = None;
                            this.close_hud(cx);
                            this.sync_system();
                        }
                        this.toast("circle-alert", "Recording didn't start", format!("{err:#}"), None, cx);
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    fn watch_recorder(&mut self, rx: Receiver<RecorderEvent>, generation: u64, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(120)).await;
                let events: Vec<RecorderEvent> = rx.try_iter().collect();
                let keep = this
                    .update(cx, |this, cx| {
                        let Some(rec) = this.recording.as_mut().filter(|r| r.generation == generation) else { return false };
                        if let Some(recorder) = rec.recorder.as_ref() {
                            let stats = recorder.stats();
                            rec.clicks = stats.clicks as u32;
                            rec.keys = stats.keys as u32;
                            rec.logs = stats.logs as u32;
                            rec.errors = stats.errors as u32;
                            rec.markers = stats.markers as u32;
                        }
                        for ev in events {
                            match ev {
                                RecorderEvent::Started { .. } => rec.started = Instant::now(),
                                RecorderEvent::Warning(message) => {
                                    log::warn!("recorder: {message}");
                                    this.capture_warning = Some(message.into());
                                }
                                RecorderEvent::Failed(message) => {
                                    this.toast("circle-alert", "Recording stopped", message, None, cx);
                                    this.stop_recording_now(cx);
                                    return false;
                                }
                                _ => {}
                            }
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
    }

    /// Stops the recorder, indexes the session and opens it for review. If the recorder is still
    /// starting, the start handler sees the recording is gone and finishes it instead.
    pub fn stop_capture(&mut self, rec: Recording, cx: &mut Context<Self>) {
        if let Some(recorder) = rec.recorder.clone() {
            self.finish_recorder(recorder, rec.source.clone(), cx);
        }
    }

    /// Stopping finalises the MP4 and writes the archive, which can take a moment; it runs in the
    /// background, then the session is indexed and opened.
    fn finish_recorder(&mut self, recorder: Arc<Recorder>, source: SharedString, cx: &mut Context<Self>) {
        self.toast("clock", "Saving recording…", source.clone(), None, cx);
        let library = self.library.clone();
        cx.spawn(async move |this, cx| {
            let finished = cx
                .background_executor()
                .spawn(async move {
                    let finished = recorder.stop()?;
                    if let Some(library) = library {
                        let archive_bytes = std::fs::metadata(&finished.archive_path).map(|m| m.len()).unwrap_or(0);
                        library.record_artifact_write(&finished.session_id, "recording.mp4", &finished.video_path, finished.video_bytes)?;
                        library.record_artifact_write(&finished.session_id, "session.archive.json", &finished.archive_path, archive_bytes)?;
                    }
                    anyhow::Ok(finished)
                })
                .await;
            this.update(cx, |this, cx| {
                this.toasts.retain(|t| t.title.as_ref() != "Saving recording…");
                match finished {
                    Ok(f) => {
                        if this.auto_sync && this.signed_in {
                            this.pending_upload_id = Some(f.session_id.clone());
                        }
                        // The saved card in the quick recorder is the next step, not the full window.
                        this.pending_saved_id = Some(f.session_id.clone());
                        this.request_suggestion(f.session_id.clone(), cx);
                        this.page = Page::Library;
                        this.reload_library(cx);
                    }
                    Err(err) => this.toast("circle-alert", "Couldn't save the recording", format!("{err:#}"), None, cx),
                }
                this.sync_system();
            })
            .ok();
        })
        .detach();
    }

    /// Tails one app's unified log into the Logs page, replacing any stream already running.
    pub fn attach_logs(&mut self, pid: i32, name: SharedString, bundle_path: Option<PathBuf>, cx: &mut Context<Self>) {
        if let Some(old) = self.live_logs.take() {
            old.stream.stop();
        }
        self.logs.clear();
        let filter = LogFilter { include_debug: self.log_levels[0], ..LogFilter::app(pid, bundle_path) };
        let (stream, rx) = match LogStream::attach(filter) {
            Ok(pair) => pair,
            Err(err) => {
                self.toast("circle-alert", "Couldn't read that app's log", format!("{err:#}"), None, cx);
                return;
            }
        };
        self.live_logs = Some(LiveLogs { stream, name: name.clone(), pid });
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let lines: Vec<jl_capture::LogLine> = rx.try_iter().take(2_000).collect();
                let keep = this
                    .update(cx, |this, cx| {
                        if this.live_logs.as_ref().map(|l| l.pid) != Some(pid) {
                            return false;
                        }
                        if lines.is_empty() || this.log_paused {
                            return true;
                        }
                        for l in lines {
                            this.logs.push(LogLine {
                                at: l.at.with_timezone(&chrono::Local),
                                level: match l.level {
                                    jl_capture::ConsoleLevel::Debug => Severity::Debug,
                                    jl_capture::ConsoleLevel::Info => Severity::Info,
                                    jl_capture::ConsoleLevel::Warn => Severity::Warn,
                                    jl_capture::ConsoleLevel::Error => Severity::Error,
                                },
                                subsystem: l.subsystem.clone().unwrap_or_else(|| l.process.clone()).into(),
                                message: l.message.clone().into(),
                            });
                        }
                        // A live console, not an archive: keep the latest few thousand lines.
                        const KEEP: usize = 5_000;
                        if this.logs.len() > KEEP {
                            let drop = this.logs.len() - KEEP;
                            this.logs.drain(..drop);
                        }
                        // Follow the tail like a terminal, unless the user scrolled up to read.
                        let offset = this.log_scroll.offset().y;
                        let max = this.log_scroll.max_offset().y;
                        if -offset >= max - px(24.) {
                            this.log_scroll.scroll_to_bottom();
                        }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        })
        .detach();
        cx.notify();
    }
}
