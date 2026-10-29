//! What can be recorded: displays, windows and applications, without our own app and without
//! system chrome (Dock, menu bar extras, Control Center, wallpaper, tiny utility windows).

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{Context, Result};
use screencapturekit::prelude::*;

use crate::sys::{self, Rect};

#[derive(Clone, Debug, PartialEq)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    /// Points, global coordinates.
    pub frame: Rect,
    pub scale: f64,
    pub is_main: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub title: Option<String>,
    pub app_name: String,
    pub bundle_id: String,
    pub pid: i32,
    pub frame: Rect,
    pub on_screen: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AppInfo {
    pub bundle_id: String,
    pub name: String,
    pub pid: i32,
    pub bundle_path: Option<PathBuf>,
    pub window_count: usize,
    pub icon_png: Option<Vec<u8>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shareable {
    pub displays: Vec<DisplayInfo>,
    pub windows: Vec<WindowInfo>,
    pub apps: Vec<AppInfo>,
}

#[derive(Clone, Copy, Debug)]
pub struct ContentOptions {
    /// Render app icons as PNG (a few ms per app).
    pub app_icons: bool,
    pub icon_size: u32,
    /// Include windows that are minimized or on another Space (only when they have a title).
    pub offscreen_windows: bool,
}

impl Default for ContentOptions {
    fn default() -> Self {
        Self {
            app_icons: true,
            icon_size: 64,
            offscreen_windows: true,
        }
    }
}

// Processes whose windows are system chrome, not something a QA session records.
const SYSTEM_BUNDLES: &[&str] = &[
    "com.apple.dock",
    "com.apple.WindowManager",
    "com.apple.controlcenter",
    "com.apple.notificationcenterui",
    "com.apple.Spotlight",
    "com.apple.systemuiserver",
    "com.apple.wallpaper.agent",
    "com.apple.screencaptureui",
    "com.apple.TextInputMenuAgent",
    "com.apple.TextInputSwitcher",
    "com.apple.loginwindow",
    "com.apple.universalcontrol",
    "com.apple.AirPlayUIAgent",
    "com.apple.coreservices.uiagent",
    "com.apple.UserNotificationCenter",
    "com.apple.ViewBridgeAuxiliary",
    "com.apple.Siri",
];

const MIN_WINDOW_W: f64 = 120.0;
const MIN_WINDOW_H: f64 = 80.0;

pub(crate) fn is_system_bundle(bundle_id: &str) -> bool {
    bundle_id.is_empty() || SYSTEM_BUNDLES.contains(&bundle_id)
}

/// "Built-in Display", or "Display N" numbering external displays in `all_ids` order.
pub(crate) fn display_name(id: u32, all_ids: &[u32]) -> String {
    if sys::display_is_builtin(id) {
        return "Built-in Display".into();
    }
    let index = all_ids
        .iter()
        .filter(|&&d| !sys::display_is_builtin(d))
        .position(|&d| d == id);
    format!("Display {}", index.map_or(id as usize, |i| i + 1))
}

pub fn shareable_content() -> Result<Shareable> {
    shareable_content_with(ContentOptions::default())
}

pub fn shareable_content_with(options: ContentOptions) -> Result<Shareable> {
    let content = SCShareableContent::create()
        .with_exclude_desktop_windows(true)
        .with_on_screen_windows_only(false)
        .get()
        .context("listing shareable content (is Screen Recording allowed?)")?;
    let snapshot = content.snapshot().context("shareable content snapshot")?;
    let own_pid = std::process::id() as i32;
    let main_display = objc2_core_graphics::CGMainDisplayID();

    let ids: Vec<u32> = snapshot.displays.iter().map(|d| d.display_id).collect();
    let displays = snapshot
        .displays
        .iter()
        .map(|d| DisplayInfo {
            id: d.display_id,
            name: display_name(d.display_id, &ids),
            frame: rect(&d.frame),
            scale: sys::display_scale(d.display_id),
            is_main: d.display_id == main_display,
        })
        .collect();

    let mut windows = Vec::new();
    let mut per_app: BTreeMap<usize, usize> = BTreeMap::new();
    for w in &snapshot.windows {
        let Some(app_index) = w.owning_app_index else {
            continue;
        };
        let Some(app) = snapshot.applications.get(app_index) else {
            continue;
        };
        let title = w.title.clone().filter(|t| !t.trim().is_empty());
        let frame = rect(&w.frame);
        let keep = w.window_layer == 0
            && app.process_id != own_pid
            && !is_system_bundle(&app.bundle_identifier)
            && frame.width >= MIN_WINDOW_W
            && frame.height >= MIN_WINDOW_H
            && (w.is_on_screen || (options.offscreen_windows && title.is_some()));
        if !keep {
            continue;
        }
        *per_app.entry(app_index).or_default() += 1;
        windows.push(WindowInfo {
            id: w.window_id,
            title,
            app_name: app.application_name.clone(),
            bundle_id: app.bundle_identifier.clone(),
            pid: app.process_id,
            frame,
            on_screen: w.is_on_screen,
        });
    }
    // Front-most first among on-screen windows, as SCK lists them; off-screen ones after.
    windows.sort_by_key(|w| !w.on_screen);

    let mut apps: Vec<AppInfo> = per_app
        .iter()
        .filter_map(|(&index, &window_count)| {
            let app = snapshot.applications.get(index)?;
            let meta = sys::app_meta(app.process_id);
            Some(AppInfo {
                bundle_id: app.bundle_identifier.clone(),
                name: if app.application_name.is_empty() {
                    meta.as_ref().map(|m| m.name.clone()).unwrap_or_default()
                } else {
                    app.application_name.clone()
                },
                pid: app.process_id,
                bundle_path: meta.and_then(|m| m.bundle_path),
                window_count,
                icon_png: options
                    .app_icons
                    .then(|| sys::app_icon_png(app.process_id, options.icon_size))
                    .flatten(),
            })
        })
        .collect();
    apps.sort_by_key(|a| a.name.to_lowercase());

    Ok(Shareable {
        displays,
        windows,
        apps,
    })
}

pub(crate) fn rect(r: &CGRect) -> Rect {
    Rect {
        x: r.origin.x,
        y: r.origin.y,
        width: r.size.width,
        height: r.size.height,
    }
}
