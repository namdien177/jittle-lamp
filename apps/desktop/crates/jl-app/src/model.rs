//! What the interface shows, independent of where it came from. Adapters in `state.rs` fill these
//! from `jl-core`, `jl-api` and `jl-capture`; `demo()` fills them for `--demo` and snapshots.

use chrono::{DateTime, Duration, Local};
use gpui_kit::SharedString;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Page {
    Record,
    Library,
    Cloud,
    Runs,
    Logs,
    Settings,
}

impl Page {
    pub const MAIN: [Page; 5] = [Page::Record, Page::Library, Page::Cloud, Page::Runs, Page::Logs];

    pub fn title(self) -> &'static str {
        match self {
            Page::Record => "Record",
            Page::Library => "Library",
            Page::Cloud => "Cloud",
            Page::Runs => "Test runs",
            Page::Logs => "Logs",
            Page::Settings => "Settings",
        }
    }

    pub fn icon(self) -> &'static str {
        match self {
            Page::Record => "circle-dot",
            Page::Library => "library",
            Page::Cloud => "cloud",
            Page::Runs => "flask-conical",
            Page::Logs => "scroll-text",
            Page::Settings => "settings",
        }
    }

    pub fn shortcut(self) -> &'static str {
        match self {
            Page::Record => "⌘1",
            Page::Library => "⌘2",
            Page::Cloud => "⌘3",
            Page::Runs => "⌘4",
            Page::Logs => "⌘5",
            Page::Settings => "⌘,",
        }
    }
}

/// What produced a session.
#[derive(Clone, PartialEq, Debug)]
pub enum Origin {
    /// The Chrome extension, with the page host.
    Browser { host: SharedString },
    /// The cloud test runner.
    Runner,
    /// This app, capturing a display.
    Screen { display: SharedString },
    /// This app, capturing an application or one of its windows.
    App { name: SharedString },
}

impl Origin {
    pub fn label(&self) -> SharedString {
        match self {
            Origin::Browser { host } => host.clone(),
            Origin::Runner => "Test runner".into(),
            Origin::Screen { display } => display.clone(),
            Origin::App { name } => name.clone(),
        }
    }

    pub fn icon(&self) -> &'static str {
        match self {
            Origin::Browser { .. } => "globe",
            Origin::Runner => "flask-conical",
            Origin::Screen { .. } => "monitor",
            Origin::App { .. } => "app-window-mac",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Sync {
    Local,
    Uploading(f32),
    Synced,
    Failed,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: SharedString,
    pub name: SharedString,
    pub origin: Origin,
    pub recorded_at: DateTime<Local>,
    pub duration_ms: u64,
    pub actions: u32,
    pub requests: u32,
    pub logs: u32,
    pub errors: u32,
    pub bytes: u64,
    pub tags: Vec<SharedString>,
    pub sync: Sync,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Lane {
    Action,
    Network,
    Console,
    Marker,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, PartialOrd, Ord)]
pub enum Severity {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Clone, Debug)]
pub struct Event {
    pub lane: Lane,
    pub offset_ms: u64,
    pub label: SharedString,
    pub detail: SharedString,
    pub severity: Severity,
    /// Network: method and status for the badge.
    pub method: Option<SharedString>,
    pub status: Option<u16>,
    pub duration_ms: Option<u64>,
    /// Index into the archive's network section, for the detail panel.
    pub network_index: Option<usize>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CaptureKind {
    Screen,
    Window,
    App,
}

#[derive(Clone, Debug)]
pub struct CaptureSource {
    pub id: SharedString,
    pub kind: CaptureKind,
    pub name: SharedString,
    pub detail: SharedString,
}

#[derive(Clone, Debug)]
pub struct LogLine {
    pub at: DateTime<Local>,
    pub level: Severity,
    pub subsystem: SharedString,
    pub message: SharedString,
}

#[derive(Clone, Debug)]
pub struct CloudEvidence {
    pub id: SharedString,
    pub title: SharedString,
    pub origin: Origin,
    pub created_at: DateTime<Local>,
    pub author: SharedString,
    pub duration_ms: u64,
    pub shared: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RunStatus {
    Running,
    Passed,
    Failed,
    Queued,
}

#[derive(Clone, Debug)]
pub struct TestRun {
    pub case_key: SharedString,
    pub title: SharedString,
    pub status: RunStatus,
    pub started_at: DateTime<Local>,
    pub duration_ms: u64,
    pub steps_done: u32,
    pub steps_total: u32,
    pub environment: SharedString,
    pub evidence_id: Option<SharedString>,
}

pub struct Demo {
    pub sessions: Vec<Session>,
    pub events: Vec<Event>,
    pub sources: Vec<CaptureSource>,
    pub logs: Vec<LogLine>,
    pub cloud: Vec<CloudEvidence>,
    pub runs: Vec<TestRun>,
}

impl Demo {
    /// Real mode starts empty; adapters fill it. Capture sources stay until jl-capture lists real ones.
    pub fn empty() -> Self {
        let d = demo();
        Demo { sessions: vec![], events: vec![], sources: d.sources, logs: vec![], cloud: vec![], runs: vec![] }
    }
}

pub fn demo() -> Demo {
    let now = Local::now();
    let s = |id: &str, name: &str, origin: Origin, mins_ago: i64, dur: u64, a: u32, r: u32, l: u32, e: u32, mb: f64, tags: &[&str], sync: Sync| Session {
        id: id.to_string().into(),
        name: name.to_string().into(),
        origin,
        recorded_at: now - Duration::minutes(mins_ago),
        duration_ms: dur,
        actions: a,
        requests: r,
        logs: l,
        errors: e,
        bytes: (mb * 1_048_576.0) as u64,
        tags: tags.iter().map(|t| SharedString::from(t.to_string())).collect(),
        sync,
    };
    let sessions = vec![
        s("s-checkout-01", "Checkout fails after applying a voucher", Origin::Browser { host: "shop.staging.jittle.dev".into() }, 6, 94_000, 38, 212, 41, 3, 18.4, &["checkout", "p1"], Sync::Synced),
        s("s-figma-02", "Export dialog freezes on large frames", Origin::App { name: "Figma".into() }, 48, 151_000, 64, 0, 932, 12, 42.0, &["desktop"], Sync::Uploading(0.62)),
        s("s-onboard-03", "Onboarding — invite teammate happy path", Origin::Browser { host: "app.jittle.dev".into() }, 190, 58_000, 21, 96, 12, 0, 9.1, &["onboarding"], Sync::Local),
        s("s-screen-04", "Retina display flicker on wake", Origin::Screen { display: "Studio Display".into() }, 1_460, 32_000, 9, 0, 0, 0, 22.7, &[], Sync::Local),
        s("s-runner-05", "TC-142 · Parent sign-up with Singpass", Origin::Runner, 2_900, 211_000, 57, 340, 88, 1, 31.2, &["regression"], Sync::Synced),
        s("s-xcode-06", "Simulator crash when rotating camera view", Origin::App { name: "Simulator".into() }, 4_400, 76_000, 17, 0, 2_314, 27, 26.5, &["ios", "crash"], Sync::Failed),
        s("s-billing-07", "Invoice PDF shows previous month", Origin::Browser { host: "billing.jittle.dev".into() }, 8_800, 120_000, 44, 158, 23, 2, 15.0, &["billing"], Sync::Synced),
    ];

    let ev = |_: usize, lane: Lane, t: u64, label: &str, detail: &str, sev: Severity| Event {
        lane,
        offset_ms: t,
        label: label.to_string().into(),
        detail: detail.to_string().into(),
        severity: sev,
        method: None,
        status: None,
        duration_ms: None,
        network_index: None,
    };
    let net = |i: usize, t: u64, method: &str, path: &str, status: u16, ms: u64| Event {
        method: Some(method.to_string().into()),
        status: Some(status),
        duration_ms: Some(ms),
        severity: if status >= 500 { Severity::Error } else if status >= 400 { Severity::Warn } else { Severity::Info },
        ..ev(i, Lane::Network, t, path, "shop.staging.jittle.dev", Severity::Info)
    };
    let events = vec![
        ev(0, Lane::Action, 0, "Navigated to /cart", "shop.staging.jittle.dev", Severity::Info),
        net(1, 420, "GET", "/api/cart", 200, 182),
        net(2, 610, "GET", "/api/vouchers/eligible", 200, 96),
        ev(3, Lane::Action, 3_800, "Clicked “Apply voucher”", "button.voucher-apply", Severity::Info),
        ev(4, Lane::Action, 5_200, "Typed in “Voucher code”", "input#voucher · 8 characters", Severity::Info),
        net(5, 6_050, "POST", "/api/cart/vouchers", 201, 240),
        ev(6, Lane::Console, 6_400, "[cart] voucher applied: SPRING25", "cart.ts:118", Severity::Info),
        net(7, 6_520, "GET", "/api/cart/totals", 200, 131),
        ev(8, Lane::Action, 11_900, "Clicked “Checkout”", "a.checkout-cta", Severity::Info),
        net(9, 12_150, "POST", "/api/checkout/session", 500, 1_840),
        ev(10, Lane::Console, 14_010, "Uncaught TypeError: Cannot read properties of undefined (reading 'amount')", "checkout-summary.tsx:44", Severity::Error),
        ev(11, Lane::Marker, 15_200, "Spinner never resolves", "Marker", Severity::Warn),
        ev(12, Lane::Console, 16_300, "[sentry] event queued", "sentry.js:1", Severity::Debug),
        net(13, 18_400, "POST", "/api/checkout/session", 500, 1_910),
        ev(14, Lane::Action, 22_600, "Pressed ⌘R", "Reload", Severity::Info),
        net(15, 23_000, "GET", "/checkout", 200, 312),
        ev(16, Lane::Console, 24_900, "Warning: Each child in a list should have a unique \"key\" prop.", "react-dom.development.js", Severity::Warn),
        net(17, 26_200, "GET", "/api/checkout/session/cs_live_9f2", 404, 88),
        ev(18, Lane::Action, 31_000, "Clicked “Back to cart”", "a.back", Severity::Info),
        ev(19, Lane::Marker, 33_500, "Voucher still applied after reload", "Marker", Severity::Info),
    ];

    let sources = vec![
        CaptureSource { id: "display-1".into(), kind: CaptureKind::Screen, name: "Built-in Retina Display".into(), detail: "3024 × 1964".into() },
        CaptureSource { id: "display-2".into(), kind: CaptureKind::Screen, name: "Studio Display".into(), detail: "5120 × 2880".into() },
        CaptureSource { id: "app-chrome".into(), kind: CaptureKind::App, name: "Google Chrome".into(), detail: "4 windows".into() },
        CaptureSource { id: "app-sim".into(), kind: CaptureKind::App, name: "Simulator".into(), detail: "iPhone 17 Pro".into() },
        CaptureSource { id: "app-figma".into(), kind: CaptureKind::App, name: "Figma".into(), detail: "2 windows".into() },
        CaptureSource { id: "win-1".into(), kind: CaptureKind::Window, name: "Checkout — Jittle Shop".into(), detail: "Google Chrome".into() },
        CaptureSource { id: "win-2".into(), kind: CaptureKind::Window, name: "iPhone 17 Pro".into(), detail: "Simulator".into() },
    ];

    let lg = |secs: i64, level: Severity, sub: &str, msg: &str| LogLine {
        at: now - Duration::seconds(secs),
        level,
        subsystem: sub.to_string().into(),
        message: msg.to_string().into(),
    };
    let logs = vec![
        lg(42, Severity::Info, "com.apple.CoreSimulator", "Device iPhone 17 Pro booted in 2.1 s"),
        lg(40, Severity::Debug, "com.jittle.parent", "Restoring session for user 8f2c…"),
        lg(38, Severity::Info, "com.jittle.parent", "GET /v2/children → 200 (182 ms)"),
        lg(31, Severity::Warn, "com.apple.camera", "AVCaptureSession interrupted: video device not available in multitasking"),
        lg(30, Severity::Info, "com.jittle.parent", "Camera permission: authorized"),
        lg(24, Severity::Error, "com.jittle.parent", "Fatal error: Unexpectedly found nil while unwrapping an Optional value (CameraView.swift:212)"),
        lg(24, Severity::Error, "com.apple.runningboard", "Process com.jittle.parent[8211] exited with signal 5 (SIGTRAP)"),
        lg(20, Severity::Info, "com.apple.CoreSimulator", "Relaunching com.jittle.parent"),
        lg(12, Severity::Debug, "com.jittle.parent", "Feature flags loaded: camera_v2=true, uploads_bg=false"),
        lg(4, Severity::Info, "com.jittle.parent", "Authorization: Bearer ••••••••"),
    ];

    let cloud = vec![
        CloudEvidence { id: "ev-1".into(), title: "Checkout fails after applying a voucher".into(), origin: Origin::Browser { host: "shop.staging.jittle.dev".into() }, created_at: now - Duration::minutes(5), author: "You".into(), duration_ms: 94_000, shared: true },
        CloudEvidence { id: "ev-2".into(), title: "TC-142 · Parent sign-up with Singpass".into(), origin: Origin::Runner, created_at: now - Duration::hours(48), author: "Runner pool".into(), duration_ms: 211_000, shared: false },
        CloudEvidence { id: "ev-3".into(), title: "Invoice PDF shows previous month".into(), origin: Origin::Browser { host: "billing.jittle.dev".into() }, created_at: now - Duration::days(6), author: "Mai Tran".into(), duration_ms: 120_000, shared: true },
        CloudEvidence { id: "ev-4".into(), title: "Calendar drag drops event a day early".into(), origin: Origin::Browser { host: "app.jittle.dev".into() }, created_at: now - Duration::days(9), author: "Kenji Sato".into(), duration_ms: 47_000, shared: false },
    ];

    let runs = vec![
        TestRun { case_key: "TC-201".into(), title: "Parent uploads a medical certificate".into(), status: RunStatus::Running, started_at: now - Duration::minutes(2), duration_ms: 74_000, steps_done: 6, steps_total: 11, environment: "UAT".into(), evidence_id: None },
        TestRun { case_key: "TC-142".into(), title: "Parent sign-up with Singpass".into(), status: RunStatus::Passed, started_at: now - Duration::hours(2), duration_ms: 211_000, steps_done: 14, steps_total: 14, environment: "UAT".into(), evidence_id: None },
        TestRun { case_key: "TC-188".into(), title: "Teacher marks attendance offline".into(), status: RunStatus::Failed, started_at: now - Duration::hours(5), duration_ms: 96_000, steps_done: 7, steps_total: 12, environment: "Staging".into(), evidence_id: None },
        TestRun { case_key: "TC-090".into(), title: "Invoice PDF month header".into(), status: RunStatus::Queued, started_at: now, duration_ms: 0, steps_done: 0, steps_total: 9, environment: "UAT".into(), evidence_id: None },
    ];

    Demo { sessions, events, sources, logs, cloud, runs }
}
