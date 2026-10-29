//! System-wide hotkeys through Carbon `RegisterEventHotKey`.
//!
//! Carbon hotkeys need no Accessibility permission and are delivered by whatever runs the
//! main run loop (here GPUI's `NSApplication`), on the main thread. The handler only forwards
//! the id to a channel.

use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Context, Result, bail};
use crossbeam_channel::Sender;
use objc2::MainThreadMarker;

use crate::Shortcut;

/// Caller-chosen identifier reported when a hotkey fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct HotkeyId(pub u32);

impl HotkeyId {
    pub const TOGGLE_RECORDING: HotkeyId = HotkeyId(1);
    pub const ADD_MARKER: HotkeyId = HotkeyId(2);
}

/// Registered hotkeys. Main-thread only (`!Send`); dropping unregisters them.
pub struct Hotkeys {
    bindings: Vec<(HotkeyId, Shortcut)>,
    refs: Vec<EventHotKeyRef>,
    handler: EventHandlerRef,
    state: *mut HandlerState,
    _not_send: PhantomData<*const ()>,
}

struct HandlerState {
    sender: Sender<HotkeyId>,
    /// `(carbon id, caller id)`; carbon ids are process-unique so several `Hotkeys` coexist.
    ids: Vec<(u32, HotkeyId)>,
}

static NEXT_CARBON_ID: AtomicU32 = AtomicU32::new(1);
/// `'JLHK'`
const SIGNATURE: u32 = u32::from_be_bytes(*b"JLHK");

impl Hotkeys {
    /// Registers every `(id, "alt+shift+r")` pair. All-or-nothing: if one shortcut fails to
    /// parse or is already taken in this process, nothing stays registered and the error names
    /// it. Must be called on the main thread.
    pub fn register(bindings: &[(HotkeyId, &str)], sender: Sender<HotkeyId>) -> Result<Hotkeys> {
        MainThreadMarker::new().context("Hotkeys::register must run on the main thread")?;
        let parsed = bindings
            .iter()
            .map(|(id, text)| Ok((*id, Shortcut::parse(text)?)))
            .collect::<Result<Vec<_>>>()?;

        let state = Box::into_raw(Box::new(HandlerState {
            sender,
            ids: Vec::new(),
        }));
        let target = unsafe { GetApplicationEventTarget() };
        let spec = EventTypeSpec {
            event_class: K_EVENT_CLASS_KEYBOARD,
            event_kind: K_EVENT_HOT_KEY_PRESSED,
        };
        let mut handler: EventHandlerRef = ptr::null_mut();
        let status = unsafe {
            InstallEventHandler(target, hotkey_handler, 1, &spec, state.cast(), &mut handler)
        };
        if status != 0 {
            drop(unsafe { Box::from_raw(state) });
            bail!("InstallEventHandler failed (OSStatus {status})");
        }

        let mut this = Hotkeys {
            bindings: Vec::new(),
            refs: Vec::new(),
            handler,
            state,
            _not_send: PhantomData,
        };
        for (id, shortcut) in parsed {
            let carbon_id = NEXT_CARBON_ID.fetch_add(1, Ordering::Relaxed);
            let mut hotkey_ref: EventHotKeyRef = ptr::null_mut();
            let status = unsafe {
                RegisterEventHotKey(
                    shortcut.key_code,
                    shortcut.modifiers.carbon_mask(),
                    EventHotKeyID {
                        signature: SIGNATURE,
                        id: carbon_id,
                    },
                    target,
                    0,
                    &mut hotkey_ref,
                )
            };
            if status != 0 {
                let reason = if status == EVENT_HOT_KEY_EXISTS_ERR {
                    "already registered"
                } else {
                    "rejected"
                };
                bail!("hotkey {shortcut} ({id:?}) {reason} (OSStatus {status})");
            }
            this.refs.push(hotkey_ref);
            unsafe { (*this.state).ids.push((carbon_id, id)) };
            this.bindings.push((id, shortcut));
        }
        Ok(this)
    }

    pub fn bindings(&self) -> &[(HotkeyId, Shortcut)] {
        &self.bindings
    }

    /// Delivers a synthetic hotkey-pressed Carbon event for `id` through the application event
    /// target, exercising the same handler path as a real key press. Returns false if `id` is
    /// not registered here.
    #[doc(hidden)]
    pub fn simulate_press(&self, id: HotkeyId) -> Result<bool> {
        let ids = unsafe { &(*self.state).ids };
        let Some(&(carbon_id, _)) = ids.iter().find(|(_, i)| *i == id) else {
            return Ok(false);
        };
        let hotkey = EventHotKeyID {
            signature: SIGNATURE,
            id: carbon_id,
        };
        unsafe {
            let mut event: EventRef = ptr::null_mut();
            let status = CreateEvent(
                ptr::null(),
                K_EVENT_CLASS_KEYBOARD,
                K_EVENT_HOT_KEY_PRESSED,
                0.0,
                0,
                &mut event,
            );
            if status != 0 {
                bail!("CreateEvent failed (OSStatus {status})");
            }
            let status = SetEventParameter(
                event,
                K_EVENT_PARAM_DIRECT_OBJECT,
                TYPE_EVENT_HOT_KEY_ID,
                size_of::<EventHotKeyID>(),
                (&raw const hotkey).cast(),
            );
            let sent = if status == 0 {
                SendEventToEventTarget(event, GetApplicationEventTarget())
            } else {
                status
            };
            ReleaseEvent(event);
            if sent != 0 {
                bail!("dispatching synthetic hotkey failed (OSStatus {sent})");
            }
        }
        Ok(true)
    }
}

impl Drop for Hotkeys {
    fn drop(&mut self) {
        unsafe {
            for hotkey_ref in self.refs.drain(..) {
                UnregisterEventHotKey(hotkey_ref);
            }
            RemoveEventHandler(self.handler);
            drop(Box::from_raw(self.state));
        }
    }
}

extern "C" fn hotkey_handler(
    _next: EventHandlerCallRef,
    event: EventRef,
    user_data: *mut c_void,
) -> OSStatus {
    let state = unsafe { &*user_data.cast::<HandlerState>() };
    let mut hotkey = EventHotKeyID {
        signature: 0,
        id: 0,
    };
    let status = unsafe {
        GetEventParameter(
            event,
            K_EVENT_PARAM_DIRECT_OBJECT,
            TYPE_EVENT_HOT_KEY_ID,
            ptr::null_mut(),
            size_of::<EventHotKeyID>(),
            ptr::null_mut(),
            (&raw mut hotkey).cast(),
        )
    };
    if status != 0 || hotkey.signature != SIGNATURE {
        return EVENT_NOT_HANDLED_ERR;
    }
    match state
        .ids
        .iter()
        .find(|(carbon_id, _)| *carbon_id == hotkey.id)
    {
        Some((_, id)) => {
            let _ = state.sender.send(*id);
            0
        }
        None => EVENT_NOT_HANDLED_ERR,
    }
}

// --- Carbon (HIToolbox) FFI -------------------------------------------------------------------

type OSStatus = i32;
type EventTargetRef = *mut c_void;
type EventHandlerRef = *mut c_void;
type EventHandlerCallRef = *mut c_void;
type EventHotKeyRef = *mut c_void;
type EventRef = *mut c_void;
type EventHandlerUPP = extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

#[repr(C)]
struct EventTypeSpec {
    event_class: u32,
    event_kind: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct EventHotKeyID {
    signature: u32,
    id: u32,
}

const K_EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
const K_EVENT_PARAM_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
const TYPE_EVENT_HOT_KEY_ID: u32 = u32::from_be_bytes(*b"hkid");
const EVENT_NOT_HANDLED_ERR: OSStatus = -9874;
const EVENT_HOT_KEY_EXISTS_ERR: OSStatus = -9878;

#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn GetApplicationEventTarget() -> EventTargetRef;
    fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandlerUPP,
        num_types: usize,
        list: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    fn RemoveEventHandler(handler: EventHandlerRef) -> OSStatus;
    fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    fn UnregisterEventHotKey(hotkey: EventHotKeyRef) -> OSStatus;
    fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> OSStatus;
    fn CreateEvent(
        allocator: *const c_void,
        class: u32,
        kind: u32,
        when: f64,
        flags: u32,
        out_event: *mut EventRef,
    ) -> OSStatus;
    fn SetEventParameter(
        event: EventRef,
        name: u32,
        kind: u32,
        size: usize,
        data: *const c_void,
    ) -> OSStatus;
    fn SendEventToEventTarget(event: EventRef, target: EventTargetRef) -> OSStatus;
    fn ReleaseEvent(event: EventRef);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_off_main_thread_is_an_error_not_a_crash() {
        // cargo runs tests on worker threads.
        let (tx, _rx) = crossbeam_channel::unbounded();
        let err = Hotkeys::register(&[(HotkeyId::TOGGLE_RECORDING, "alt+shift+r")], tx)
            .err()
            .unwrap();
        assert!(err.to_string().contains("main thread"));
    }

    #[test]
    fn four_char_codes() {
        assert_eq!(K_EVENT_CLASS_KEYBOARD, 0x6B65_7962);
        assert_eq!(TYPE_EVENT_HOT_KEY_ID, 0x686B_6964);
        assert_eq!(K_EVENT_PARAM_DIRECT_OBJECT, 0x2D2D_2D2D);
    }
}
