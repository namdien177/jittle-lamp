//! Screen, window and application recording with ScreenCaptureKit (`SCRecordingOutput`, macOS 15)
//! into `<output_dir>/<session_id>/recording.mp4`, plus the archive written on stop.

use std::path::PathBuf;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, FixedOffset, Local};
use crossbeam_channel::{Sender, bounded};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use parking_lot::Mutex;
use screencapturekit::cm::SCFrameStatus;
use screencapturekit::prelude::*;
use screencapturekit::recording_output::{
    RecordingCallbacks, SCRecordingOutput, SCRecordingOutputCodec, SCRecordingOutputConfiguration,
    SCRecordingOutputFileType,
};
use screencapturekit::stream::delegate_trait::StreamCallbacks;

use crate::archive::{
    self, ARCHIVE_FILE, ActionPayload, ArchiveInput, CaptureSource, Entry, EntryPayload,
    MARKER_TAG, SourceKind, VIDEO_FILE,
};
use crate::content::{display_name, is_system_bundle, rect};
use crate::input::{InputAction, InputCapture, InputOptions, InputScope};
use crate::logs::{ConsoleLevel, LogBudget, LogFilter, LogStream};
use crate::permissions::{self, PermissionStatus};
use crate::session_id::{is_valid_session_id, unused_session_id};
use crate::sys::{self, Rect};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppSelector {
    BundleId(String),
    Pid(i32),
}

impl std::fmt::Display for AppSelector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BundleId(bundle_id) => f.write_str(bundle_id),
            Self::Pid(pid) => write!(f, "pid {pid}"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureTarget {
    /// `None` records the main display.
    Display {
        display_id: Option<u32>,
    },
    Window {
        window_id: u32,
    },
    /// Every window of the app on one display. `None` picks the display showing most of the app.
    Application {
        app: AppSelector,
        display_id: Option<u32>,
    },
}

#[derive(Clone, Debug)]
pub struct RecordingOptions {
    pub output_dir: PathBuf,
    /// Generated (`jl_<base36 ms>`) when `None`.
    pub session_id: Option<String>,
    /// Defaults to the app, window or display name.
    pub name: Option<String>,
    pub target: CaptureTarget,
    pub fps: u32,
    /// Record at the display's pixel density (2× on Retina) rather than in points.
    pub retina: bool,
    pub show_cursor: bool,
    /// Draw a ring around clicks in the video (macOS 15).
    pub show_clicks: bool,
    pub system_audio: bool,
    pub microphone: bool,
    /// Clicks and shortcut keys; needs Accessibility (or Input Monitoring).
    pub capture_input: bool,
    /// App switches and window-title changes.
    pub capture_app_switches: bool,
    /// The target app's unified log (application and window targets only).
    pub capture_logs: bool,
    pub log_debug: bool,
    /// Keep a small live frame for `latest_preview_frame`.
    pub preview: bool,
    /// Leave Jittle Lamp's own windows (HUD, main window) out of display recordings.
    pub exclude_own_app: bool,
}

impl RecordingOptions {
    pub fn new(output_dir: impl Into<PathBuf>, target: CaptureTarget) -> Self {
        Self {
            output_dir: output_dir.into(),
            session_id: None,
            name: None,
            target,
            fps: 30,
            retina: true,
            show_cursor: true,
            show_clicks: false,
            system_audio: false,
            microphone: false,
            capture_input: true,
            capture_app_switches: true,
            capture_logs: true,
            log_debug: true,
            preview: true,
            exclude_own_app: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    Click,
    Key,
    Navigation,
}

#[derive(Clone, Debug)]
pub enum RecorderEvent {
    /// The first frame was written; offsets count from here.
    Started {
        session_id: String,
        video_path: PathBuf,
    },
    Action {
        offset_ms: u64,
        kind: ActionKind,
        label: String,
    },
    Marker {
        offset_ms: u64,
        label: String,
    },
    ConsoleError {
        offset_ms: u64,
        message: String,
    },
    /// Something optional did not work (no Accessibility, log stream failed, no preview).
    Warning(String),
    /// Capture stopped on its own (window closed, permission revoked, disk full). Call `stop` to
    /// finalize what was recorded.
    Failed(String),
    Finished(FinishedRecording),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LiveStats {
    pub clicks: u64,
    pub keys: u64,
    pub navigations: u64,
    pub logs: u64,
    pub errors: u64,
    pub markers: u64,
    pub dropped_logs: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FinishedRecording {
    pub session_id: String,
    pub folder: PathBuf,
    pub video_path: PathBuf,
    pub archive_path: PathBuf,
    pub duration_ms: u64,
    pub video_bytes: u64,
}

#[derive(Default)]
struct Counters {
    clicks: AtomicU64,
    keys: AtomicU64,
    navigations: AtomicU64,
    logs: AtomicU64,
    errors: AtomicU64,
    markers: AtomicU64,
    dropped_logs: AtomicU64,
}

struct SharedPixelBuffer(CFRetained<CVPixelBuffer>);
// CVPixelBuffers are immutable once delivered and CF retain/release is thread-safe.
unsafe impl Send for SharedPixelBuffer {}
unsafe impl Sync for SharedPixelBuffer {}

struct Shared {
    session_id: String,
    folder: PathBuf,
    video_path: PathBuf,
    archive_path: PathBuf,
    created_at: DateTime<FixedOffset>,
    anchor: OnceLock<(Instant, DateTime<FixedOffset>)>,
    entries: Mutex<Vec<Entry>>,
    order: AtomicU64,
    counters: Counters,
    events: Sender<RecorderEvent>,
    preview: Mutex<Option<SharedPixelBuffer>>,
    failure: Mutex<Option<String>>,
}

impl Shared {
    fn emit(&self, event: RecorderEvent) {
        let _ = self.events.try_send(event);
    }

    fn push(&self, at: DateTime<FixedOffset>, tags: Vec<String>, payload: EntryPayload) {
        let order = self.order.fetch_add(1, Ordering::Relaxed);
        self.entries.lock().push(Entry {
            at,
            order,
            tags,
            payload,
        });
    }

    fn offset_ms(&self, at: &DateTime<FixedOffset>) -> u64 {
        self.anchor.get().map_or(0, |(_, start)| {
            (*at - *start).num_milliseconds().max(0) as u64
        })
    }

    fn fail(&self, message: String) {
        let mut failure = self.failure.lock();
        if failure.is_none() {
            log::warn!("recording {} failed: {message}", self.session_id);
            *failure = Some(message.clone());
            drop(failure);
            self.emit(RecorderEvent::Failed(message));
        }
    }

    fn record_action(&self, action: InputAction) {
        let kind = match action.payload {
            ActionPayload::Click { .. } => ActionKind::Click,
            ActionPayload::Keyboard { .. } => ActionKind::Key,
            _ => ActionKind::Navigation,
        };
        let counter = match kind {
            ActionKind::Click => &self.counters.clicks,
            ActionKind::Key => &self.counters.keys,
            ActionKind::Navigation => &self.counters.navigations,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        let offset_ms = self.offset_ms(&action.at);
        self.push(action.at, vec![], EntryPayload::Action(action.payload));
        self.emit(RecorderEvent::Action {
            offset_ms,
            kind,
            label: action.label,
        });
    }
}

struct Running {
    stream: SCStream,
    recording: SCRecordingOutput,
    preview: Option<SCStream>,
    input: Option<InputCapture>,
    logs: Option<(LogStream, JoinHandle<LogBudget>)>,
    finished: crossbeam_channel::Receiver<()>,
    name: String,
    page_title: String,
    source: CaptureSource,
}

/// A recording in progress. `Send + Sync`; share it behind an `Arc` and call `stop` once.
pub struct Recorder {
    shared: Arc<Shared>,
    running: Mutex<Option<Running>>,
}

/// What `start` resolved the target to.
struct Resolved {
    filter: SCContentFilter,
    /// Captured area in global points.
    area: Rect,
    scale: f64,
    source: CaptureSource,
    scope: InputScope,
    page_title: String,
    log_target: Option<(i32, Option<PathBuf>)>,
}

impl Recorder {
    pub fn start(options: RecordingOptions, events: Sender<RecorderEvent>) -> Result<Recorder> {
        if !permissions::permissions().screen_recording.is_granted() {
            bail!(
                "Screen Recording is not allowed for this app; enable it in System Settings › Privacy & Security › Screen & System Audio Recording"
            );
        }
        std::fs::create_dir_all(&options.output_dir)
            .with_context(|| format!("creating {}", options.output_dir.display()))?;
        let session_id = match &options.session_id {
            Some(id) if !is_valid_session_id(id) => bail!("invalid session id {id:?}"),
            Some(id) => id.clone(),
            None => unused_session_id(&options.output_dir),
        };
        let folder = options.output_dir.join(&session_id);
        std::fs::create_dir(&folder)
            .with_context(|| format!("creating session folder {}", folder.display()))?;

        let (finished_tx, finished_rx) = bounded(1);
        let shared = Arc::new(Shared {
            video_path: folder.join(VIDEO_FILE),
            archive_path: folder.join(ARCHIVE_FILE),
            session_id,
            folder,
            created_at: Local::now().fixed_offset(),
            anchor: OnceLock::new(),
            entries: Mutex::new(Vec::new()),
            order: AtomicU64::new(0),
            counters: Counters::default(),
            events,
            preview: Mutex::new(None),
            failure: Mutex::new(None),
        });

        match Self::start_capture(&options, &shared, finished_tx, finished_rx) {
            Ok(running) => Ok(Recorder {
                shared,
                running: Mutex::new(Some(running)),
            }),
            Err(error) => {
                // Nothing was recorded; do not leave an empty session folder behind.
                if !shared.video_path.exists() {
                    let _ = std::fs::remove_dir_all(&shared.folder);
                }
                Err(error)
            }
        }
    }

    fn start_capture(
        options: &RecordingOptions,
        shared: &Arc<Shared>,
        finished_tx: Sender<()>,
        finished_rx: crossbeam_channel::Receiver<()>,
    ) -> Result<Running> {
        let resolved = resolve_target(options)?;
        let (width, height) = video_size(
            resolved.area.width,
            resolved.area.height,
            if options.retina { resolved.scale } else { 1.0 },
        );

        let mut config = SCStreamConfiguration::new()
            .with_width(width)
            .with_height(height)
            .with_fps(options.fps.clamp(1, 120))
            .with_pixel_format(PixelFormat::YCbCr_420v)
            .with_queue_depth(6)
            .with_shows_cursor(options.show_cursor)
            .with_captures_audio(options.system_audio)
            .with_excludes_current_process_audio(true);
        if matches!(options.target, CaptureTarget::Window { .. }) {
            config = config.with_scales_to_fit(true);
        }
        if options.show_clicks {
            config = config
                .with_shows_mouse_clicks(true)
                .context("showing clicks")?;
        }
        if options.microphone {
            match permissions::request_microphone() {
                PermissionStatus::Granted => {
                    config = config
                        .with_captures_microphone(true)
                        .context("capturing the microphone")?
                }
                status => shared.emit(RecorderEvent::Warning(format!(
                    "Microphone not recorded: permission is {status:?}"
                ))),
            }
        }

        let recording_config = SCRecordingOutputConfiguration::new()
            .map_err(|e| anyhow!("recording output configuration: {e}"))?
            .with_output_url(&shared.video_path)
            .map_err(|e| anyhow!("recording output path: {e}"))?
            .with_video_codec(SCRecordingOutputCodec::H264)
            .with_output_file_type(SCRecordingOutputFileType::MP4);

        let (started_tx, started_rx) = bounded::<Result<(), String>>(1);
        let callbacks = {
            let (on_start, on_fail, started_fail) =
                (shared.clone(), shared.clone(), started_tx.clone());
            let source_name = resolved.source.name.clone();
            RecordingCallbacks::new()
                .on_start(move || {
                    let now = Local::now().fixed_offset();
                    if on_start.anchor.set((Instant::now(), now)).is_ok() {
                        // The viewer anchors every offset on the first `recording` lifecycle entry.
                        on_start.push(
                            now,
                            vec![],
                            EntryPayload::Action(ActionPayload::Lifecycle {
                                phase: "recording",
                                detail: format!("Recording {source_name}."),
                            }),
                        );
                    }
                    let _ = started_tx.try_send(Ok(()));
                })
                .on_fail(move |error| {
                    let _ = started_fail.try_send(Err(error.clone()));
                    on_fail.fail(format!("Recording failed: {error}"));
                })
                .on_finish(move || {
                    let _ = finished_tx.try_send(());
                })
        };
        let recording = SCRecordingOutput::new_with_delegate(&recording_config, callbacks)
            .context("SCRecordingOutput needs macOS 15 or later")?;

        let stream_shared = shared.clone();
        let delegate = StreamCallbacks::new()
            .on_error(move |error| stream_shared.fail(format!("Capture stopped: {error}")));
        let stream = SCStream::new_with_delegate(&resolved.filter, &config, delegate)
            .map_err(|e| anyhow!("creating the capture stream: {e}"))?;
        stream
            .add_recording_output(&recording)
            .map_err(|e| anyhow!("adding the recording output: {e}"))?;
        stream
            .start_capture()
            .map_err(|e| anyhow!("starting capture: {e}"))?;

        match started_rx.recv_timeout(Duration::from_secs(8)) {
            Ok(Ok(())) => {}
            outcome => {
                let _ = stream.remove_recording_output(&recording);
                let _ = stream.stop_capture();
                return Err(match outcome {
                    Ok(Err(error)) => anyhow!("recording did not start: {error}"),
                    _ => anyhow!("recording did not start within 8 s"),
                });
            }
        }
        shared.emit(RecorderEvent::Started {
            session_id: shared.session_id.clone(),
            video_path: shared.video_path.clone(),
        });

        let preview = if options.preview {
            match start_preview(&resolved.filter, resolved.area, options.show_cursor, shared) {
                Ok(stream) => Some(stream),
                Err(error) => {
                    shared.emit(RecorderEvent::Warning(format!("No live preview: {error}")));
                    None
                }
            }
        } else {
            None
        };

        let input = start_input(options, &resolved, shared);
        let logs = match (&resolved.log_target, options.capture_logs) {
            (Some((pid, bundle_path)), true) => {
                start_logs(*pid, bundle_path.clone(), options.log_debug, shared)
            }
            _ => None,
        };

        let name = options
            .name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| resolved.page_title.clone());
        Ok(Running {
            stream,
            recording,
            preview,
            input,
            logs,
            finished: finished_rx,
            name,
            page_title: resolved.page_title,
            source: resolved.source,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.shared.session_id
    }

    pub fn folder(&self) -> &std::path::Path {
        &self.shared.folder
    }

    pub fn is_recording(&self) -> bool {
        self.running.lock().is_some()
    }

    /// Time since the first frame.
    pub fn elapsed(&self) -> Duration {
        self.shared
            .anchor
            .get()
            .map_or(Duration::ZERO, |(start, _)| start.elapsed())
    }

    pub fn stats(&self) -> LiveStats {
        let c = &self.shared.counters;
        LiveStats {
            clicks: c.clicks.load(Ordering::Relaxed),
            keys: c.keys.load(Ordering::Relaxed),
            navigations: c.navigations.load(Ordering::Relaxed),
            logs: c.logs.load(Ordering::Relaxed),
            errors: c.errors.load(Ordering::Relaxed),
            markers: c.markers.load(Ordering::Relaxed),
            dropped_logs: c.dropped_logs.load(Ordering::Relaxed),
        }
    }

    /// The newest preview frame (≤ 480 px wide, about 4 fps), bi-planar full-range YCbCr as
    /// GPUI's `surface()` expects.
    pub fn latest_preview_frame(&self) -> Option<CFRetained<CVPixelBuffer>> {
        self.shared
            .preview
            .lock()
            .as_ref()
            .map(|frame| frame.0.clone())
    }

    /// Adds a user marker at the current time and returns its offset in the video.
    pub fn add_marker(&self, label: &str) -> Result<u64> {
        if !self.is_recording() {
            bail!("not recording");
        }
        let count = self.shared.counters.markers.fetch_add(1, Ordering::Relaxed) + 1;
        let label = match label.trim() {
            "" => format!("Marker {count}"),
            label => label.to_owned(),
        };
        let at = Local::now().fixed_offset();
        let offset_ms = self.shared.offset_ms(&at);
        self.shared.push(
            at,
            vec![MARKER_TAG.into()],
            EntryPayload::Action(ActionPayload::Lifecycle {
                phase: "recording",
                detail: label.clone(),
            }),
        );
        self.shared.emit(RecorderEvent::Marker { offset_ms, label });
        Ok(offset_ms)
    }

    /// Stops capture, finalizes the MP4 and writes `session.archive.json`.
    pub fn stop(&self) -> Result<FinishedRecording> {
        let mut running = self
            .running
            .lock()
            .take()
            .context("recording already stopped")?;
        let shared = &self.shared;

        if let Some(mut input) = running.input.take() {
            input.stop();
        }
        if let Some(preview) = running.preview.take() {
            let _ = preview.stop_capture();
        }
        let stopped_at = Local::now().fixed_offset();
        // With no frame handlers attached, removing the only recording output stops the stream and
        // waits until the movie is finalized.
        if let Err(error) = running.stream.remove_recording_output(&running.recording) {
            log::warn!("removing recording output: {error}");
        }
        let _ = running.stream.stop_capture();
        let _ = running.finished.recv_timeout(Duration::from_secs(10));
        let recorded = running.recording.recorded_duration();

        if let Some((stream, consumer)) = running.logs.take() {
            stream.stop();
            if let Ok(budget) = consumer.join() {
                let dropped = budget.dropped_total() + stream.dropped();
                shared
                    .counters
                    .dropped_logs
                    .store(dropped, Ordering::Relaxed);
                if dropped > 0 {
                    shared.push(stopped_at, vec!["capture-notice".into()], EntryPayload::Console {
                        level: ConsoleLevel::Info,
                        message: format!(
                            "jittle-lamp kept the log readable by dropping {dropped} lines ({} debug, {} info, {} error)",
                            budget.dropped_debug, budget.dropped_info + stream.dropped(), budget.dropped_error
                        ),
                        args: vec![],
                    });
                }
            }
        }
        *shared.preview.lock() = None;

        let video_bytes = std::fs::metadata(&shared.video_path)
            .map(|m| m.len())
            .unwrap_or(0);
        if video_bytes == 0 {
            let reason = shared
                .failure
                .lock()
                .clone()
                .unwrap_or_else(|| "no frames were written".into());
            bail!("recording produced no video: {reason}");
        }
        // The file's own duration first; SCK's recordedDuration is rounded, wall time is the last resort.
        let duration_ms = crate::mp4::duration_ms(&shared.video_path)
            .or_else(|| {
                (recorded.timescale > 0 && recorded.value > 0)
                    .then(|| recorded.value as f64 * 1000.0 / recorded.timescale as f64)
            })
            .unwrap_or_else(|| {
                shared
                    .anchor
                    .get()
                    .map_or(0.0, |(start, _)| start.elapsed().as_millis() as f64)
            })
            .round() as u64;

        let detail = match shared.failure.lock().as_deref() {
            Some(reason) => format!("Recording ended early. {reason}"),
            None => "Recording stopped.".into(),
        };
        shared.push(
            stopped_at,
            vec![],
            EntryPayload::Action(ActionPayload::Lifecycle {
                phase: "ready",
                detail,
            }),
        );

        let input = ArchiveInput {
            session_id: shared.session_id.clone(),
            name: running.name.clone(),
            created_at: shared.created_at,
            updated_at: Local::now().fixed_offset(),
            page_title: running.page_title.clone(),
            source: running.source.clone(),
            recorder_version: env!("CARGO_PKG_VERSION").into(),
            os: sys::os_version(),
            video_bytes: Some(video_bytes),
            video_duration_ms: Some(duration_ms as f64),
            // Log lines stamped after the last frame would fall past the end of the video.
            entries: std::mem::take(&mut *shared.entries.lock())
                .into_iter()
                .filter(|e| e.at <= stopped_at)
                .collect(),
            notes: vec![],
        };
        archive::write_archive(&shared.archive_path, &archive::build_archive(&input))?;

        let finished = FinishedRecording {
            session_id: shared.session_id.clone(),
            folder: shared.folder.clone(),
            video_path: shared.video_path.clone(),
            archive_path: shared.archive_path.clone(),
            duration_ms,
            video_bytes,
        };
        shared.emit(RecorderEvent::Finished(finished.clone()));
        Ok(finished)
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        if self.running.get_mut().is_some()
            && let Err(error) = self.stop()
        {
            log::warn!("finalizing recording on drop: {error}");
        }
    }
}

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Recorder>();
    assert_send_sync::<LogStream>();
};

/// Output size in pixels: the area at `scale`, shrunk to H.264's 4096 × 2304 frame budget and
/// rounded to even numbers.
pub fn video_size(width_pt: f64, height_pt: f64, scale: f64) -> (u32, u32) {
    const MAX_SIDE: f64 = 4096.0;
    const MAX_PIXELS: f64 = 4096.0 * 2304.0;
    let (mut w, mut h) = ((width_pt * scale).max(2.0), (height_pt * scale).max(2.0));
    let shrink = (MAX_SIDE / w)
        .min(MAX_SIDE / h)
        .min((MAX_PIXELS / (w * h)).sqrt())
        .min(1.0);
    w *= shrink;
    h *= shrink;
    let even = |v: f64| ((v / 2.0).floor() as u32 * 2).max(2);
    (even(w), even(h))
}

fn resolve_target(options: &RecordingOptions) -> Result<Resolved> {
    let content = SCShareableContent::create()
        .with_exclude_desktop_windows(true)
        .with_on_screen_windows_only(false)
        .get()
        .map_err(|e| anyhow!("listing shareable content: {e}"))?;
    let displays = content.displays();
    let display_ids: Vec<u32> = displays.iter().map(SCDisplay::display_id).collect();
    let own_pid = std::process::id() as i32;
    let find_display = |id: u32| displays.iter().find(|d| d.display_id() == id);
    let main = || find_display(objc2_core_graphics::CGMainDisplayID()).or(displays.first());

    match &options.target {
        CaptureTarget::Display { display_id } => {
            let display = match display_id {
                Some(id) => {
                    find_display(*id).with_context(|| format!("display {id} is not connected"))?
                }
                None => main().context("no display")?,
            };
            let applications = content.applications();
            let own: Vec<&SCRunningApplication> = applications
                .iter()
                .filter(|a| options.exclude_own_app && a.process_id() == own_pid)
                .collect();
            let filter = SCContentFilter::create()
                .with_display(display)
                .with_excluding_applications(&own, &[])
                .build()
                .map_err(|e| anyhow!("display filter: {e}"))?;
            let id = display.display_id();
            let name = display_name(id, &display_ids);
            let area = rect(&display.frame());
            Ok(Resolved {
                scale: scale_of(&filter, id),
                filter,
                area,
                source: CaptureSource {
                    kind: SourceKind::Display,
                    name: name.clone(),
                    bundle_id: None,
                    pid: None,
                    display_id: Some(id),
                },
                scope: InputScope::Display { bounds: area },
                page_title: name,
                log_target: None,
            })
        }
        CaptureTarget::Window { window_id } => {
            let windows = content.windows();
            let window = windows
                .iter()
                .find(|w| w.window_id() == *window_id)
                .with_context(|| format!("window {window_id} is gone"))?;
            let app = window
                .owning_application()
                .context("window has no owning application")?;
            let (pid, app_name, bundle_id) = (
                app.process_id(),
                app.application_name(),
                app.bundle_identifier(),
            );
            let title = window.title().filter(|t| !t.trim().is_empty());
            sys::ensure_window_server_connection();
            let filter = SCContentFilter::create()
                .with_window(window)
                .build()
                .map_err(|e| anyhow!("window filter: {e}"))?;
            let area = rect(&window.frame());
            let page_title = title.clone().unwrap_or_else(|| app_name.clone());
            Ok(Resolved {
                scale: scale_of(
                    &filter,
                    display_at(&displays, &area).map_or(0, SCDisplay::display_id),
                ),
                filter,
                area,
                source: CaptureSource {
                    kind: SourceKind::Window,
                    name: title.map_or_else(|| app_name.clone(), |t| format!("{app_name} — {t}")),
                    bundle_id: Some(bundle_id).filter(|b| !b.is_empty()),
                    pid: Some(pid),
                    display_id: None,
                },
                scope: InputScope::Window {
                    id: *window_id,
                    pid,
                },
                page_title,
                log_target: Some((pid, sys::app_meta(pid).and_then(|m| m.bundle_path))),
            })
        }
        CaptureTarget::Application { app, display_id } => {
            let applications = content.applications();
            let target = applications
                .iter()
                .find(|a| match app {
                    AppSelector::BundleId(bundle_id) => a.bundle_identifier() == *bundle_id,
                    AppSelector::Pid(pid) => a.process_id() == *pid,
                })
                .with_context(|| format!("{app} is not running"))?;
            let (pid, app_name, bundle_id) = (
                target.process_id(),
                target.application_name(),
                target.bundle_identifier(),
            );
            if pid == own_pid || is_system_bundle(&bundle_id) {
                bail!("{app_name} cannot be recorded as an application");
            }
            let display = match display_id {
                Some(id) => {
                    find_display(*id).with_context(|| format!("display {id} is not connected"))?
                }
                None => {
                    // The display showing the largest on-screen window of the app.
                    let windows = content.windows();
                    let largest = windows
                        .iter()
                        .filter(|w| {
                            w.is_on_screen()
                                && w.window_layer() == 0
                                && w.owning_application()
                                    .is_some_and(|a| a.process_id() == pid)
                        })
                        .map(|w| rect(&w.frame()))
                        .max_by(|a, b| (a.width * a.height).total_cmp(&(b.width * b.height)));
                    largest
                        .and_then(|r| display_at(&displays, &r))
                        .or_else(main)
                        .context("no display")?
                }
            };
            let filter = SCContentFilter::create()
                .with_display(display)
                .with_including_applications(&[target], &[])
                .build()
                .map_err(|e| anyhow!("application filter: {e}"))?;
            let area = rect(&display.frame());
            Ok(Resolved {
                scale: scale_of(&filter, display.display_id()),
                filter,
                area,
                source: CaptureSource {
                    kind: SourceKind::Application,
                    name: app_name.clone(),
                    bundle_id: Some(bundle_id).filter(|b| !b.is_empty()),
                    pid: Some(pid),
                    display_id: Some(display.display_id()),
                },
                scope: InputScope::App {
                    pid,
                    display_bounds: area,
                },
                page_title: app_name,
                log_target: Some((pid, sys::app_meta(pid).and_then(|m| m.bundle_path))),
            })
        }
    }
}

fn scale_of(filter: &SCContentFilter, display_id: u32) -> f64 {
    let scale = filter.point_pixel_scale() as f64;
    if scale > 0.0 {
        scale
    } else {
        sys::display_scale(display_id)
    }
}

/// The display containing the center of `area`.
fn display_at<'a>(displays: &'a [SCDisplay], area: &Rect) -> Option<&'a SCDisplay> {
    let (cx, cy) = (area.x + area.width / 2.0, area.y + area.height / 2.0);
    displays.iter().find(|d| rect(&d.frame()).contains(cx, cy))
}

fn start_preview(
    filter: &SCContentFilter,
    area: Rect,
    show_cursor: bool,
    shared: &Arc<Shared>,
) -> Result<SCStream> {
    const PREVIEW_WIDTH: f64 = 480.0;
    let scale = (PREVIEW_WIDTH / area.width.max(1.0)).min(1.0);
    let (width, height) = video_size(area.width, area.height, scale);
    let config = SCStreamConfiguration::new()
        .with_width(width)
        .with_height(height)
        .with_fps(4)
        .with_queue_depth(3)
        .with_pixel_format(PixelFormat::YCbCr_420f)
        .with_shows_cursor(show_cursor);
    let mut stream = SCStream::new(filter, &config).map_err(|e| anyhow!("{e}"))?;
    let slot = shared.clone();
    stream
        .add_output_handler(
            move |sample: CMSampleBuffer, of_type: SCStreamOutputType| {
                if of_type != SCStreamOutputType::Screen
                    || sample.frame_status() != Some(SCFrameStatus::Complete)
                {
                    return;
                }
                let Some(buffer) = sample.pixel_buffer() else {
                    return;
                };
                let Some(ptr) = NonNull::new(buffer.as_ptr().cast::<CVPixelBuffer>()) else {
                    return;
                };
                // Take our own +1 so the frame outlives the screencapturekit wrapper.
                let retained = unsafe { CFRetained::retain(ptr) };
                *slot.preview.lock() = Some(SharedPixelBuffer(retained));
            },
            SCStreamOutputType::Screen,
        )
        .map_err(|e| anyhow!("{e}"))?;
    stream.start_capture().map_err(|e| anyhow!("{e}"))?;
    Ok(stream)
}

fn start_input(
    options: &RecordingOptions,
    resolved: &Resolved,
    shared: &Arc<Shared>,
) -> Option<InputCapture> {
    let mut events = options.capture_input;
    if events && !permissions::permissions().can_capture_input() {
        shared.emit(RecorderEvent::Warning(
            "Clicks and shortcuts are not recorded: allow Accessibility for Jittle Lamp".into(),
        ));
        events = false;
    }
    if !events && !options.capture_app_switches {
        return None;
    }
    let sink_shared = shared.clone();
    let input_options = InputOptions {
        scope: resolved.scope.clone(),
        events,
        focus: options.capture_app_switches,
        page_url: resolved.source.page_url(),
        page_title: resolved.page_title.clone(),
        scale: resolved.scale,
    };
    match InputCapture::start(
        input_options,
        Arc::new(move |action| sink_shared.record_action(action)),
    ) {
        Ok(capture) => Some(capture),
        Err(error) => {
            shared.emit(RecorderEvent::Warning(format!(
                "Clicks and shortcuts are not recorded: {error}"
            )));
            None
        }
    }
}

fn start_logs(
    pid: i32,
    bundle_path: Option<PathBuf>,
    debug: bool,
    shared: &Arc<Shared>,
) -> Option<(LogStream, JoinHandle<LogBudget>)> {
    let mut filter = LogFilter::app(pid, bundle_path);
    filter.include_debug = debug;
    let (stream, lines) = match LogStream::attach(filter) {
        Ok(attached) => attached,
        Err(error) => {
            shared.emit(RecorderEvent::Warning(format!(
                "App logs are not recorded: {error}"
            )));
            return None;
        }
    };
    let shared = shared.clone();
    let consumer = std::thread::Builder::new()
        .name("jl-capture-logs".into())
        .spawn(move || {
            let mut budget = LogBudget::default();
            for line in lines {
                if !budget.admit(line.level, Instant::now()) {
                    shared.counters.dropped_logs.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                shared.counters.logs.fetch_add(1, Ordering::Relaxed);
                if line.level == ConsoleLevel::Error {
                    shared.counters.errors.fetch_add(1, Ordering::Relaxed);
                    shared.emit(RecorderEvent::ConsoleError {
                        offset_ms: shared.offset_ms(&line.at),
                        message: line.message.clone(),
                    });
                }
                let args = line.console_args();
                shared.push(
                    line.at,
                    vec![],
                    EntryPayload::Console {
                        level: line.level,
                        message: line.message,
                        args,
                    },
                );
            }
            budget
        })
        .ok()?;
    Some((stream, consumer))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_size_fits_h264() {
        assert_eq!(video_size(1512.0, 982.0, 2.0), (3024, 1964));
        assert_eq!(video_size(1920.0, 1080.0, 1.0), (1920, 1080));
        // 5K Studio Display at 2×: shrunk to the 4096 × 2304 budget, aspect kept.
        let (w, h) = video_size(2560.0, 1440.0, 2.0);
        assert!(w <= 4096 && (w as u64 * h as u64) <= 4096 * 2304, "{w}×{h}");
        assert!(((w as f64 / h as f64) - 16.0 / 9.0).abs() < 0.01);
        // Portrait 1080 × 1920 display stays below 4096 on the long side.
        assert_eq!(video_size(1080.0, 1920.0, 1.0), (1080, 1920));
        assert_eq!(video_size(801.0, 601.0, 1.0), (800, 600));
    }
}
