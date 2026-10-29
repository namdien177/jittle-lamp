//! User notifications through `UNUserNotificationCenter`.
//!
//! `UNUserNotificationCenter.currentNotificationCenter` throws when the process has no bundle
//! (e.g. `cargo run`), so every entry point checks [`crate::is_bundled`] first and degrades to
//! a log line.

use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{Result, bail};
use block2::RcBlock;
use crossbeam_channel::Sender;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSArray, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
    UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
    UNNotificationDefaultActionIdentifier, UNNotificationDismissActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

const CATEGORY_ID: &str = "JL_RECORDING";
const REVIEW_ACTION_ID: &str = "JL_REVIEW";

/// What the user did with a notification posted by [`notify`]; `id` is the id passed to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotificationEvent {
    /// Clicked the "Review" action button.
    Review { id: String },
    /// Clicked the notification body.
    Opened { id: String },
    /// Dismissed it from Notification Center.
    Dismissed { id: String },
}

struct DelegateIvars {
    sender: Sender<NotificationEvent>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and Delegate does not implement Drop.
    #[unsafe(super(NSObject))]
    #[name = "JLNotificationDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        // Show banners even while Jittle Lamp is frontmost.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            let action = response.actionIdentifier();
            let event = if action.to_string() == REVIEW_ACTION_ID {
                Some(NotificationEvent::Review { id })
            } else if &*action == unsafe { UNNotificationDefaultActionIdentifier } {
                Some(NotificationEvent::Opened { id })
            } else if &*action == unsafe { UNNotificationDismissActionIdentifier } {
                Some(NotificationEvent::Dismissed { id })
            } else {
                None
            };
            if let Some(event) = event {
                let _ = self.ivars().sender.send(event);
            }
            completion.call(());
        }
    }
);

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Sets the notification delegate and registers the "Review" action. Call once, early in
/// launch (a click on a notification that launched the app is delivered right after
/// `applicationDidFinishLaunching`). Does not prompt for permission; [`notify`] does that
/// lazily. Returns `Ok(false)` when unbundled (notifications disabled). Any thread.
pub fn install(sender: Sender<NotificationEvent>) -> Result<bool> {
    if !crate::is_bundled() {
        log::info!("notifications disabled: not running from an .app bundle");
        return Ok(false);
    }
    if INSTALLED.swap(true, Ordering::SeqCst) {
        bail!("notifications already installed");
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();

    let delegate: Retained<Delegate> = {
        let this = Delegate::alloc().set_ivars(DelegateIvars { sender });
        unsafe { msg_send![super(this), init] }
    };
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly; it must live as long as the process.
    std::mem::forget(delegate);

    let review = UNNotificationAction::actionWithIdentifier_title_options(
        &NSString::from_str(REVIEW_ACTION_ID),
        &NSString::from_str("Review"),
        UNNotificationActionOptions::Foreground,
    );
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(CATEGORY_ID),
        &NSArray::from_retained_slice(&[review]),
        &NSArray::new(),
        UNNotificationCategoryOptions::CustomDismissAction,
    );
    center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
    Ok(true)
}

/// Posts a notification with a "Review" action. The first call asks for permission. Posting
/// again with the same `id` replaces the earlier notification. Returns `Ok(false)` when
/// unbundled (logged, nothing shown). Delivery errors (permission denied) are logged, since
/// they arrive asynchronously. Any thread.
pub fn notify(title: &str, body: &str, id: &str) -> Result<bool> {
    if !crate::is_bundled() {
        log::info!("notification skipped (not running from an .app bundle): {title} — {body}");
        return Ok(false);
    }
    if !INSTALLED.load(Ordering::SeqCst) {
        log::warn!("notify() before notifications::install(): clicks will not be reported");
    }

    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setCategoryIdentifier(&NSString::from_str(CATEGORY_ID));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(id),
        &content,
        None,
    );

    let center = UNUserNotificationCenter::currentNotificationCenter();
    let post_center = center.clone();
    let on_authorized = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        if !granted.as_bool() {
            let reason = unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string());
            log::warn!(
                "notification permission not granted: {}",
                reason.as_deref().unwrap_or("denied by user")
            );
            return;
        }
        let on_added = RcBlock::new(|error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                log::warn!(
                    "posting notification failed: {}",
                    error.localizedDescription()
                );
            }
        });
        post_center.addNotificationRequest_withCompletionHandler(&request, Some(&on_added));
    });
    center.requestAuthorizationWithOptions_completionHandler(
        UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
        &on_authorized,
    );
    Ok(true)
}

/// Removes a delivered notification (e.g. after the recording was opened another way).
pub fn remove(id: &str) {
    if crate::is_bundled() {
        UNUserNotificationCenter::currentNotificationCenter()
            .removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&[
                NSString::from_str(id),
            ]));
    }
}
