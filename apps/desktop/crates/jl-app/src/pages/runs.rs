//! Test runs: cloud runner results, with live progress for runs in flight.

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::RunStatus;
use crate::theme::{Palette, text};
use crate::ui::{self, ico};

impl JlApp {
    pub fn render_runs(&mut self, p: &Palette, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = self.toolbar(Self::page_title("Test runs", p), div().flex().gap(px(8.)).child(ui::icon_button("runs-refresh", "refresh-cw", ui::Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.refresh_cloud(cx)))), p);
        let mut list = div().flex().flex_col().px(px(12.)).py(px(12.));
        if self.runs.is_empty() {
            list = list.child(if self.signed_in {
                ui::empty_state("flask-conical", "No test runs yet", "Runs started from the web or the MCP server show up here with live progress.", p)
            } else {
                ui::empty_state("flask-conical", "Sign in to see test runs", "Runner results for your organisation, with the recording of every step.", p)
            });
        }
        for (i, r) in self.runs.iter().enumerate() {
            let (label, fg, bg, icon_name) = match r.status {
                RunStatus::Running => ("Running", p.info, p.info_soft, "activity"),
                RunStatus::Passed => ("Passed", p.primary, p.primary_soft, "circle-check"),
                RunStatus::Failed => ("Failed", p.danger, p.danger_soft, "circle-x"),
                RunStatus::Queued => ("Queued", p.fg_muted, p.hover, "clock"),
            };
            let (evidence, run_title) = (r.evidence_id.clone(), r.title.clone());
            let frac = if r.steps_total == 0 { 0. } else { r.steps_done as f32 / r.steps_total as f32 };
            list = list.child(
                div()
                    .id(("run", i))
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .px(px(12.))
                    .py(px(12.))
                    .rounded(px(10.))
                    .cursor_pointer()
                    .hover(|d| d.bg(p.hover))
                    .active(|d| d.bg(p.pressed))
                    .child(div().size(px(32.)).rounded(px(8.)).bg(bg).flex().items_center().justify_center().child(ico(icon_name, 16., fg)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(px(3.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(div().text_size(px(text::CAPTION)).font_family(ui::mono_family()).text_color(p.fg_subtle).child(r.case_key.clone()))
                                    .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).truncate().child(r.title.clone())),
                            )
                            .child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).child(format!("{} · {}", r.environment, ui::format_relative(r.started_at)))),
                    )
                    .child(
                        div()
                            .w(px(160.))
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).font_features(ui::tnum()).child(format!("{} of {} steps", r.steps_done, r.steps_total)))
                            .child(div().h(px(4.)).w_full().rounded_full().bg(p.hover).child(div().h_full().w(relative(frac)).rounded_full().bg(fg))),
                    )
                    .child(div().w(px(56.)).text_right().text_size(px(text::SMALL)).font_features(ui::tnum()).text_color(p.fg_subtle).child(if r.duration_ms > 0 { ui::format_clock(r.duration_ms) } else { "—".into() }))
                    .child(ui::badge(label, fg, bg))
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| match evidence.clone() {
                        Some(id) => this.open_remote(id, run_title.clone(), cx),
                        None if this.demo => this.open_session(4, cx),
                        None => this.toast("clock", "No recording yet", "The runner uploads the recording when the run finishes.", None, cx),
                    })),
            );
        }
        div().flex().flex_col().size_full().child(header).child(div().id("runs-scroll").flex_1().overflow_y_scroll().child(list))
    }
}
