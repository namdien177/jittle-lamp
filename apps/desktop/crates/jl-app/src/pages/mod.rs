mod cloud;
mod library;
mod logs;
mod record;
mod runs;
mod settings;
mod viewer;

use gpui_kit::base::motion::spring;
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::theme::{Palette, motion, text};
use crate::ui::ico;

impl JlApp {
    /// A segmented control. The selection pill slides on a spring from wherever it is, so rapid
    /// clicks retarget it instead of queueing; keyboard changes would snap (none use it yet).
    #[allow(clippy::too_many_arguments)]
    pub fn segmented<T: Copy + PartialEq + 'static>(
        &self,
        id: &'static str,
        items: &[(T, &'static str, Option<&'static str>)],
        current: T,
        item_w: f32,
        on: fn(&mut Self, T, &mut Context<Self>),
        p: &Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Div {
        let index = items.iter().position(|(v, _, _)| *v == current).unwrap_or(0);
        let x = spring((id, "pill"), index as f32 * item_w, motion::MOVE.with_epsilon(0.5), window, cx);
        let mut row = div()
            .relative()
            .flex()
            .flex_none()
            .p(px(2.))
            .rounded(px(8.))
            .bg(p.hover)
            .child(
                div()
                    .absolute()
                    .top(px(2.))
                    .left(px(2. + x))
                    .w(px(item_w))
                    .h(px(26.))
                    .rounded(px(6.))
                    .bg(if p.dark { p.border_strong } else { p.card })
                    .shadow(vec![BoxShadow { color: p.shadow.opacity(0.35), offset: point(px(0.), px(1.)), blur_radius: px(2.), spread_radius: px(0.), inset: false }]),
            );
        for (i, (value, label, icon_name)) in items.iter().enumerate() {
            let value = *value;
            let selected = i == index;
            row = row.child(
                div()
                    .id((id, i))
                    .relative()
                    .w(px(item_w))
                    .h(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(px(6.))
                    .text_size(px(text::SMALL))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(if selected { p.fg } else { p.fg_muted })
                    .cursor_pointer()
                    .when_some(*icon_name, |s, name| s.child(ico(name, 13., if selected { p.fg } else { p.fg_muted })))
                    .child(*label)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        on(this, value, cx);
                        cx.notify();
                    })),
            );
        }
        row
    }
}
