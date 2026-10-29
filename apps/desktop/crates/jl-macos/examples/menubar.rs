//! Smoke test for jl-macos under an externally owned NSApplication.
//!
//! ```sh
//! RUST_LOG=info cargo run -p jl-macos --example menubar -- --seconds 5
//! RUST_LOG=info cargo run -p jl-macos --example menubar -- --seconds 60 --manual
//! ```
//!
//! The example owns `NSApplication` the way GPUI does: everything is installed from a timer
//! that fires once the run loop is running. By default it drives the menu and the hotkey
//! handler with synthetic clicks/presses; `--manual` skips that so you can press ⌥⇧R / ⌘⇧M
//! in any app and click the menu bar item yourself. `--no-notify` skips posting a
//! notification (which asks for permission the first time when bundled). Launch at login is
//! only attempted unbundled, where it must fail; bundled runs just print its status.

use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;
use std::time::Instant;

use block2::RcBlock;
use crossbeam_channel::{Receiver, unbounded};
use jl_macos::{
    AppRef, HotkeyId, Hotkeys, NotificationEvent, StatusEvent, StatusItem, StatusMenu,
    notifications,
};
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSEvent, NSEventModifierFlags, NSEventType,
};
use objc2_foundation::{NSPoint, NSTimer};

/// `(seconds since launch, action)` steps of the synthetic run.
type Script<'a> = [(f64, &'a dyn Fn(&mut Shell)); 6];

struct Shell {
    status: StatusItem,
    hotkeys: Hotkeys,
    status_rx: Receiver<StatusEvent>,
    hotkey_rx: Receiver<HotkeyId>,
    notification_rx: Receiver<NotificationEvent>,
    menu: StatusMenu,
    recording_since: Option<Instant>,
    post_notifications: bool,
}

impl Shell {
    fn toggle_recording(&mut self, source: Option<&str>) {
        if self.recording_since.take().is_some() {
            println!("  -> recording stopped");
            if self.post_notifications {
                jl_macos::notify("Recording saved", "0:02 · Safari", "session-demo").ok();
            }
        } else {
            println!(
                "  -> recording started ({})",
                source.unwrap_or("default source")
            );
            self.recording_since = Some(Instant::now());
        }
        self.menu.recording = self.recording_since.is_some();
        self.status.set_menu(&self.menu);
        self.status
            .set_recording(self.recording_since.map(|t| t.elapsed()));
    }

    fn poll(&mut self) {
        while let Ok(id) = self.hotkey_rx.try_recv() {
            println!("hotkey: {id:?}");
            if id == HotkeyId::TOGGLE_RECORDING {
                self.toggle_recording(None);
            }
        }
        while let Ok(event) = self.status_rx.try_recv() {
            println!("status item: {event:?}");
            match &event {
                StatusEvent::StartRecording { source_id } => self.toggle_recording(Some(source_id)),
                StatusEvent::StopRecording => self.toggle_recording(None),
                _ => {}
            }
        }
        while let Ok(event) = self.notification_rx.try_recv() {
            println!("notification: {event:?}");
        }
        if let Some(since) = self.recording_since {
            self.status.set_recording(Some(since.elapsed()));
        }
    }
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().collect();
    let seconds: f64 = args
        .iter()
        .position(|a| a == "--seconds")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(5.0);
    let manual = args.iter().any(|a| a == "--manual");
    let post_notifications = !args.iter().any(|a| a == "--no-notify");

    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    let shell: Rc<RefCell<Option<Shell>>> = Rc::default();
    let started = Instant::now();
    let script_step = RefCell::new(0usize);

    let tick = {
        let shell = shell.clone();
        RcBlock::new(move |_timer: NonNull<NSTimer>| {
            let mut slot = shell.borrow_mut();
            if slot.is_none() {
                *slot = Some(launch(post_notifications));
            }
            let shell = slot.as_mut().unwrap();
            shell.poll();

            let t = started.elapsed().as_secs_f64();
            if !manual {
                let mut step = script_step.borrow_mut();
                let first_source = shell.menu.sources[0].1.clone();
                let script: Script = [
                    (0.5, &|s| {
                        println!(
                            "simulate ⌥⇧R press: {:?}",
                            s.hotkeys.simulate_press(HotkeyId::TOGGLE_RECORDING)
                        )
                    }),
                    (1.2, &|s| {
                        println!("click 'Add Marker': {}", s.status.trigger(&["Add Marker"]))
                    }),
                    (1.4, &|s| {
                        println!(
                            "simulate ⌘⇧M press: {:?}",
                            s.hotkeys.simulate_press(HotkeyId::ADD_MARKER)
                        )
                    }),
                    (2.6, &|s| {
                        println!(
                            "click 'Stop Recording': {}",
                            s.status.trigger(&["Stop Recording"])
                        )
                    }),
                    (3.0, &|s| {
                        println!(
                            "click 'Add Marker' while idle (disabled): {}",
                            s.status.trigger(&["Add Marker"])
                        )
                    }),
                    (3.2, &|s| {
                        println!(
                            "click 'Start Recording ▸ {first_source}': {}",
                            s.status.trigger(&["Start Recording", &first_source])
                        );
                        println!(
                            "click recent 'Session from yesterday': {}",
                            s.status.trigger(&["Session from yesterday"])
                        );
                    }),
                ];
                while let Some((at, action)) = script.get(*step) {
                    if t < *at {
                        break;
                    }
                    action(shell);
                    *step += 1;
                }
            }

            if t >= seconds {
                println!("{seconds}s elapsed, stopping the run loop");
                let mtm = MainThreadMarker::new().unwrap();
                let app = NSApplication::sharedApplication(mtm);
                app.stop(None);
                // `stop` takes effect after the next event; post one so `run` returns now.
                if let Some(event) = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                    NSEventType::ApplicationDefined,
                    NSPoint::new(0.0, 0.0),
                    NSEventModifierFlags::empty(),
                    0.0,
                    0,
                    None,
                    0,
                    0,
                    0,
                ) {
                    app.postEvent_atStart(&event, true);
                }
            }
        })
    };
    // SAFETY: a scheduled timer fires on the run loop it was scheduled on (main), so the
    // non-Send captures never leave the main thread.
    let timer = unsafe { NSTimer::scheduledTimerWithTimeInterval_repeats_block(0.1, true, &tick) };

    println!("running NSApplication for {seconds}s (manual: {manual})");
    app.run();
    timer.invalidate();

    let shell = shell.borrow_mut().take();
    drop(shell);
    println!("status item removed, hotkeys unregistered; bye");
}

fn launch(post_notifications: bool) -> Shell {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    println!("app launched: {}", app.isRunning());
    println!(
        "bundled: {} ({:?})",
        jl_macos::is_bundled(),
        jl_macos::bundle_identifier()
    );

    let (status_tx, status_rx) = unbounded();
    let status = StatusItem::install(status_tx).expect("status item");

    let apps = jl_macos::running_apps();
    println!("running regular apps: {}", apps.len());
    for a in apps.iter().take(5) {
        println!(
            "  pid {:>6} active={:<5} {:?} {}",
            a.pid, a.active, a.bundle_id, a.name
        );
    }
    let mut sources = vec![("display:main".to_string(), "Entire Screen".to_string())];
    sources.extend(
        apps.iter()
            .filter(|a| a.pid as u32 != std::process::id())
            .take(3)
            .map(|a| {
                (
                    format!("app:{}", a.bundle_id.clone().unwrap_or_default()),
                    a.name.clone(),
                )
            }),
    );
    if let Some(front) = apps.iter().find(|a| a.active) {
        let png = jl_macos::app_icon_png(AppRef::Pid(front.pid), 64);
        println!(
            "icon of frontmost app {}: {:?} bytes",
            front.name,
            png.map(|p| p.len())
        );
    }

    let menu = StatusMenu {
        recording: false,
        sources,
        recent: vec![
            ("s1".into(), "Session from yesterday".into()),
            ("s2".into(), "Checkout bug".into()),
        ],
        signed_in_as: Some("qa@example.com".into()),
    };
    status.set_menu(&menu);

    let (hotkey_tx, hotkey_rx) = unbounded();
    let hotkeys = Hotkeys::register(
        &[
            (
                HotkeyId::TOGGLE_RECORDING,
                jl_macos::TOGGLE_RECORDING_SHORTCUT,
            ),
            (HotkeyId::ADD_MARKER, jl_macos::ADD_MARKER_SHORTCUT),
        ],
        hotkey_tx.clone(),
    )
    .expect("register hotkeys");
    for (id, shortcut) in hotkeys.bindings() {
        println!(
            "registered hotkey {shortcut} -> {id:?} (carbon key code {:#04x})",
            shortcut.key_code
        );
    }
    match Hotkeys::register(&[(HotkeyId(99), "alt+shift+r")], hotkey_tx) {
        Ok(_) => println!("duplicate registration unexpectedly succeeded"),
        Err(e) => println!("duplicate registration rejected as expected: {e}"),
    }

    let (notification_tx, notification_rx) = unbounded();
    println!(
        "notifications installed: {:?}",
        notifications::install(notification_tx)
    );
    if post_notifications {
        println!(
            "notify: {:?}",
            jl_macos::notify("Jittle Lamp", "menubar example is running", "example")
        );
    }
    println!("dock badge: {:?}", jl_macos::set_dock_badge(Some("1")));
    println!("reduce motion: {}", jl_macos::system_reduce_motion());
    println!("launch at login: {:?}", jl_macos::launch_at_login());
    if !jl_macos::is_bundled() {
        println!(
            "set launch at login (expected to fail unbundled): {:?}",
            jl_macos::set_launch_at_login(true)
        );
    }

    Shell {
        status,
        hotkeys,
        status_rx,
        hotkey_rx,
        notification_rx,
        menu,
        recording_since: None,
        post_notifications,
    }
}
