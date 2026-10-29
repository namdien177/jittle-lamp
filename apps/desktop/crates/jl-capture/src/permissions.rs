//! TCC permissions the recorder needs: Screen Recording (capture), Accessibility and Input
//! Monitoring (clicks and shortcuts), Microphone.

use anyhow::{Result, bail};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2_app_kit::NSWorkspace;
use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
use objc2_core_graphics::{
    CGPreflightListenEventAccess, CGPreflightScreenCaptureAccess, CGRequestListenEventAccess,
    CGRequestScreenCaptureAccess,
};
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PermissionStatus {
    Granted,
    /// Denied, or (for Screen Recording, Accessibility and Input Monitoring, which cannot tell the
    /// difference) not asked yet. Call the matching `request_*` and, if that returns false, open
    /// the settings pane.
    Denied,
    NotDetermined,
    Restricted,
}

impl PermissionStatus {
    pub fn is_granted(self) -> bool {
        self == Self::Granted
    }

    fn from_bool(granted: bool) -> Self {
        if granted { Self::Granted } else { Self::Denied }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Permissions {
    pub screen_recording: PermissionStatus,
    pub accessibility: PermissionStatus,
    /// Listen-only event taps are allowed with either Accessibility or Input Monitoring.
    pub input_monitoring: PermissionStatus,
    pub microphone: PermissionStatus,
}

impl Permissions {
    /// Whether clicks and shortcuts can be captured.
    pub fn can_capture_input(&self) -> bool {
        self.accessibility.is_granted() || self.input_monitoring.is_granted()
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const AnyObject) -> bool;
}

/// Current state, without prompting.
pub fn permissions() -> Permissions {
    Permissions {
        screen_recording: PermissionStatus::from_bool(CGPreflightScreenCaptureAccess()),
        accessibility: PermissionStatus::from_bool(accessibility_trusted()),
        input_monitoring: PermissionStatus::from_bool(CGPreflightListenEventAccess()),
        microphone: microphone_status(),
    }
}

pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Shows the system prompt the first time; afterwards returns the current state.
pub fn request_screen_recording() -> bool {
    CGRequestScreenCaptureAccess()
}

/// Shows the "would like to control this computer" prompt if not trusted yet.
pub fn request_accessibility() -> bool {
    // kAXTrustedCheckOptionPrompt
    let key = NSString::from_str("AXTrustedCheckOptionPrompt");
    let value = NSNumber::new_bool(true);
    let options: Retained<NSDictionary<NSString, NSNumber>> =
        NSDictionary::from_retained_objects(&[&*key], &[value]);
    unsafe { AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast()) }
}

pub fn request_input_monitoring() -> bool {
    CGRequestListenEventAccess()
}

pub fn microphone_status() -> PermissionStatus {
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionStatus::Restricted;
    };
    match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) } {
        AVAuthorizationStatus::Authorized => PermissionStatus::Granted,
        AVAuthorizationStatus::Denied => PermissionStatus::Denied,
        AVAuthorizationStatus::Restricted => PermissionStatus::Restricted,
        _ => PermissionStatus::NotDetermined,
    }
}

/// Prompts when not determined and blocks until the user answers.
pub fn request_microphone() -> PermissionStatus {
    let status = microphone_status();
    if status != PermissionStatus::NotDetermined {
        return status;
    }
    let Some(media_type) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionStatus::Restricted;
    };
    let (tx, rx) = crossbeam_channel::bounded(1);
    let block = RcBlock::new(move |granted: Bool| {
        let _ = tx.try_send(granted.as_bool());
    });
    unsafe { AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &block) };
    match rx.recv() {
        Ok(granted) => PermissionStatus::from_bool(granted),
        Err(_) => microphone_status(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsPane {
    ScreenRecording,
    Accessibility,
    InputMonitoring,
    Microphone,
}

impl SettingsPane {
    pub fn url(self) -> &'static str {
        match self {
            Self::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Self::Accessibility => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Self::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            Self::Microphone => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
            }
        }
    }
}

/// Opens System Settings › Privacy & Security on the pane.
pub fn open_settings(pane: SettingsPane) -> Result<()> {
    let Some(url) = NSURL::URLWithString(&NSString::from_str(pane.url())) else {
        bail!("invalid settings URL {}", pane.url());
    };
    if !NSWorkspace::sharedWorkspace().openURL(&url) {
        bail!("System Settings did not open {}", pane.url());
    }
    Ok(())
}
