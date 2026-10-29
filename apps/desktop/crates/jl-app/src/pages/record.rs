//! Record: pick a source, choose what to capture, start. While a recording runs, the page becomes
//! its live control surface.

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::CaptureKind;
use crate::theme::{Palette, text};
use crate::ui::{self, Size, Variant, ico, kbd};

impl JlApp {
    pub fn render_record(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.recording.is_some() {
            return self.render_live(p, cx).into_any_element();
        }
        let kinds = [
            (CaptureKind::Screen, "Screen", Some("monitor")),
            (CaptureKind::Window, "Window", Some("app-window")),
            (CaptureKind::App, "App", Some("app-window-mac")),
        ];
        let picker = self.segmented(
            "capture-kind",
            &kinds,
            self.capture_kind,
            96.,
            |this, kind, _| {
                this.capture_kind = kind;
                this.selected_source = 0;
            },
            p,
            window,
            cx,
        );

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.toolbar(Self::page_title("Record", p), div(), p))
            .child(
                div()
                    .id("record-scroll")
                    .flex_1()
                    .overflow_y_scroll()
                    .child(
                        div()
                            .max_w(px(920.))
                            .mx_auto()
                            .px(px(32.))
                            .py(px(28.))
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            .child(self.record_hero(p))
                            .child(div().flex().items_center().gap(px(12.)).child(picker).child(div().flex_1()).child(
                                div().text_size(px(text::SMALL)).text_color(p.fg_subtle).child(match self.capture_kind {
                                    CaptureKind::Screen => "Everything on one display",
                                    CaptureKind::Window => "One window, follows it when it moves",
                                    CaptureKind::App => "Every window of one app, plus its logs",
                                }),
                            ))
                            .child(if self.needs_screen_permission { self.permission_card(p, cx).into_any_element() } else { self.source_grid(p, cx).into_any_element() })
                            .child(self.capture_options(p, window, cx))
                            .child(self.extension_card(p)),
                    ),
            )
            .child(self.record_footer(p, cx))
            .into_any_element()
    }

    fn record_hero(&self, p: &Palette) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(div().text_size(px(text::DISPLAY)).font_weight(FontWeight::BOLD).line_height(px(32.)).text_color(p.fg).child("What should we capture?"))
            .child(
                div()
                    .text_size(px(text::EMPHASIS))
                    .text_color(p.fg_muted)
                    .child("Video, clicks, shortcuts and the app's own logs land on one timeline, ready to review or share."),
            )
    }

    fn source_grid(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let sources: Vec<_> = self.visible_sources().into_iter().cloned().collect();
        let mut grid = div().flex().flex_wrap().gap(px(14.));
        for (i, s) in sources.iter().enumerate() {
            let selected = i == self.selected_source;
            grid = grid.child(
                div()
                    .id(("source", i))
                    .w(px(160.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .p(px(8.))
                    .rounded(px(14.))
                    .border_2()
                    .border_color(if selected { p.primary } else { gpui_kit::transparent_black() })
                    .bg(if selected { p.primary_soft } else { gpui_kit::transparent_black() })
                    .cursor_pointer()
                    .when(!selected, |d| d.hover(|d| d.bg(p.hover)))
                    .active(|d| d.bg(p.pressed))
                    .child(source_thumb(s.kind, &s.name, self.source_icons.get(&s.id).cloned(), selected, p))
                    .child(
                        div()
                            .px(px(4.))
                            .pb(px(2.))
                            .flex()
                            .flex_col()
                            .gap(px(1.))
                            .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).text_color(p.fg).truncate().child(s.name.clone()))
                            .child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).truncate().child(s.detail.clone())),
                    )
                    .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                        this.selected_source = i;
                        if ev.click_count() == 2 {
                            this.toggle_recording(window, cx);
                        }
                        cx.notify();
                    })),
            );
        }
        grid
    }

    fn permission_card(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        ui::card(p)
            .p(px(24.))
            .flex()
            .items_center()
            .gap(px(18.))
            .child(div().size(px(48.)).flex_none().rounded(px(12.)).bg(p.info_soft).flex().items_center().justify_center().child(ico("monitor", 22., p.info)))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(div().text_size(px(text::EMPHASIS)).font_weight(FontWeight::SEMIBOLD).child("Allow screen recording"))
                    .child(div().text_size(px(text::BODY)).text_color(p.fg_muted).child("macOS asks once. Jittle Lamp only captures while you record, and only what you pick here.")),
            )
            .child(ui::button("allow-screen", "Allow…", Variant::Primary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.request_screen_permission(cx))))
    }

    fn capture_options(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let app_like = self.capture_kind != CaptureKind::Screen;
        type OptionRow = (&'static str, &'static str, &'static str, bool, fn(&mut JlApp));
        let rows: Vec<OptionRow> = vec![
            ("mouse-pointer-click", "Clicks", "Where you clicked, with a ripple in the video", self.opt_clicks, |t| t.opt_clicks = !t.opt_clicks),
            ("keyboard", "Shortcuts", "Key combos like ⌘S. Typed text is never recorded", self.opt_keys, |t| t.opt_keys = !t.opt_keys),
            ("scroll-text", "App logs", "Stream the app's unified log into the console tab", self.opt_logs && app_like, |t| t.opt_logs = !t.opt_logs),
            ("volume-2", "System audio", "What the Mac plays", self.opt_system_audio, |t| t.opt_system_audio = !t.opt_system_audio),
            ("mic", "Microphone", "Narrate while you reproduce", self.opt_mic, |t| t.opt_mic = !t.opt_mic),
        ];
        let mut card = ui::card(p).flex().flex_col();
        let count = rows.len();
        for (i, (icon_name, title, desc, on, toggle)) in rows.into_iter().enumerate() {
            let disabled = title == "App logs" && !app_like;
            let sw = ui::switch(("opt", i), on, p, window, cx);
            card = card.child(
                div()
                    .id(("opt-row", i))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .px(px(16.))
                    .py(px(11.))
                    .when(i + 1 < count, |d| d.border_b_1().border_color(p.border))
                    .when(disabled, |d| d.opacity(0.45))
                    .when(!disabled, |d| d.cursor_pointer())
                    .child(div().size(px(28.)).rounded(px(7.)).bg(p.hover).flex().items_center().justify_center().child(ico(icon_name, 15., p.fg_muted)))
                    .child(
                        div()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).child(title))
                            .child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).child(if disabled { "Pick a window or an app to stream its logs" } else { desc })),
                    )
                    .child(sw)
                    .when(!disabled, |d| {
                        d.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            toggle(this);
                            cx.notify();
                        }))
                    }),
            );
        }
        div().flex().flex_col().gap(px(10.)).child(ui::label_caps("CAPTURE", p)).child(card)
    }

    fn extension_card(&self, p: &Palette) -> impl IntoElement {
        div()
            .flex()
            .items_center()
            .gap(px(14.))
            .p(px(16.))
            .rounded(px(12.))
            .bg(p.hover)
            .child(ico("globe", 18., p.fg_muted))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).child("Recording a web app?"))
                    .child(
                        div()
                            .text_size(px(text::SMALL))
                            .text_color(p.fg_muted)
                            .child("The Chrome extension captures network requests and console output too. Its recordings appear in your Library as soon as they stop."),
                    ),
            )
            .child(ui::badge(if self.companion_listening { "Connected" } else { "Not running" }, if self.companion_listening { p.primary } else { p.warning }, if self.companion_listening { p.primary_soft } else { p.warning_soft }))
    }

    fn record_footer(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let source = self.visible_sources().get(self.selected_source).map(|s| s.name.clone()).unwrap_or_default();
        div()
            .flex_none()
            .h(px(68.))
            .px(px(24.))
            .flex()
            .items_center()
            .gap(px(14.))
            .border_t_1()
            .border_color(p.border)
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).truncate().child(source))
                    .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(format!("Saves to {}", self.output_dir))),
            )
            .child(kbd("⌥⇧R", p))
            .child(
                ui::button_with("start-recording", Some(ui::RECORD_GLYPH), Some("Start recording".into()), Variant::Record, Size::Large, p)
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_recording(window, cx))),
            )
    }

    fn render_live(&self, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let rec = self.recording.as_ref().expect("recording");
        let elapsed = rec.started.elapsed();
        // A one-second breathing pulse on the dot: fast enough not to sit near the 0.2 Hz band that
        // bothers people, and it only runs while recording.
        let phase = (elapsed.as_secs_f32() * std::f32::consts::TAU).sin() * 0.5 + 0.5;
        let stat = |label: &'static str, value: u32, color: Hsla| {
            div()
                .flex()
                .flex_col()
                .items_center()
                .gap(px(2.))
                .min_w(px(84.))
                .child(div().text_size(px(text::TITLE)).font_weight(FontWeight::SEMIBOLD).font_features(ui::tnum()).text_color(color).child(value.to_string()))
                .child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).child(label))
        };
        // What the recorder sees right now, a few times a second — proof it's capturing the right thing.
        let preview = rec.recorder.as_ref().and_then(|r| r.latest_preview_frame()).map(|frame| {
            div()
                .w(px(420.))
                .h(px(236.))
                .rounded(px(12.))
                .overflow_hidden()
                .bg(p.media)
                .border_1()
                .border_color(p.border)
                .child(surface(frame).object_fit(ObjectFit::Contain).size_full())
        });
        let warning = self.capture_warning.clone();
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.toolbar(Self::page_title("Recording", p), div(), p))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(28.))
                    .children(preview)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(14.))
                            .child(ui::dot(p.record, 14.).opacity(0.55 + 0.45 * phase).shadow(vec![BoxShadow {
                                color: p.record.opacity(0.45 * phase),
                                offset: point(px(0.), px(0.)),
                                blur_radius: px(12.),
                                spread_radius: px(2.),
                                inset: false,
                            }]))
                            .child(
                                div()
                                    .text_size(px(56.))
                                    .font_weight(FontWeight::LIGHT)
                                    .font_features(ui::tnum())
                                    .text_color(p.fg)
                                    .child(ui::format_clock(elapsed.as_millis() as u64)),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .text_size(px(text::BODY))
                            .text_color(p.fg_muted)
                            .child(ico(match rec.kind { CaptureKind::Screen => "monitor", CaptureKind::Window => "app-window", CaptureKind::App => "app-window-mac" }, 15., p.fg_muted))
                            .child(rec.source.clone()),
                    )
                    .child(
                        ui::card(p)
                            .flex()
                            .py(px(14.))
                            .px(px(10.))
                            .child(stat("Clicks", rec.clicks, p.fg))
                            .child(ui::vline(p))
                            .child(stat("Shortcuts", rec.keys, p.fg))
                            .child(ui::vline(p))
                            .child(stat("Log lines", rec.logs, p.fg))
                            .child(ui::vline(p))
                            .child(stat("Errors", rec.errors, if rec.errors > 0 { p.danger } else { p.fg }))
                            .child(ui::vline(p))
                            .child(stat("Markers", rec.markers, p.warning)),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(10.))
                            .child(
                                ui::button_with("marker", Some("bookmark-plus"), Some("Add marker".into()), Variant::Secondary, Size::Large, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.add_marker(cx))),
                            )
                            .child(
                                ui::button_with("stop", Some(ui::STOP_GLYPH), Some("Stop".into()), Variant::Record, Size::Large, p)
                                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.toggle_recording(window, cx))),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(16.))
                            .text_size(px(text::SMALL))
                            .text_color(p.fg_subtle)
                            .child(div().flex().gap(px(6.)).items_center().child(kbd("⌘⇧M", p)).child("Marker"))
                            .child(div().flex().gap(px(6.)).items_center().child(kbd("⌥⇧R", p)).child("Stop from anywhere")),
                    )
                    .when_some(warning, |d, w| d.child(div().flex().items_center().gap(px(6.)).text_size(px(text::SMALL)).text_color(p.warning).child(ico("triangle-alert", 13., p.warning)).child(w))),
            )
    }
}

/// A stylised preview until live ScreenCaptureKit thumbnails are wired in.
fn source_thumb(kind: CaptureKind, name: &SharedString, icon: Option<std::sync::Arc<RenderImage>>, selected: bool, p: &Palette) -> impl IntoElement {
    let (icon_name, tint) = match kind {
        CaptureKind::Screen => ("monitor", p.info),
        CaptureKind::Window => ("app-window", p.violet),
        CaptureKind::App => ("app-window-mac", p.primary),
    };
    let initial: String = name.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default();
    div()
        .h(px(92.))
        .w_full()
        .rounded(px(9.))
        .overflow_hidden()
        // Flat surfaces only: app icons bring their own colour, displays and windows a tinted glyph.
        .bg(p.hover)
        .border_1()
        .border_color(if selected { p.primary.opacity(0.4) } else { p.border })
        .flex()
        .items_center()
        .justify_center()
        .child(match (kind, icon) {
            (CaptureKind::App, Some(icon)) => img(icon).size(px(56.)).into_any_element(),
            (CaptureKind::Window, Some(icon)) => div()
                .relative()
                .child(ico(icon_name, 34., tint.opacity(0.7)))
                .child(img(icon).absolute().right(px(-12.)).bottom(px(-10.)).size(px(26.)))
                .into_any_element(),
            (CaptureKind::App, None) => div()
                .size(px(48.))
                .rounded(px(12.))
                .bg(tint.opacity(0.9))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(22.))
                .font_weight(FontWeight::BOLD)
                .text_color(gpui_kit::white())
                .child(initial)
                .into_any_element(),
            _ => ico(icon_name, 30., tint).into_any_element(),
        })
}
