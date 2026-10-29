//! Unified-log capture through `/usr/bin/log stream --style ndjson`.
//!
//! [`LogStream::attach`] tails any process for the Logs page; the recorder uses the same stream for
//! application and window targets and turns [`LogLine`]s into archive console entries.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, FixedOffset};
use crossbeam_channel::{Receiver, Sender, bounded};
use parking_lot::Mutex;
use serde::Deserialize;

use crate::mask::mask_secrets;

/// Console levels of the archive schema (`consoleEventSchema.level`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ConsoleLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }

    /// `default`/`info` → info, `debug` → debug, `error`/`fault` → error.
    pub fn from_message_type(message_type: &str) -> Self {
        match message_type.to_ascii_lowercase().as_str() {
            "debug" => Self::Debug,
            "error" | "fault" => Self::Error,
            _ => Self::Info,
        }
    }
}

/// Which processes to tail.
#[derive(Clone, Debug)]
pub enum LogTarget {
    Pid(i32),
    /// An app and everything launched from its bundle (helpers, renderers, XPC services).
    App {
        pid: i32,
        bundle_path: Option<PathBuf>,
    },
    ProcessName(String),
    ImagePath(PathBuf),
    /// A raw `log` predicate, used as is.
    Predicate(String),
}

#[derive(Clone, Debug)]
pub struct LogFilter {
    pub target: LogTarget,
    /// `--level debug` (otherwise `info`; `default`, `error` and `fault` are always included).
    pub include_debug: bool,
    pub subsystem: Option<String>,
}

impl LogFilter {
    pub fn pid(pid: i32) -> Self {
        Self {
            target: LogTarget::Pid(pid),
            include_debug: true,
            subsystem: None,
        }
    }

    pub fn app(pid: i32, bundle_path: Option<PathBuf>) -> Self {
        Self {
            target: LogTarget::App { pid, bundle_path },
            include_debug: true,
            subsystem: None,
        }
    }

    pub fn process_name(name: impl Into<String>) -> Self {
        Self {
            target: LogTarget::ProcessName(name.into()),
            include_debug: true,
            subsystem: None,
        }
    }

    pub fn predicate(&self) -> String {
        let target = match &self.target {
            LogTarget::Pid(pid) => format!("processID == {pid}"),
            LogTarget::App {
                pid,
                bundle_path: Some(path),
            } => {
                let prefix = format!("{}/", path.to_string_lossy().trim_end_matches('/'));
                format!(
                    "(processID == {pid} OR processImagePath BEGINSWITH {})",
                    quote(&prefix)
                )
            }
            LogTarget::App {
                pid,
                bundle_path: None,
            } => format!("processID == {pid}"),
            LogTarget::ProcessName(name) => format!("process == {}", quote(name)),
            LogTarget::ImagePath(path) => {
                format!("processImagePath == {}", quote(&path.to_string_lossy()))
            }
            LogTarget::Predicate(raw) => return raw.clone(),
        };
        match &self.subsystem {
            Some(subsystem) => format!("{target} AND subsystem == {}", quote(subsystem)),
            None => target,
        }
    }
}

// NSPredicate string literal.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// One parsed, masked unified-log event.
#[derive(Clone, Debug, PartialEq)]
pub struct LogLine {
    pub at: DateTime<FixedOffset>,
    pub level: ConsoleLevel,
    /// The raw `messageType` (`Default`, `Info`, `Debug`, `Error`, `Fault`).
    pub message_type: String,
    pub message: String,
    pub subsystem: Option<String>,
    pub category: Option<String>,
    pub process: String,
    pub pid: i32,
}

impl LogLine {
    /// Archive console `args`: where the line came from, so the viewer can filter on it.
    pub fn console_args(&self) -> Vec<String> {
        let mut args = vec![format!("process={}[{}]", self.process, self.pid)];
        if let Some(subsystem) = &self.subsystem {
            args.push(format!("subsystem={subsystem}"));
        }
        if let Some(category) = &self.category {
            args.push(format!("category={category}"));
        }
        if self.message_type.eq_ignore_ascii_case("fault") {
            args.push("type=fault".into());
        }
        args
    }
}

const MAX_MESSAGE_CHARS: usize = 8_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawEvent {
    event_type: Option<String>,
    message_type: Option<String>,
    timestamp: Option<String>,
    event_message: Option<String>,
    subsystem: Option<String>,
    category: Option<String>,
    process_image_path: Option<String>,
    #[serde(rename = "processID")]
    process_id: Option<i32>,
}

/// Parses one `log stream --style ndjson` line. The banner line, activity and signpost events
/// return `None`.
pub fn parse_ndjson_line(line: &str) -> Option<LogLine> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let raw: RawEvent = serde_json::from_str(line).ok()?;
    if raw.event_type.as_deref() != Some("logEvent") {
        return None;
    }
    let at = parse_log_timestamp(raw.timestamp.as_deref()?)?;
    let message_type = raw.message_type.unwrap_or_else(|| "Default".into());
    let mut message = mask_secrets(raw.event_message.as_deref().unwrap_or("")).into_owned();
    if message.chars().count() > MAX_MESSAGE_CHARS {
        message = message.chars().take(MAX_MESSAGE_CHARS).collect::<String>() + "…";
    }
    let image_path = raw.process_image_path.unwrap_or_default();
    let process = image_path.rsplit('/').next().unwrap_or_default().to_owned();
    Some(LogLine {
        at,
        level: ConsoleLevel::from_message_type(&message_type),
        message_type,
        message,
        subsystem: raw.subsystem.filter(|s| !s.is_empty()),
        category: raw.category.filter(|s| !s.is_empty()),
        process,
        pid: raw.process_id.unwrap_or(0),
    })
}

/// `2026-10-29 21:11:27.130922+0700`
pub fn parse_log_timestamp(value: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f%z").ok()
}

/// Volume cap for a recording: debug floods are thinned to a per-second budget and the total
/// is bounded, while errors are always kept. Dropped lines are counted per level.
#[derive(Debug)]
pub struct LogBudget {
    debug_per_second: u32,
    info_per_second: u32,
    max_total: usize,
    window_start: Option<Instant>,
    window_debug: u32,
    window_info: u32,
    kept: usize,
    pub dropped_debug: u64,
    pub dropped_info: u64,
    pub dropped_error: u64,
}

impl Default for LogBudget {
    fn default() -> Self {
        Self::new(40, 200, 20_000)
    }
}

impl LogBudget {
    pub fn new(debug_per_second: u32, info_per_second: u32, max_total: usize) -> Self {
        Self {
            debug_per_second,
            info_per_second,
            max_total,
            window_start: None,
            window_debug: 0,
            window_info: 0,
            kept: 0,
            dropped_debug: 0,
            dropped_info: 0,
            dropped_error: 0,
        }
    }

    pub fn admit(&mut self, level: ConsoleLevel, now: Instant) -> bool {
        if self
            .window_start
            .is_none_or(|start| now.duration_since(start) >= Duration::from_secs(1))
        {
            self.window_start = Some(now);
            self.window_debug = 0;
            self.window_info = 0;
        }
        let keep = match level {
            // Errors are what the review is for; only the hard total applies to them.
            ConsoleLevel::Error | ConsoleLevel::Warn => self.kept < self.max_total,
            ConsoleLevel::Info => {
                self.window_info += 1;
                self.window_info <= self.info_per_second && self.kept < self.max_total * 9 / 10
            }
            ConsoleLevel::Debug => {
                self.window_debug += 1;
                self.window_debug <= self.debug_per_second && self.kept < self.max_total / 2
            }
        };
        if keep {
            self.kept += 1;
        } else {
            match level {
                ConsoleLevel::Debug => self.dropped_debug += 1,
                ConsoleLevel::Info => self.dropped_info += 1,
                ConsoleLevel::Warn | ConsoleLevel::Error => self.dropped_error += 1,
            }
        }
        keep
    }

    pub fn dropped_total(&self) -> u64 {
        self.dropped_debug + self.dropped_info + self.dropped_error
    }
}

const CHANNEL_CAPACITY: usize = 20_000;

/// A running `log stream` child. Dropping it kills the child.
pub struct LogStream {
    predicate: String,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    running: Arc<AtomicBool>,
    dropped: Arc<AtomicU64>,
}

impl LogStream {
    /// Starts `log stream` for `filter`. Lines arrive masked on the receiver; it disconnects when
    /// the stream stops. Fails when `log` rejects the predicate.
    pub fn attach(filter: LogFilter) -> Result<(LogStream, Receiver<LogLine>)> {
        let predicate = filter.predicate();
        let level = if filter.include_debug {
            "debug"
        } else {
            "info"
        };
        let mut child = Command::new("/usr/bin/log")
            .args([
                "stream",
                "--style",
                "ndjson",
                "--level",
                level,
                "--predicate",
                &predicate,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("spawning /usr/bin/log stream")?;
        let stdout = child.stdout.take().context("log stream stdout")?;
        let mut stderr = child.stderr.take().context("log stream stderr")?;

        let (tx, rx) = bounded(CHANNEL_CAPACITY);
        let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);
        let running = Arc::new(AtomicBool::new(true));
        let dropped = Arc::new(AtomicU64::new(0));
        let reader = {
            let running = running.clone();
            let dropped = dropped.clone();
            std::thread::Builder::new()
                .name("jl-log-stream".into())
                .spawn(move || {
                    read_lines(stdout, &tx, &ready_tx, &dropped);
                    running.store(false, Ordering::Release);
                    let mut message = String::new();
                    let _ = stderr.read_to_string(&mut message);
                    let _ = ready_tx.try_send(Err(message));
                })?
        };

        let stream = LogStream {
            predicate,
            child: Mutex::new(Some(child)),
            reader: Mutex::new(Some(reader)),
            running,
            dropped,
        };
        // `log` prints a "Filtering the log data using …" banner once the predicate is accepted.
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Err(message)) => {
                stream.stop();
                bail!("log stream failed: {}", message.trim());
            }
            Ok(Ok(())) | Err(_) => Ok((stream, rx)),
        }
    }

    pub fn predicate(&self) -> &str {
        &self.predicate
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Acquire)
    }

    /// Lines dropped because the receiver fell more than 20 000 lines behind.
    pub fn dropped(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.lock().take() {
            let _ = reader.join();
        }
    }
}

impl Drop for LogStream {
    fn drop(&mut self) {
        self.stop();
    }
}

fn read_lines(
    stdout: impl Read,
    tx: &Sender<LogLine>,
    ready: &Sender<Result<(), String>>,
    dropped: &AtomicU64,
) {
    let mut reader = BufReader::new(stdout);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let _ = ready.try_send(Ok(()));
        let Some(line) = parse_ndjson_line(&buf) else {
            continue;
        };
        match tx.try_send(line) {
            Ok(()) => {}
            Err(crossbeam_channel::TrySendError::Full(_)) => {
                dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(crossbeam_channel::TrySendError::Disconnected(_)) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"timezoneName":"","messageType":"Error","eventType":"logEvent","formatString":"%@","subsystem":"com.example.app","category":"network","threadID":1,"processImagePath":"\/Applications\/Example.app\/Contents\/MacOS\/Example","timestamp":"2026-10-29 21:11:27.130922+0700","eventMessage":"request failed Authorization: Bearer abcdef0123456789xyz","processID":405}"#;

    #[test]
    fn parses_log_event() {
        let line = parse_ndjson_line(SAMPLE).expect("parsed");
        assert_eq!(line.level, ConsoleLevel::Error);
        assert_eq!(
            line.message,
            "request failed Authorization: Bearer abcd****9xyz"
        );
        assert_eq!(line.process, "Example");
        assert_eq!(line.pid, 405);
        assert_eq!(line.at.to_rfc3339(), "2026-10-29T21:11:27.130922+07:00");
        assert_eq!(
            line.console_args(),
            vec![
                "process=Example[405]",
                "subsystem=com.example.app",
                "category=network"
            ]
        );
    }

    #[test]
    fn maps_levels() {
        for (raw, level) in [
            ("Default", ConsoleLevel::Info),
            ("Info", ConsoleLevel::Info),
            ("Debug", ConsoleLevel::Debug),
            ("Error", ConsoleLevel::Error),
            ("Fault", ConsoleLevel::Error),
        ] {
            assert_eq!(ConsoleLevel::from_message_type(raw), level, "{raw}");
        }
        let fault = SAMPLE.replace(r#""messageType":"Error""#, r#""messageType":"Fault""#);
        assert!(
            parse_ndjson_line(&fault)
                .unwrap()
                .console_args()
                .contains(&"type=fault".to_string())
        );
    }

    #[test]
    fn skips_banner_and_non_log_events() {
        assert!(parse_ndjson_line(r#"Filtering the log data using "processID == 1""#).is_none());
        assert!(parse_ndjson_line("").is_none());
        let activity = SAMPLE.replace("logEvent", "activityCreateEvent");
        assert!(parse_ndjson_line(&activity).is_none());
        assert!(parse_ndjson_line("{not json").is_none());
    }

    #[test]
    fn builds_predicates() {
        assert_eq!(LogFilter::pid(42).predicate(), "processID == 42");
        assert_eq!(
            LogFilter::app(42, Some("/Applications/My \"App\".app".into())).predicate(),
            r#"(processID == 42 OR processImagePath BEGINSWITH "/Applications/My \"App\".app/")"#
        );
        let mut filter = LogFilter::process_name("Finder");
        filter.subsystem = Some("com.apple.finder".into());
        assert_eq!(
            filter.predicate(),
            r#"process == "Finder" AND subsystem == "com.apple.finder""#
        );
    }

    #[test]
    fn budget_thins_debug_floods_and_keeps_errors() {
        let mut budget = LogBudget::new(5, 10, 1_000);
        let t0 = Instant::now();
        let kept = (0..100)
            .filter(|_| budget.admit(ConsoleLevel::Debug, t0))
            .count();
        assert_eq!(kept, 5);
        assert_eq!(budget.dropped_debug, 95);
        assert!((0..50).all(|_| budget.admit(ConsoleLevel::Error, t0)));
        // The next second gets a fresh debug allowance.
        assert!(budget.admit(ConsoleLevel::Debug, t0 + Duration::from_millis(1_001)));
    }
}
