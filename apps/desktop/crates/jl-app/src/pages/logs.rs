//! Logs: tail any running app's unified log, live, without recording. One click turns the stream
//! into a recording of the same app.

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::Severity;
use crate::theme::{Palette, text};
use crate::ui::{self, Size, Variant, ico};

impl JlApp {
    pub fn render_logs(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let levels = [(Severity::Debug, "Debug", p.fg_subtle), (Severity::Info, "Info", p.fg_muted), (Severity::Warn, "Warnings", p.warning), (Severity::Error, "Errors", p.danger)];
        let mut chips = div().flex().gap(px(6.));
        for (i, (_, label, color)) in levels.iter().enumerate() {
            let on = self.log_levels[i];
            let n = self.logs.iter().filter(|l| l.level as usize == i).count();
            chips = chips.child(
                div()
                    .id(("level", i))
                    .h(px(26.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded_full()
                    .text_size(px(text::SMALL))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .border_1()
                    .border_color(if on { color.opacity(0.4) } else { p.border })
                    .bg(if on { color.opacity(0.1) } else { gpui_kit::transparent_black() })
                    .text_color(if on { p.fg } else { p.fg_subtle })
                    .active(|d| d.opacity(0.8))
                    .child(ui::dot(*color, 6.))
                    .child(*label)
                    .child(div().text_color(p.fg_subtle).font_features(ui::tnum()).child(n.to_string()))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.log_levels[i] = !this.log_levels[i];
                        cx.notify();
                    })),
            );
        }

        let (source_name, source_pid) = match (&self.live_logs, self.demo) {
            (Some(l), _) => (l.name.clone(), Some(l.pid)),
            (None, true) => ("Simulator".into(), Some(8211)),
            (None, false) => (SharedString::from("Choose an app"), None),
        };
        let source_icon = source_pid.and_then(|pid| self.source_icons.get(&SharedString::from(format!("pid:{pid}"))).cloned());
        let source = div()
            .id("log-source")
            .h(px(30.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded(px(7.))
            .border_1()
            .border_color(p.border_strong)
            .bg(p.card)
            .cursor_pointer()
            .hover(|d| d.bg(p.hover))
            .active(|d| d.bg(p.pressed))
            .map(|d| match source_icon {
                Some(icon) => d.child(img(icon).size(px(18.))),
                None => d.child(ico("app-window-mac", 14., p.fg_muted)),
            })
            .child(div().text_size(px(text::SMALL)).font_weight(FontWeight::MEDIUM).child(source_name))
            .when_some(source_pid, |d, pid| d.child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(format!("pid {pid}"))))
            .child(ico("chevron-down", 13., p.fg_subtle))
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                this.log_picker = if this.log_picker.is_some() { None } else { Some(jl_macos::running_apps()) };
                this.picker_opened = std::time::Instant::now();
                cx.notify();
            }));

        let header = self.toolbar(
            div().flex().items_center().gap(px(12.)).child(Self::page_title("Logs", p)).child(source),
            div()
                .flex()
                .gap(px(8.))
                .child(
                    ui::button_with("log-pause", Some(if self.log_paused { "play" } else { "pause" }), Some(if self.log_paused { "Resume" } else { "Pause" }.into()), Variant::Secondary, Size::Small, p)
                        .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            this.log_paused = !this.log_paused;
                            cx.notify();
                        })),
                )
                .child(
                    ui::button_with("log-record", Some(ui::RECORD_GLYPH), Some("Record this app".into()), Variant::Record, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        if this.demo {
                            this.capture_kind = crate::model::CaptureKind::App;
                            this.toggle_recording(window, cx);
                            return;
                        }
                        // Record exactly the app being tailed, or nothing.
                        let Some((pid, name)) = this.live_logs.as_ref().map(|l| (l.pid, l.name.clone())) else {
                            this.toast("app-window-mac", "Pick an app first", "Choose the app to record from the menu next to Logs.", None, cx);
                            return;
                        };
                        let id = SharedString::from(format!("app:{pid}"));
                        this.capture_kind = crate::model::CaptureKind::App;
                        match this.visible_sources().iter().position(|s| s.id == id) {
                            Some(i) => {
                                this.selected_source = i;
                                this.toggle_recording(window, cx);
                            }
                            None => {
                                this.refresh_sources(cx);
                                this.toast("app-window-mac", "Can't record that app yet", format!("{name} has no window on screen to capture. Bring one up and try again."), None, cx);
                            }
                        }
                    })),
                ),
            p,
        );

        let mut rows = div().flex().flex_col().py(px(4.));
        for (i, l) in self.logs.iter().enumerate().filter(|(_, l)| self.log_levels[l.level as usize]) {
            let color = match l.level {
                Severity::Debug => p.fg_subtle,
                Severity::Info => p.fg_muted,
                Severity::Warn => p.warning,
                Severity::Error => p.danger,
            };
            rows = rows.child(
                div()
                    .id(("log", i))
                    .flex()
                    .items_start()
                    .gap(px(12.))
                    .px(px(20.))
                    .py(px(5.))
                    .font_family(ui::mono_family())
                    .text_size(px(11.5))
                    .when(l.level == Severity::Error, |d| d.bg(p.danger_soft.opacity(0.6)))
                    .when(l.level == Severity::Warn, |d| d.bg(p.warning_soft.opacity(0.5)))
                    .hover(|d| d.bg(p.hover))
                    .child(div().w(px(86.)).flex_none().text_color(p.fg_subtle).child(l.at.format("%H:%M:%S%.3f").to_string()))
                    .child(div().w(px(6.)).flex_none().pt(px(5.)).child(ui::dot(color, 6.)))
                    .child(div().w(px(170.)).flex_none().text_color(p.fg_subtle).truncate().child(l.subsystem.clone()))
                    .child(div().flex_1().min_w_0().text_color(if l.level >= Severity::Warn { color } else { p.fg }).child(l.message.clone())),
            );
        }

        // The picker grows down out of its button: a short fade and a few points of travel.
        let (pt, picker_moving) = crate::theme::ease::progress(self.picker_opened, crate::theme::ease::POPOVER);
        if picker_moving && self.log_picker.is_some() {
            window.request_animation_frame();
        }
        let picker_drop = if cx.reduce_motion() { 0. } else { -6. * (1. - pt) };
        let picker = self.log_picker.clone().map(|apps| {
            let mut list = div().flex().flex_col().p(px(6.));
            for (i, a) in apps.into_iter().enumerate() {
                let icon = self.source_icons.get(&SharedString::from(format!("pid:{}", a.pid))).cloned();
                let name: SharedString = a.name.clone().into();
                let pid = a.pid;
                list = list.child(
                    div()
                        .id(("log-app", i))
                        .h(px(32.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(7.))
                        .cursor_pointer()
                        .hover(|d| d.bg(p.hover))
                        .active(|d| d.bg(p.pressed))
                        .map(|d| match icon {
                            Some(icon) => d.child(img(icon).size(px(20.))),
                            None => d.child(div().size(px(20.)).flex().items_center().justify_center().child(ico("app-window-mac", 14., p.fg_muted))),
                        })
                        .child(div().flex_1().text_size(px(text::BODY)).truncate().child(name.clone()))
                        .child(div().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(format!("pid {pid}")))
                        .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                            this.log_picker = None;
                            let bundle = this.source_targets.get(&SharedString::from(format!("app:{pid}"))).and_then(|t| t.bundle_path.clone());
                            this.attach_logs(pid, name.clone(), bundle, cx);
                        })),
                );
            }
            div()
                .id("log-picker")
                .absolute()
                .opacity(pt)
                .top(px(46. + picker_drop))
                .left(px(80.))
                .w(px(300.))
                .max_h(px(420.))
                .overflow_y_scroll()
                .rounded(px(10.))
                .bg(p.elevated)
                .border_1()
                .border_color(p.border_strong)
                .shadow(ui::shadow_lg(p))
                .child(list)
        });
        let empty = self.logs.is_empty().then(|| {
            if self.live_logs.is_some() {
                ui::empty_state("scroll-text", "Listening…", "Lines appear here as the app logs them. Use it, and watch.", p)
            } else {
                ui::empty_state("scroll-text", "Tail any app's log", "Pick a running app above. Its unified log streams here live, with secrets masked — no Console.app needed.", p)
            }
        });

        div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .child(header)
            .child(
                div()
                    .px(px(20.))
                    .py(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .border_b_1()
                    .border_color(p.border)
                    .child(chips)
                    .child(div().flex_1())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(text::CAPTION))
                            .text_color(p.fg_subtle)
                            .child(ui::dot(if self.log_paused { p.warning } else { p.primary }, 6.))
                            .child(if self.log_paused { "Paused" } else { "Streaming · secrets masked" }),
                    ),
            )
            .child(div().id("log-scroll").flex_1().overflow_y_scroll().track_scroll(&self.log_scroll).child(rows).children(empty))
            .children(picker)
    }
}
