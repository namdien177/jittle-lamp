//! Library: every local recording, newest first. Keyboard-first: ↑↓ to move, ⏎ to open, ⌘F to search.

use gpui_kit::component::input::Input;
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::{JlApp, LibraryFilter};
use crate::model::{Origin, Session, Sync};
use crate::theme::{Palette, text};
use crate::ui::{self, ico};

impl JlApp {
    pub fn render_library(&mut self, p: &Palette, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let rows = self.filtered_sessions();
        let total_bytes: u64 = self.sessions.iter().map(|s| s.bytes).sum();
        let search = div().w(px(260.)).child(Input::new(&self.search).prefix(ico("search", 14., p.fg_subtle)).cleanable(true));

        let filters = [
            (LibraryFilter::All, "All"),
            (LibraryFilter::Browser, "Browser"),
            (LibraryFilter::Apps, "Apps"),
            (LibraryFilter::Screen, "Screen"),
            (LibraryFilter::Errors, "With errors"),
        ];
        let mut chips = div().flex().gap(px(6.));
        for (i, (f, label)) in filters.into_iter().enumerate() {
            let on = self.library_filter == f;
            chips = chips.child(
                div()
                    .id(("filter", i))
                    .h(px(26.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .rounded_full()
                    .text_size(px(text::SMALL))
                    .font_weight(FontWeight::MEDIUM)
                    .cursor_pointer()
                    .when(on, |d| d.bg(p.fg).text_color(p.bg))
                    .when(!on, |d| d.bg(p.hover).text_color(p.fg_muted).hover(|d| d.text_color(p.fg)))
                    .active(|d| d.opacity(0.85))
                    .child(label)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        this.library_filter = f;
                        this.library_selected = 0;
                        cx.notify();
                    })),
            );
        }

        let mut list = div().flex().flex_col().px(px(12.)).pb(px(16.));
        if rows.is_empty() {
            list = list.child(if self.sessions.is_empty() {
                ui::empty_state("library", "No recordings yet", "Start one from Record, or stop a recording in the Chrome extension — it lands here.", p)
            } else {
                ui::empty_state("search", "Nothing matches", "Try another word, or clear the filter.", p)
            });
        }
        for (pos, &i) in rows.iter().enumerate() {
            list = list.child(self.session_row(pos, i, &self.sessions[i], pos == self.library_selected, p, cx));
        }

        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.toolbar(
                div()
                    .flex()
                    .items_baseline()
                    .gap(px(10.))
                    .child(Self::page_title("Library", p))
                    .child(div().text_size(px(text::SMALL)).text_color(p.fg_subtle).child(format!("{} · {}", ui::plural(self.sessions.len() as u32, "recording", "recordings"), ui::format_bytes(total_bytes)))),
                search,
                p,
            ))
            .child(div().px(px(24.)).py(px(12.)).child(chips))
            .child(div().id("library-scroll").flex_1().overflow_y_scroll().child(list))
    }

    fn session_row(&self, pos: usize, index: usize, s: &Session, selected: bool, p: &Palette, cx: &mut Context<Self>) -> impl IntoElement {
        let meta = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(text::SMALL))
            .text_color(p.fg_muted)
            .child(ico(s.origin.icon(), 12., p.fg_subtle))
            .child(div().truncate().child(s.origin.label()))
            .child("·")
            .child(ui::format_relative(s.recorded_at));

        let mut counts = div().flex().items_center().gap(px(14.)).text_size(px(text::SMALL)).font_features(ui::tnum()).text_color(p.fg_muted);
        let count = |icon_name: &'static str, n: u32, color: Hsla| div().flex().items_center().gap(px(5.)).child(ico(icon_name, 13., color)).child(n.to_string());
        counts = counts.child(count("mouse-pointer-click", s.actions, p.fg_subtle));
        if matches!(s.origin, Origin::Browser { .. } | Origin::Runner) {
            counts = counts.child(count("network", s.requests, p.fg_subtle));
        } else {
            counts = counts.child(count("scroll-text", s.logs, p.fg_subtle));
        }
        if s.errors > 0 {
            counts = counts.child(div().flex().items_center().gap(px(5.)).text_color(p.danger).child(ico("circle-alert", 13., p.danger)).child(s.errors.to_string()));
        }

        let mut tags = div().flex().gap(px(4.));
        for t in s.tags.iter().take(2) {
            tags = tags.child(ui::badge(t.clone(), p.fg_muted, p.hover));
        }

        div()
            .id(("session", index))
            .flex()
            .items_center()
            .gap(px(14.))
            .p(px(8.))
            .rounded(px(10.))
            .cursor_pointer()
            .when(selected, |d| d.bg(p.selected))
            .when(!selected, |d| d.hover(|d| d.bg(p.hover)))
            .active(|d| d.bg(p.pressed))
            .child(thumb(s, self.thumbs.get(&s.id).cloned(), p))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(3.))
                    .child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).text_color(p.fg).truncate().child(s.name.clone()))
                    .child(meta),
            )
            .child(tags)
            .child(counts)
            .child(div().w(px(64.)).text_right().text_size(px(text::SMALL)).text_color(p.fg_subtle).font_features(ui::tnum()).child(ui::format_bytes(s.bytes)))
            .child(sync_glyph(s.sync, p))
            .on_click(cx.listener(move |this, ev: &ClickEvent, _, cx| {
                this.library_selected = pos;
                // Click selects, double-click opens — Finder's convention.
                if ev.click_count() >= 2 {
                    this.open_session(index, cx);
                }
                cx.notify();
            }))
    }
}

fn thumb(s: &Session, poster: Option<std::sync::Arc<RenderImage>>, p: &Palette) -> impl IntoElement {
    let tint = match s.origin {
        Origin::Browser { .. } => p.info,
        Origin::Runner => p.violet,
        Origin::Screen { .. } => p.warning,
        Origin::App { .. } => p.primary,
    };
    div()
        .relative()
        .flex_none()
        .w(px(96.))
        .h(px(58.))
        .rounded(px(7.))
        .overflow_hidden()
        .border_1()
        .border_color(p.border)
        // Flat surface until the poster frame lands; the origin icon carries the colour.
        .bg(p.hover)
        .flex()
        .items_center()
        .justify_center()
        .map(|d| match poster {
            Some(image) => d.child(img(image).absolute().inset_0().size_full().object_fit(ObjectFit::Cover)),
            None => d.child(ico(s.origin.icon(), 18., tint.opacity(0.9))),
        })
        .child(
            div()
                .absolute()
                .right(px(4.))
                .bottom(px(4.))
                .px(px(4.))
                .rounded(px(4.))
                .bg(hsla(0., 0., 0., 0.62))
                .text_size(px(10.))
                .font_weight(FontWeight::MEDIUM)
                .font_features(ui::tnum())
                .text_color(gpui_kit::white())
                .child(ui::format_clock(s.duration_ms)),
        )
}

fn sync_glyph(sync: Sync, p: &Palette) -> impl IntoElement {
    let el = div().w(px(22.)).flex().justify_center();
    match sync {
        Sync::Local => el.child(ico("cloud", 15., p.fg_subtle.opacity(0.6))),
        Sync::Synced => el.child(ico("cloud-check", 15., p.primary)),
        Sync::Failed => el.child(ico("cloud-off", 15., p.danger)),
        Sync::Uploading(f) => el.child(
            div()
                .w(px(18.))
                .h(px(4.))
                .rounded_full()
                .bg(p.border_strong)
                .child(div().h_full().w(px(18. * f)).rounded_full().bg(p.primary)),
        ),
    }
}
