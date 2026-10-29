//! The recording HUD: a small floating pill that stays above everything while a recording runs, so
//! the main window can get out of the way. Always dark, like the system's own capture controls.

use std::time::Duration;

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::theme::{self, text};
use crate::ui::{self, ico};

pub const WIDTH: f32 = 340.;
pub const HEIGHT: f32 = 48.;

pub struct Hud {
    app: WeakEntity<JlApp>,
    _tick: Task<()>,
}

impl Hud {
    pub fn open(app: WeakEntity<JlApp>, cx: &mut App) -> Option<WindowHandle<Hud>> {
        let display = cx.primary_display()?;
        let screen = display.bounds();
        let origin = point(screen.origin.x + (screen.size.width - px(WIDTH)) / 2., screen.origin.y + px(44.));
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds { origin, size: size(px(WIDTH), px(HEIGHT)) })),
            titlebar: None,
            kind: WindowKind::PopUp,
            is_movable: true,
            is_resizable: false,
            is_minimizable: false,
            focus: false,
            show: true,
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        };
        cx.open_window(options, move |_, cx| {
            cx.new(|cx| {
                // One-second resolution is all a clock needs; the dot's pulse rides the same tick.
                let tick = cx.spawn(async move |this, cx| loop {
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        break;
                    }
                });
                Hud { app, _tick: tick }
            })
        })
        .ok()
    }
}

impl Render for Hud {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = theme::dark();
        let Some(app) = self.app.upgrade() else { return div().into_any_element() };
        let app_ref = app.read(cx);
        let Some(rec) = app_ref.recording.as_ref() else { return div().into_any_element() };
        let elapsed = rec.started.elapsed();
        let phase = (elapsed.as_secs_f32() * std::f32::consts::TAU).sin() * 0.5 + 0.5;
        let counts = format!("{} · {} · {}", ui::plural(rec.clicks, "click", "clicks"), ui::plural(rec.logs, "log", "logs"), ui::plural(rec.errors, "error", "errors"));
        let errors = rec.errors;
        let source = rec.source.clone();

        let weak = self.app.clone();
        let weak_stop = self.app.clone();
        div()
            .id("hud")
            .size_full()
            .flex()
            .items_center()
            .gap(px(10.))
            .pl(px(16.))
            .pr(px(6.))
            .rounded_full()
            .bg(hsla(240. / 360., 0.04, 0.09, 0.94))
            .border_1()
            .border_color(hsla(0., 0., 1., 0.12))
            .text_color(p.fg)
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
            .child(ui::dot(p.record, 10.).opacity(0.5 + 0.5 * phase))
            .child(div().text_size(px(text::EMPHASIS)).font_weight(FontWeight::SEMIBOLD).font_features(ui::tnum()).child(ui::format_clock(elapsed.as_millis() as u64)))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).truncate().child(source))
                    .child(div().text_size(px(10.)).text_color(if errors > 0 { p.danger } else { p.fg_subtle }).truncate().child(counts)),
            )
            .child(
                div()
                    .id("hud-marker")
                    .size(px(34.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .hover(|d| d.bg(hsla(0., 0., 1., 0.08)))
                    .active(|d| d.bg(hsla(0., 0., 1., 0.16)))
                    .child(ico("bookmark-plus", 16., p.fg_muted))
                    .on_click(move |_, _, cx| {
                        weak.update(cx, |app, cx| app.add_marker(cx))
                        .ok();
                    }),
            )
            .child(
                div()
                    .id("hud-stop")
                    .h(px(34.))
                    .px(px(12.))
                    .rounded_full()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .bg(p.record)
                    .cursor_pointer()
                    .active(|d| d.bg(p.record_pressed))
                    .child(div().size(px(9.)).rounded(px(2.)).bg(gpui_kit::white()))
                    .child(div().text_size(px(text::SMALL)).font_weight(FontWeight::SEMIBOLD).text_color(gpui_kit::white()).child("Stop"))
                    .on_click(move |_, window, cx| {
                        let _ = window;
                        weak_stop.update(cx, |app, cx| app.stop_from_hud(cx)).ok();
                    }),
            )
            .into_any_element()
    }
}
