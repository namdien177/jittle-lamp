//! ⌘K: jump to any page, recording or command by typing. Used many times a day, so it opens and
//! closes instantly — no animation.

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::Page;
use crate::theme::{Palette, text};
use crate::ui::{self, ico, kbd};

#[derive(Clone)]
pub enum Command {
    Go(Page),
    StartRecording,
    StopRecording,
    Open(usize),
    OpenFile,
}

pub struct Item {
    pub icon: &'static str,
    pub title: SharedString,
    pub hint: SharedString,
    pub keys: Option<&'static str>,
    pub command: Command,
}

pub struct PaletteState {
    pub input: Entity<InputState>,
    pub selected: usize,
    _sub: Subscription,
}

impl JlApp {
    pub fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.is_some() {
            self.close_palette(window, cx);
            return;
        }
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search pages, recordings and commands"));
        let sub = cx.subscribe_in(&input, window, |this: &mut Self, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::Change => {
                if let Some(p) = this.palette.as_mut() {
                    p.selected = 0;
                }
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.run_selected(window, cx),
            _ => {}
        });
        input.update(cx, |s, cx| s.focus(window, cx));
        self.palette = Some(PaletteState { input, selected: 0, _sub: sub });
        cx.notify();
    }

    pub fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette = None;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    fn palette_items(&self, cx: &App) -> Vec<Item> {
        let query = self.palette.as_ref().map(|p| p.input.read(cx).value().to_lowercase()).unwrap_or_default();
        let mut items = Vec::new();
        if self.recording.is_some() {
            items.push(Item { icon: "square", title: "Stop recording".into(), hint: "Saves and opens the review".into(), keys: Some("⌥⇧R"), command: Command::StopRecording });
        } else {
            items.push(Item { icon: "circle-dot", title: "Start recording".into(), hint: "With the current source and options".into(), keys: Some("⌥⇧R"), command: Command::StartRecording });
        }
        items.push(Item { icon: "folder-open", title: "Open recording file…".into(), hint: "A ZIP or a session folder".into(), keys: Some("⌘O"), command: Command::OpenFile });
        for page in Page::MAIN.into_iter().chain([Page::Settings]) {
            items.push(Item { icon: page.icon(), title: format!("Go to {}", page.title()).into(), hint: "".into(), keys: Some(page.shortcut()), command: Command::Go(page) });
        }
        for (i, s) in self.sessions.iter().enumerate() {
            items.push(Item { icon: s.origin.icon(), title: s.name.clone(), hint: format!("{} · {}", s.origin.label(), ui::format_relative(s.recorded_at)).into(), keys: None, command: Command::Open(i) });
        }
        if query.is_empty() {
            items.truncate(9);
            return items;
        }
        // Every word must appear somewhere in the title or hint; titles that start with the query rank first.
        let words: Vec<&str> = query.split_whitespace().collect();
        let mut scored: Vec<(usize, Item)> = items
            .into_iter()
            .filter_map(|it| {
                let hay = format!("{} {}", it.title, it.hint).to_lowercase();
                if !words.iter().all(|w| hay.contains(w)) {
                    return None;
                }
                let title = it.title.to_lowercase();
                let score = if title.starts_with(&query) { 0 } else if title.contains(&query) { 1 } else { 2 };
                Some((score, it))
            })
            .collect();
        scored.sort_by_key(|(s, _)| *s);
        scored.into_iter().map(|(_, it)| it).take(12).collect()
    }

    fn run_selected(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let items = self.palette_items(cx);
        let Some(item) = self.palette.as_ref().and_then(|p| items.into_iter().nth(p.selected)) else { return };
        self.close_palette(window, cx);
        match item.command {
            Command::Go(page) => self.go(page, true, cx),
            Command::StartRecording | Command::StopRecording => self.toggle_recording(window, cx),
            Command::OpenFile => self.open_file(cx),
            Command::Open(i) => {
                self.page = Page::Library;
                self.open_session(i, cx);
            }
        }
    }

    pub fn render_palette(&mut self, p: &Palette, cx: &mut Context<Self>) -> Option<AnyElement> {
        let state = self.palette.as_ref()?;
        let items = self.palette_items(cx);
        let selected = state.selected.min(items.len().saturating_sub(1));
        let count = items.len();

        let mut list = div().flex().flex_col().p(px(6.));
        if items.is_empty() {
            list = list.child(div().py(px(24.)).text_center().text_size(px(text::BODY)).text_color(p.fg_muted).child("No matches"));
        }
        for (i, it) in items.into_iter().enumerate() {
            let on = i == selected;
            list = list.child(
                div()
                    .id(("palette", i))
                    .h(px(40.))
                    .px(px(10.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .rounded(px(8.))
                    .cursor_pointer()
                    .when(on, |d| d.bg(p.selected))
                    .child(ico(it.icon, 15., if on { p.fg } else { p.fg_muted }))
                    .child(div().text_size(px(text::BODY)).text_color(p.fg).truncate().child(it.title))
                    .child(div().flex_1().min_w_0().text_size(px(text::SMALL)).text_color(p.fg_subtle).truncate().child(it.hint))
                    .when_some(it.keys, |d, k| d.child(kbd(k, p)))
                    .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
                        if let Some(p) = this.palette.as_mut()
                            && p.selected != i {
                                p.selected = i;
                                cx.notify();
                            }
                    }))
                    .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                        if let Some(p) = this.palette.as_mut() {
                            p.selected = i;
                        }
                        this.run_selected(window, cx);
                    })),
            );
        }

        let input = state.input.clone();
        Some(
            div()
                .id("palette-scrim")
                .absolute()
                .inset_0()
                .bg(p.scrim.opacity(0.5))
                .flex()
                .justify_center()
                .pt(px(96.))
                .on_mouse_down(MouseButton::Left, cx.listener(|this, _: &MouseDownEvent, window, cx| this.close_palette(window, cx)))
                .child(
                    div()
                        .id("palette")
                        .w(px(620.))
                        .max_h(px(520.))
                        .flex()
                        .flex_col()
                        .rounded(px(14.))
                        .bg(p.elevated)
                        .border_1()
                        .border_color(p.border_strong)
                        .shadow(ui::shadow_lg(p))
                        .overflow_hidden()
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .capture_key_down(cx.listener(move |this, ev: &KeyDownEvent, window, cx| {
                            let key = ev.keystroke.key.as_str();
                            let Some(p) = this.palette.as_mut() else { return };
                            match key {
                                "down" => p.selected = (p.selected + 1).min(count.saturating_sub(1)),
                                "up" => p.selected = p.selected.saturating_sub(1),
                                "escape" => {
                                    this.close_palette(window, cx);
                                    cx.stop_propagation();
                                    return;
                                }
                                _ => return,
                            }
                            cx.stop_propagation();
                            cx.notify();
                        }))
                        .child(div().p(px(10.)).border_b_1().border_color(p.border).child(Input::new(&input).appearance(false).prefix(ico("search", 15., p.fg_subtle))))
                        .child(div().id("palette-list").flex_1().overflow_y_scroll().child(list)),
                )
                .into_any_element(),
        )
    }
}
