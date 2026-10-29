//! Settings, grouped the way System Settings groups them: one card per topic, one row per choice.

use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::app::JlApp;
use crate::theme::{Palette, text};
use crate::ui::{self, Size, Variant, ico, kbd};

impl JlApp {
    pub fn render_settings(&mut self, p: &Palette, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sync = ui::switch("auto-sync", self.auto_sync, p, window, cx).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
            this.auto_sync = !this.auto_sync;
            this.save_config(cx);
            cx.notify();
        }));
        let login_on = matches!(self.launch_at_login, jl_macos::LaunchAtLogin::Enabled | jl_macos::LaunchAtLogin::RequiresApproval);
        let login_available = !matches!(self.launch_at_login, jl_macos::LaunchAtLogin::Unavailable);
        let login = ui::switch("login", login_on, p, window, cx)
            .when(!login_available, |d| d.opacity(0.4))
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                match jl_macos::set_launch_at_login(!login_on) {
                    Ok(()) => this.launch_at_login = jl_macos::launch_at_login(),
                    Err(err) => this.toast("circle-alert", "Couldn't change login items", err.to_string(), None, cx),
                }
                cx.notify();
            }));
        let perms = if self.demo { None } else { Some(jl_capture::permissions()) };
        let perm_control = |id: &'static str, status: Option<jl_capture::PermissionStatus>, pane: jl_capture::SettingsPane, cx: &mut Context<Self>| -> AnyElement {
            use jl_capture::PermissionStatus::*;
            match status {
                Some(Granted) | None => ui::badge("Allowed", p.primary, p.primary_soft).into_any_element(),
                Some(NotDetermined) => ui::button(id, "Allow…", Variant::Secondary, Size::Small, p)
                    .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                        match pane {
                            jl_capture::SettingsPane::ScreenRecording => {
                                jl_capture::permissions::request_screen_recording();
                            }
                            jl_capture::SettingsPane::Accessibility => {
                                jl_capture::permissions::request_accessibility();
                            }
                            jl_capture::SettingsPane::InputMonitoring => {
                                jl_capture::permissions::request_input_monitoring();
                            }
                            jl_capture::SettingsPane::Microphone => {
                                // Blocks until answered, so ask off the main thread.
                                cx.background_executor().spawn(async { jl_capture::permissions::request_microphone() }).detach();
                            }
                        }
                        this.toast("monitor", "Check System Settings", "macOS asks once; if nothing appeared, turn Jittle Lamp on in Privacy & Security.", None, cx);
                    }))
                    .into_any_element(),
                Some(_) => ui::button(id, "Open Settings", Variant::Secondary, Size::Small, p)
                    .on_click(move |_, _, _| {
                        jl_capture::open_settings(pane).ok();
                    })
                    .into_any_element(),
            }
        };
        let screen_ctl = perm_control("perm-screen", perms.as_ref().map(|p| p.screen_recording), jl_capture::SettingsPane::ScreenRecording, cx);
        let ax_ctl = perm_control("perm-ax", perms.as_ref().map(|p| p.accessibility), jl_capture::SettingsPane::Accessibility, cx);
        let input_ctl = perm_control("perm-input", perms.as_ref().map(|p| p.input_monitoring), jl_capture::SettingsPane::InputMonitoring, cx);
        let mic_ctl = perm_control("perm-mic", perms.as_ref().map(|p| p.microphone), jl_capture::SettingsPane::Microphone, cx);
        let group = |title: &'static str, rows: Vec<AnyElement>| {
            let n = rows.len();
            let mut card = ui::card(p).flex().flex_col();
            for (i, r) in rows.into_iter().enumerate() {
                card = card.child(div().when(i + 1 < n, |d| d.border_b_1().border_color(p.border)).child(r));
            }
            div().flex().flex_col().gap(px(8.)).child(ui::label_caps(title, p)).child(card)
        };
        let row = |icon_name: &'static str, title: &'static str, detail: SharedString, control: AnyElement| {
            div()
                .flex()
                .items_center()
                .gap(px(12.))
                .px(px(16.))
                .py(px(12.))
                .child(ico(icon_name, 16., p.fg_muted))
                .child(div().flex_1().min_w_0().flex().flex_col().child(div().text_size(px(text::BODY)).font_weight(FontWeight::MEDIUM).child(title)).child(div().text_size(px(text::SMALL)).text_color(p.fg_muted).truncate().child(detail)))
                .child(control)
                .into_any_element()
        };

        // Permissions change in System Settings while we're away; read them fresh on each visit.
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(self.toolbar(Self::page_title("Settings", p), div(), p))
            .child(
                div().id("settings-scroll").flex_1().overflow_y_scroll().child(
                    div()
                        .max_w(px(680.))
                        .mx_auto()
                        .px(px(24.))
                        .py(px(24.))
                        .flex()
                        .flex_col()
                        .gap(px(24.))
                        .child(group(
                            "STORAGE",
                            vec![
                                row("folder", "Recordings folder", self.output_dir.clone(), div().flex().gap(px(6.)).child(ui::icon_button("reveal-output", "folder-open", Variant::Ghost, p).on_click(cx.listener(|this, _: &ClickEvent, _, _| {
                                    if let Some(dir) = this.library.as_ref().map(|l| l.output_dir()) {
                                        jl_macos::reveal_in_finder(&dir).ok();
                                    }
                                }))).child(ui::button("choose-folder", "Choose…", Variant::Secondary, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.choose_output_dir(cx)))).into_any_element()),
                                row("cloud-upload", "Upload new recordings", "Sync to your organisation as soon as they finish".into(), sync.into_any_element()),
                                row("zap", "Open at login", "Keep the menu bar recorder one shortcut away".into(), login.into_any_element()),
                            ],
                        ))
                        .child(group(
                            "SHORTCUTS",
                            vec![
                                row("circle-dot", "Start or stop recording", "Works from any app".into(), kbd("⌥⇧R", p).into_any_element()),
                                row("bookmark-plus", "Add a marker", "While recording".into(), kbd("⌘⇧M", p).into_any_element()),
                                row("search", "Search the library", "".into(), kbd("⌘F", p).into_any_element()),
                            ],
                        ))
                        .child(group(
                            "PERMISSIONS",
                            vec![
                                row("monitor", "Screen Recording", "Needed to capture the screen, windows and apps".into(), screen_ctl),
                                row("mouse-pointer-click", "Accessibility", "Names the button under each click on the timeline".into(), ax_ctl),
                                row("keyboard", "Input Monitoring", "Sees clicks and shortcuts while you record — never typed text".into(), input_ctl),
                                row("mic", "Microphone", "Only when narration is on".into(), mic_ctl),
                            ],
                        ))
                        .child(group(
                            "ACCOUNT",
                            vec![
                                match self.account.as_ref().filter(|_| self.signed_in) {
                                    Some(a) => row("user-round", "Account", format!("{} · {}", a.email, a.org).into(), ui::button("sign-out", "Sign out", Variant::Secondary, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.sign_out(cx))).into_any_element()),
                                    None => row("user-round", "Account", "Sign in to upload, share and see test runs".into(), ui::button("settings-sign-in", "Sign in", Variant::Primary, Size::Small, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.start_sign_in(cx))).into_any_element()),
                                },
                                row("plug", "Browser extension", "Listening on 127.0.0.1:48115".into(), ui::badge(if self.companion_listening { "Connected" } else { "Offline" }, p.primary, p.primary_soft).into_any_element()),
                            ],
                        ))
                        .child(div().text_center().text_size(px(text::CAPTION)).text_color(p.fg_subtle).child(format!("Jittle Lamp {} for Mac", env!("CARGO_PKG_VERSION")))),
                ),
            )
    }
}

impl JlApp {
    pub fn save_config(&mut self, cx: &mut Context<Self>) {
        let Some(dir) = self.library.as_ref().map(|l| l.output_dir()) else { return };
        if let Err(err) = jl_core::config::save_to(&crate::local::config_file(), &dir.display().to_string(), Some(self.auto_sync)) {
            self.toast("circle-alert", "Couldn't save settings", format!("{err:#}"), None, cx);
        }
    }

    pub fn choose_output_dir(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Use Folder".into()) });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(dir) = paths.into_iter().next() else { return };
            this.update(cx, |this, cx| {
                if let Some(library) = this.library.as_ref() {
                    library.set_output_dir(dir.clone());
                }
                this.output_dir = dir.display().to_string().replace(&std::env::var("HOME").unwrap_or_default(), "~").into();
                this.save_config(cx);
                if let Some(companion) = this.companion.as_ref() {
                    companion.set_config(crate::local::load_config());
                }
                this.reload_library(cx);
            })
            .ok();
        })
        .detach();
    }
}
