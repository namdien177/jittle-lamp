//! The review surface: video, a lane timeline under it, and the inspector on the right. Everything
//! is keyed to one clock — the playhead — so clicking any row seeks and playing keeps the row at the
//! playhead highlighted.

use std::cell::Cell;
use std::rc::Rc;
use std::time::Instant;

use gpui_kit::prelude::*;
use gpui_kit::*;
use jl_media::SeekMode;

use crate::app::{InspectorTab, JlApp};
use crate::model::{Event, Lane, Severity};
use crate::theme::{Palette, text};
use crate::ui::{self, Size, Variant, ico, kbd};

thread_local! {
    /// Where the timeline track was laid out last frame, for turning pointer x into time.
    static TRACK: Rc<Cell<Bounds<Pixels>>> = Rc::new(Cell::new(Bounds::default()));
}

impl JlApp {
    pub fn advance_playback(&mut self) {
        let Some(v) = self.viewer.as_mut() else { return };
        let now = Instant::now();
        if let Some(player) = v.player.as_ref() {
            // The player owns the clock; the UI reads it once per frame.
            if !v.scrubbing {
                v.position_ms = player.position_ms();
            }
            v.playing = player.is_playing();
            if player.duration_ms() > 0 {
                v.session.duration_ms = player.duration_ms();
            }
            v.last_tick = now;
            return;
        }
        if v.playing && !v.scrubbing {
            let dt = now.duration_since(v.last_tick).as_secs_f32() * 1000. * v.rate;
            v.position_ms = (v.position_ms + dt as u64).min(v.session.duration_ms);
            if v.position_ms >= v.session.duration_ms {
                v.playing = false;
            }
        }
        v.last_tick = now;
    }

    pub fn toggle_play(&mut self, cx: &mut Context<Self>) {
        if let Some(v) = self.viewer.as_mut() {
            if !v.playing && v.position_ms >= v.session.duration_ms {
                v.position_ms = 0;
            }
            if let Some(player) = v.player.as_ref() {
                if player.ended() {
                    player.seek(0, SeekMode::Exact);
                }
                player.toggle();
                v.playing = player.is_playing();
            } else {
                v.playing = !v.playing;
            }
            v.last_tick = Instant::now();
            cx.notify();
        }
    }

    pub fn nudge(&mut self, delta: i64, cx: &mut Context<Self>) {
        if let Some(v) = self.viewer.as_mut() {
            let ms = (v.position_ms as i64 + delta).clamp(0, v.session.duration_ms as i64) as u64;
            self.seek_viewer(ms, SeekMode::Exact);
            cx.notify();
        }
    }

    fn seek_to_pointer(&mut self, x: Pixels) {
        let Some(v) = self.viewer.as_mut() else { return };
        let b = TRACK.with(|t| t.get());
        if b.size.width <= px(0.) {
            return;
        }
        let f = ((x - b.origin.x) / b.size.width).clamp(0., 1.);
        let ms = (f * v.session.duration_ms as f32) as u64;
        // Keyframe seeks keep up with the pointer; the release lands exactly.
        self.seek_viewer(ms, SeekMode::Fast);
    }

    pub fn seek_viewer(&mut self, ms: u64, mode: SeekMode) {
        let Some(v) = self.viewer.as_mut() else { return };
        v.position_ms = ms;
        if let Some(player) = v.player.as_ref() {
            player.seek(ms, mode);
        }
    }

    pub fn render_viewer(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.viewer.as_ref().expect("viewer");
        let title = v.session.name.clone();
        let origin = v.session.origin.clone();
        let sync = v.session.sync;

        let crumbs = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .min_w_0()
            .child(
                ui::button_with("back", Some("chevron-left"), Some("Library".into()), Variant::Ghost, Size::Small, p)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.viewer = None;
                        cx.notify();
                    })),
            )
            .child(div().text_color(p.fg_subtle).child("/"))
            .child(div().text_size(px(text::BODY)).font_weight(FontWeight::SEMIBOLD).truncate().child(title));

        let actions = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(ui::badge(origin.label(), p.fg_muted, p.hover))
            .child(ui::icon_button("reveal", "folder-open", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, _| {
                if let Some(folder) = this.viewer.as_ref().and_then(|v| v.loaded.as_ref()).map(|l| l.folder.clone()) {
                    jl_macos::reveal_in_finder(&folder).ok();
                }
            })))
            .child(ui::icon_button("export", "download", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.export_zip(cx))))
            .child(
                match sync {
                    crate::model::Sync::Uploading(f) => div()
                        .h(px(28.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded(px(7.))
                        .bg(p.primary_soft)
                        .text_size(px(text::SMALL))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.primary)
                        .font_features(ui::tnum())
                        .child(div().w(px(56.)).h(px(4.)).rounded_full().bg(p.primary.opacity(0.2)).child(div().h_full().w(relative(f)).rounded_full().bg(p.primary)))
                        .child(format!("Uploading {:.0}%", f * 100.))
                        .into_any_element(),
                    _ => ui::button_with("share", Some("share-2"), Some(if self.signed_in || self.demo { "Share" } else { "Sign in to share" }.into()), Variant::Primary, Size::Small, p)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.share_current(cx)))
                        .into_any_element(),
                },
            );

        div()
            .id("viewer")
            .flex()
            .flex_col()
            .size_full()
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _, cx| {
                if this.viewer.as_ref().is_some_and(|v| v.scrubbing) {
                    this.seek_to_pointer(ev.position.x);
                    cx.notify();
                }
            }))
            .on_mouse_up(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| {
                let release = this.viewer.as_mut().filter(|v| v.scrubbing).map(|v| {
                    v.scrubbing = false;
                    v.last_tick = Instant::now();
                    v.position_ms
                });
                if let Some(ms) = release {
                    this.seek_viewer(ms, SeekMode::Exact);
                }
                cx.notify();
            }))
            .on_mouse_up_out(MouseButton::Left, cx.listener(|this, _: &MouseUpEvent, _, cx| {
                if let Some(v) = this.viewer.as_mut() {
                    v.scrubbing = false;
                }
                cx.notify();
            }))
            .child(self.toolbar(crumbs, actions, p))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .p(px(16.))
                            .gap(px(12.))
                            .child(self.video_stage(p, cx))
                            .child(self.transport(p, cx))
                            .child(self.timeline(p, cx)),
                    )
                    .child(ui::vline(p))
                    .child(self.inspector(p, window, cx)),
            )
    }

    fn video_stage(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.viewer.as_ref().unwrap();
        let playing = v.playing;
        div()
            .id("stage")
            .flex_1()
            .min_h(px(240.))
            .rounded(px(12.))
            .overflow_hidden()
            .bg(p.media)
            .flex()
            .items_center()
            .justify_center()
            .relative()
            .cursor_pointer()
            .child(match v.player.as_ref().and_then(|p| p.current_frame()) {
                Some(frame) => surface(frame).object_fit(ObjectFit::Contain).size_full().into_any_element(),
                None if v.loaded.is_some() || !self.demo => div().into_any_element(),
                None => mock_frame(v.position_ms, p).into_any_element(),
            })
            .when(!playing, |d| {
                d.child(
                    div()
                        .absolute()
                        .size(px(64.))
                        .rounded_full()
                        .bg(hsla(0., 0., 0., 0.45))
                        .border_1()
                        .border_color(hsla(0., 0., 1., 0.18))
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(ico("play", 26., gpui_kit::white())),
                )
            })
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_play(cx)))
    }

    fn transport(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.viewer.as_ref().unwrap();
        let rate = v.rate;
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .child(
                ui::icon_button("play", if v.playing { "pause" } else { "play" }, Variant::Secondary, p)
                    .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_play(cx))),
            )
            .child(ui::icon_button("back5", "rewind", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.nudge(-5_000, cx))))
            .child(ui::icon_button("fwd5", "fast-forward", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.nudge(5_000, cx))))
            .child(
                div()
                    .ml(px(6.))
                    .text_size(px(text::SMALL))
                    .font_features(ui::tnum())
                    .child(div().flex().gap(px(4.)).child(div().text_color(p.fg).child(ui::format_clock(v.position_ms))).child(div().text_color(p.fg_subtle).child("/")).child(div().text_color(p.fg_subtle).child(ui::format_clock(v.session.duration_ms)))),
            )
            .child(div().flex_1())
            .child(
                ui::button(("rate", 0usize), format!("{rate}×"), Variant::Ghost, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    if let Some(v) = this.viewer.as_mut() {
                        v.rate = match v.rate { r if r < 1.0 => 1.0, r if r < 1.5 => 1.5, r if r < 2.0 => 2.0, _ => 0.5 };
                        if let Some(player) = v.player.as_ref() {
                            player.set_rate(v.rate);
                        }
                    }
                    cx.notify();
                })),
            )
            .child(ui::icon_button("copy-frame", "image", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                let png = this.viewer.as_ref().and_then(|v| v.player.as_ref()).map(|p| p.current_frame_png());
                match png {
                    Some(Ok(png)) if jl_macos::copy_image_to_pasteboard(&png).is_ok() => this.toast("copy", "Frame copied", "Paste it into Jira, Slack or a doc.", None, cx),
                    Some(Err(err)) => this.toast("circle-alert", "Couldn't copy the frame", err.to_string(), None, cx),
                    _ => {}
                }
            })))
    }

    fn timeline(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.viewer.as_ref().unwrap();
        let dur = v.session.duration_ms.max(1) as f32;
        let lanes = [(Lane::Action, "Actions"), (Lane::Network, "Network"), (Lane::Console, "Console"), (Lane::Marker, "Markers")];
        let head = v.position_ms as f32 / dur;

        let mut track = div().relative().flex_1().flex().flex_col().gap(px(4.));
        for (lane, _) in lanes {
            let mut row = div().relative().h(px(14.)).rounded(px(3.)).bg(p.hover);
            for e in v.events.iter().filter(|e| e.lane == lane) {
                let color = lane_color(e, p);
                let x = e.offset_ms as f32 / dur;
                let width = e.duration_ms.map(|d| (d as f32 / dur).max(0.004)).unwrap_or(0.0);
                row = row.child(if lane == Lane::Marker {
                    div().absolute().top(px(1.)).left(relative(x)).ml(px(-6.)).child(ico("bookmark", 12., p.warning))
                } else if width > 0.0 {
                    div().absolute().top(px(3.)).h(px(8.)).left(relative(x)).w(relative(width)).min_w(px(3.)).rounded(px(2.)).bg(color)
                } else {
                    div().absolute().top(px(2.)).h(px(10.)).left(relative(x)).w(px(3.)).rounded(px(1.)).bg(color)
                });
            }
            track = track.child(row);
        }
        let bounds = TRACK.with(|t| t.clone());
        track = track
            .child(canvas(move |b, _, _| bounds.set(b), |_, _, _, _| {}).absolute().size_full())
            .child(div().absolute().top(px(-4.)).bottom(px(-4.)).left(relative(head)).w(px(2.)).ml(px(-1.)).rounded_full().bg(p.fg))
            .child(div().absolute().top(px(-8.)).left(relative(head)).ml(px(-5.)).size(px(10.)).rounded_full().bg(p.fg).border_2().border_color(p.bg));

        let mut labels = div().w(px(64.)).flex().flex_col().gap(px(4.));
        for (_, name) in lanes {
            labels = labels.child(div().h(px(14.)).flex().items_center().text_size(px(10.)).text_color(p.fg_subtle).child(name));
        }

        div()
            .id("timeline")
            .flex()
            .gap(px(8.))
            .pt(px(10.))
            .pb(px(6.))
            .px(px(10.))
            .rounded(px(10.))
            .border_1()
            .border_color(p.border)
            .bg(p.card)
            .cursor(CursorStyle::PointingHand)
            .child(labels)
            .child(track)
            .on_mouse_down(MouseButton::Left, cx.listener(|this, ev: &MouseDownEvent, _, cx| {
                // The playhead follows the pointer 1:1 from the moment of the press.
                if let Some(v) = this.viewer.as_mut() {
                    v.scrubbing = true;
                }
                this.seek_to_pointer(ev.position.x);
                cx.notify();
            }))
    }

    fn inspector(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tab = self.viewer.as_ref().unwrap().tab;
        let counts = {
            let v = self.viewer.as_ref().unwrap();
            let c = |l: Lane| v.events.iter().filter(|e| e.lane == l).count();
            (c(Lane::Action) + c(Lane::Marker), c(Lane::Network), c(Lane::Console))
        };
        let tabs = self.segmented(
            "inspector-tabs",
            &[(InspectorTab::Actions, "Actions", None), (InspectorTab::Network, "Network", None), (InspectorTab::Console, "Console", None), (InspectorTab::Notes, "Notes", None)],
            tab,
            84.,
            |this, t, _| {
                if let Some(v) = this.viewer.as_mut() {
                    v.tab = t;
                    v.selected_event = None;
                }
            },
            p,
            window,
            cx,
        );
        let summary = match tab {
            InspectorTab::Actions => format!("{} actions and markers", counts.0),
            InspectorTab::Network => format!("{} requests", counts.1),
            InspectorTab::Console => format!("{} console entries", counts.2),
            InspectorTab::Notes => "Saved with the recording".into(),
        };

        let body: AnyElement = if tab == InspectorTab::Notes {
            self.notes_panel(p, window, cx).into_any_element()
        } else {
            self.event_list(tab, p, cx).into_any_element()
        };
        let detail = self.network_detail(p);

        div()
            .w(px(400.))
            .flex_none()
            .h_full()
            .flex()
            .flex_col()
            .child(div().p(px(12.)).flex().flex_col().gap(px(8.)).child(tabs).child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(summary)))
            .child(ui::hairline(p))
            .child(div().flex_1().min_h_0().child(body))
            .children(detail)
    }

    fn event_list(&self, tab: InspectorTab, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let v = self.viewer.as_ref().unwrap();
        let wanted = |e: &Event| match tab {
            InspectorTab::Actions => matches!(e.lane, Lane::Action | Lane::Marker),
            InspectorTab::Network => e.lane == Lane::Network,
            InspectorTab::Console => e.lane == Lane::Console,
            InspectorTab::Notes => false,
        };
        let current = v.events.iter().enumerate().filter(|(_, e)| wanted(e) && e.offset_ms <= v.position_ms).map(|(i, _)| i).last();
        let mut list = div().flex().flex_col().p(px(6.));
        for (i, e) in v.events.iter().enumerate().filter(|(_, e)| wanted(e)) {
            let is_current = Some(i) == current;
            let is_selected = Some(i) == v.selected_event;
            let past = e.offset_ms <= v.position_ms;
            let offset = e.offset_ms;
            let lead: AnyElement = match (e.lane, &e.method) {
                (Lane::Network, Some(m)) => div()
                    .w(px(44.))
                    .flex_none()
                    .text_size(px(10.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .font_family(ui::mono_family())
                    .text_color(p.fg_muted)
                    .child(m.clone())
                    .into_any_element(),
                _ => div().w(px(20.)).flex_none().flex().justify_center().child(ico(event_icon(e), 13., lane_color(e, p))).into_any_element(),
            };
            let trailing: AnyElement = match e.status {
                Some(s) => ui::badge(s.to_string(), status_color(s, p), status_color(s, p).opacity(0.12)).into_any_element(),
                None => div().into_any_element(),
            };
            list = list.child(
                div()
                    .id(("event", i))
                    .relative()
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(6.))
                    .rounded(px(7.))
                    .cursor_pointer()
                    .when(is_selected, |d| d.bg(p.selected))
                    .when(is_current && !is_selected, |d| d.bg(p.primary_soft))
                    .when(!is_selected && !is_current, |d| d.hover(|d| d.bg(p.hover)))
                    .active(|d| d.bg(p.pressed))
                    .when(!past, |d| d.opacity(0.55))
                    .child(div().w(px(46.)).flex_none().pt(px(1.)).text_size(px(text::CAPTION)).font_features(ui::tnum()).text_color(if is_current { p.primary } else { p.fg_subtle }).child(ui::format_offset(e.offset_ms)))
                    .child(lead)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(
                                div()
                                    .text_size(px(text::SMALL))
                                    .text_color(if e.severity == Severity::Error { p.danger } else { p.fg })
                                    .when(e.lane == Lane::Network || e.lane == Lane::Console, |d| d.font_family(ui::mono_family()).text_size(px(11.5)))
                                    .line_clamp(2)
                                    .child(e.label.clone()),
                            )
                            .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).truncate().child(e.detail.clone())),
                    )
                    .child(trailing)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        if let Some(v) = this.viewer.as_mut() {
                            v.selected_event = Some(i);
                        }
                        this.seek_viewer(offset, SeekMode::Exact);
                        cx.notify();
                    })),
            );
        }
        div().id("event-scroll").size_full().overflow_y_scroll().child(list)
    }

    /// What the archive recorded for the selected request: nothing invented, nothing implied.
    fn network_detail(&self, p: &Palette) -> Option<impl IntoElement> {
        let v = self.viewer.as_ref()?;
        let e = v.events.get(v.selected_event?)?;
        if e.lane != Lane::Network {
            return None;
        }
        let net = e.network_index.and_then(|i| v.loaded.as_ref()?.archive.sections.network.get(i)).map(|n| &n.payload);
        let status = net.and_then(|n| n.status).or(e.status);
        let label_row = |k: SharedString, val: SharedString| {
            div()
                .flex()
                .gap(px(10.))
                .text_size(px(text::CAPTION))
                .child(div().w(px(120.)).flex_none().text_color(p.fg_subtle).truncate().child(k))
                .child(div().flex_1().min_w_0().font_family(ui::mono_family()).text_color(p.fg).truncate().child(val))
        };
        let section = |title: &'static str| div().pt(px(4.)).child(ui::label_caps(title, p));
        let mut panel = div()
            .id("network-detail")
            .flex_none()
            .max_h(px(360.))
            .overflow_y_scroll()
            .border_t_1()
            .border_color(p.border)
            .bg(p.card)
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(ui::badge(e.method.clone().unwrap_or_default(), p.fg, p.hover))
                    .when_some(status, |d, s| d.child(ui::badge(s.to_string(), status_color(s, p), status_color(s, p).opacity(0.12))))
                    .when_some(e.duration_ms, |d, ms| d.child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).child(format!("{ms} ms")))),
            )
            .child(div().text_size(px(text::SMALL)).font_family(ui::mono_family()).text_color(p.fg).line_clamp(3).child(net.map(|n| SharedString::from(n.url.clone())).unwrap_or_else(|| e.label.clone())));
        let Some(net) = net else { return Some(panel) };
        if let Some(failure) = net.failure_text.clone() {
            panel = panel.child(div().text_size(px(text::SMALL)).text_color(p.danger).child(failure));
        }
        if !net.request.headers.is_empty() {
            panel = panel.child(section("REQUEST HEADERS"));
            for h in &net.request.headers {
                panel = panel.child(label_row(h.name.clone().into(), h.value.clone().into()));
            }
        }
        if let Some(body) = net.request.body.as_ref().and_then(|b| b.display_text()) {
            panel = panel.child(section("REQUEST BODY")).child(body_block(body, p));
        }
        if let Some(resp) = net.response.as_ref() {
            if !resp.headers.is_empty() {
                panel = panel.child(section("RESPONSE HEADERS"));
                for h in &resp.headers {
                    panel = panel.child(label_row(h.name.clone().into(), h.value.clone().into()));
                }
            }
            if let Some(b) = resp.body.as_ref() {
                panel = panel.child(section("RESPONSE BODY")).child(match b.display_text() {
                    Some(text) => body_block(text, p),
                    None => div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(b.reason.clone().unwrap_or_else(|| "Not captured".into())),
                });
            }
        }
        Some(panel)
    }

    fn notes_panel(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.demo {
            if let Some(editor) = self.ensure_notes_editor(window, cx) {
                let status = self.viewer.as_ref().and_then(|v| v.notes_status.clone()).unwrap_or_else(|| "Notes save as you type".into());
                return div()
                    .p(px(14.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(gpui_kit::component::input::Textarea::new(&editor))
                    .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(status))
                    .into_any_element();
            }
            let v = self.viewer.as_ref();
            let (notes, hint): (SharedString, &str) = match v.and_then(|v| v.loaded.as_ref()) {
                None => ("".into(), "Loading…"),
                Some(l) if l.notes.trim().is_empty() => ("".into(), "No notes on this copy."),
                Some(l) => (l.notes.clone().into(), "Read-only: this is a copy from the cloud or a ZIP."),
            };
            return div()
                .p(px(14.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .when(!notes.is_empty(), |d| d.child(div().p(px(12.)).rounded(px(9.)).bg(p.hover).text_size(px(text::BODY)).child(notes)))
                .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(hint))
                .into_any_element();
        }
        if let Some(editor) = self.ensure_notes_editor(window, cx) {
            let status = self.viewer.as_ref().and_then(|v| v.notes_status.clone()).unwrap_or_else(|| "Notes save as you type".into());
            return div()
                .p(px(14.))
                .flex()
                .flex_col()
                .gap(px(10.))
                .child(gpui_kit::component::input::Textarea::new(&editor))
                .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(status))
                .into_any_element();
        }
        div()
            .p(px(14.))
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(
                div()
                    .min_h(px(160.))
                    .p(px(12.))
                    .rounded(px(9.))
                    .border_1()
                    .border_color(p.border_strong)
                    .text_size(px(text::BODY))
                    .text_color(p.fg_muted)
                    .child("Steps: add SPRING25 on /cart, press Checkout. Session endpoint returns 500 twice; the summary crashes on `amount`."),
            )
            .child(div().flex().items_center().gap(px(6.)).text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(kbd("⌘S", p)).child("Notes save as you type"))
            .into_any_element()
    }
}

/// Bodies can be large; the panel shows the first few kilobytes, which is what a reviewer reads.
fn body_block(text: String, p: &Palette) -> Div {
    const LIMIT: usize = 6_000;
    let shown = if text.len() > LIMIT {
        let mut end = LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}\n… {} more bytes", &text[..end], text.len() - end)
    } else {
        text
    };
    div().p(px(10.)).rounded(px(7.)).bg(p.hover).text_size(px(11.)).font_family(ui::mono_family()).text_color(p.fg_muted).child(shown)
}

fn event_icon(e: &Event) -> &'static str {
    match e.lane {
        Lane::Marker => "bookmark",
        Lane::Console => match e.severity {
            Severity::Error => "circle-alert",
            Severity::Warn => "triangle-alert",
            _ => "terminal",
        },
        Lane::Network => "network",
        Lane::Action => {
            let l = e.label.as_ref();
            if l.starts_with("Navigated") {
                "globe"
            } else if l.starts_with("Typed") || l.starts_with("Pressed") {
                "keyboard"
            } else {
                "mouse-pointer-click"
            }
        }
    }
}

fn lane_color(e: &Event, p: &Palette) -> Hsla {
    match (e.lane, e.severity) {
        (_, Severity::Error) => p.danger,
        (_, Severity::Warn) => p.warning,
        (Lane::Action, _) => p.primary,
        (Lane::Network, _) => p.info,
        (Lane::Console, Severity::Debug) => p.fg_subtle,
        (Lane::Console, _) => p.violet,
        (Lane::Marker, _) => p.warning,
    }
}

fn status_color(s: u16, p: &Palette) -> Hsla {
    match s {
        500.. => p.danger,
        400.. => p.warning,
        300.. => p.info,
        _ => p.primary,
    }
}

/// Until jl-media lands: a schematic frame of the captured page, so the stage has content.
fn mock_frame(position_ms: u64, p: &Palette) -> impl IntoElement {
    let broken = position_ms > 14_000;
    let line = |w: f32, c: Hsla| div().h(px(8.)).w(relative(w)).rounded(px(3.)).bg(c);
    let shade = hsla(0., 0., 1., 0.08);
    div()
        .w(relative(0.86))
        .h(relative(0.84))
        .rounded(px(8.))
        .overflow_hidden()
        .bg(hsla(230. / 360., 0.12, 0.12, 1.))
        .border_1()
        .border_color(hsla(0., 0., 1., 0.08))
        .flex()
        .flex_col()
        .child(
            div()
                .h(px(26.))
                .flex_none()
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(5.))
                .bg(hsla(0., 0., 1., 0.05))
                .child(ui::dot(hsla(0., 0.8, 0.6, 0.8), 7.))
                .child(ui::dot(hsla(0.12, 0.8, 0.6, 0.8), 7.))
                .child(ui::dot(hsla(0.33, 0.6, 0.5, 0.8), 7.))
                .child(div().ml(px(10.)).h(px(14.)).w(px(220.)).rounded(px(4.)).bg(shade)),
        )
        .child(
            div()
                .flex_1()
                .flex()
                .gap(px(18.))
                .p(px(22.))
                .child(div().flex_1().flex().flex_col().gap(px(10.)).child(line(0.5, hsla(0., 0., 1., 0.22))).child(line(0.9, shade)).child(line(0.8, shade)).child(line(0.6, shade)).child(div().mt(px(12.)).h(px(70.)).rounded(px(6.)).bg(shade)))
                .child(
                    div()
                        .w(relative(0.34))
                        .flex()
                        .flex_col()
                        .gap(px(10.))
                        .p(px(12.))
                        .rounded(px(8.))
                        .bg(hsla(0., 0., 1., 0.05))
                        .child(line(0.6, hsla(0., 0., 1., 0.2)))
                        .child(line(0.9, shade))
                        .child(line(0.7, shade))
                        .child(
                            div()
                                .mt(px(8.))
                                .h(px(26.))
                                .rounded(px(6.))
                                .bg(if broken { p.danger.opacity(0.35) } else { p.primary.opacity(0.7) })
                                .flex()
                                .items_center()
                                .justify_center()
                                .text_size(px(10.))
                                .text_color(gpui_kit::white())
                                .child(if broken { "Something went wrong" } else { "Checkout" }),
                        ),
                ),
        )
}
