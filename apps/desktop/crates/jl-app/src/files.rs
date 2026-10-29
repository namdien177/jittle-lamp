//! Getting recordings in and out: `jittle-lamp://` links, ZIP export, and opening a ZIP or a
//! session folder from disk.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender, unbounded};
use gpui_kit::*;

use crate::app::JlApp;
use crate::model::Sync;

static LINKS: OnceLock<(Sender<String>, Receiver<String>)> = OnceLock::new();

fn links() -> &'static (Sender<String>, Receiver<String>) {
    LINKS.get_or_init(unbounded)
}

/// Called by the platform, before and after launch, with `jittle-lamp://` URLs.
pub fn queue_urls(urls: Vec<String>) {
    for url in urls {
        let _ = links().0.send(url);
    }
}

/// What a `jittle-lamp://` link asks for. The recorder actions exist for Siri and Shortcuts:
/// "Hey Siri, record a bug" can run a shortcut that opens `jittle-lamp://record`.
#[derive(Debug, PartialEq)]
pub enum Link {
    Run(String),
    /// Start recording: the last-used source, or `?source=screen` / `?source=<app name>`.
    Record { source: Option<String> },
    Stop,
    Marker,
    Quick,
    /// The full window: the library, or one recording in it.
    Library { session: Option<String> },
}

pub fn parse_link(raw: &str) -> Option<Link> {
    if let Some(id) = parse_run_link(raw) {
        return Some(Link::Run(id));
    }
    let rest = raw.trim().strip_prefix("jittle-lamp:")?.trim_start_matches('/');
    let (action, query) = rest.split_once('?').unwrap_or((rest, ""));
    let source = query.split('&').find_map(|kv| kv.strip_prefix("source=")).map(|v| v.replace("%20", " ").replace('+', " ")).filter(|v| !v.is_empty() && v.len() < 120);
    match action.trim_end_matches('/').to_ascii_lowercase().as_str() {
        "record" | "start" => Some(Link::Record { source }),
        "stop" => Some(Link::Stop),
        "marker" => Some(Link::Marker),
        "quick" | "recorder" => Some(Link::Quick),
        "library" => Some(Link::Library { session: None }),
        "session" => {
            let id = query.split('&').find_map(|kv| kv.strip_prefix("id="))?;
            jl_capture::is_valid_session_id(id).then(|| Link::Library { session: Some(id.to_owned()) })
        }
        _ => None,
    }
}

/// `jittle-lamp://run?runId=<id>` (and the `jittle-lamp:run?…` spelling), as the Electron app and
/// the web's "Open in desktop" button produce them. Anything else is ignored.
pub fn parse_run_link(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("jittle-lamp:")?.trim_start_matches('/');
    let (action, query) = rest.split_once('?')?;
    if !action.trim_end_matches('/').eq_ignore_ascii_case("run") {
        return None;
    }
    let ids: Vec<&str> = query.split('&').filter_map(|kv| kv.strip_prefix("runId=")).collect();
    match ids.as_slice() {
        [id] if jl_api::remote::is_safe_resource_id(id) => Some(id.to_string()),
        _ => None,
    }
}

impl JlApp {
    pub fn watch_links(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(200)).await;
                let urls: Vec<String> = links().1.try_iter().collect();
                if urls.is_empty() {
                    if this.upgrade().is_none() {
                        break;
                    }
                    continue;
                }
                let alive = this.update(cx, |this, cx| {
                    for url in urls {
                        match parse_link(&url) {
                            Some(Link::Run(run_id)) => this.open_run(run_id, cx),
                            Some(Link::Record { source }) => this.record_from_link(source, cx),
                            Some(Link::Stop) => {
                                if this.recording.is_some() {
                                    this.stop_recording_now(cx);
                                }
                            }
                            Some(Link::Marker) => this.add_marker(cx),
                            Some(Link::Quick) => this.open_quick(crate::quick::QuickMode::Pick, None, cx),
                            Some(Link::Library { session }) => {
                                this.show_main_window(cx);
                                this.viewer = None;
                                this.page = crate::model::Page::Library;
                                this.pending_open_id = session;
                                this.reload_library(cx);
                            }
                            None => log::warn!("ignored link {url}"),
                        }
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    /// Starts recording without any UI first: the named source if it matches, else the last used.
    fn record_from_link(&mut self, source: Option<String>, cx: &mut Context<Self>) {
        if self.recording.is_some() {
            return;
        }
        let wanted = source.map(|s| s.to_lowercase());
        let pick = match wanted.as_deref() {
            Some("screen") | Some("display") => self.sources.iter().find(|s| s.kind == crate::model::CaptureKind::Screen).cloned(),
            Some(name) => self.sources.iter().find(|s| s.kind == crate::model::CaptureKind::App && s.name.to_lowercase() == name).cloned(),
            None => self.last_source_id.as_ref().and_then(|id| self.sources.iter().find(|s| &s.id == id)).or_else(|| self.sources.iter().find(|s| s.kind == crate::model::CaptureKind::Screen)).cloned(),
        };
        let Some(pick) = pick else {
            // Nothing to match yet (sources still loading or not allowed): let the user choose.
            self.open_quick(crate::quick::QuickMode::Pick, None, cx);
            return;
        };
        self.capture_kind = pick.kind;
        self.selected_source = self.visible_sources().iter().position(|s| s.id == pick.id).unwrap_or(0);
        self.last_source_id = Some(pick.id.clone());
        self.start_recording_now(cx);
        self.sync_system();
    }

    fn open_run(&mut self, run_id: String, cx: &mut Context<Self>) {
        cx.activate(true);
        let Some(cloud) = self.cloud_api.clone().filter(|_| self.signed_in) else {
            self.toast("log-in", "Sign in to open the run", "Links to test runs need your organisation's workspace.", None, cx);
            self.start_sign_in(cx);
            return;
        };
        cx.spawn(async move |this, cx| {
            let api = cloud.api.clone();
            let run = cx.background_executor().spawn(async move { api.get_test_run(&run_id) }).await;
            this.update(cx, |this, cx| match run {
                Ok(run) => match run.summary.evidence_id.clone() {
                    Some(id) => this.open_remote(id.into(), run.summary.test_case_title.clone().into(), cx),
                    None => {
                        this.page = crate::model::Page::Runs;
                        this.toast("clock", "No recording yet", format!("{} is still {:?}.", run.summary.test_case_key, run.summary.status).to_lowercase(), None, cx);
                    }
                },
                Err(err) => this.toast("circle-alert", "Couldn't open the run", err.to_string(), None, cx),
            })
            .ok();
        })
        .detach();
    }

    /// The viewer's download button: the same ZIP the web exports, so it round-trips.
    pub fn export_zip(&mut self, cx: &mut Context<Self>) {
        let Some(loaded) = self.viewer.as_ref().and_then(|v| v.loaded.as_ref()) else { return };
        let folder = loaded.folder.clone();
        let name = format!("{}.zip", sanitize(&loaded.archive.name));
        let downloads = dirs_downloads();
        let path = cx.prompt_for_new_path(&downloads, Some(&name));
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(dest))) = path.await else { return };
            let target = dest.clone();
            let written = cx.background_executor().spawn(async move { jl_core::zip::write_session_zip(&folder, &target) }).await;
            this.update(cx, |this, cx| match written {
                Ok(()) => {
                    jl_macos::reveal_in_finder(&dest).ok();
                    this.toast("download", "Exported", dest.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(), None, cx);
                }
                Err(err) => this.toast("circle-alert", "Couldn't export", format!("{err:#}"), None, cx),
            })
            .ok();
        })
        .detach();
    }

    /// ⌘O: a ZIP someone sent you, or a session folder anywhere on disk.
    pub fn open_file(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions { files: true, directories: true, multiple: false, prompt: Some("Open".into()) });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            let loaded = cx
                .background_executor()
                .spawn(async move {
                    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) {
                        jl_core::zip::import_zip_file(&path)
                    } else {
                        jl_core::library::load_folder(&path)
                    }
                })
                .await;
            this.update(cx, |this, cx| match loaded {
                Ok(loaded) => this.open_loaded(loaded, Sync::Local, None, cx),
                Err(err) => this.toast("circle-alert", "Couldn't open that", format!("{err:#}"), None, cx),
            })
            .ok();
        })
        .detach();
    }
}

fn sanitize(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '-' }).collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() { "recording".into() } else { s.chars().take(80).collect() }
}

fn dirs_downloads() -> PathBuf {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Downloads")).unwrap_or_else(|| PathBuf::from("/tmp"))
}

#[cfg(test)]
mod tests {
    use super::{Link, parse_link, parse_run_link, sanitize};

    #[test]
    fn recorder_links_for_siri_shortcuts() {
        assert_eq!(parse_link("jittle-lamp://record"), Some(Link::Record { source: None }));
        assert_eq!(parse_link("jittle-lamp://record?source=Google%20Chrome"), Some(Link::Record { source: Some("Google Chrome".into()) }));
        assert_eq!(parse_link("jittle-lamp://stop"), Some(Link::Stop));
        assert_eq!(parse_link("jittle-lamp:marker"), Some(Link::Marker));
        assert_eq!(parse_link("jittle-lamp://run?runId=r1"), Some(Link::Run("r1".into())));
        assert_eq!(parse_link("jittle-lamp://delete"), None);
        assert_eq!(parse_link("jittle-lamp://library"), Some(Link::Library { session: None }));
        assert_eq!(parse_link("jittle-lamp://session?id=jl_abc12345"), Some(Link::Library { session: Some("jl_abc12345".into()) }));
        assert_eq!(parse_link("jittle-lamp://session?id=../etc"), None);
    }

    #[test]
    fn run_links() {
        assert_eq!(parse_run_link("jittle-lamp://run?runId=abc-123").as_deref(), Some("abc-123"));
        assert_eq!(parse_run_link("jittle-lamp:run?runId=abc_123").as_deref(), Some("abc_123"));
        assert_eq!(parse_run_link("jittle-lamp:///run/?runId=R1").as_deref(), Some("R1"));
        assert_eq!(parse_run_link("jittle-lamp://run?runId=a&runId=b"), None);
        assert_eq!(parse_run_link("jittle-lamp://run?runId=../etc"), None);
        assert_eq!(parse_run_link("jittle-lamp://evidence?runId=x"), None);
        assert_eq!(parse_run_link("https://run?runId=x"), None);
    }

    #[test]
    fn zip_names_are_safe() {
        assert_eq!(sanitize("Checkout / voucher: 500?"), "Checkout - voucher- 500-");
        assert_eq!(sanitize("..."), "recording");
    }
}
