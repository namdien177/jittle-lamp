//! Tail a running app's unified log, masked, the way the Logs page does.
//!
//! ```text
//! cargo run -p jl-capture --example logs -- --app com.apple.Safari [--seconds 10] [--no-debug]
//! cargo run -p jl-capture --example logs -- --pid 405
//! cargo run -p jl-capture --example logs -- --process WindowServer
//! ```

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use jl_capture::{ContentOptions, LogFilter, LogStream};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };

    let mut filter = if let Some(bundle_id) = value("--app") {
        let content = jl_capture::shareable_content_with(ContentOptions {
            app_icons: false,
            ..ContentOptions::default()
        })?;
        let app = content
            .apps
            .iter()
            .find(|a| a.bundle_id == bundle_id)
            .with_context(|| format!("{bundle_id} has no windows open"))?;
        LogFilter::app(app.pid, app.bundle_path.clone())
    } else if let Some(pid) = value("--pid") {
        LogFilter::pid(pid.parse()?)
    } else if let Some(name) = value("--process") {
        LogFilter::process_name(name)
    } else {
        bail!("pass --app <bundle-id>, --pid <pid> or --process <name>");
    };
    filter.include_debug = !args.iter().any(|a| a == "--no-debug");
    let seconds: f64 = value("--seconds")
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(10.0);

    let (stream, lines) = LogStream::attach(filter)?;
    println!("predicate: {}", stream.predicate());
    let deadline = Instant::now() + Duration::from_secs_f64(seconds);
    let mut count = 0usize;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let Ok(line) = lines.recv_timeout(left) else {
            break;
        };
        count += 1;
        println!(
            "{} {:<5} {}[{}] {}{} {}",
            line.at.format("%H:%M:%S%.3f"),
            line.level.as_str(),
            line.process,
            line.pid,
            line.subsystem.as_deref().unwrap_or("-"),
            line.category
                .as_deref()
                .map(|c| format!(":{c}"))
                .unwrap_or_default(),
            line.message
        );
    }
    stream.stop();
    println!(
        "{count} lines, {} dropped, running after stop: {}",
        stream.dropped(),
        stream.is_running()
    );
    Ok(())
}
