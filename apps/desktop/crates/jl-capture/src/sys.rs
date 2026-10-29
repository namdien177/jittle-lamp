//! Small macOS helpers shared by the content listing, recorder and input capture.

use std::path::PathBuf;

use objc2::AnyThread;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSRunningApplication};
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{
    CGDisplayCopyDisplayMode, CGDisplayMode, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_foundation::{
    NSArray, NSDictionary, NSNumber, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
};

/// A rectangle in global display points, origin at the top-left of the main display.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

/// One entry of `CGWindowListCopyWindowInfo`.
#[derive(Clone, Debug)]
pub(crate) struct CgWindow {
    pub id: u32,
    pub pid: i32,
    pub owner: String,
    /// Needs Screen Recording permission; `None` without it.
    pub title: Option<String>,
    pub layer: i32,
    pub bounds: Rect,
}

type WindowDict = NSDictionary<NSString, AnyObject>;

fn number(dict: &WindowDict, key: &str) -> Option<Retained<NSNumber>> {
    dict.objectForKey(&NSString::from_str(key))?
        .downcast::<NSNumber>()
        .ok()
}

fn string(dict: &WindowDict, key: &str) -> Option<String> {
    let value = dict
        .objectForKey(&NSString::from_str(key))?
        .downcast::<NSString>()
        .ok()?;
    Some(value.to_string())
}

fn bounds(dict: &WindowDict) -> Rect {
    let Some(b) = dict
        .objectForKey(&NSString::from_str("kCGWindowBounds"))
        .and_then(|o| o.downcast::<NSDictionary>().ok())
    else {
        return Rect::default();
    };
    // kCGWindowBounds is a CGRect dictionary with string keys.
    let b: Retained<WindowDict> = unsafe { Retained::cast_unchecked(b) };
    let f = |k: &str| number(&b, k).map(|n| n.doubleValue()).unwrap_or(0.0);
    Rect {
        x: f("X"),
        y: f("Y"),
        width: f("Width"),
        height: f("Height"),
    }
}

fn window_info(option: CGWindowListOption, relative_to: u32) -> Vec<CgWindow> {
    autoreleasepool(|_| {
        let Some(array) = CGWindowListCopyWindowInfo(option, relative_to) else {
            return Vec::new();
        };
        // CFArray of CFDictionary is toll-free bridged to NSArray of NSDictionary.
        let ptr = CFRetained::into_raw(array)
            .as_ptr()
            .cast::<NSArray<WindowDict>>();
        let Some(array) = (unsafe { Retained::from_raw(ptr) }) else {
            return Vec::new();
        };
        array
            .iter()
            .map(|dict| CgWindow {
                id: number(&dict, "kCGWindowNumber")
                    .map(|n| n.unsignedIntValue())
                    .unwrap_or(0),
                pid: number(&dict, "kCGWindowOwnerPID")
                    .map(|n| n.intValue())
                    .unwrap_or(0),
                owner: string(&dict, "kCGWindowOwnerName").unwrap_or_default(),
                title: string(&dict, "kCGWindowName").filter(|t| !t.is_empty()),
                layer: number(&dict, "kCGWindowLayer")
                    .map(|n| n.intValue())
                    .unwrap_or(0),
                bounds: bounds(&dict),
            })
            .collect()
    })
}

/// Opens this process's window-server connection. `SCContentFilter(desktopIndependentWindow:)`
/// asserts (`CGS_REQUIRE_INIT`) in processes that have not made one yet, such as command-line
/// tools without an `NSApplication`; listing windows makes it.
pub(crate) fn ensure_window_server_connection() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = window_info(CGWindowListOption::OptionOnScreenOnly, 0);
    });
}

/// On-screen windows, front to back.
pub(crate) fn on_screen_windows() -> Vec<CgWindow> {
    window_info(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    )
}

pub(crate) fn window_by_id(id: u32) -> Option<CgWindow> {
    window_info(CGWindowListOption::OptionIncludingWindow, id)
        .into_iter()
        .find(|w| w.id == id)
}

/// The frontmost normal window (layer 0) not owned by `exclude_pid`. Works without a main run
/// loop, unlike `NSWorkspace.frontmostApplication`, which only updates when one spins.
pub(crate) fn frontmost_window(exclude_pid: i32) -> Option<CgWindow> {
    on_screen_windows().into_iter().find(|w| {
        w.layer == 0 && w.pid != exclude_pid && w.bounds.width >= 40.0 && w.bounds.height >= 40.0
    })
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppMeta {
    pub name: String,
    pub bundle_id: Option<String>,
    pub bundle_path: Option<PathBuf>,
}

pub(crate) fn app_meta(pid: i32) -> Option<AppMeta> {
    autoreleasepool(|_| {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        Some(AppMeta {
            name: app
                .localizedName()
                .map(|n| n.to_string())
                .unwrap_or_default(),
            bundle_id: app.bundleIdentifier().map(|b| b.to_string()),
            bundle_path: app
                .bundleURL()
                .and_then(|u| u.path())
                .map(|p| PathBuf::from(p.to_string())),
        })
    })
}

/// The app's icon as PNG, rendered from the representation closest to `size` pixels.
pub fn app_icon_png(pid: i32, size: u32) -> Option<Vec<u8>> {
    autoreleasepool(|_| {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        let icon = app.icon()?;
        let mut rect = NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(size as f64, size as f64),
        );
        let image = unsafe { icon.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
        let data = unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }?;
        Some(data.to_vec())
    })
}

/// `macOS 15.4.1`
pub(crate) fn os_version() -> String {
    let v = NSProcessInfo::processInfo().operatingSystemVersion();
    format!(
        "macOS {}.{}.{}",
        v.majorVersion, v.minorVersion, v.patchVersion
    )
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGDisplayIsBuiltin(display: u32) -> u32;
}

pub(crate) fn display_is_builtin(display_id: u32) -> bool {
    unsafe { CGDisplayIsBuiltin(display_id) != 0 }
}

/// Backing scale (2.0 on Retina) of the display's current mode.
pub(crate) fn display_scale(display_id: u32) -> f64 {
    let Some(mode) = CGDisplayCopyDisplayMode(display_id) else {
        return 1.0;
    };
    let (pixels, points) = (
        CGDisplayMode::pixel_width(Some(&mode)),
        CGDisplayMode::width(Some(&mode)),
    );
    if points == 0 {
        1.0
    } else {
        pixels as f64 / points as f64
    }
}
