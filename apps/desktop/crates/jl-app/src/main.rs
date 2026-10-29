mod app;
mod assets;
mod capture;
mod cloud;
mod edit;
mod files;
mod hud;
mod local;
mod model;
mod pages;
mod share;
mod quick;
mod suggest;
mod system;
mod palette;
mod theme;
mod ui;

use gpui_kit::*;

use app::{JlApp, Quit};
use model::Page;

pub struct MainWindow(pub AnyWindowHandle);

/// Orders a window out or back in without closing it (GPUI has no per-window hide).
pub fn set_visible(window: &Window, visible: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if let Ok(handle) = HasWindowHandle::window_handle(window)
        && let RawWindowHandle::AppKit(appkit) = handle.as_raw() {
            // SAFETY: the view belongs to this live GPUI window.
            if let Err(err) = unsafe { jl_macos::set_window_visible(appkit.ns_view.as_ptr(), visible) } {
                log::warn!("window visibility: {err:#}");
            }
        }
}

/// The app entity, for platform callbacks (Dock reopen) that arrive without one.
pub struct AppHandle(pub WeakEntity<JlApp>);

impl Global for AppHandle {}

impl Global for MainWindow {}

struct Args {
    page: Page,
    open: Option<usize>,
    recording: bool,
    light: bool,
    palette: bool,
    demo: bool,
    /// Show the full window at launch (any page or session flag implies it).
    window: bool,
    /// Start silently in the menu bar (login item).
    background: bool,
    /// Snapshot the quick recorder instead of the main window: `pick`, or a library index to show its saved card.
    quick: Option<String>,
    /// `--auto-record <secs> --capture screen|<app name>`: record, stop and open the review.
    auto_record: Option<(u64, String)>,
    tail: Option<String>,
    snapshot: Option<std::path::PathBuf>,
    snapshot_delay_ms: u64,
    size: (f32, f32),
}

fn parse_args() -> Args {
    let mut args = Args { page: Page::Record, open: None, recording: false, light: false, palette: false, demo: false, window: false, background: false, quick: None, auto_record: None, tail: None, snapshot: None, snapshot_delay_ms: 900, size: (1280., 820.) };
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--page" => {
                args.window = true;
                args.page = match it.next().as_deref() {
                    Some("library") => Page::Library,
                    Some("cloud") => Page::Cloud,
                    Some("runs") => Page::Runs,
                    Some("logs") => Page::Logs,
                    Some("settings") => Page::Settings,
                    _ => Page::Record,
                }
            }
            "--open" => {
                args.window = true;
                args.open = it.next().and_then(|s| s.parse().ok());
            }
            "--recording" => args.recording = true,
            "--light" => args.light = true,
            "--palette" => args.palette = true,
            "--demo" => args.demo = true,
            "--window" => args.window = true,
            "--background" => args.background = true,
            "--quick" => args.quick = it.next(),
            "--tail" => args.tail = it.next(),
            "--auto-record" => {
                let secs = it.next().and_then(|s| s.parse().ok()).unwrap_or(4);
                args.auto_record = Some((secs, args.auto_record.take().map(|(_, c)| c).unwrap_or_else(|| "screen".into())));
            }
            "--capture" => {
                let target = it.next().unwrap_or_else(|| "screen".into());
                args.auto_record = Some((args.auto_record.map(|(s, _)| s).unwrap_or(4), target));
            }
            "--snapshot" => args.snapshot = it.next().map(Into::into),
            "--snapshot-delay" => args.snapshot_delay_ms = it.next().and_then(|s| s.parse().ok()).unwrap_or(900),
            "--size" => {
                if let Some((w, h)) = it.next().and_then(|s| s.split_once('x').map(|(w, h)| (w.parse().unwrap_or(1280.), h.parse().unwrap_or(820.)))) {
                    args.size = (w, h);
                }
            }
            _ => {}
        }
    }
    args
}

fn main() {
    env_logger::init();
    let args = parse_args();
    let application = gpui_kit::application().with_assets(assets::Assets);
    application.on_open_urls(files::queue_urls);
    // Dock icon clicked with no window showing: bring the main window back.
    // Launching the app again (Finder, Spotlight, Launchpad) while it runs in the menu bar
    // brings up the quick recorder, the everyday surface.
    application.on_reopen(|cx| {
        if let Some(app) = cx.try_global::<AppHandle>().map(|a| a.0.clone()) {
            app.update(cx, |app, cx| {
                if app.quick.is_none() {
                    app.open_quick(quick::QuickMode::Pick, None, cx);
                }
            })
            .ok();
        }
    });
    application.run(move |cx: &mut App| {
        gpui_kit::init(cx);
        if args.light {
            cx.set_global(theme::ForcedMode(gpui_kit::component::ThemeMode::Light));
        }
        theme::apply(cx);
        cx.observe_global::<gpui_kit::component::Theme>(theme::apply).detach();
        app::bind_keys(cx);
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.set_menus([
            Menu::new("Jittle Lamp").items([MenuItem::action("Quit Jittle Lamp", Quit)]),
            Menu::new("File").items([MenuItem::action("Open Recording…", app::OpenFile), MenuItem::action("Export as ZIP…", app::ExportZip)]),
            Menu::new("Record").items([
                MenuItem::action("Start or Stop Recording", app::ToggleRecording),
                MenuItem::action("Add Marker", app::AddMarker),
            ]),
            Menu::new("Go").items([
                MenuItem::action("Record", app::GoRecord),
                MenuItem::action("Library", app::GoLibrary),
                MenuItem::action("Cloud", app::GoCloud),
                MenuItem::action("Test Runs", app::GoRuns),
                MenuItem::action("Logs", app::GoLogs),
            ]),
        ]);

        let bounds = Bounds::centered(None, size(px(args.size.0), px(args.size.1)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(size(px(960.), px(620.))),
            titlebar: Some(TitlebarOptions { title: Some("Jittle Lamp".into()), appears_transparent: true, traffic_light_position: Some(point(px(16.), px(18.))) }),
            window_background: WindowBackgroundAppearance::Blurred,
            // The menu bar recorder is the everyday surface; the full window waits until asked for.
            show: args.snapshot.is_none() && args.window,
            focus: args.snapshot.is_none() && args.window,
            app_id: Some("dev.jittlelamp.desktop".into()),
            ..Default::default()
        };
        let page = args.page;
        let demo = args.demo;
        let light = args.light;
        let (window, view) = gpui_kit::open_window(options, cx, move |window, cx| {
            let _ = light;
            theme::follow_system(window, cx);
            cx.new(|cx| {
                let mut app = JlApp::new(page, demo, window, cx);
                if !demo {
                    app.start_local(cx);
                    app.watch_links(cx);
                    app.refresh_sources(cx);
                    app.restore_session(cx);
                }
                app
            })
        })
        .expect("failed to open window");
        cx.set_global(MainWindow(window));
        cx.set_global(AppHandle(view.downgrade()));
        let show_window = args.window || args.snapshot.is_some();
        view.update(cx, |app, _| app.main_visible = show_window);
        if show_window {
            cx.activate(true);
        } else {
            // Menu bar only until the full window is asked for (Info.plist sets LSUIElement too).
            cx.set_activation_policy(ActivationPolicy::Accessory);
        }
        // The menu bar recorder, hotkeys and the extension's companion server live as long as the
        // app does, so closing the window hides it and drops the Dock icon instead of quitting.
        let weak = view.downgrade();
        window
            .update(cx, |_, window, cx| {
                window.on_window_should_close(cx, move |window, cx| {
                    set_visible(window, false);
                    cx.set_activation_policy(ActivationPolicy::Accessory);
                    weak.update(cx, |app, _| app.main_visible = false).ok();
                    false
                });
            })
            .ok();

        if args.snapshot.is_none() {
            view.update(cx, |app, cx| app.install_system(cx));
            if !(args.window || args.snapshot.is_some()) && !args.background && !jl_macos::launched_as_login_item() {
                view.update(cx, |app, cx| app.open_quick(quick::QuickMode::Pick, None, cx));
            }
        }
        if let Some(i) = args.open {
            view.update(cx, |app, cx| {
                app.page = Page::Library;
                if app.demo { app.open_session(i, cx) } else { app.pending_open = Some(i) }
            });
        }
        if args.recording {
            window
                .update(cx, |_, window, cx| {
                    view.update(cx, |app, cx| {
                        app.show_hud = false;
                        app.toggle_recording(window, cx);
                        if let Some(r) = app.recording.as_mut() {
                            r.started -= std::time::Duration::from_secs(83);
                            r.clicks = 14;
                            r.keys = 6;
                            r.logs = 312;
                            r.errors = 2;
                            r.markers = 1;
                        }
                    })
                })
                .ok();
        }
        if args.palette {
            window.update(cx, |_, window, cx| view.update(cx, |app, cx| app.open_palette(window, cx))).ok();
        }
        if let Some(name) = args.tail.clone() {
            let view = view.downgrade();
            cx.spawn(async move |cx| {
                for _ in 0..50 {
                    cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                    if view.update(cx, |app, _| !app.sources.is_empty() && !app.sources_loading).unwrap_or(false) {
                        break;
                    }
                }
                view.update(cx, |app, cx| {
                    app.page = Page::Logs;
                    if let Some(a) = jl_macos::running_apps().into_iter().find(|a| a.name.eq_ignore_ascii_case(&name)) {
                        app.attach_logs(a.pid, a.name.into(), None, cx);
                    }
                })
                .ok();
            })
            .detach();
        }
        if let Some((secs, target)) = args.auto_record.clone() {
            auto_record(view.downgrade(), secs, target, cx);
        }
        if let Some(path) = args.snapshot.clone() {
            match args.quick.clone() {
                Some(which) => snapshot_quick(view.downgrade(), which, path, args.snapshot_delay_ms, cx),
                None => snapshot(window, path, args.snapshot_delay_ms, cx),
            }
        }
    });
}

/// Waits for the source list, picks the requested source, records for `secs`, then stops.
fn auto_record(view: WeakEntity<JlApp>, secs: u64, target: String, cx: &mut App) {
    cx.spawn(async move |cx| {
        for _ in 0..50 {
            cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
            let ready = view.update(cx, |app, _| !app.sources.is_empty() && !app.sources_loading && app.library.is_some()).unwrap_or(false);
            if ready {
                break;
            }
        }
        view.update(cx, |app, cx| {
            let wanted = target.to_lowercase();
            let pick = app.sources.iter().find(|s| if wanted == "screen" { s.kind == model::CaptureKind::Screen } else { s.kind == model::CaptureKind::App && s.name.to_lowercase() == wanted }).cloned();
            let Some(pick) = pick else {
                eprintln!("auto-record: no source named {target}");
                return;
            };
            app.capture_kind = pick.kind;
            app.selected_source = app.visible_sources().iter().position(|s| s.id == pick.id).unwrap_or(0);
            eprintln!("auto-record: recording {} for {secs}s", pick.name);
            app.start_recording_now(cx);
        })
        .ok();
        // A marker halfway, so the run exercises the marker path too.
        cx.background_executor().timer(std::time::Duration::from_millis(secs * 500)).await;
        view.update(cx, |app, cx| app.add_marker(cx)).ok();
        cx.background_executor().timer(std::time::Duration::from_millis(secs * 500)).await;
        view.update(cx, |app, cx| {
            if let Some(rec) = app.recording.as_ref() {
                eprintln!("auto-record: stopping (clicks {}, keys {}, logs {}, errors {}, markers {})", rec.clicks, rec.keys, rec.logs, rec.errors, rec.markers);
            }
            app.stop_recording_now(cx);
        })
        .ok();
    })
    .detach();
}

/// Opens the quick recorder (once the library and sources are ready) and snapshots its window.
fn snapshot_quick(view: WeakEntity<JlApp>, which: String, path: std::path::PathBuf, delay_ms: u64, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(std::time::Duration::from_millis(1200)).await;
        view.update(cx, |app, cx| {
            let mode = match which.parse::<usize>().ok().and_then(|i| app.records.get(i)) {
                Some(r) => {
                    let id = r.session_id.clone();
                    app.request_suggestion(id.clone(), cx);
                    quick::QuickMode::Saved { session_id: id }
                }
                None => quick::QuickMode::Pick,
            };
            app.open_quick(mode, None, cx);
        })
        .ok();
        cx.background_executor().timer(std::time::Duration::from_millis(600)).await;
        let handle = view.update(cx, |app, _| app.quick).ok().flatten();
        match handle {
            Some(h) => cx.update(|cx| snapshot(h.into(), path, delay_ms, cx)),
            None => {
                eprintln!("quick panel did not open");
                cx.update(|cx| cx.quit());
            }
        }
    })
    .detach();
}

#[cfg(feature = "snapshot")]
fn snapshot(window: AnyWindowHandle, path: std::path::PathBuf, delay_ms: u64, cx: &mut App) {
    cx.spawn(async move |cx| {
        cx.background_executor().timer(std::time::Duration::from_millis(delay_ms)).await;
        let result = cx.update_window(window, |_, window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
            window.render_to_image()
        });
        match result {
            Ok(Ok(image)) => match image.save(&path) {
                Ok(()) => eprintln!("snapshot written to {}", path.display()),
                Err(e) => eprintln!("snapshot save failed: {e}"),
            },
            Ok(Err(e)) => eprintln!("render_to_image failed: {e}"),
            Err(e) => eprintln!("window update failed: {e}"),
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

#[cfg(not(feature = "snapshot"))]
fn snapshot(_: AnyWindowHandle, _: std::path::PathBuf, _: u64, cx: &mut App) {
    eprintln!("--snapshot needs a build with --features snapshot");
    cx.quit();
}
