//! Record a display, window or app and write the session folder.
//!
//! ```text
//! cargo run -p jl-capture --example record -- --display [ID] --seconds 5
//! cargo run -p jl-capture --example record -- --app com.apple.Safari --seconds 5
//! cargo run -p jl-capture --example record -- --window 1234 --seconds 5
//! cargo run -p jl-capture --example record -- --list
//! ```
//! Options: `--out DIR` (default /tmp/jl-capture), `--audio`, `--mic`, `--no-input`, `--no-logs`,
//! `--marker-at SECS`, `--fps N`, `--points` (1× instead of Retina).

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use jl_capture::{
    AppSelector, CaptureTarget, ContentOptions, Recorder, RecorderEvent, RecordingOptions,
};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .filter(|v| !v.starts_with("--"))
            .cloned()
    };

    let perms = jl_capture::permissions();
    println!("permissions: {perms:?}");
    if flag("--list") {
        return list();
    }

    let target = if flag("--display") {
        CaptureTarget::Display {
            display_id: value("--display").map(|v| v.parse()).transpose()?,
        }
    } else if let Some(bundle_id) = value("--app") {
        CaptureTarget::Application {
            app: AppSelector::BundleId(bundle_id),
            display_id: None,
        }
    } else if let Some(id) = value("--window") {
        CaptureTarget::Window {
            window_id: id.parse()?,
        }
    } else {
        bail!("pass --display [ID], --app <bundle-id>, --window <id> or --list");
    };
    let seconds: f64 = value("--seconds")
        .map(|v| v.parse())
        .transpose()?
        .unwrap_or(5.0);
    let mut options = RecordingOptions::new(
        value("--out").unwrap_or_else(|| "/tmp/jl-capture".into()),
        target,
    );
    options.system_audio = flag("--audio");
    options.microphone = flag("--mic");
    options.capture_input = !flag("--no-input");
    options.capture_logs = !flag("--no-logs");
    options.retina = !flag("--points");
    if let Some(fps) = value("--fps") {
        options.fps = fps.parse()?;
    }
    let marker_at: Option<f64> = value("--marker-at").map(|v| v.parse()).transpose()?;

    let (tx, rx) = crossbeam_channel::unbounded();
    let started = Instant::now();
    let recorder = Recorder::start(options, tx).context("starting the recording")?;
    println!(
        "recording {} for {seconds}s → {}",
        recorder.session_id(),
        recorder.folder().display()
    );

    let deadline = started + Duration::from_secs_f64(seconds);
    let mut marker_done = marker_at.is_none();
    let mut next_tick = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
            print_event(&event);
        }
        if !marker_done && recorder.elapsed().as_secs_f64() >= marker_at.unwrap_or(0.0) {
            marker_done = true;
            recorder.add_marker("Example marker")?;
        }
        if Instant::now() >= next_tick {
            next_tick += Duration::from_secs(1);
            let preview = recorder.latest_preview_frame().map(|f| {
                use objc2_core_video::{
                    CVPixelBufferGetHeight, CVPixelBufferGetPixelFormatType, CVPixelBufferGetWidth,
                };
                let format = CVPixelBufferGetPixelFormatType(&f).to_be_bytes();
                format!(
                    "{}×{} {}",
                    CVPixelBufferGetWidth(&f),
                    CVPixelBufferGetHeight(&f),
                    String::from_utf8_lossy(&format)
                )
            });
            println!(
                "  {:>5.1}s {:?} preview {:?}",
                recorder.elapsed().as_secs_f64(),
                recorder.stats(),
                preview
            );
        }
    }

    let finished = recorder.stop()?;
    for event in rx.try_iter() {
        print_event(&event);
    }
    println!("stats: {:?}", recorder.stats());
    println!("finished: {finished:#?}");
    Ok(())
}

fn print_event(event: &RecorderEvent) {
    match event {
        RecorderEvent::Finished(_) => println!("  event: Finished"),
        other => println!("  event: {other:?}"),
    }
}

fn list() -> Result<()> {
    let content = jl_capture::shareable_content_with(ContentOptions {
        app_icons: true,
        ..ContentOptions::default()
    })?;
    for d in &content.displays {
        println!(
            "display {:>3}  {:<18} {:?} @{}x{}",
            d.id,
            d.name,
            d.frame,
            d.scale,
            if d.is_main { " (main)" } else { "" }
        );
    }
    for w in &content.windows {
        println!(
            "window {:>6}  {:<24} {:<32} pid {:>6} {:>5.0}×{:<5.0} {}  {}",
            w.id,
            w.app_name,
            w.bundle_id,
            w.pid,
            w.frame.width,
            w.frame.height,
            if w.on_screen { "on " } else { "off" },
            w.title.as_deref().unwrap_or("(untitled)")
        );
    }
    for a in &content.apps {
        println!(
            "app  {:<40} {:<24} pid {:>6} windows {}  icon {} B",
            a.bundle_id,
            a.name,
            a.pid,
            a.window_count,
            a.icon_png.as_ref().map_or(0, Vec::len)
        );
    }
    Ok(())
}
