//! Cloud: the organisation's uploaded evidence.

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::theme::{Palette, text};
use crate::ui::{self, Size, Variant, ico};

impl JlApp {
    pub fn render_cloud(&mut self, p: &Palette, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let header = self.toolbar(
            div().flex().items_baseline().gap(px(10.)).child(Self::page_title("Cloud", p)).child(div().text_size(px(text::SMALL)).text_color(p.fg_subtle).child(self.account.as_ref().map(|a| a.org.clone()).unwrap_or_default())),
            div()
                .flex()
                .gap(px(8.))
                .child(ui::icon_button("cloud-refresh", "refresh-cw", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.refresh_cloud(cx))))
                .child(ui::button_with("open-web", Some("arrow-up-right"), Some("Open in browser".into()), Variant::Secondary, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    let url = this.cloud_api.as_ref().map(|c| c.api.config().web_origin.clone()).unwrap_or_default();
                    if !url.is_empty() {
                        cx.open_url(&url);
                    }
                }))),
            p,
        );
        if !self.signed_in {
            return div().flex().flex_col().size_full().child(header).child(
                div().flex_1().flex().items_center().justify_center().child(
                    ui::empty_state("cloud", "Sign in to see your team's evidence", "Uploads, share links and test runs live in your organisation's workspace.", p).child(
                        ui::button_with("sign-in", Some("log-in"), Some("Sign in with browser".into()), Variant::Primary, Size::Medium, p)
                            .mt(px(6.))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.start_sign_in(cx))),
                    ),
                ),
            );
        }

        let mut grid = div().flex().flex_wrap().gap(px(16.)).p(px(24.));
        for (i, e) in self.cloud.iter().enumerate() {
            let (eid, etitle) = (e.id.clone(), e.title.clone());
            grid = grid.child(
                div()
                    .id(("cloud", i))
                    .w(px(268.))
                    .flex()
                    .flex_col()
                    .rounded(px(12.))
                    .overflow_hidden()
                    .border_1()
                    .border_color(p.border)
                    .bg(p.card)
                    .cursor_pointer()
                    .hover(|d| d.border_color(p.border_strong))
                    .active(|d| d.bg(p.hover))
                    .child(
                        div()
                            .relative()
                            .h(px(140.))
                            .bg(p.hover)
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(ico(e.origin.icon(), 26., p.fg_muted))
                            .child(
                                div()
                                    .absolute()
                                    .right(px(8.))
                                    .bottom(px(8.))
                                    .px(px(5.))
                                    .rounded(px(4.))
                                    .bg(hsla(0., 0., 0., 0.62))
                                    .text_size(px(10.))
                                    .font_features(ui::tnum())
                                    .text_color(gpui_kit::white())
                                    .child(ui::format_clock(e.duration_ms)),
                            )
                            .when(e.shared, |d| d.child(div().absolute().left(px(8.)).top(px(8.)).child(ui::badge("Shared", p.primary, p.bg.opacity(0.85))))),
                    )
                    .child(
                        div()
                            .p(px(12.))
                            .flex()
                            .flex_col()
                            .gap(px(4.))
                            .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).line_clamp(2).child(e.title.clone()))
                            .child(div().text_size(px(text::CAPTION)).text_color(p.fg_muted).child(format!("{} · {}", e.author, ui::format_relative(e.created_at)))),
                    )
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.open_remote(eid.clone(), etitle.clone(), cx))),
            );
        }
        div().flex().flex_col().size_full().child(header).child(div().id("cloud-scroll").flex_1().overflow_y_scroll().child(grid))
    }
}
