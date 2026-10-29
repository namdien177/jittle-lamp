//! Small building blocks shared by every page.
//!
//! Press feedback lands on mouse-down (GPUI's `active` style), never on release. Hover only tints;
//! nothing moves under the pointer.

use std::sync::Arc;

use chrono::{DateTime, Local};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::assets::icon;
use crate::theme::{Palette, text};

pub fn ico(name: &str, size: f32, color: Hsla) -> Svg {
    svg().path(icon(name)).size(px(size)).flex_none().text_color(color)
}

/// Tabular figures so changing numbers don't shift sideways.
pub fn tnum() -> FontFeatures {
    FontFeatures(Arc::new(vec![("tnum".into(), 1)]))
}

pub fn mono_family() -> SharedString {
    "Menlo".into()
}

/// Pass as a button icon for the solid record dot.
pub const RECORD_GLYPH: &str = "record";
/// The solid stop square.
pub const STOP_GLYPH: &str = "stop";

#[derive(Clone, Copy, PartialEq)]
pub enum Variant {
    Primary,
    Record,
    Secondary,
    Ghost,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Size {
    Small,
    Medium,
    Large,
}

/// A push button. Call `.on_click` on the result.
pub fn button(id: impl Into<ElementId>, label: impl Into<SharedString>, variant: Variant, size: Size, p: &Palette) -> Stateful<Div> {
    button_with(id, None, Some(label.into()), variant, size, p)
}

pub fn icon_button(id: impl Into<ElementId>, icon_name: &'static str, variant: Variant, p: &Palette) -> Stateful<Div> {
    button_with(id, Some(icon_name), None, variant, Size::Small, p).w(px(28.)).px_0().justify_center()
}

pub fn button_with(
    id: impl Into<ElementId>,
    icon_name: Option<&'static str>,
    label: Option<SharedString>,
    variant: Variant,
    size: Size,
    p: &Palette,
) -> Stateful<Div> {
    let (bg, hover, pressed, fg, border) = match variant {
        Variant::Primary => (p.primary, p.primary_hover, p.primary_pressed, p.on_primary, None),
        Variant::Record => (p.record, p.record.opacity(0.92), p.record_pressed, gpui_kit::white(), None),
        Variant::Secondary => (p.card, p.hover, p.pressed, p.fg, Some(p.border_strong)),
        Variant::Ghost => (gpui_kit::transparent_black(), p.hover, p.pressed, p.fg_muted, None),
    };
    let (h, pad, font, icon_size) = match size {
        Size::Small => (28., 10., text::SMALL, 14.),
        Size::Medium => (32., 12., text::BODY, 15.),
        Size::Large => (44., 18., text::EMPHASIS, 18.),
    };
    let mut el = div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .gap(px(6.))
        .h(px(h))
        .px(px(pad))
        .rounded(px(if size == Size::Large { 10. } else { 7. }))
        .bg(bg)
        .text_size(px(font))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .cursor_pointer()
        .active(move |s| s.bg(pressed));
    // Ghost buttons sit quietly in toolbars until the pointer finds them.
    let fg_hover = if variant == Variant::Ghost { p.fg } else { fg };
    el = el.hover(move |s| s.bg(hover).text_color(fg_hover));
    if let Some(border) = border {
        el = el.border_1().border_color(border);
    }
    if icon_name == Some(STOP_GLYPH) {
        el = el.child(div().flex_none().size(px(icon_size * 0.62)).rounded(px(2.5)).bg(fg));
    } else if icon_name == Some(RECORD_GLYPH) {
        // The record glyph is a solid dot, as on every recorder since tape decks.
        el = el.child(div().flex_none().size(px(icon_size * 0.72)).rounded_full().bg(fg));
    } else if let Some(name) = icon_name {
        el = el.child(svg().path(icon(name)).size(px(icon_size)).flex_none().text_color(fg));
    }
    if let Some(label) = label {
        el = el.child(label);
    }
    el
}

/// A key cap, e.g. `kbd("⌘K")`.
pub fn kbd(keys: impl Into<SharedString>, p: &Palette) -> Div {
    div()
        .flex_none()
        .px(px(5.))
        .h(px(18.))
        .flex()
        .items_center()
        .rounded(px(4.))
        .border_1()
        .border_color(p.border)
        .bg(p.hover)
        .text_size(px(text::CAPTION))
        .text_color(p.fg_muted)
        .child(keys.into())
}

pub fn badge(label: impl Into<SharedString>, fg: Hsla, bg: Hsla) -> Div {
    div()
        .flex_none()
        .flex()
        .items_center()
        .gap(px(4.))
        .h(px(20.))
        .px(px(7.))
        .rounded(px(5.))
        .bg(bg)
        .text_size(px(text::CAPTION))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .child(label.into())
}

pub fn dot(color: Hsla, size: f32) -> Div {
    div().flex_none().size(px(size)).rounded_full().bg(color)
}

pub fn hairline(p: &Palette) -> Div {
    div().h(px(1.)).w_full().flex_none().bg(p.border)
}

pub fn vline(p: &Palette) -> Div {
    div().w(px(1.)).h_full().flex_none().bg(p.border)
}

pub fn card(p: &Palette) -> Div {
    div().rounded(px(12.)).border_1().border_color(p.border).bg(p.card)
}

pub fn shadow_lg(p: &Palette) -> Vec<BoxShadow> {
    vec![
        BoxShadow { color: p.shadow.opacity(0.5), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false },
        BoxShadow { color: p.shadow, offset: point(px(0.), px(12.)), blur_radius: px(32.), spread_radius: px(-6.), inset: false },
    ]
}

pub fn label_caps(t: impl Into<SharedString>, p: &Palette) -> Div {
    div().text_size(px(text::CAPTION)).font_weight(FontWeight::SEMIBOLD).text_color(p.fg_subtle).child(t.into())
}

pub fn empty_state(icon_name: &'static str, title: impl Into<SharedString>, body: impl Into<SharedString>, p: &Palette) -> Div {
    div()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(10.))
        .py(px(48.))
        .child(
            div()
                .size(px(44.))
                .rounded(px(12.))
                .bg(p.hover)
                .flex()
                .items_center()
                .justify_center()
                .child(ico(icon_name, 20., p.fg_muted)),
        )
        .child(div().text_size(px(text::EMPHASIS)).font_weight(FontWeight::SEMIBOLD).text_color(p.fg).child(title.into()))
        .child(div().max_w(px(360.)).text_center().text_size(px(text::BODY)).text_color(p.fg_muted).child(body.into()))
}

/// A switch drawn to the macOS proportions. The knob slides on a spring so a fast double toggle
/// reverses smoothly instead of restarting.
pub fn switch(id: impl Into<ElementId>, on: bool, p: &Palette, window: &mut Window, cx: &mut App) -> Stateful<Div> {
    let id: ElementId = id.into();
    let t = gpui_kit::base::motion::spring((id.clone(), "knob"), if on { 1.0f32 } else { 0.0 }, crate::theme::motion::CONTROL, window, cx);
    let track = if on { p.primary } else { p.border_strong };
    div()
        .id(id)
        .flex_none()
        .w(px(32.))
        .h(px(18.))
        .rounded_full()
        .bg(track)
        .cursor_pointer()
        .relative()
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(2. + 14. * t))
                .size(px(14.))
                .rounded_full()
                .bg(gpui_kit::white())
                .shadow(vec![BoxShadow { color: hsla(0., 0., 0., 0.25), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false }]),
        )
}

pub fn format_clock(ms: u64) -> String {
    let s = ms / 1000;
    let (h, m, s) = (s / 3600, (s / 60) % 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

/// `0:14.0` style offset for event rows.
pub fn format_offset(ms: u64) -> String {
    let s = ms / 1000;
    format!("{}:{:02}.{}", s / 60, s % 60, (ms % 1000) / 100)
}

pub fn format_bytes(b: u64) -> String {
    const K: f64 = 1024.;
    let b = b as f64;
    if b < K {
        format!("{b:.0} B")
    } else if b < K * K {
        format!("{:.0} KB", b / K)
    } else if b < K * K * K {
        format!("{:.1} MB", b / K / K)
    } else {
        format!("{:.2} GB", b / K / K / K)
    }
}

pub fn format_relative(at: DateTime<Local>) -> String {
    let d = Local::now().signed_duration_since(at);
    let mins = d.num_minutes();
    if mins < 1 {
        "Just now".into()
    } else if mins < 60 {
        format!("{mins} min ago")
    } else if d.num_hours() < 24 {
        format!("{} h ago", d.num_hours())
    } else if d.num_days() < 2 {
        format!("Yesterday, {}", at.format("%H:%M"))
    } else if d.num_days() < 7 {
        at.format("%A, %H:%M").to_string()
    } else {
        at.format("%-d %b, %H:%M").to_string()
    }
}

pub fn plural(n: u32, one: &str, many: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {many}") }
}

#[cfg(test)]
mod tests {
    use super::{format_bytes, format_clock, format_offset, plural};

    #[test]
    fn clocks_drop_hours_until_needed() {
        assert_eq!(format_clock(0), "0:00");
        assert_eq!(format_clock(83_400), "1:23");
        assert_eq!(format_clock(3_723_000), "1:02:03");
    }

    #[test]
    fn offsets_show_tenths() {
        assert_eq!(format_offset(14_010), "0:14.0");
        assert_eq!(format_offset(61_950), "1:01.9");
    }

    #[test]
    fn bytes_use_binary_units() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(18 * 1024 * 1024 + 400 * 1024), "18.4 MB");
        assert_eq!(format_bytes(3 * 1024 * 1024 * 1024), "3.00 GB");
    }

    #[test]
    fn plurals() {
        assert_eq!(plural(1, "click", "clicks"), "1 click");
        assert_eq!(plural(0, "click", "clicks"), "0 clicks");
    }
}
