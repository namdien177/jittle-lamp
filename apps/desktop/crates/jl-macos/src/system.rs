//! Small AppKit helpers: Finder, URLs, pasteboard, Dock, accessibility, login item, apps.

use std::path::Path;

use anyhow::{Context, Result, bail};
use objc2::rc::Retained;
use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBitmapImageFileType, NSBitmapImageRep,
    NSCompositingOperation, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSImageInterpolation, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString,
    NSPasteboardTypeTIFF, NSRunningApplication, NSWorkspace,
};
use objc2_foundation::{NSArray, NSData, NSDictionary, NSPoint, NSRect, NSSize, NSString, NSURL};
use objc2_service_management::{SMAppService, SMAppServiceStatus};

/// True when running from an `.app` bundle with a bundle identifier. `cargo run` binaries are
/// not, and APIs tied to bundle identity (notifications, login items) are disabled there.
pub fn is_bundled() -> bool {
    let bundle = objc2_foundation::NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

/// The main bundle's identifier, if any.
pub fn bundle_identifier() -> Option<String> {
    objc2_foundation::NSBundle::mainBundle()
        .bundleIdentifier()
        .map(|id| id.to_string())
}

/// Opens a Finder window with `path` selected.
pub fn reveal_in_finder(path: &Path) -> Result<()> {
    if !path.exists() {
        bail!("{} does not exist", path.display());
    }
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSWorkspace::sharedWorkspace()
        .activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[url]));
    Ok(())
}

/// Orders a window out (hidden, still alive) or back in front, given the `NSView` pointer from a
/// raw AppKit window handle. Main thread only.
///
/// # Safety
/// `ns_view` must be a live `NSView` owned by a window of this process.
pub unsafe fn set_window_visible(ns_view: *mut std::ffi::c_void, visible: bool) -> Result<()> {
    MainThreadMarker::new().context("set_window_visible must run on the main thread")?;
    let view = unsafe { &*(ns_view as *const objc2_app_kit::NSView) };
    let window = view.window().context("view is not in a window")?;
    if visible {
        window.makeKeyAndOrderFront(None);
    } else {
        window.orderOut(None);
    }
    Ok(())
}

/// True when macOS started the app as a login item, so it should stay quietly in the menu bar.
/// Reads the launch Apple event; call it during start-up, before other events arrive.
pub fn launched_as_login_item() -> bool {
    use objc2_foundation::NSAppleEventManager;
    // keyAELaunchedAsLogInItem = 'lgit'
    const LAUNCHED_AS_LOGIN_ITEM: u32 = u32::from_be_bytes(*b"lgit");
    let manager = NSAppleEventManager::sharedAppleEventManager();
    let Some(event) = manager.currentAppleEvent() else { return false };
    let found: Option<Retained<objc2_foundation::NSAppleEventDescriptor>> =
        unsafe { objc2::msg_send![&*event, paramDescriptorForKeyword: LAUNCHED_AS_LOGIN_ITEM] };
    found.is_some()
}

/// Moves a file or folder to the Trash and returns where it landed, so the move can be undone.
pub fn move_to_trash(path: &Path) -> Result<std::path::PathBuf> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    let mut landed: Option<Retained<NSURL>> = None;
    objc2_foundation::NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, Some(&mut landed))
        .map_err(|e| anyhow::anyhow!("{}", e.localizedDescription()))?;
    landed
        .and_then(|u| u.path())
        .map(|p| std::path::PathBuf::from(p.to_string()))
        .context("the Trash did not report where the item went")
}

/// Opens a URL with its default handler (browser for http(s), Mail for mailto:, …).
pub fn open_url(url: &str) -> Result<()> {
    let ns_url = NSURL::URLWithString(&NSString::from_str(url))
        .with_context(|| format!("invalid URL {url:?}"))?;
    if !NSWorkspace::sharedWorkspace().openURL(&ns_url) {
        bail!("no application could open {url}");
    }
    Ok(())
}

/// Replaces the general pasteboard's contents with `text`.
pub fn copy_text(text: &str) {
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    pasteboard.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
}

/// Replaces the general pasteboard's contents with an image, offered as PNG and TIFF (some
/// apps only read TIFF).
pub fn copy_image_to_pasteboard(png: &[u8]) -> Result<()> {
    let data = NSData::with_bytes(png);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .context("pasteboard image is not a decodable image")?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let mut ok = pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypePNG });
    if let Some(tiff) = image.TIFFRepresentation() {
        ok |= pasteboard.setData_forType(Some(&tiff), unsafe { NSPasteboardTypeTIFF });
    }
    if !ok {
        bail!("writing the image to the pasteboard failed");
    }
    Ok(())
}

/// Sets or clears the Dock icon badge. Main thread only.
pub fn set_dock_badge(label: Option<&str>) -> Result<()> {
    let mtm = MainThreadMarker::new().context("set_dock_badge must run on the main thread")?;
    let label = label.map(NSString::from_str);
    NSApplication::sharedApplication(mtm)
        .dockTile()
        .setBadgeLabel(label.as_deref());
    Ok(())
}

/// System Settings › Accessibility › Display › Reduce motion.
pub fn system_reduce_motion() -> bool {
    NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceMotion()
}

/// Registers or unregisters the app as a login item (`SMAppService.mainAppService`). The user
/// may still need to approve it in System Settings › General › Login Items; see
/// [`launch_at_login`]. Errors when unbundled.
pub fn set_launch_at_login(enabled: bool) -> Result<()> {
    if !is_bundled() {
        bail!("launch at login needs the app to run from an .app bundle");
    }
    let service = unsafe { SMAppService::mainAppService() };
    let result = unsafe {
        if enabled {
            service.registerAndReturnError()
        } else {
            service.unregisterAndReturnError()
        }
    };
    result.map_err(|e| anyhow::anyhow!("SMAppService: {}", e.localizedDescription()))
}

/// Login item state as seen by `SMAppService`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchAtLogin {
    Enabled,
    Disabled,
    /// Registered, waiting for the user to allow it in System Settings.
    RequiresApproval,
    /// Unbundled or the service could not be found.
    Unavailable,
}

pub fn launch_at_login() -> LaunchAtLogin {
    if !is_bundled() {
        return LaunchAtLogin::Unavailable;
    }
    match unsafe { SMAppService::mainAppService().status() } {
        SMAppServiceStatus::Enabled => LaunchAtLogin::Enabled,
        SMAppServiceStatus::NotRegistered => LaunchAtLogin::Disabled,
        SMAppServiceStatus::RequiresApproval => LaunchAtLogin::RequiresApproval,
        _ => LaunchAtLogin::Unavailable,
    }
}

/// Opens System Settings › General › Login Items.
pub fn open_login_items_settings() {
    unsafe { SMAppService::openSystemSettingsLoginItems() };
}

/// A running GUI application.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppInfo {
    pub pid: i32,
    pub bundle_id: Option<String>,
    pub name: String,
    /// Frontmost application.
    pub active: bool,
}

/// Running applications with the regular activation policy (those with a Dock icon), in
/// NSWorkspace order (roughly launch order). Includes this process if it is regular.
pub fn running_apps() -> Vec<AppInfo> {
    NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .filter(|app| {
            app.activationPolicy() == NSApplicationActivationPolicy::Regular && !app.isTerminated()
        })
        .map(|app| AppInfo {
            pid: app.processIdentifier(),
            bundle_id: app.bundleIdentifier().map(|id| id.to_string()),
            name: app
                .localizedName()
                .map(|n| n.to_string())
                .unwrap_or_default(),
            active: app.isActive(),
        })
        .collect()
}

/// Which application [`app_icon_png`] should look up.
#[derive(Clone, Copy, Debug)]
pub enum AppRef<'a> {
    Pid(i32),
    /// A running instance is preferred; otherwise the installed app's icon.
    BundleId(&'a str),
}

/// The application's icon rendered to a `size`×`size` pixel PNG.
pub fn app_icon_png(app: AppRef<'_>, size: u32) -> Option<Vec<u8>> {
    let icon = match app {
        AppRef::Pid(pid) => {
            NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?.icon()?
        }
        AppRef::BundleId(bundle_id) => {
            let ns_id = NSString::from_str(bundle_id);
            let running = NSRunningApplication::runningApplicationsWithBundleIdentifier(&ns_id);
            match running.iter().find_map(|app| app.icon()) {
                Some(icon) => icon,
                None => {
                    let workspace = NSWorkspace::sharedWorkspace();
                    let url = workspace.URLForApplicationWithBundleIdentifier(&ns_id)?;
                    workspace.iconForFile(&*url.path()?)
                }
            }
        }
    };
    render_png(&icon, size)
}

fn render_png(image: &NSImage, size: u32) -> Option<Vec<u8>> {
    if size == 0 || size > 4096 {
        return None;
    }
    let pixels = size as isize;
    let rep: Retained<NSBitmapImageRep> = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            pixels,
            pixels,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;
    // Draw in pixel units: the rep's point size equals its pixel size.
    let extent = NSSize::new(size as f64, size as f64);
    rep.setSize(extent);
    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;

    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&context));
    context.setImageInterpolation(NSImageInterpolation::High);
    image.drawInRect_fromRect_operation_fraction(
        NSRect::new(NSPoint::new(0.0, 0.0), extent),
        NSRect::ZERO,
        NSCompositingOperation::Copy,
        1.0,
    );
    context.flushGraphics();
    NSGraphicsContext::restoreGraphicsState_class();

    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cargo_test_binary_is_unbundled() {
        assert!(!is_bundled());
        assert!(set_launch_at_login(true).is_err());
        assert_eq!(launch_at_login(), LaunchAtLogin::Unavailable);
    }

    #[test]
    fn dock_badge_off_main_thread_errors() {
        assert!(set_dock_badge(Some("1")).is_err());
    }

    #[test]
    fn rejects_bad_inputs() {
        assert!(reveal_in_finder(Path::new("/definitely/not/here")).is_err());
        assert!(copy_image_to_pasteboard(b"not an image").is_err());
        assert!(app_icon_png(AppRef::BundleId("invalid.bundle.id.jl-macos-test"), 32).is_none());
    }

    #[test]
    fn renders_finder_icon_and_lists_apps() {
        let png = app_icon_png(AppRef::BundleId("com.apple.finder"), 64).expect("Finder icon");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        // IHDR width/height.
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 64);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 64);

        let apps = running_apps();
        let finder = apps
            .iter()
            .find(|a| a.bundle_id.as_deref() == Some("com.apple.finder"))
            .expect("Finder runs");
        assert!(app_icon_png(AppRef::Pid(finder.pid), 32).is_some());
        assert!(apps.iter().filter(|a| a.active).count() <= 1);
    }
}
