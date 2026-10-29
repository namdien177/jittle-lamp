//! Runs the real `/usr/bin/log stream`; needs macOS but no TCC permission.

use std::time::{Duration, Instant};

use jl_capture::{ConsoleLevel, LogFilter, LogStream, LogTarget};

#[test]
fn tails_a_process_and_masks_secrets() {
    let (stream, lines) =
        LogStream::attach(LogFilter::process_name("logger")).expect("log stream starts");
    let marker = format!("jl-capture-test-{}", std::process::id());
    let message = format!("{marker} Authorization: Bearer abcdef0123456789xyz password=hunter2");
    std::process::Command::new("/usr/bin/logger")
        .arg(&message)
        .status()
        .expect("logger runs");

    let deadline = Instant::now() + Duration::from_secs(10);
    let line = loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .expect("log line arrived within 10 s");
        let line = lines.recv_timeout(left).expect("stream still open");
        if line.message.contains(&marker) {
            break line;
        }
    };
    assert_eq!(
        line.message,
        format!("{marker} Authorization: Bearer abcd****9xyz password=****")
    );
    assert_eq!(line.process, "logger");
    assert_eq!(line.level, ConsoleLevel::Info);
    assert!(stream.is_running());
    stream.stop();
    assert!(!stream.is_running());
    // The reader thread is gone, so draining what is buffered ends instead of blocking.
    let _ = lines.iter().count();
}

#[test]
fn rejects_an_invalid_predicate() {
    let filter = LogFilter {
        target: LogTarget::Predicate("processID ===".into()),
        include_debug: false,
        subsystem: None,
    };
    let error = LogStream::attach(filter)
        .err()
        .expect("log rejects the predicate");
    assert!(error.to_string().contains("log stream failed"), "{error}");
}
