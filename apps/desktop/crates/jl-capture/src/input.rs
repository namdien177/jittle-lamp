//! Clicks, shortcut keys and app/window switches during a recording.
//!
//! A listen-only `CGEventTap` on its own run-loop thread reads mouse-down and key-down events and
//! hands them to a worker that scopes them to the capture target and resolves the clicked
//! accessibility element. Only a key code and modifier flags are read from key events — never the
//! typed characters — and a key is kept only when it is a shortcut (⌘ or ⌃ + key) or a special key
//! (Return, Esc, arrows, F-keys, …).

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

use anyhow::{Result, anyhow};
use chrono::{DateTime, FixedOffset, Local};
use crossbeam_channel::{Receiver, Sender, unbounded};
use objc2::rc::{Retained, autoreleasepool};
use objc2_core_foundation::{
    CFMachPort, CFRetained, CFRunLoop, kCFRunLoopCommonModes, kCFRunLoopDefaultMode,
};
use objc2_core_graphics::{
    CGEvent, CGEventField, CGEventFlags, CGEventTapLocation, CGEventTapOptions,
    CGEventTapPlacement, CGEventTapProxy, CGEventType,
};
use objc2_foundation::NSString;
use parking_lot::Mutex;

use crate::archive::{ActionPayload, ClickTarget, Modifiers, Viewport, app_url};
use crate::mask::mask_secrets;
use crate::sys::{self, Rect};

/// What the recorder captures, for scoping input to it.
#[derive(Clone, Debug)]
pub(crate) enum InputScope {
    Display { bounds: Rect },
    Window { id: u32, pid: i32 },
    App { pid: i32, display_bounds: Rect },
}

impl InputScope {
    fn target_pid(&self) -> Option<i32> {
        match self {
            Self::Display { .. } => None,
            Self::Window { pid, .. } | Self::App { pid, .. } => Some(*pid),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct InputAction {
    pub at: DateTime<FixedOffset>,
    pub label: String,
    pub payload: ActionPayload,
}

pub(crate) type ActionSink = Arc<dyn Fn(InputAction) + Send + Sync>;

pub(crate) struct InputOptions {
    pub scope: InputScope,
    /// Clicks and shortcuts (needs Accessibility or Input Monitoring).
    pub events: bool,
    /// App and window-title switches.
    pub focus: bool,
    pub page_url: String,
    pub page_title: String,
    pub scale: f64,
}

enum RawInput {
    Mouse {
        at: DateTime<FixedOffset>,
        x: f64,
        y: f64,
        button: i64,
        clicks: i64,
        flags: CGEventFlags,
        window: u32,
    },
    Key {
        at: DateTime<FixedOffset>,
        keycode: u16,
        flags: CGEventFlags,
    },
}

struct SendRunLoop(CFRetained<CFRunLoop>);
// CFRunLoopStop may be called from any thread.
unsafe impl Send for SendRunLoop {}
unsafe impl Sync for SendRunLoop {}

/// Running input capture; `stop` (or drop) ends every thread.
pub(crate) struct InputCapture {
    stopping: Arc<AtomicBool>,
    run_loop: Arc<Mutex<Option<SendRunLoop>>>,
    threads: Vec<JoinHandle<()>>,
}

impl InputCapture {
    pub(crate) fn start(options: InputOptions, sink: ActionSink) -> Result<InputCapture> {
        let stopping = Arc::new(AtomicBool::new(false));
        let run_loop = Arc::new(Mutex::new(None));
        let focused_pid = Arc::new(AtomicI32::new(
            sys::frontmost_window(own_pid()).map(|w| w.pid).unwrap_or(0),
        ));
        let window_bounds = Arc::new(Mutex::new(match options.scope {
            InputScope::Window { id, .. } => sys::window_by_id(id).map(|w| w.bounds),
            _ => None,
        }));
        let mut threads = Vec::new();

        if options.focus || matches!(options.scope, InputScope::Window { .. }) {
            let (stopping, focused_pid, window_bounds, sink) = (
                stopping.clone(),
                focused_pid.clone(),
                window_bounds.clone(),
                sink.clone(),
            );
            let (scope, report) = (options.scope.clone(), options.focus);
            threads.push(
                std::thread::Builder::new()
                    .name("jl-input-focus".into())
                    .spawn(move || {
                        poll_focus(
                            &scope,
                            report,
                            &stopping,
                            &focused_pid,
                            &window_bounds,
                            &sink,
                        )
                    })?,
            );
        }

        if options.events {
            let (tx, rx) = unbounded();
            let (ready_tx, ready_rx) = crossbeam_channel::bounded(1);
            let (run_loop_slot, tap_stopping) = (run_loop.clone(), stopping.clone());
            let tap = std::thread::Builder::new()
                .name("jl-input-tap".into())
                .spawn(move || run_tap(tx, ready_tx, &run_loop_slot, &tap_stopping))?;
            let outcome = ready_rx.recv_timeout(Duration::from_secs(2));
            if !matches!(outcome, Ok(Ok(()))) {
                // A tap thread that is still starting sees `stopping` and exits on its own.
                let mut capture = InputCapture {
                    stopping,
                    run_loop,
                    threads,
                };
                capture.stop();
                return Err(match outcome {
                    Ok(Err(error)) => error,
                    _ => anyhow!("event tap did not start"),
                });
            }
            threads.push(tap);
            let worker = Worker {
                scope: options.scope,
                focused_pid,
                window_bounds,
                page_url: options.page_url,
                page_title: options.page_title,
                scale: options.scale,
                sink,
            };
            threads.push(
                std::thread::Builder::new()
                    .name("jl-input-worker".into())
                    .spawn(move || worker.run(rx))?,
            );
        }

        Ok(InputCapture {
            stopping,
            run_loop,
            threads,
        })
    }

    pub(crate) fn stop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        if let Some(run_loop) = self.run_loop.lock().take() {
            run_loop.0.stop();
        }
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}

impl Drop for InputCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

fn own_pid() -> i32 {
    std::process::id() as i32
}

// ---- event tap -------------------------------------------------------------------------------

struct TapContext {
    tx: Sender<RawInput>,
    port: Mutex<Option<CFRetained<CFMachPort>>>,
}

const MOUSE_DOWN_TYPES: [CGEventType; 3] = [
    CGEventType::LeftMouseDown,
    CGEventType::RightMouseDown,
    CGEventType::OtherMouseDown,
];

fn run_tap(
    tx: Sender<RawInput>,
    ready: Sender<Result<()>>,
    run_loop_slot: &Mutex<Option<SendRunLoop>>,
    stopping: &AtomicBool,
) {
    autoreleasepool(|_| {
        let mask = MOUSE_DOWN_TYPES
            .iter()
            .chain([CGEventType::KeyDown].iter())
            .fold(0u64, |m, t| m | (1u64 << t.0));
        let context = Box::new(TapContext {
            tx,
            port: Mutex::new(None),
        });
        let context_ptr = &*context as *const TapContext as *mut c_void;
        let port = unsafe {
            CGEvent::tap_create(
                CGEventTapLocation::SessionEventTap,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                mask,
                Some(tap_callback),
                context_ptr,
            )
        };
        let Some(port) = port else {
            let _ = ready.send(Err(anyhow!(
                "CGEventTapCreate failed: Accessibility or Input Monitoring is not allowed"
            )));
            return;
        };
        let (Some(source), Some(run_loop)) = (
            CFMachPort::new_run_loop_source(None, Some(&port), 0),
            CFRunLoop::current(),
        ) else {
            let _ = ready.send(Err(anyhow!("could not attach the event tap to a run loop")));
            return;
        };
        run_loop.add_source(Some(&source), unsafe { kCFRunLoopCommonModes });
        CGEvent::tap_enable(&port, true);
        *context.port.lock() = Some(port.clone());
        *run_loop_slot.lock() = Some(SendRunLoop(run_loop.clone()));
        let _ = ready.send(Ok(()));
        // `stop` also stops the loop for a prompt exit; the slices cover a stop that lands before
        // the loop first runs.
        while !stopping.load(Ordering::Acquire) {
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.5, false);
        }
        CGEvent::tap_enable(&port, false);
        port.invalidate();
        drop(context);
    });
}

unsafe extern "C-unwind" fn tap_callback(
    _proxy: CGEventTapProxy,
    event_type: CGEventType,
    event: NonNull<CGEvent>,
    user_info: *mut c_void,
) -> *mut CGEvent {
    let context = unsafe { &*(user_info as *const TapContext) };
    let ev = unsafe { event.as_ref() };
    if event_type == CGEventType::TapDisabledByTimeout
        || event_type == CGEventType::TapDisabledByUserInput
    {
        if let Some(port) = context.port.lock().as_ref() {
            CGEvent::tap_enable(port, true);
        }
        return event.as_ptr();
    }
    let at = Local::now().fixed_offset();
    let flags = CGEvent::flags(Some(ev));
    let field = |f: CGEventField| CGEvent::integer_value_field(Some(ev), f);
    let raw = if MOUSE_DOWN_TYPES.contains(&event_type) {
        let p = CGEvent::location(Some(ev));
        RawInput::Mouse {
            at,
            x: p.x,
            y: p.y,
            button: field(CGEventField::MouseEventButtonNumber),
            clicks: field(CGEventField::MouseEventClickState),
            flags,
            window: field(CGEventField::MouseEventWindowUnderMousePointer) as u32,
        }
    } else if event_type == CGEventType::KeyDown {
        if field(CGEventField::KeyboardEventAutorepeat) != 0 {
            return event.as_ptr();
        }
        RawInput::Key {
            at,
            keycode: field(CGEventField::KeyboardEventKeycode) as u16,
            flags,
        }
    } else {
        return event.as_ptr();
    };
    let _ = context.tx.send(raw);
    event.as_ptr()
}

// ---- worker ----------------------------------------------------------------------------------

struct Worker {
    scope: InputScope,
    focused_pid: Arc<AtomicI32>,
    window_bounds: Arc<Mutex<Option<Rect>>>,
    page_url: String,
    page_title: String,
    scale: f64,
    sink: ActionSink,
}

impl Worker {
    fn run(self, rx: Receiver<RawInput>) {
        let ax = Ax::new();
        for raw in rx {
            autoreleasepool(|_| match raw {
                RawInput::Mouse {
                    at,
                    x,
                    y,
                    button,
                    clicks,
                    flags,
                    window,
                } => self.click(&ax, at, x, y, button, clicks, flags, window),
                RawInput::Key { at, keycode, flags } => self.key(at, keycode, flags),
            });
        }
    }

    /// The captured area's origin and size in global points.
    fn area(&self) -> Option<Rect> {
        match &self.scope {
            InputScope::Display { bounds } => Some(*bounds),
            InputScope::App { display_bounds, .. } => Some(*display_bounds),
            InputScope::Window { .. } => *self.window_bounds.lock(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn click(
        &self,
        ax: &Ax,
        at: DateTime<FixedOffset>,
        x: f64,
        y: f64,
        button: i64,
        clicks: i64,
        flags: CGEventFlags,
        window: u32,
    ) {
        let Some(area) = self.area() else { return };
        if !area.contains(x, y) {
            return;
        }
        let element = ax.element_at(x, y);
        let in_scope = match &self.scope {
            InputScope::Display { .. } => true,
            InputScope::Window { id, pid } => {
                window == *id || (window == 0 && element.as_ref().is_some_and(|e| e.pid == *pid))
            }
            InputScope::App { pid, .. } => {
                let owner = element
                    .as_ref()
                    .map(|e| e.pid)
                    .filter(|p| *p > 0)
                    .or_else(|| {
                        (window != 0)
                            .then(|| sys::window_by_id(window).map(|w| w.pid))
                            .flatten()
                    });
                owner == Some(*pid)
            }
        };
        if !in_scope {
            return;
        }
        let target = element.map(|e| ClickTarget {
            rect: e
                .frame
                .map(|f| (f.x - area.x, f.y - area.y, f.width, f.height)),
            role: e.role,
            text: e.text,
        });
        let (rx, ry) = (x - area.x, y - area.y);
        let label = match target.as_ref().and_then(|t| t.text.as_deref()) {
            Some(text) => format!("Click \"{}\"", text.chars().take(60).collect::<String>()),
            None => format!("Click at {:.0}, {:.0}", rx, ry),
        };
        (self.sink)(InputAction {
            at,
            label,
            payload: ActionPayload::Click {
                x: rx,
                y: ry,
                button,
                click_count: clicks.max(1),
                modifiers: modifiers(flags),
                target,
                viewport: Some(Viewport {
                    width: area.width,
                    height: area.height,
                    scale: self.scale,
                }),
                page_url: Some(self.page_url.clone()),
                page_title: Some(self.page_title.clone()),
            },
        });
    }

    fn key(&self, at: DateTime<FixedOffset>, keycode: u16, flags: CGEventFlags) {
        if let Some(pid) = self.scope.target_pid()
            && self.focused_pid.load(Ordering::Relaxed) != pid
        {
            return;
        }
        let Some(key) = recordable_key(keycode, modifiers(flags)) else {
            return;
        };
        (self.sink)(InputAction {
            at,
            label: key.label,
            payload: ActionPayload::Keyboard {
                key: key.key.into(),
                code: Some(key.code.into()),
                modifiers: key.modifiers,
            },
        });
    }
}

pub(crate) fn modifiers(flags: CGEventFlags) -> Modifiers {
    Modifiers {
        alt: flags.contains(CGEventFlags::MaskAlternate),
        ctrl: flags.contains(CGEventFlags::MaskControl),
        meta: flags.contains(CGEventFlags::MaskCommand),
        shift: flags.contains(CGEventFlags::MaskShift),
    }
}

// ---- keys ------------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub(crate) struct RecordableKey {
    pub key: &'static str,
    pub code: &'static str,
    pub modifiers: Modifiers,
    pub label: String,
}

/// (macOS virtual key code, DOM `key`, DOM `code`, special). Special keys are recorded on their
/// own; the rest only as part of a ⌘/⌃ shortcut. Names follow the US layout.
const KEYS: &[(u16, &str, &str, bool)] = &[
    (0x00, "a", "KeyA", false),
    (0x0B, "b", "KeyB", false),
    (0x08, "c", "KeyC", false),
    (0x02, "d", "KeyD", false),
    (0x0E, "e", "KeyE", false),
    (0x03, "f", "KeyF", false),
    (0x05, "g", "KeyG", false),
    (0x04, "h", "KeyH", false),
    (0x22, "i", "KeyI", false),
    (0x26, "j", "KeyJ", false),
    (0x28, "k", "KeyK", false),
    (0x25, "l", "KeyL", false),
    (0x2E, "m", "KeyM", false),
    (0x2D, "n", "KeyN", false),
    (0x1F, "o", "KeyO", false),
    (0x23, "p", "KeyP", false),
    (0x0C, "q", "KeyQ", false),
    (0x0F, "r", "KeyR", false),
    (0x01, "s", "KeyS", false),
    (0x11, "t", "KeyT", false),
    (0x20, "u", "KeyU", false),
    (0x09, "v", "KeyV", false),
    (0x0D, "w", "KeyW", false),
    (0x07, "x", "KeyX", false),
    (0x10, "y", "KeyY", false),
    (0x06, "z", "KeyZ", false),
    (0x1D, "0", "Digit0", false),
    (0x12, "1", "Digit1", false),
    (0x13, "2", "Digit2", false),
    (0x14, "3", "Digit3", false),
    (0x15, "4", "Digit4", false),
    (0x17, "5", "Digit5", false),
    (0x16, "6", "Digit6", false),
    (0x1A, "7", "Digit7", false),
    (0x1C, "8", "Digit8", false),
    (0x19, "9", "Digit9", false),
    (0x18, "=", "Equal", false),
    (0x1B, "-", "Minus", false),
    (0x21, "[", "BracketLeft", false),
    (0x1E, "]", "BracketRight", false),
    (0x27, "'", "Quote", false),
    (0x29, ";", "Semicolon", false),
    (0x2A, "\\", "Backslash", false),
    (0x2B, ",", "Comma", false),
    (0x2C, "/", "Slash", false),
    (0x2F, ".", "Period", false),
    (0x32, "`", "Backquote", false),
    (0x31, " ", "Space", false),
    (0x24, "Enter", "Enter", true),
    (0x4C, "Enter", "NumpadEnter", true),
    (0x30, "Tab", "Tab", true),
    (0x33, "Backspace", "Backspace", true),
    (0x75, "Delete", "Delete", true),
    (0x35, "Escape", "Escape", true),
    (0x7B, "ArrowLeft", "ArrowLeft", true),
    (0x7C, "ArrowRight", "ArrowRight", true),
    (0x7D, "ArrowDown", "ArrowDown", true),
    (0x7E, "ArrowUp", "ArrowUp", true),
    (0x73, "Home", "Home", true),
    (0x77, "End", "End", true),
    (0x74, "PageUp", "PageUp", true),
    (0x79, "PageDown", "PageDown", true),
    (0x72, "Help", "Help", true),
    (0x7A, "F1", "F1", true),
    (0x78, "F2", "F2", true),
    (0x63, "F3", "F3", true),
    (0x76, "F4", "F4", true),
    (0x60, "F5", "F5", true),
    (0x61, "F6", "F6", true),
    (0x62, "F7", "F7", true),
    (0x64, "F8", "F8", true),
    (0x65, "F9", "F9", true),
    (0x6D, "F10", "F10", true),
    (0x67, "F11", "F11", true),
    (0x6F, "F12", "F12", true),
    (0x69, "F13", "F13", true),
    (0x6B, "F14", "F14", true),
    (0x71, "F15", "F15", true),
    (0x6A, "F16", "F16", true),
    (0x40, "F17", "F17", true),
    (0x4F, "F18", "F18", true),
    (0x50, "F19", "F19", true),
    (0x5A, "F20", "F20", true),
];

/// `Some` for shortcuts and special keys; `None` for anything that types a character (plain,
/// ⇧ or ⌥ + a character key) and for unknown keys.
pub(crate) fn recordable_key(keycode: u16, modifiers: Modifiers) -> Option<RecordableKey> {
    let &(_, key, code, special) = KEYS.iter().find(|k| k.0 == keycode)?;
    if !special && !(modifiers.meta || modifiers.ctrl) {
        return None;
    }
    let mut label = String::new();
    for (on, symbol) in [
        (modifiers.ctrl, "⌃"),
        (modifiers.alt, "⌥"),
        (modifiers.shift, "⇧"),
        (modifiers.meta, "⌘"),
    ] {
        if on {
            label.push_str(symbol);
        }
    }
    label.push_str(match key {
        " " => "Space",
        "Enter" => "↩",
        "Escape" => "Esc",
        "Backspace" => "⌫",
        "Delete" => "⌦",
        "Tab" => "⇥",
        "ArrowLeft" => "←",
        "ArrowRight" => "→",
        "ArrowUp" => "↑",
        "ArrowDown" => "↓",
        _ => "",
    });
    if label.chars().last().is_none_or(|c| "⌃⌥⇧⌘".contains(c)) {
        label.push_str(&key.to_uppercase());
    }
    Some(RecordableKey {
        key,
        code,
        modifiers,
        label,
    })
}

// ---- focus -----------------------------------------------------------------------------------

fn poll_focus(
    scope: &InputScope,
    report: bool,
    stopping: &AtomicBool,
    focused_pid: &AtomicI32,
    window_bounds: &Mutex<Option<Rect>>,
    sink: &ActionSink,
) {
    let own = own_pid();
    let mut last: Option<(i32, Option<String>)> = None;
    let mut app_cache: Option<(i32, String, Option<String>)> = None;
    while !stopping.load(Ordering::Acquire) {
        autoreleasepool(|_| {
            if let InputScope::Window { id, .. } = scope
                && let Some(w) = sys::window_by_id(*id)
            {
                *window_bounds.lock() = Some(w.bounds);
            }
            let Some(front) = sys::frontmost_window(own) else {
                return;
            };
            focused_pid.store(front.pid, Ordering::Relaxed);
            let current = (front.pid, front.title.clone());
            let changed = last.as_ref() != Some(&current);
            let previous_pid = last.as_ref().map(|l| l.0);
            let first = last.is_none();
            last = Some(current);
            if !report || !changed || first {
                return;
            }
            let relevant = match scope.target_pid() {
                None => true,
                Some(pid) => front.pid == pid || previous_pid == Some(pid),
            };
            if !relevant {
                return;
            }
            if app_cache.as_ref().is_none_or(|c| c.0 != front.pid) {
                let meta = sys::app_meta(front.pid).unwrap_or_default();
                let name = if meta.name.is_empty() {
                    front.owner.clone()
                } else {
                    meta.name
                };
                app_cache = Some((front.pid, name, meta.bundle_id));
            }
            let (_, name, bundle_id) = app_cache.as_ref().expect("cached");
            let app_switch = previous_pid != Some(front.pid);
            let url = match bundle_id {
                Some(b) => app_url(b),
                None => format!("app://pid-{}", front.pid),
            };
            let title = front.title.as_deref().map(|t| mask_secrets(t).into_owned());
            let label = match (&title, app_switch) {
                (Some(t), true) => format!("Switched to {name} — {t}"),
                (None, true) => format!("Switched to {name}"),
                (Some(t), false) => format!("Window \"{t}\""),
                (None, false) => format!("{name} window changed"),
            };
            sink(InputAction {
                at: Local::now().fixed_offset(),
                label,
                payload: ActionPayload::Navigation {
                    url,
                    title: Some(match &title {
                        Some(t) => format!("{name} — {t}"),
                        None => name.clone(),
                    }),
                    app_switch,
                },
            });
        });
        std::thread::sleep(Duration::from_millis(400));
    }
}

// ---- accessibility ---------------------------------------------------------------------------

type AXUIElementRef = *const c_void;
type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct CGPointRaw {
    x: f64,
    y: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        app: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> i32;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> i32;
    fn AXValueGetValue(value: CFTypeRef, value_type: u32, out: *mut c_void) -> bool;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
}

const AX_VALUE_CGPOINT: u32 = 1;
const AX_VALUE_CGSIZE: u32 = 2;

struct AxElement {
    pid: i32,
    role: Option<String>,
    text: Option<String>,
    frame: Option<Rect>,
}

/// System-wide accessibility element, with a short messaging timeout so a hung app cannot stall
/// the worker.
struct Ax(AXUIElementRef);

impl Ax {
    fn new() -> Self {
        let system = unsafe { AXUIElementCreateSystemWide() };
        if !system.is_null() {
            unsafe { AXUIElementSetMessagingTimeout(system, 0.25) };
        }
        Ax(system)
    }

    fn element_at(&self, x: f64, y: f64) -> Option<AxElement> {
        if self.0.is_null() {
            return None;
        }
        let mut element: AXUIElementRef = std::ptr::null();
        if unsafe { AXUIElementCopyElementAtPosition(self.0, x as f32, y as f32, &mut element) }
            != 0
            || element.is_null()
        {
            return None;
        }
        let mut pid = 0;
        unsafe { AXUIElementGetPid(element, &mut pid) };
        let role = string_attr(element, "AXRole");
        let subrole = string_attr(element, "AXSubrole");
        let secure = subrole.as_deref() == Some("AXSecureTextField")
            || role.as_deref() == Some("AXSecureTextField");
        // Titles and descriptions are labels; values are only read for static text, never for
        // fields a user types into.
        let text = if secure {
            None
        } else {
            string_attr(element, "AXTitle")
                .or_else(|| string_attr(element, "AXDescription"))
                .or_else(|| {
                    (role.as_deref() == Some("AXStaticText"))
                        .then(|| string_attr(element, "AXValue"))
                        .flatten()
                })
                .map(|t| mask_secrets(t.trim()).into_owned())
                .filter(|t| !t.is_empty())
        };
        let frame = match (
            point_attr(element, "AXPosition", AX_VALUE_CGPOINT),
            point_attr(element, "AXSize", AX_VALUE_CGSIZE),
        ) {
            (Some(p), Some(s)) => Some(Rect {
                x: p.x,
                y: p.y,
                width: s.x,
                height: s.y,
            }),
            _ => None,
        };
        unsafe { CFRelease(element) };
        Some(AxElement {
            pid,
            role,
            text,
            frame,
        })
    }
}

impl Drop for Ax {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

fn copy_attr(element: AXUIElementRef, name: &str) -> Option<CFTypeRef> {
    let name = NSString::from_str(name);
    let mut value: CFTypeRef = std::ptr::null();
    let status = unsafe {
        AXUIElementCopyAttributeValue(element, Retained::as_ptr(&name).cast(), &mut value)
    };
    (status == 0 && !value.is_null()).then_some(value)
}

fn string_attr(element: AXUIElementRef, name: &str) -> Option<String> {
    let value = copy_attr(element, name)?;
    let text = if unsafe { CFGetTypeID(value) == CFStringGetTypeID() } {
        // CFString is toll-free bridged to NSString.
        Some(unsafe { &*(value as *const NSString) }.to_string())
    } else {
        None
    };
    unsafe { CFRelease(value) };
    text.filter(|t| !t.is_empty())
}

fn point_attr(element: AXUIElementRef, name: &str, value_type: u32) -> Option<CGPointRaw> {
    let value = copy_attr(element, name)?;
    let mut out = CGPointRaw::default();
    let ok = unsafe { AXValueGetValue(value, value_type, (&mut out as *mut CGPointRaw).cast()) };
    unsafe { CFRelease(value) };
    ok.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mods(meta: bool, ctrl: bool, alt: bool, shift: bool) -> Modifiers {
        Modifiers {
            alt,
            ctrl,
            meta,
            shift,
        }
    }

    #[test]
    fn never_records_typed_characters() {
        let s = 0x01;
        assert_eq!(recordable_key(s, Modifiers::default()), None);
        assert_eq!(
            recordable_key(s, mods(false, false, false, true)),
            None,
            "⇧S types S"
        );
        assert_eq!(
            recordable_key(s, mods(false, false, true, false)),
            None,
            "⌥S types ß"
        );
        assert_eq!(recordable_key(0x31, Modifiers::default()), None, "space");
        assert_eq!(
            recordable_key(0x12, mods(false, false, false, true)),
            None,
            "⇧1 types !"
        );
    }

    #[test]
    fn records_shortcuts_and_special_keys() {
        let save = recordable_key(0x01, mods(true, false, false, false)).unwrap();
        assert_eq!(
            (save.key, save.code, save.label.as_str()),
            ("s", "KeyS", "⌘S")
        );
        let redo = recordable_key(0x06, mods(true, false, false, true)).unwrap();
        assert_eq!(redo.label, "⇧⌘Z");
        assert_eq!(
            recordable_key(0x24, Modifiers::default()).unwrap().label,
            "↩"
        );
        assert_eq!(
            recordable_key(0x35, Modifiers::default()).unwrap().key,
            "Escape"
        );
        assert_eq!(
            recordable_key(0x7B, mods(false, false, true, false))
                .unwrap()
                .label,
            "⌥←"
        );
        assert_eq!(
            recordable_key(0x7A, Modifiers::default()).unwrap().label,
            "F1"
        );
        assert_eq!(
            recordable_key(0x31, mods(false, true, false, false))
                .unwrap()
                .label,
            "⌃Space"
        );
        assert_eq!(recordable_key(0xFF, mods(true, false, false, false)), None);
    }
}
