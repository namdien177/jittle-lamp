//! The quick recorder: a small panel under the menu bar icon (or ⌥⇧R from anywhere) that is the
//! app's everyday surface. Pick a source, press ⏎, and you're recording; stop, and the same panel
//! offers a suggested title, a description and "Copy link" — the full window is only for review.
//!
//! Opened many times a day, so it appears and disappears instantly (no animation) and is fully
//! keyboard driven: type to filter, ↑↓ to choose, ⏎ to record, ⎋ to close.

use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::CaptureKind;
use crate::theme::{self, Palette, text};
use crate::ui::{self, Size, Variant, ico, kbd};

pub const WIDTH: f32 = 384.;
/// Room for the panel's shadow inside the transparent window.
const MARGIN: f32 = 14.;

#[derive(Clone, PartialEq)]
pub enum QuickMode {
    Pick,
    Saved { session_id: String },
}

pub struct QuickPanel {
    app: WeakEntity<JlApp>,
    mode: QuickMode,
    query: Entity<InputState>,
    title: Option<Entity<InputState>>,
    notes: Option<Entity<TextareaState>>,
    /// The user typed into a field, so a late suggestion must not overwrite it.
    title_edited: bool,
    notes_edited: bool,
    filled_from_suggestion: bool,
    selected: usize,
    closing: bool,
    was_active: bool,
    _subs: Vec<Subscription>,
}

/// Where the panel opens: under the menu bar icon, or top-right under the menu bar (where the icon
/// lives) when the icon's frame isn't known yet — at launch it is still being placed.
pub fn panel_origin(anchor: Option<(i32, i32, i32, i32)>, height: f32, cx: &App) -> Point<Pixels> {
    let screen = cx.primary_display().map(|d| d.bounds()).unwrap_or_else(|| Bounds::new(point(px(0.), px(0.)), size(px(1440.), px(900.))));
    let w = WIDTH + MARGIN * 2.;
    let menu_bar = px(30.);
    // A real menu bar icon sits in the top strip of a screen and has a sensible size.
    let anchor = anchor.filter(|&(_, ay, aw, ah)| ay >= 0 && (ay as f32) < 60. && aw > 0 && (1..80).contains(&ah));
    let (x, y) = match anchor {
        Some((ax, ay, aw, ah)) => (px(ax as f32 + aw as f32 / 2. - w / 2.), px((ay + ah) as f32 + 2.) - px(MARGIN)),
        None => (screen.origin.x + screen.size.width - px(w) - px(8.), screen.origin.y + menu_bar),
    };
    let max_x = screen.origin.x + screen.size.width - px(w) - px(4.);
    let max_y = screen.origin.y + screen.size.height - px(height);
    point(x.clamp(screen.origin.x + px(4.), max_x), y.clamp(screen.origin.y, max_y))
}

impl QuickPanel {
    pub fn height(mode: &QuickMode) -> f32 {
        match mode {
            QuickMode::Pick => 520.,
            QuickMode::Saved { .. } => 560.,
        }
    }

    pub fn open(app: WeakEntity<JlApp>, mode: QuickMode, anchor: Option<(i32, i32, i32, i32)>, cx: &mut App) -> Option<WindowHandle<QuickPanel>> {
        let h = Self::height(&mode) + MARGIN * 2.;
        let origin = panel_origin(anchor, h, cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds { origin, size: size(px(WIDTH + MARGIN * 2.), px(h)) })),
            titlebar: None,
            kind: WindowKind::PopUp,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            focus: true,
            show: true,
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        };
        let handle = match cx.open_window(options, move |window, cx| cx.new(|cx| QuickPanel::new(app, mode, window, cx))) {
            Ok(h) => h,
            Err(err) => {
                log::warn!("quick recorder did not open: {err:#}");
                return None;
            }
        };
        log::debug!("quick recorder opened at {origin:?}");
        cx.activate(true);
        Some(handle)
    }

    fn new(app: WeakEntity<JlApp>, mode: QuickMode, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search screens, windows and apps"));
        let mut subs = vec![cx.subscribe_in(&query, window, |this: &mut Self, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::Change => {
                this.selected = 0;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.start(window, cx),
            _ => {}
        })];
        // Clicking anywhere else closes it, like any menu bar popover. Edits are kept.
        // Only a blur after the panel has had focus counts: the first activation report can arrive
        // before macOS has finished bringing the panel forward.
        subs.push(cx.observe_window_activation(window, |this: &mut Self, window, cx| {
            if window.is_window_active() {
                this.was_active = true;
            } else if this.was_active && !this.closing {
                this.close(true, window, cx);
            }
        }));
        if let Some(app) = app.upgrade() {
            subs.push(cx.observe(&app, |_, _, cx| cx.notify()));
        }
        let mut this = QuickPanel { app, mode, query, title: None, notes: None, title_edited: false, notes_edited: false, filled_from_suggestion: false, selected: 0, closing: false, was_active: false, _subs: subs };
        this.prepare_mode(window, cx);
        this
    }

    fn prepare_mode(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.mode.clone() {
            QuickMode::Pick => {
                self.query.update(cx, |s, cx| s.focus(window, cx));
            }
            QuickMode::Saved { session_id } => {
                let (name, notes) = self
                    .app
                    .upgrade()
                    .and_then(|app| app.read(cx).records.iter().find(|r| r.session_id == session_id).map(|r| (r.name.clone(), r.notes.clone())))
                    .unwrap_or_default();
                let title = cx.new(|cx| InputState::new(window, cx).placeholder("Title").default_value(name));
                let notes = cx.new(|cx| TextareaState::new(window, cx).rows(4).placeholder("What happened, and what should have happened").default_value(notes));
                self._subs.push(cx.subscribe_in(&title, window, |this: &mut Self, _, ev: &InputEvent, window, cx| match ev {
                    InputEvent::Change => this.title_edited = true,
                    InputEvent::PressEnter { secondary, .. } => {
                        if *secondary {
                            this.copy_link(window, cx)
                        } else {
                            this.close(true, window, cx)
                        }
                    }
                    _ => {}
                }));
                self._subs.push(cx.subscribe_in(&notes, window, |this: &mut Self, _, ev: &InputEvent, _, _| {
                    if let InputEvent::Change = ev {
                        this.notes_edited = true;
                    }
                }));
                title.update(cx, |s, cx| s.focus(window, cx));
                self.title = Some(title);
                self.notes = Some(notes);
                // The edit flags only count the user's typing, not the initial value.
                self.title_edited = false;
                self.notes_edited = false;
            }
        }
    }

    /// Fills the fields from an on-device suggestion when it lands, unless the user got there first.
    fn apply_suggestion(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.filled_from_suggestion {
            return;
        }
        let QuickMode::Saved { session_id } = &self.mode else { return };
        let Some(s) = self.app.upgrade().and_then(|app| app.read(cx).suggestions.get(session_id).cloned()) else { return };
        self.filled_from_suggestion = true;
        if !self.title_edited
            && let Some(t) = self.title.as_ref() {
                t.update(cx, |st, cx| st.set_value(s.title.clone(), window, cx));
            }
        if !self.notes_edited
            && let Some(n) = self.notes.as_ref() {
                n.update(cx, |st, cx| st.set_value(s.description.clone(), window, cx));
            }
        // set_value fires Change; those weren't the user.
        self.title_edited = false;
        self.notes_edited = false;
    }

    fn sources(&self, cx: &App) -> Vec<crate::model::CaptureSource> {
        let Some(app) = self.app.upgrade() else { return Vec::new() };
        let app = app.read(cx);
        let q = self.query.read(cx).value().to_lowercase();
        let mut list: Vec<_> = app
            .sources
            .iter()
            .filter(|s| if q.is_empty() { s.kind == app.capture_kind } else { s.name.to_lowercase().contains(&q) || s.detail.to_lowercase().contains(&q) })
            .cloned()
            .collect();
        // The source used last comes first: most recordings repeat the previous one.
        if let Some(last) = app.last_source_id.as_ref()
            && let Some(i) = list.iter().position(|s| &s.id == last) {
                let s = list.remove(i);
                list.insert(0, s);
            }
        list
    }

    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.mode != QuickMode::Pick {
            return;
        }
        let sources = self.sources(cx);
        let Some(source) = sources.get(self.selected.min(sources.len().saturating_sub(1))).cloned() else { return };
        self.app
            .update(cx, |app, cx| {
                app.capture_kind = source.kind;
                app.selected_source = app.visible_sources().iter().position(|s| s.id == source.id).unwrap_or(0);
                app.last_source_id = Some(source.id.clone());
                app.start_recording_now(cx);
                app.sync_system();
            })
            .ok();
        self.close(false, window, cx);
    }

    pub fn start_from_shortcut(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start(window, cx);
    }

    fn close(&mut self, save: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing {
            return;
        }
        log::debug!("quick recorder closing (save: {save})");
        self.closing = true;
        if save {
            self.save(cx);
        }
        self.app.update(cx, |app, _| app.quick = None).ok();
        window.remove_window();
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        let QuickMode::Saved { session_id } = self.mode.clone() else { return };
        let title = self.title.as_ref().map(|t| t.read(cx).value().to_string()).unwrap_or_default();
        let notes = self.notes.as_ref().map(|n| n.read(cx).value().to_string()).unwrap_or_default();
        self.app.update(cx, |app, cx| app.save_quick_edits(session_id, title, notes, cx)).ok();
    }

    fn copy_link(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let QuickMode::Saved { session_id } = self.mode.clone() else { return };
        self.save(cx);
        self.app.update(cx, |app, cx| app.share_session(session_id, cx)).ok();
        self.close(false, window, cx);
    }

    fn review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let QuickMode::Saved { session_id } = self.mode.clone() else { return };
        self.save(cx);
        self.app
            .update(cx, |app, cx| {
                app.show_main_window(cx);
                app.pending_open_id = Some(session_id);
                app.reload_library(cx);
            })
            .ok();
        self.close(false, window, cx);
    }
}

impl Render for QuickPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = theme::palette(cx);
        self.apply_suggestion(window, cx);
        let recording = self.app.upgrade().is_some_and(|a| a.read(cx).recording.is_some());
        let body: AnyElement = match (&self.mode, recording) {
            (QuickMode::Pick, true) => self.render_recording(&p, cx).into_any_element(),
            (QuickMode::Pick, false) => self.render_pick(&p, window, cx).into_any_element(),
            (QuickMode::Saved { .. }, _) => self.render_saved(&p, cx).into_any_element(),
        };
        div()
            .size_full()
            .p(px(MARGIN))
            .text_color(p.fg)
            .text_size(px(text::BODY))
            .child(
                div()
                    .id("quick")
                    .size_full()
                    .flex()
                    .flex_col()
                    .rounded(px(14.))
                    .overflow_hidden()
                    .bg(p.elevated)
                    .border_1()
                    .border_color(p.border_strong)
                    .shadow(ui::shadow_lg(&p))
                    .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                        let k = &ev.keystroke;
                        let cmd = k.modifiers.platform;
                        match (k.key.as_str(), cmd) {
                            ("escape", _) => this.close(true, window, cx),
                            ("down", false) if this.mode == QuickMode::Pick => {
                                let n = this.sources(cx).len();
                                this.selected = (this.selected + 1).min(n.saturating_sub(1));
                            }
                            ("up", false) if this.mode == QuickMode::Pick => this.selected = this.selected.saturating_sub(1),
                            ("enter", true) if this.mode != QuickMode::Pick => this.copy_link(window, cx),
                            ("1" | "2" | "3", true) if this.mode == QuickMode::Pick => {
                                let kind = match k.key.as_str() {
                                    "1" => CaptureKind::Screen,
                                    "2" => CaptureKind::Window,
                                    _ => CaptureKind::App,
                                };
                                this.app.update(cx, |app, _| app.capture_kind = kind).ok();
                                this.selected = 0;
                            }
                            _ => return,
                        }
                        cx.stop_propagation();
                        cx.notify();
                    }))
                    .child(body),
            )
    }
}

impl QuickPanel {
    fn render_pick(&mut self, p: &Palette, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(app_entity) = self.app.upgrade() else { return div() };
        let (kind, needs_permission, icons, last, opts, count) = {
            let a = app_entity.read(cx);
            (
                a.capture_kind,
                a.needs_screen_permission,
                a.source_icons.clone(),
                a.last_source_id.clone(),
                [a.opt_logs, a.opt_clicks, a.opt_system_audio, a.opt_mic],
                a.sessions.len(),
            )
        };
        let searching = !self.query.read(cx).value().is_empty();
        let sources = self.sources(cx);
        let selected = self.selected.min(sources.len().saturating_sub(1));

        let mut tabs = div().flex().gap(px(2.)).p(px(2.)).rounded(px(8.)).bg(p.hover);
        for (i, (k, label, icon)) in [(CaptureKind::Screen, "Screen", "monitor"), (CaptureKind::Window, "Window", "app-window"), (CaptureKind::App, "App", "app-window-mac")].into_iter().enumerate() {
            let on = k == kind && !searching;
            tabs = tabs.child(
                div()
                    .id(("qk", i))
                    .h(px(26.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded(px(6.))
                    .text_size(px(text::SMALL))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .when(on, |d| d.bg(if p.dark { p.border_strong } else { p.card }).text_color(p.fg))
                    .when(!on, |d| d.text_color(p.fg_muted).hover(|d| d.text_color(p.fg)))
                    .child(ico(icon, 13., if on { p.fg } else { p.fg_muted }))
                    .child(label)
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        this.app.update(cx, |app, _| app.capture_kind = k).ok();
                        this.query.update(cx, |s, cx| s.set_value("", window, cx));
                        this.selected = 0;
                        cx.notify();
                    })),
            );
        }

        let list: AnyElement = if needs_permission {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(10.))
                .px(px(28.))
                .text_center()
                .child(ico("monitor", 22., p.info))
                .child(div().text_size(px(text::EMPHASIS)).font_weight(FontWeight::SEMIBOLD).child("Allow screen recording"))
                .child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).child("macOS asks once. Nothing is captured until you press Record."))
                .child(ui::button("q-allow", "Allow…", Variant::Primary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.app.update(cx, |app, cx| app.request_screen_permission(cx)).ok();
                })))
                .into_any_element()
        } else if sources.is_empty() {
            div().flex_1().flex().items_center().justify_center().text_size(px(text::SMALL)).text_color(p.fg_muted).child(if searching { "Nothing matches" } else { "Looking for screens and apps…" }).into_any_element()
        } else {
            let mut rows = div().flex().flex_col().px(px(6.)).py(px(4.));
            for (i, s) in sources.iter().enumerate() {
                let on = i == selected;
                let icon = icons.get(&s.id).cloned();
                let is_last = last.as_ref() == Some(&s.id);
                let glyph = match s.kind {
                    CaptureKind::Screen => "monitor",
                    CaptureKind::Window => "app-window",
                    CaptureKind::App => "app-window-mac",
                };
                rows = rows.child(
                    div()
                        .id(("qs", i))
                        .h(px(40.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(8.))
                        .cursor_pointer()
                        .when(on, |d| d.bg(p.selected))
                        .active(|d| d.bg(p.pressed))
                        .map(|d| match icon {
                            Some(img_) => d.child(img(img_).size(px(24.)).flex_none()),
                            None => d.child(div().size(px(24.)).flex_none().flex().items_center().justify_center().child(ico(glyph, 16., p.fg_muted))),
                        })
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).truncate().child(s.name.clone()))
                                .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).truncate().child(s.detail.clone())),
                        )
                        .when(is_last, |d| d.child(ui::badge("Last used", p.fg_muted, p.hover)))
                        .when(on, |d| d.child(kbd("⏎", p)))
                        .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
                            if this.selected != i {
                                this.selected = i;
                                cx.notify();
                            }
                        }))
                        .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                            this.selected = i;
                            this.start(window, cx);
                        })),
                );
            }
            div().id("q-list").flex_1().min_h_0().overflow_y_scroll().child(rows).into_any_element()
        };

        let mut toggles = div().flex().gap(px(6.));
        let names: [(&str, &str); 4] = [("scroll-text", "Logs"), ("mouse-pointer-click", "Clicks"), ("volume-2", "Audio"), ("mic", "Mic")];
        for (i, (icon, label)) in names.into_iter().enumerate() {
            let on = opts[i];
            toggles = toggles.child(
                div()
                    .id(("qo", i))
                    .h(px(26.))
                    .px(px(9.))
                    .flex()
                    .items_center()
                    .gap(px(5.))
                    .rounded_full()
                    .border_1()
                    .text_size(px(text::CAPTION))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .when(on, |d| d.border_color(p.primary.opacity(0.35)).bg(p.primary_soft).text_color(p.primary))
                    .when(!on, |d| d.border_color(p.border).text_color(p.fg_muted).hover(|d| d.bg(p.hover)))
                    .active(|d| d.bg(p.pressed))
                    .child(ico(icon, 12., if on { p.primary } else { p.fg_muted }))
                    .child(label)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.app
                            .update(cx, |app, cx| {
                                match i {
                                    0 => app.opt_logs = !app.opt_logs,
                                    1 => {
                                        app.opt_clicks = !app.opt_clicks;
                                        app.opt_keys = app.opt_clicks;
                                    }
                                    2 => app.opt_system_audio = !app.opt_system_audio,
                                    _ => app.opt_mic = !app.opt_mic,
                                }
                                cx.notify();
                            })
                            .ok();
                    })),
            );
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .child(
                div()
                    .px(px(12.))
                    .pt(px(12.))
                    .pb(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(tabs)
                    .child(div().flex_1())
                    .child(ui::icon_button("q-library", "library", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.app.update(cx, |app, cx| app.show_main_window(cx)).ok();
                        this.close(false, window, cx);
                    }))),
            )
            .child(div().px(px(12.)).pb(px(6.)).child(Input::new(&self.query).appearance(false).prefix(ico("search", 14., p.fg_subtle))))
            .child(ui::hairline(p))
            .child(list)
            .child(ui::hairline(p))
            .child(div().px(px(12.)).py(px(10.)).child(toggles))
            .child(
                div()
                    .px(px(12.))
                    .pb(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("q-open-library")
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(text::SMALL))
                            .text_color(p.fg_muted)
                            .cursor_pointer()
                            .hover(|d| d.text_color(p.fg))
                            .child(ico("library", 13., p.fg_subtle))
                            .child(ui::plural(count as u32, "recording", "recordings"))
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                                this.app.update(cx, |app, cx| app.show_main_window(cx)).ok();
                                this.close(false, window, cx);
                            })),
                    )
                    .child(div().flex_1())
                    .child(
                        ui::button_with("q-record", Some(ui::RECORD_GLYPH), Some("Record".into()), Variant::Record, Size::Medium, p)
                            .child(div().ml(px(2.)).text_size(px(text::CAPTION)).opacity(0.75).child("⏎"))
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.start(window, cx))),
                    ),
            )
    }

    fn render_recording(&mut self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(app) = self.app.upgrade() else { return div() };
        let (elapsed, source, counts, preview) = {
            let a = app.read(cx);
            let r = a.recording.as_ref().expect("recording");
            (r.started.elapsed(), r.source.clone(), (r.clicks, r.logs, r.errors, r.markers), r.recorder.as_ref().and_then(|rec| rec.latest_preview_frame()))
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(14.))
            .gap(px(12.))
            .child(
                div()
                    .h(px(200.))
                    .rounded(px(10.))
                    .overflow_hidden()
                    .bg(p.media)
                    .when_some(preview, |d, f| d.child(surface(f).object_fit(ObjectFit::Contain).size_full())),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .child(ui::dot(p.record, 10.))
                    .child(div().text_size(px(text::TITLE)).font_weight(FontWeight::SEMIBOLD).font_features(ui::tnum()).child(ui::format_clock(elapsed.as_millis() as u64)))
                    .child(div().flex_1().min_w_0().text_size(px(text::SMALL)).text_color(p.fg_muted).truncate().child(source)),
            )
            .child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).font_features(ui::tnum()).child(format!(
                "{} · {} · {} · {}",
                ui::plural(counts.0, "click", "clicks"),
                ui::plural(counts.1, "log line", "log lines"),
                ui::plural(counts.2, "error", "errors"),
                ui::plural(counts.3, "marker", "markers")
            )))
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(ui::button_with("q-marker", Some("bookmark-plus"), Some("Marker".into()), Variant::Secondary, Size::Medium, p).flex_1().justify_center().on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.app.update(cx, |app, cx| app.add_marker(cx)).ok();
                    })))
                    .child(ui::button_with("q-stop", Some(ui::STOP_GLYPH), Some("Stop".into()), Variant::Record, Size::Medium, p).flex_1().justify_center().on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.app.update(cx, |app, cx| app.stop_recording_now(cx)).ok();
                        this.close(false, window, cx);
                    }))),
            )
    }

    fn render_saved(&mut self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let QuickMode::Saved { session_id } = self.mode.clone() else { return div() };
        let Some(app) = self.app.upgrade() else { return div() };
        let (poster, meta, suggestion_state, signed_in) = {
            let a = app.read(cx);
            let r = a.records.iter().find(|r| r.session_id == session_id);
            let meta = r
                .map(|r| {
                    let mut parts = vec![ui::format_clock(r.duration_ms.unwrap_or(0.) as u64)];
                    if r.action_count > 0 {
                        parts.push(ui::plural(r.action_count as u32, "action", "actions"));
                    }
                    if r.console_error_count > 0 {
                        parts.push(ui::plural(r.console_error_count as u32, "error", "errors"));
                    }
                    parts.join(" · ")
                })
                .unwrap_or_default();
            let state = match a.suggestions.get(&session_id) {
                Some(s) if s.on_device => ("Suggested by Apple Intelligence, on this Mac", false),
                Some(_) => ("Suggested from what was recorded", false),
                None if a.suggesting.contains(&session_id) => ("Suggesting a title…", true),
                None => ("", false),
            };
            (a.thumbs.get(session_id.as_str()).cloned(), meta, state, a.signed_in)
        };
        let label = |t: &'static str| div().text_size(px(text::CAPTION)).font_weight(FontWeight::MEDIUM).text_color(p.fg_muted).child(t);
        let title = self.title.clone();
        let notes = self.notes.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(14.))
            .gap(px(10.))
            .child(
                div()
                    .relative()
                    .h(px(176.))
                    .rounded(px(10.))
                    .overflow_hidden()
                    .bg(p.media)
                    .when_some(poster, |d, img_| d.child(img(img_).size_full().object_fit(ObjectFit::Cover)))
                    .child(
                        div()
                            .absolute()
                            .left(px(10.))
                            .bottom(px(10.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .px(px(8.))
                            .py(px(3.))
                            .rounded(px(6.))
                            .bg(hsla(0., 0., 0., 0.62))
                            .text_size(px(text::CAPTION))
                            .text_color(gpui_kit::white())
                            .child(ico("circle-check", 12., gpui_kit::white()))
                            .child(format!("Saved · {meta}")),
                    ),
            )
            .child(label("Title"))
            .children(title.map(|t| Input::new(&t)))
            .child(label("Description"))
            .children(notes.map(|n| Textarea::new(&n)))
            .child(
                div()
                    .h(px(16.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(text::CAPTION))
                    .text_color(p.fg_subtle)
                    .when(!suggestion_state.0.is_empty(), |d| d.child(ico("sparkles", 12., if suggestion_state.1 { p.fg_subtle } else { p.violet })).child(suggestion_state.0)),
            )
            .child(div().flex_1())
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(ui::button("q-done", "Done", Variant::Secondary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.close(true, window, cx))))
                    .child(ui::button("q-review", "Review", Variant::Secondary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.review(window, cx))))
                    .child(div().flex_1())
                    .child(
                        ui::button_with("q-share", Some("link"), Some(if signed_in { "Copy link" } else { "Sign in to share" }.into()), Variant::Primary, Size::Medium, p)
                            .child(div().text_size(px(text::CAPTION)).opacity(0.7).child("⌘⏎"))
                            .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.copy_link(window, cx))),
                    ),
            )
    }
}

impl JlApp {
    /// ⌥⇧R and the menu bar icon: open the quick recorder, or close it if it's already up.
    pub fn toggle_quick(&mut self, anchor: Option<(i32, i32, i32, i32)>, cx: &mut Context<Self>) {
        if let Some(q) = self.quick.take() {
            cx.defer(move |cx| {
                q.update(cx, |_, window, _| window.remove_window()).ok();
            });
            return;
        }
        self.open_quick(QuickMode::Pick, anchor, cx);
    }

    pub fn open_quick(&mut self, mode: QuickMode, anchor: Option<(i32, i32, i32, i32)>, cx: &mut Context<Self>) {
        if mode == QuickMode::Pick {
            self.refresh_sources(cx);
        }
        let anchor = anchor.or_else(|| self.system.as_ref().and_then(|s| s.anchor()));
        let weak = cx.entity().downgrade();
        let previous = self.quick.take();
        // Opening a window renders it, and its first render reads this entity: defer past the update.
        cx.defer(move |cx| {
            if let Some(q) = previous {
                q.update(cx, |_, window, _| window.remove_window()).ok();
            }
            let handle = QuickPanel::open(weak.clone(), mode, anchor, cx);
            weak.update(cx, |app, _| app.quick = handle).ok();
        });
    }

    /// Title and description from the saved card: the title renames the recording, the
    /// description becomes its notes.
    pub fn save_quick_edits(&mut self, session_id: String, title: String, notes: String, cx: &mut Context<Self>) {
        let Some(library) = self.library.clone() else { return };
        let Some(record) = self.records.iter().find(|r| r.session_id == session_id).cloned() else { return };
        let rename = !title.trim().is_empty() && title.trim() != record.name;
        let renote = notes.trim() != record.notes.trim();
        if !rename && !renote {
            return;
        }
        cx.spawn(async move |this, cx| {
            let id = session_id.clone();
            let result = cx
                .background_executor()
                .spawn(async move {
                    if rename {
                        library.rename_session(&id, title.trim())?;
                    }
                    if renote {
                        let loaded = library.load_session(&id)?;
                        library.save_review_state(&id, notes.trim(), &loaded.archive.annotations)?;
                    }
                    anyhow::Ok(())
                })
                .await;
            this.update(cx, |this, cx| match result {
                Ok(()) => this.reload_library(cx),
                Err(err) => this.toast("circle-alert", "Couldn't save the title", format!("{err:#}"), None, cx),
            })
            .ok();
        })
        .detach();
    }

    /// Unhides the full window and gives the app its Dock icon back while it's open.
    pub fn show_main_window(&mut self, cx: &mut Context<Self>) {
        cx.set_activation_policy(ActivationPolicy::Regular);
        cx.activate(true);
        if let Some(main) = cx.try_global::<crate::MainWindow>().map(|m| m.0) {
            main.update(cx, |_, window, _| {
                crate::set_visible(window, true);
                window.activate_window();
            })
            .ok();
        }
        self.main_visible = true;
    }
}
