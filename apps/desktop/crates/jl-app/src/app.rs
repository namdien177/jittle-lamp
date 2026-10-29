//! The main window: sidebar, page router, and the state the pages share.

use std::time::{Duration, Instant};

use gpui_kit::base::motion::spring;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::model::{self, CaptureKind, Event, Lane, Page, Session};
use crate::theme::{self, Palette, motion, text};
use crate::ui::{self, Size, Variant, ico, kbd};

actions!(
    jittle,
    [
        GoRecord, GoLibrary, GoCloud, GoRuns, GoLogs, GoSettings, ToggleRecording, AddMarker, SelectPrev,
        SelectNext, OpenSelected, Back, PlayPause, StepBack, StepForward, FocusSearch, TogglePalette, DeleteSelected, OpenFile, ExportZip, Quit
    ]
);

pub const KEY_CONTEXT: &str = "JittleApp";

pub fn bind_keys(cx: &mut App) {
    let list = Some("JittleApp && !Input");
    cx.bind_keys([
        KeyBinding::new("cmd-1", GoRecord, None),
        KeyBinding::new("cmd-2", GoLibrary, None),
        KeyBinding::new("cmd-3", GoCloud, None),
        KeyBinding::new("cmd-4", GoRuns, None),
        KeyBinding::new("cmd-5", GoLogs, None),
        KeyBinding::new("cmd-,", GoSettings, None),
        KeyBinding::new("alt-shift-r", ToggleRecording, None),
        KeyBinding::new("cmd-shift-m", AddMarker, None),
        KeyBinding::new("cmd-f", FocusSearch, None),
        KeyBinding::new("cmd-k", TogglePalette, None),
        KeyBinding::new("cmd-o", OpenFile, None),
        KeyBinding::new("cmd-e", ExportZip, None),
        KeyBinding::new("cmd-backspace", DeleteSelected, list),
        KeyBinding::new("up", SelectPrev, list),
        KeyBinding::new("down", SelectNext, list),
        KeyBinding::new("enter", OpenSelected, list),
        KeyBinding::new("escape", Back, list),
        KeyBinding::new("space", PlayPause, list),
        KeyBinding::new("left", StepBack, list),
        KeyBinding::new("right", StepForward, list),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
}

#[derive(Clone, Copy, PartialEq)]
pub enum InspectorTab {
    Actions,
    Network,
    Console,
    Notes,
}

#[derive(Clone, Copy, PartialEq)]
pub enum LibraryFilter {
    All,
    Browser,
    Apps,
    Screen,
    Errors,
}

pub struct Recording {
    pub started: Instant,
    pub source: SharedString,
    pub kind: CaptureKind,
    pub clicks: u32,
    pub keys: u32,
    pub logs: u32,
    pub errors: u32,
    pub markers: u32,
    pub recorder: Option<std::sync::Arc<jl_capture::Recorder>>,
    /// Which start this is, so a slow `Recorder::start` can't attach to a later recording.
    pub generation: u64,
    /// Markers added before the recorder finished starting.
    pub pending_markers: Vec<String>,
}

/// A pre-filled title and description for a just-saved recording.
#[derive(Clone)]
pub struct Suggestion {
    pub title: String,
    pub description: String,
    /// Written by the on-device model (vs. derived from the recording's own labels).
    pub on_device: bool,
}

pub struct Toast {
    pub id: u64,
    pub title: SharedString,
    pub body: SharedString,
    pub icon: &'static str,
    pub action: Option<SharedString>,
    /// The recording the action applies to (Undo restores this one).
    pub target: Option<String>,
    pub born: Instant,
    /// Set when dismissed: the toast fades out (faster than it came in), then goes.
    pub leaving: Option<Instant>,
}

pub struct Viewer {
    pub session: Session,
    pub events: Vec<Event>,
    pub position_ms: u64,
    pub playing: bool,
    pub tab: InspectorTab,
    pub selected_event: Option<usize>,
    pub scrubbing: bool,
    pub last_tick: Instant,
    pub rate: f32,
    pub loaded: Option<jl_core::library::LoadedSession>,
    pub player: Option<jl_media::Player>,
    pub notes: Option<Entity<gpui_kit::component::input::TextareaState>>,
    pub notes_sub: Option<Subscription>,
    /// Opened from the library (editable, deletable) rather than a cloud download or a ZIP.
    pub library_backed: bool,
    /// Set when the recording came from the cloud, so Share links it instead of re-uploading.
    pub remote_evidence_id: Option<String>,
    pub notes_status: Option<SharedString>,
    pub notes_generation: u64,
}

pub struct JlApp {
    pub page: Page,
    /// Set when the last page change came from the keyboard, so the sidebar indicator jumps
    /// instead of travelling.
    pub keyboard_nav: bool,
    pub focus: FocusHandle,
    pub sessions: Vec<Session>,
    pub demo_events: Vec<Event>,
    pub sources: Vec<model::CaptureSource>,
    pub logs: Vec<model::LogLine>,
    pub cloud: Vec<model::CloudEvidence>,
    pub runs: Vec<model::TestRun>,
    pub capture_kind: CaptureKind,
    pub selected_source: usize,
    pub opt_clicks: bool,
    pub opt_keys: bool,
    pub opt_logs: bool,
    pub opt_system_audio: bool,
    pub opt_mic: bool,
    pub recording: Option<Recording>,
    pub library_selected: usize,
    pub library_filter: LibraryFilter,
    pub search: Entity<InputState>,
    pub query: String,
    pub viewer: Option<Viewer>,
    pub toasts: Vec<Toast>,
    pub next_toast: u64,
    pub log_levels: [bool; 4],
    pub log_paused: bool,
    pub signed_in: bool,
    pub account: Option<crate::cloud::Account>,
    pub sign_in: Option<crate::cloud::SignIn>,
    pub cloud_api: Option<crate::cloud::Cloud>,
    pub demo: bool,
    pub trashed: Vec<crate::edit::Trashed>,
    pub quick: Option<WindowHandle<crate::quick::QuickPanel>>,
    /// The source the quick recorder offers first next time.
    pub last_source_id: Option<SharedString>,
    pub suggestions: std::collections::HashMap<String, Suggestion>,
    pub suggesting: std::collections::HashSet<String>,
    pub main_visible: bool,
    /// When the sign-in sheet and the log picker opened, for their short enter animations.
    pub sheet_opened: Instant,
    pub picker_opened: Instant,
    pub recording_generation: u64,
    pub sign_in_generation: u64,
    pub scan_generation: u64,
    pub sources_loading: bool,
    pub needs_screen_permission: bool,
    pub source_targets: std::collections::HashMap<SharedString, crate::capture::SourceTarget>,
    pub source_icons: std::collections::HashMap<SharedString, std::sync::Arc<RenderImage>>,
    pub capture_error: Option<SharedString>,
    pub capture_warning: Option<SharedString>,
    pub live_logs: Option<crate::capture::LiveLogs>,
    pub log_scroll: ScrollHandle,
    pub launch_at_login: jl_macos::LaunchAtLogin,
    pub log_picker: Option<Vec<jl_macos::AppInfo>>,
    /// A session to open once the next library scan lands (a recording that just stopped).
    pub pending_open_id: Option<String>,
    /// A just-saved recording to upload once indexed ("Upload new recordings").
    pub pending_upload_id: Option<String>,
    /// A just-saved recording whose card opens in the quick recorder once it's indexed.
    pub pending_saved_id: Option<String>,
    /// Poster frames for library rows, keyed by session id.
    pub thumbs: std::collections::HashMap<SharedString, std::sync::Arc<RenderImage>>,
    pub system: Option<crate::system::System>,
    /// The menu bar menu needs rebuilding (recent sessions or sign-in changed).
    pub menu_dirty: bool,
    /// A session to open once the first library scan lands (`--open`).
    pub pending_open: Option<usize>,
    pub library: Option<jl_core::library::Library>,
    pub records: Vec<jl_core::library::SessionRecord>,
    pub companion: Option<jl_core::companion::CompanionHandle>,
    pub auto_sync: bool,
    pub output_dir: SharedString,
    pub companion_listening: bool,
    pub hud: Option<WindowHandle<crate::hud::Hud>>,
    pub show_hud: bool,
    pub palette: Option<crate::palette::PaletteState>,
    _subscriptions: Vec<Subscription>,
}

impl JlApp {
    pub fn new(start: Page, demo_mode: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let demo = if demo_mode { model::demo() } else { model::Demo::empty() };
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search recordings"));
        let mut subs = vec![cx.subscribe_in(&search, window, |this: &mut Self, state, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                this.query = state.read(cx).value().to_string();
                this.library_selected = 0;
                cx.notify();
            }
        })];
        subs.push(cx.observe_window_activation(window, |this: &mut Self, window, cx| {
            // Coming back from System Settings: pick up a permission granted meanwhile.
            if window.is_window_active() && this.needs_screen_permission {
                this.refresh_sources(cx);
            }
        }));
        subs.push(cx.observe_window_appearance(window, |_, window, cx| {
            theme::follow_system(window, cx);
            cx.notify();
        }));
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Self {
            page: start,
            keyboard_nav: false,
            focus,
            sessions: demo.sessions,
            demo_events: demo.events,
            sources: demo.sources,
            logs: demo.logs,
            cloud: demo.cloud,
            runs: demo.runs,
            capture_kind: CaptureKind::App,
            selected_source: 0,
            opt_clicks: true,
            opt_keys: true,
            opt_logs: true,
            opt_system_audio: false,
            opt_mic: false,
            recording: None,
            library_selected: 0,
            library_filter: LibraryFilter::All,
            search,
            query: String::new(),
            viewer: None,
            toasts: Vec::new(),
            next_toast: 0,
            log_levels: [false, true, true, true],
            log_paused: false,
            signed_in: demo_mode,
            account: demo_mode.then(|| crate::cloud::Account { name: "Do Nam".into(), email: "donam@littlelives.com".into(), org: "LittleLives QA".into(), initials: "DN".into() }),
            sign_in: None,
            cloud_api: (!demo_mode).then(crate::cloud::Cloud::new),
            demo: demo_mode,
            trashed: Vec::new(),
            quick: None,
            last_source_id: None,
            suggestions: Default::default(),
            suggesting: Default::default(),
            main_visible: true,
            sheet_opened: Instant::now(),
            picker_opened: Instant::now(),
            recording_generation: 0,
            sign_in_generation: 0,
            scan_generation: 0,
            sources_loading: false,
            needs_screen_permission: false,
            source_targets: Default::default(),
            source_icons: Default::default(),
            capture_error: None,
            capture_warning: None,
            live_logs: None,
            log_scroll: ScrollHandle::new(),
            launch_at_login: jl_macos::launch_at_login(),
            log_picker: None,
            pending_open_id: None,
            pending_upload_id: None,
            pending_saved_id: None,
            thumbs: Default::default(),
            system: None,
            menu_dirty: true,
            pending_open: None,
            library: None,
            records: Vec::new(),
            companion: None,
            auto_sync: true,
            output_dir: "~/jittle-lamp-sessions".into(),
            companion_listening: demo_mode,
            hud: None,
            show_hud: true,
            palette: None,
            _subscriptions: subs,
        }
    }

    pub fn go(&mut self, page: Page, keyboard: bool, cx: &mut Context<Self>) {
        self.keyboard_nav = keyboard;
        if self.page != page || self.viewer.is_some() {
            self.page = page;
            self.viewer = None;
        }
        if page == Page::Record {
            self.refresh_sources(cx);
        }
        cx.notify();
    }

    pub fn toast(&mut self, icon: &'static str, title: impl Into<SharedString>, body: impl Into<SharedString>, action: Option<&str>, cx: &mut Context<Self>) {
        self.toast_with_target(icon, title, body, action, None, cx);
    }

    pub fn toast_with_target(&mut self, icon: &'static str, title: impl Into<SharedString>, body: impl Into<SharedString>, action: Option<&str>, target: Option<String>, cx: &mut Context<Self>) {
        let id = self.next_toast;
        self.next_toast += 1;
        self.toasts.push(Toast { id, title: title.into(), body: body.into(), icon, action: action.map(|a| a.to_string().into()), target, born: Instant::now(), leaving: None });
        if self.toasts.len() > 3 {
            self.toasts.remove(0);
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(5)).await;
            this.update(cx, |this, cx| this.dismiss_toast(id, cx)).ok();
        })
        .detach();
        cx.notify();
    }

    pub fn filtered_sessions(&self) -> Vec<usize> {
        let q = self.query.to_lowercase();
        self.sessions
            .iter()
            .enumerate()
            .filter(|(_, s)| match self.library_filter {
                LibraryFilter::All => true,
                LibraryFilter::Browser => matches!(s.origin, model::Origin::Browser { .. }),
                LibraryFilter::Apps => matches!(s.origin, model::Origin::App { .. }),
                LibraryFilter::Screen => matches!(s.origin, model::Origin::Screen { .. }),
                LibraryFilter::Errors => s.errors > 0,
            })
            .filter(|(_, s)| {
                q.is_empty()
                    || s.name.to_lowercase().contains(&q)
                    || s.origin.label().to_lowercase().contains(&q)
                    || s.tags.iter().any(|t| t.to_lowercase().contains(&q))
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn open_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if !self.demo {
            self.open_record(index, cx);
            return;
        }
        let Some(session) = self.sessions.get(index).cloned() else { return };
        self.viewer = Some(Viewer {
            session,
            events: self.demo_events.clone(),
            position_ms: 11_400,
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
            library_backed: false,
            remote_evidence_id: None,
            notes_status: None,
            notes_generation: 0,
        });
        cx.notify();
    }

    pub fn toggle_recording(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.recording.is_some() { self.stop_recording(cx) } else { self.start_recording_now(cx) }
        self.sync_system();
    }

    pub fn stop_from_hud(&mut self, cx: &mut Context<Self>) {
        self.stop_recording_now(cx);
        // Bring the review to the front: the HUD's job is done.
        cx.activate(true);
    }

    /// The HUD's first render reads this entity, so its window opens after the current update.
    pub fn open_hud(&mut self, cx: &mut Context<Self>) {
        let weak = cx.entity().downgrade();
        cx.defer(move |cx| {
            let hud = crate::hud::Hud::open(weak.clone(), cx);
            let leftover = weak
                .update(cx, |app, _| {
                    if app.recording.is_some() {
                        app.hud = hud;
                        None
                    } else {
                        hud
                    }
                })
                .ok()
                .flatten();
            // Stopped before the window opened.
            if let Some(hud) = leftover {
                hud.update(cx, |_, window, _| window.remove_window()).ok();
            }
        });
    }

    /// Deferred too: Stop is often clicked inside the HUD itself, whose window is busy dispatching.
    pub fn close_hud(&mut self, cx: &mut Context<Self>) {
        if let Some(hud) = self.hud.take() {
            cx.defer(move |cx| {
                hud.update(cx, |_, window, _| window.remove_window()).ok();
            });
        }
    }

    pub fn stop_recording_now(&mut self, cx: &mut Context<Self>) {
        self.stop_recording(cx);
        self.sync_system();
    }

    fn stop_recording(&mut self, cx: &mut Context<Self>) {
        self.close_hud(cx);
        self.capture_warning = None;
        if !self.demo {
            if let Some(rec) = self.recording.take() {
                self.stop_capture(rec, cx);
            }
            cx.notify();
            return;
        }
        if let Some(rec) = self.recording.take() {
            let secs = rec.started.elapsed().as_millis() as u64;
            let session = Session {
                id: format!("s-new-{}", self.next_toast).into(),
                name: format!("{} — {}", rec.source, chrono::Local::now().format("%-d %b %H:%M")).into(),
                origin: match rec.kind {
                    CaptureKind::Screen => model::Origin::Screen { display: rec.source.clone() },
                    _ => model::Origin::App { name: rec.source.clone() },
                },
                recorded_at: chrono::Local::now(),
                duration_ms: secs,
                actions: rec.clicks + rec.keys,
                requests: 0,
                logs: rec.logs,
                errors: rec.errors,
                bytes: secs * 180,
                tags: vec![],
                sync: model::Sync::Local,
            };
            self.sessions.insert(0, session);
            self.page = Page::Library;
            self.library_selected = 0;
            self.toast("circle-check", "Recording saved", format!("{} · {}", rec.source, ui::format_clock(secs)), Some("Review"), cx);
            self.open_session(0, cx);
        }
        cx.notify();
    }

    pub fn start_recording_now(&mut self, cx: &mut Context<Self>) {
        if !self.demo {
            self.start_capture(cx);
            return;
        }
        {
            let source = self.visible_sources().get(self.selected_source).map(|s| s.name.clone()).unwrap_or_else(|| "Screen".into());
            self.recording = Some(Recording { started: Instant::now(), source, kind: self.capture_kind, clicks: 0, keys: 0, logs: 0, errors: 0, markers: 0, recorder: None, generation: 0, pending_markers: Vec::new() });
            self.page = Page::Record;
            self.viewer = None;
            self.tick_recording(cx);
            if self.show_hud {
                self.open_hud(cx);
            }
        }
        cx.notify();
    }

    fn tick_recording(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            let mut n = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_millis(250)).await;
                n += 1;
                let alive = this
                    .update(cx, |this, cx| {
                        let Some(rec) = this.recording.as_mut() else { return false };
                        // Demo counters until jl-capture reports real ones.
                        if n.is_multiple_of(7) { rec.clicks += 1; }
                        if n.is_multiple_of(3) { rec.logs += 2; }
                        if n.is_multiple_of(41) { rec.errors += 1; }
                        cx.notify();
                        true
                    })
                    .unwrap_or(false);
                if !alive {
                    break;
                }
            }
        })
        .detach();
    }

    pub fn visible_sources(&self) -> Vec<&model::CaptureSource> {
        self.sources.iter().filter(|s| s.kind == self.capture_kind).collect()
    }

    fn render_sidebar(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        const ROW: f32 = 30.;
        const GAP: f32 = 2.;
        let active = Page::MAIN.iter().position(|pg| *pg == self.page);
        let target = active.unwrap_or(0) as f32 * (ROW + GAP);
        let y = spring("nav-indicator", target, motion::MOVE.with_travel(!self.keyboard_nav), window, cx);

        let mut rows = div().relative().flex().flex_col().gap(px(GAP));
        if active.is_some() {
            rows = rows.child(div().absolute().left_0().right_0().top(px(y)).h(px(ROW)).rounded(px(7.)).bg(p.selected));
        }
        for page in Page::MAIN {
            rows = rows.child(self.nav_row(page, active.map(|i| Page::MAIN[i]) == Some(page), p, cx));
        }

        let recording = self.recording.is_some();
        div()
            .w(px(232.))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .bg(p.sidebar)
            .child(
                // Title bar strip: traffic lights live here; the strip drags the window.
                div().h(px(52.)).flex_none().on_mouse_down(MouseButton::Left, |ev, window, _| {
                    if ev.click_count == 2 { window.titlebar_double_click() } else { window.start_window_move() }
                }),
            )
            .child(
                div().px(px(10.)).flex().flex_col().gap(px(14.)).child(self.record_cta(recording, p, cx)).child(rows),
            )
            .child(div().flex_1())
            .child(
                div()
                    .px(px(10.))
                    .pb(px(10.))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(self.companion_status(p))
                    .child(self.nav_row(Page::Settings, self.page == Page::Settings, p, cx).when(self.page == Page::Settings, |r| r.bg(p.selected)))
                    .child(self.account_chip(p, cx)),
            )
    }

    fn nav_row(&self, page: Page, active: bool, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let fg = if active { p.fg } else { p.fg_muted };
        let badge = match page {
            Page::Runs => self.runs.iter().filter(|r| r.status == model::RunStatus::Running).count(),
            _ => 0,
        };
        div()
            .id(SharedString::from(format!("nav-{}", page.title())))
            .h(px(30.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(9.))
            .rounded(px(7.))
            .text_size(px(text::BODY))
            .text_color(fg)
            .font_weight(if active { FontWeight::MEDIUM } else { FontWeight::NORMAL })
            .cursor_pointer()
            .when(!active, |s| s.hover(|s| s.bg(p.hover)))
            .active(|s| s.bg(p.pressed))
            .child(ico(page.icon(), 15., if active { p.primary } else { p.fg_muted }))
            .child(div().flex_1().child(page.title()))
            .when(badge > 0, |s| s.child(ui::badge(badge.to_string(), p.primary, p.primary_soft)))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.go(page, false, cx)))
    }

    fn record_cta(&self, recording: bool, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let label: SharedString = if let Some(rec) = &self.recording {
            ui::format_clock(rec.started.elapsed().as_millis() as u64).into()
        } else {
            "New recording".into()
        };
        div()
            .id("sidebar-record")
            .h(px(34.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(8.))
            .bg(if recording { p.record_soft } else { p.card })
            .border_1()
            .border_color(if recording { p.record.opacity(0.35) } else { p.border })
            .cursor_pointer()
            .hover(|s| s.bg(if recording { p.record_soft.opacity(1.4) } else { p.hover }))
            .active(|s| s.bg(p.pressed))
            .child(ui::dot(p.record, 9.).when(recording, |d| d.shadow(vec![BoxShadow { color: p.record.opacity(0.5), offset: point(px(0.), px(0.)), blur_radius: px(6.), spread_radius: px(1.), inset: false }])))
            .child(
                div()
                    .flex_1()
                    .text_size(px(text::BODY))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if recording { p.record } else { p.fg })
                    .font_features(ui::tnum())
                    .child(label),
            )
            .child(kbd(if recording { "Stop ⌥⇧R" } else { "⌥⇧R" }, p))
            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_recording(window, cx)))
    }

    fn companion_status(&self, p: &Palette) -> impl IntoElement {
        let (color, label) = if self.companion_listening { (p.primary, "Extension connected") } else { (p.warning, "Companion offline") };
        div()
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(7.))
            .text_size(px(text::CAPTION))
            .text_color(p.fg_subtle)
            .child(ui::dot(color, 6.))
            .child(label)
    }

    fn account_chip(&self, p: &Palette, cx: &mut Context<Self>) -> Stateful<Div> {
        let chip = div().id("account").h(px(40.)).px(px(8.)).flex().items_center().gap(px(9.)).rounded(px(8.)).cursor_pointer().hover(|s| s.bg(p.hover)).active(|s| s.bg(p.pressed));
        let Some(account) = self.account.as_ref().filter(|_| self.signed_in) else {
            return chip
                .child(div().size(px(24.)).rounded_full().bg(p.hover).flex().items_center().justify_center().child(ico("user-round", 13., p.fg_muted)))
                .child(div().flex_1().text_size(px(text::SMALL)).font_weight(FontWeight::MEDIUM).text_color(p.fg).child("Sign in"))
                .child(ico("log-in", 14., p.fg_subtle))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.start_sign_in(cx)));
        };
        chip.child(
            div()
                .size(px(24.))
                .flex_none()
                .rounded_full()
                .bg(p.primary_soft)
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(text::CAPTION))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(p.primary)
                .child(account.initials.clone()),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .child(div().text_size(px(text::SMALL)).text_color(p.fg).font_weight(FontWeight::MEDIUM).truncate().child(account.name.clone()))
                .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).truncate().child(account.org.clone())),
        )
        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.go(Page::Settings, false, cx)))
    }

    /// The content pane's top strip: page title on the left, page actions on the right. Empty space
    /// drags the window, as a real title bar would.
    pub fn toolbar(&self, title: impl IntoElement, actions: impl IntoElement, p: &Palette) -> impl IntoElement {
        div()
            .h(px(52.))
            .flex_none()
            .px(px(20.))
            .flex()
            .items_center()
            .gap(px(12.))
            .border_b_1()
            .border_color(p.border)
            .on_mouse_down(MouseButton::Left, |ev, window, _| {
                if ev.click_count == 2 { window.titlebar_double_click() } else { window.start_window_move() }
            })
            .child(title)
            .child(div().flex_1())
            .child(actions)
    }

    pub fn page_title(t: impl Into<SharedString>, p: &Palette) -> Div {
        div().text_size(px(text::EMPHASIS)).font_weight(FontWeight::SEMIBOLD).text_color(p.fg).child(t.into())
    }

    pub fn dismiss_toast(&mut self, id: u64, cx: &mut Context<Self>) {
        let Some(t) = self.toasts.iter_mut().find(|t| t.id == id && t.leaving.is_none()) else { return };
        t.leaving = Some(Instant::now());
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(crate::theme::ease::EXIT).await;
            this.update(cx, |this, cx| {
                this.toasts.retain(|t| t.id != id);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn render_toasts(&self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        use crate::theme::ease;
        let reduce = cx.reduce_motion();
        let mut stack = div().absolute().bottom(px(20.)).right(px(20.)).flex().flex_col().gap(px(8.)).w(px(340.));
        for t in &self.toasts {
            // Enters rising a few points with a strong ease-out; leaves faster, sinking back the way it came.
            let (enter, entering) = ease::progress(t.born, ease::ENTER);
            let (exit, exiting) = t.leaving.map(|l| ease::progress(l, ease::EXIT)).unwrap_or((0., false));
            if entering || exiting {
                window.request_animation_frame();
            }
            let opacity = enter * (1. - exit);
            let y = if reduce { 0. } else { 8. * (1. - enter) + 4. * exit };
            let id = t.id;
            stack = stack.child(
                div()
                    .relative()
                    .top(px(y))
                    .opacity(opacity)
                    .flex()
                    .items_start()
                    .gap(px(10.))
                    .p(px(12.))
                    .rounded(px(12.))
                    .bg(p.elevated)
                    .border_1()
                    .border_color(p.border_strong)
                    .shadow(ui::shadow_lg(p))
                    .child(ico(t.icon, 16., p.primary))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(div().text_size(px(text::BODY)).font_weight(FontWeight::SEMIBOLD).text_color(p.fg).child(t.title.clone()))
                            .child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).child(t.body.clone())),
                    )
                    .when_some(t.action.clone(), |s, a| {
                        let undo = (a.as_ref() == "Undo").then(|| t.target.clone()).flatten();
                        s.child(ui::button(("toast-action", id as usize), a, Variant::Secondary, Size::Small, p).on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.dismiss_toast(id, cx);
                            if let Some(session_id) = undo.as_deref() {
                                this.undo_trash(session_id, cx);
                            }
                        })))
                    }),
            );
        }
        stack
    }
}

impl Render for JlApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = theme::palette(cx);
        let content: AnyElement = if self.viewer.is_some() {
            self.render_viewer(&p, window, cx).into_any_element()
        } else {
            match self.page {
                Page::Record => self.render_record(&p, window, cx).into_any_element(),
                Page::Library => self.render_library(&p, window, cx).into_any_element(),
                Page::Cloud => self.render_cloud(&p, window, cx).into_any_element(),
                Page::Runs => self.render_runs(&p, window, cx).into_any_element(),
                Page::Logs => self.render_logs(&p, window, cx).into_any_element(),
                Page::Settings => self.render_settings(&p, window, cx).into_any_element(),
            }
        };
        if self.recording.is_some() || self.viewer.as_ref().is_some_and(|v| v.playing || v.player.as_ref().is_some_and(|p| p.is_playing() || p.is_seeking())) {
            // The timer and the playhead move every frame.
            window.request_animation_frame();
        }
        self.advance_playback();

        div()
            .id("root")
            .key_context(KEY_CONTEXT)
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .text_color(p.fg)
            .text_size(px(text::BODY))
            .on_action(cx.listener(|this, _: &GoRecord, _, cx| this.go(Page::Record, true, cx)))
            .on_action(cx.listener(|this, _: &GoLibrary, _, cx| this.go(Page::Library, true, cx)))
            .on_action(cx.listener(|this, _: &GoCloud, _, cx| this.go(Page::Cloud, true, cx)))
            .on_action(cx.listener(|this, _: &GoRuns, _, cx| this.go(Page::Runs, true, cx)))
            .on_action(cx.listener(|this, _: &GoLogs, _, cx| this.go(Page::Logs, true, cx)))
            .on_action(cx.listener(|this, _: &GoSettings, _, cx| this.go(Page::Settings, true, cx)))
            .on_action(cx.listener(|this, _: &ToggleRecording, window, cx| this.toggle_recording(window, cx)))
            .on_action(cx.listener(|this, _: &AddMarker, _, cx| this.add_marker(cx)))
            .on_action(cx.listener(|this, _: &SelectPrev, _, cx| this.move_selection(-1, cx)))
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| this.move_selection(1, cx)))
            .on_action(cx.listener(|this, _: &OpenSelected, _, cx| {
                if this.viewer.is_none() && this.page == Page::Library
                    && let Some(&i) = this.filtered_sessions().get(this.library_selected) {
                        this.open_session(i, cx);
                    }
            }))
            .on_action(cx.listener(|this, _: &Back, _, cx| {
                if this.viewer.take().is_some() {
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &PlayPause, _, cx| this.toggle_play(cx)))
            .on_action(cx.listener(|this, _: &StepBack, _, cx| this.nudge(-5_000, cx)))
            .on_action(cx.listener(|this, _: &StepForward, _, cx| this.nudge(5_000, cx)))
            .on_action(cx.listener(|this, _: &TogglePalette, window, cx| this.open_palette(window, cx)))
            .on_action(cx.listener(|this, _: &OpenFile, _, cx| this.open_file(cx)))
            .on_action(cx.listener(|this, _: &ExportZip, _, cx| this.export_zip(cx)))
            .on_action(cx.listener(|this, _: &DeleteSelected, _, cx| {
                let id = match this.viewer.as_ref() {
                    // Copies from the cloud or a ZIP aren't in the library; there's nothing to trash.
                    Some(v) if !v.library_backed => None,
                    Some(v) => Some(v.session.id.to_string()),
                    None if this.page == Page::Library => this.filtered_sessions().get(this.library_selected).map(|&i| this.sessions[i].id.to_string()),
                    None => None,
                };
                if let Some(id) = id.filter(|_| !this.demo) {
                    this.trash_session(id, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| {
                this.go(Page::Library, true, cx);
                this.search.update(cx, |s, cx| s.focus(window, cx));
            }))
            .child(self.render_sidebar(&p, window, cx))
            .child(
                div()
                    .flex_1()
                    .h_full()
                    .min_w_0()
                    .relative()
                    .flex()
                    .flex_col()
                    .bg(p.bg)
                    .border_l_1()
                    .border_color(p.border)
                    .child(content)
                    .child(self.render_toasts(&p, window, cx)),
            )
            .children(self.render_palette(&p, cx))
            .children(self.render_sign_in(&p, window, cx))
    }
}

impl JlApp {
    fn move_selection(&mut self, delta: i32, cx: &mut Context<Self>) {
        if let Some(v) = self.viewer.as_mut() {
            let lane = match v.tab {
                InspectorTab::Actions => Some(Lane::Action),
                InspectorTab::Network => Some(Lane::Network),
                InspectorTab::Console => Some(Lane::Console),
                InspectorTab::Notes => None,
            };
            let Some(lane) = lane else { return };
            let idx: Vec<usize> = v.events.iter().enumerate().filter(|(_, e)| e.lane == lane || (lane == Lane::Action && e.lane == Lane::Marker)).map(|(i, _)| i).collect();
            let cur = v.selected_event.and_then(|s| idx.iter().position(|&i| i == s));
            let next = match cur {
                Some(c) => (c as i32 + delta).clamp(0, idx.len() as i32 - 1) as usize,
                None => 0,
            };
            if let Some(&e) = idx.get(next) {
                v.selected_event = Some(e);
                let ms = v.events[e].offset_ms;
                self.seek_viewer(ms, jl_media::SeekMode::Exact);
            }
        } else if self.page == Page::Library {
            let n = self.filtered_sessions().len();
            if n > 0 {
                self.library_selected = (self.library_selected as i32 + delta).clamp(0, n as i32 - 1) as usize;
            }
        }
        cx.notify();
    }
}
