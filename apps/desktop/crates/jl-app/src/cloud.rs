//! The signed-in side of the app: browser sign-in, the Keychain session, and loading Cloud and Test
//! runs from the backend. All network calls run on the background executor.

use std::sync::Arc;
use std::time::Duration;

use chrono::{Local, TimeZone};
use gpui_kit::*;
use jl_api::{ApiClient, ApiConfig, DeviceFlow, EvidenceQuery, KeychainSessionStore, PollOutcome, SessionStore, TestRunQuery, TestRunStatus};

use crate::app::JlApp;
use crate::model::{CloudEvidence, Origin, RunStatus, TestRun};

pub struct Account {
    pub name: SharedString,
    pub email: SharedString,
    pub org: SharedString,
    pub initials: SharedString,
}

pub enum SignIn {
    Starting,
    Waiting { user_code: SharedString, url: SharedString },
    Failed(SharedString),
}

#[derive(Clone)]
pub struct Cloud {
    pub api: Arc<ApiClient>,
    pub store: Arc<KeychainSessionStore>,
}

impl Cloud {
    pub fn new() -> Self {
        Self { api: Arc::new(ApiClient::new(ApiConfig::from_env())), store: Arc::new(KeychainSessionStore::default()) }
    }
}

fn local_ms(ms: i64) -> chrono::DateTime<Local> {
    Local.timestamp_millis_opt(ms).single().unwrap_or_else(Local::now)
}

fn initials(name: &str) -> String {
    name.split_whitespace().filter_map(|w| w.chars().next()).take(2).flat_map(|c| c.to_uppercase()).collect()
}

impl JlApp {
    /// Restores the Keychain session at launch and loads the signed-in pages.
    pub fn restore_session(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud_api.clone() else { return };
        cx.spawn(async move |this, cx| {
            let store = cloud.store.clone();
            let session = cx.background_executor().spawn(async move { store.load_fresh().ok().flatten() }).await;
            let Some(session) = session else {
                this.update(cx, |this, cx| {
                    this.signed_in = false;
                    cx.notify();
                })
                .ok();
                return;
            };
            cloud.api.set_session(Some(session));
            this.update(cx, |this, cx| this.refresh_cloud(cx)).ok();
        })
        .detach();
    }

    pub fn refresh_cloud(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud_api.clone() else { return };
        self.signed_in = cloud.api.is_signed_in();
        if !self.signed_in {
            cx.notify();
            return;
        }
        cx.spawn(async move |this, cx| {
            let api = cloud.api.clone();
            let (profile, evidences, runs) = cx
                .background_executor()
                .spawn(async move {
                    let profile = api.account_profile();
                    let evidences = api.list_evidences(&EvidenceQuery { limit: Some(60), ..Default::default() });
                    let runs = api.list_test_runs(&TestRunQuery { limit: Some(50), ..Default::default() });
                    (profile, evidences, runs)
                })
                .await;
            this.update(cx, |this, cx| {
                if profile.as_ref().err().is_some_and(|e| e.is_unauthorized()) {
                    this.signed_in = false;
                    this.account = None;
                    cx.notify();
                    return;
                }
                if let Ok(profile) = profile {
                    let name = profile.display_label();
                    let org = profile.active_organization().map(|o| o.name.clone()).unwrap_or_default();
                    this.account = Some(Account {
                        initials: initials(&name).into(),
                        email: profile.user.email.clone().unwrap_or_default().into(),
                        name: name.into(),
                        org: org.into(),
                    });
                }
                match evidences {
                    Ok(page) => {
                        this.cloud = page
                            .evidences
                            .into_iter()
                            .map(|e| CloudEvidence {
                                id: e.id.into(),
                                origin: if e.source_type.contains("run") { Origin::Runner } else { Origin::Browser { host: e.source_type.clone().into() } },
                                title: e.title.into(),
                                created_at: local_ms(e.created_at),
                                author: "".into(),
                                duration_ms: e.duration_ms.unwrap_or(0.).max(0.) as u64,
                                shared: false,
                            })
                            .collect();
                    }
                    Err(err) => log::warn!("evidence list failed: {err}"),
                }
                match runs {
                    Ok(page) => {
                        this.runs = page
                            .items
                            .into_iter()
                            .map(|r| {
                                let m = &r.metrics;
                                TestRun {
                                    case_key: r.test_case_key.clone().into(),
                                    title: r.test_case_title.clone().into(),
                                    status: match (r.status, r.outcome) {
                                        (TestRunStatus::Queued | TestRunStatus::Claimed, _) => RunStatus::Queued,
                                        (TestRunStatus::Running | TestRunStatus::Paused, _) => RunStatus::Running,
                                        (_, Some(jl_api::test_runs::TestRunOutcome::Passed)) => RunStatus::Passed,
                                        _ => RunStatus::Failed,
                                    },
                                    started_at: local_ms(r.started_at.unwrap_or(r.queued_at)),
                                    duration_ms: m.duration_ms.unwrap_or(0.).max(0.) as u64,
                                    steps_done: (m.steps_replayed + m.steps_agent + m.steps_handoff) as u32,
                                    steps_total: m.steps_total as u32,
                                    environment: r.environment_name.clone().unwrap_or_default().into(),
                                    evidence_id: r.evidence_id.clone().map(Into::into),
                                }
                            })
                            .collect();
                    }
                    Err(err) => log::warn!("test run list failed: {err}"),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Browser sign-in (device code): open the verification page, show the code, poll until the
    /// browser approves.
    pub fn start_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud_api.clone() else { return };
        if self.sign_in.is_none() {
            self.sheet_opened = std::time::Instant::now();
        }
        self.sign_in = Some(SignIn::Starting);
        // A newer sign-in (or a cancel) makes this flow stale; stale flows stop touching state.
        self.sign_in_generation += 1;
        let generation = self.sign_in_generation;
        cx.notify();
        cx.spawn(async move |this, cx| {
            let api = cloud.api.clone();
            let flow: Result<DeviceFlow, _> = cx.background_executor().spawn(async move { api.start_device_flow() }).await;
            let flow = match flow {
                Ok(flow) => flow,
                Err(err) => {
                    this.update(cx, |this, cx| {
                        if this.sign_in_generation != generation {
                            return;
                        }
                        this.sign_in = Some(SignIn::Failed(err.to_string().into()));
                        cx.notify();
                    })
                    .ok();
                    return;
                }
            };
            let url = flow.verification_uri_complete.clone();
            this.update(cx, |this, cx| {
                if this.sign_in_generation != generation {
                    return;
                }
                this.sign_in = Some(SignIn::Waiting { user_code: flow.user_code.clone().into(), url: url.clone().into() });
                cx.open_url(&url);
                cx.notify();
            })
            .ok();
            let mut interval = flow.interval();
            loop {
                cx.background_executor().timer(interval).await;
                // Stop polling when the sheet was dismissed.
                if !this.update(cx, |this, _| this.sign_in_generation == generation && matches!(this.sign_in, Some(SignIn::Waiting { .. }))).unwrap_or(false) {
                    return;
                }
                let api = cloud.api.clone();
                let code = flow.device_code.clone();
                let outcome = cx.background_executor().spawn(async move { api.poll_device_flow(&code) }).await;
                let message = match outcome {
                    Ok(PollOutcome::Pending { interval: next }) => {
                        interval = next.max(Duration::from_secs(1));
                        continue;
                    }
                    Ok(PollOutcome::Approved(session)) => {
                        let store = cloud.store.clone();
                        let saved = session.clone();
                        cx.background_executor().spawn(async move { store.save(&saved) }).await.ok();
                        cloud.api.set_session(Some(session));
                        this.update(cx, |this, cx| {
                            this.sign_in = None;
                            this.refresh_cloud(cx);
                            this.toast("circle-check", "Signed in", "Cloud, sharing and test runs are ready.", None, cx);
                        })
                        .ok();
                        return;
                    }
                    Ok(PollOutcome::Expired) => "The sign-in request expired. Start again.".to_string(),
                    Ok(PollOutcome::Denied) => "The sign-in request was denied in the browser.".to_string(),
                    Err(err) => err.to_string(),
                };
                this.update(cx, |this, cx| {
                    if this.sign_in_generation != generation {
                        return;
                    }
                    this.sign_in = Some(SignIn::Failed(message.into()));
                    cx.notify();
                })
                .ok();
                return;
            }
        })
        .detach();
    }

    /// Downloads an uploaded recording (or a test run's evidence) into a temp folder and opens it
    /// in the same viewer as local recordings.
    pub fn open_remote(&mut self, evidence_id: SharedString, title: SharedString, cx: &mut Context<Self>) {
        if self.demo {
            self.open_session(0, cx);
            return;
        }
        let Some(cloud) = self.cloud_api.clone() else { return };
        self.toast("cloud-upload", "Opening from the cloud…", title.clone(), None, cx);
        cx.spawn(async move |this, cx| {
            let api = cloud.api.clone();
            let id = evidence_id.to_string();
            let loaded = cx
                .background_executor()
                .spawn(async move {
                    let remote = api.open_remote_evidence(&id, None)?;
                    jl_core::library::load_folder(&remote.folder)
                })
                .await;
            this.update(cx, |this, cx| {
                this.toasts.retain(|t| t.title.as_ref() != "Opening from the cloud…");
                match loaded {
                    Ok(loaded) => this.open_loaded(loaded, crate::model::Sync::Synced, Some(evidence_id.to_string()), cx),
                    Err(err) => this.toast("cloud-off", "Couldn't open it", format!("{err:#}"), None, cx),
                }
            })
            .ok();
        })
        .detach();
    }

    pub fn sign_out(&mut self, cx: &mut Context<Self>) {
        let Some(cloud) = self.cloud_api.clone() else { return };
        cloud.api.set_session(None);
        let store = cloud.store.clone();
        cx.background_executor().spawn(async move { store.clear() }).detach();
        self.signed_in = false;
        self.account = None;
        self.cloud.clear();
        self.runs.clear();
        cx.notify();
    }
}

impl JlApp {
    /// The sign-in sheet: the one-time code, large and spaced so it can be compared with the browser
    /// at a glance, and a live status line.
    pub fn render_sign_in(&mut self, p: &crate::theme::Palette, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
        use crate::theme::text;
        use crate::ui::{self, Size, Variant, ico};
        use gpui_kit::prelude::*;

        let state = self.sign_in.as_ref()?;
        let (title, body, code, url, failed): (&str, SharedString, Option<SharedString>, Option<SharedString>, bool) = match state {
            SignIn::Starting => ("Signing in…", "Opening your browser.".into(), None, None, false),
            SignIn::Waiting { user_code, url } => ("Confirm in your browser", "Check that the browser shows this code, then approve.".into(), Some(user_code.clone()), Some(url.clone()), false),
            SignIn::Failed(message) => ("Couldn't sign in", message.clone(), None, None, true),
        };
        let spaced = code.map(|c| c.chars().map(|ch| ch.to_string()).collect::<Vec<_>>().join(" "));
        // A modal: the scrim fades in and the card rises a few points, centred (no trigger to grow from).
        let (t, moving) = crate::theme::ease::progress(self.sheet_opened, crate::theme::ease::ENTER);
        if moving {
            window.request_animation_frame();
        }
        let rise = if cx.reduce_motion() { 0. } else { 10. * (1. - t) };
        Some(
            div()
                .id("sign-in-scrim")
                .absolute()
                .inset_0()
                .bg(p.scrim.opacity(t))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    div()
                        .id("sign-in")
                        .relative()
                        .top(px(rise))
                        .opacity(t)
                        .w(px(420.))
                        .p(px(24.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(14.))
                        .rounded(px(16.))
                        .bg(p.elevated)
                        .border_1()
                        .border_color(p.border_strong)
                        .shadow(ui::shadow_lg(p))
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(
                            div()
                                .size(px(44.))
                                .rounded(px(12.))
                                .bg(if failed { p.danger_soft } else { p.primary_soft })
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(ico(if failed { "circle-alert" } else { "log-in" }, 20., if failed { p.danger } else { p.primary })),
                        )
                        .child(div().text_size(px(text::TITLE)).font_weight(FontWeight::SEMIBOLD).child(title))
                        .child(div().text_center().text_size(px(text::BODY)).text_color(p.fg_muted).child(body))
                        .when_some(spaced, |d, code| {
                            d.child(
                                div()
                                    .my(px(4.))
                                    .px(px(18.))
                                    .py(px(10.))
                                    .rounded(px(10.))
                                    .bg(p.hover)
                                    .text_size(px(26.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .font_family(ui::mono_family())
                                    .child(code),
                            )
                            .child(div().flex().items_center().gap(px(8.)).text_size(px(text::SMALL)).text_color(p.fg_subtle).child(ui::dot(p.primary, 6.)).child("Waiting for approval"))
                        })
                        .child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .gap(px(8.))
                                .child(ui::button("sign-in-cancel", if failed { "Close" } else { "Cancel" }, Variant::Secondary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                    this.sign_in = None;
                                    this.sign_in_generation += 1;
                                    cx.notify();
                                })))
                                .when_some(url, |d, url| {
                                    d.child(ui::button("sign-in-reopen", "Open browser again", Variant::Primary, Size::Medium, p).on_click(move |_, _, cx| cx.open_url(&url)))
                                })
                                .when(failed, |d| {
                                    d.child(ui::button("sign-in-retry", "Try again", Variant::Primary, Size::Medium, p).on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.start_sign_in(cx))))
                                }),
                        ),
                )
                .into_any_element(),
        )
    }
}
