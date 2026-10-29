//! macOS shell integration for the Jittle Lamp desktop app: menu bar extra, global hotkeys,
//! user notifications and small AppKit helpers.
//!
//! The host app owns `NSApplication` and its run loop (GPUI). Nothing here runs an event
//! loop: install things from the main thread once the app has launched and poll the
//! `crossbeam_channel` receivers from the app's executor. Types that wrap AppKit objects
//! (`StatusItem`, `Hotkeys`) are `!Send` and must stay on the main thread.

mod hotkeys;
mod menu_model;
pub mod notifications;
mod shortcut;
mod status_item;
mod system;

pub use hotkeys::{HotkeyId, Hotkeys};
pub use menu_model::{
    ADD_MARKER_SHORTCUT, MAX_RECENT, MenuEntry, MenuItem, StatusEvent, StatusMenu,
    TOGGLE_RECORDING_SHORTCUT, format_elapsed,
};
pub use notifications::{NotificationEvent, notify};
pub use shortcut::{Modifiers, Shortcut};
pub use status_item::StatusItem;
pub use system::{
    AppInfo, AppRef, LaunchAtLogin, app_icon_png, bundle_identifier, copy_image_to_pasteboard,
    copy_text, is_bundled, launch_at_login, open_login_items_settings, open_url, reveal_in_finder,
    running_apps, set_dock_badge, set_launch_at_login, system_reduce_motion, move_to_trash, set_window_visible, launched_as_login_item};
