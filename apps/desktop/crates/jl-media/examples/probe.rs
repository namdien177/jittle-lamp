//! Prints MediaInfo for each file, writes thumbnails, measures WebM decode speed and runs a
//! short playback smoke test on the main thread.
//!
//! cargo run --release -p jl-media --example probe -- [--out DIR] FILE...

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use anyhow::Result;
use jl_media::{
    Container, MediaSource, Player, SeekMode, vpx::Decoder, webm::WebmIndex, yuv::SurfacePool,
};
use objc2_core_foundation::{CFRunLoop, kCFRunLoopDefaultMode};

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    let mut out = PathBuf::from("/tmp/jl-media-probe");
    if let Some(i) = args.iter().position(|a| a == "--out") {
        out = PathBuf::from(args.remove(i + 1));
        args.remove(i);
    }
    std::fs::create_dir_all(&out)?;
    for path in args.iter().map(PathBuf::from) {
        if let Err(err) = probe_one(&path, &out) {
            println!("{}: ERROR {err:#}", path.display());
        }
    }
    Ok(())
}

fn probe_one(path: &Path, out: &Path) -> Result<()> {
    let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
    println!("== {}", path.display());
    let t = Instant::now();
    let source = MediaSource::open(path, None)?;
    println!(
        "open: {:?}  {:?}  {:?}",
        t.elapsed(),
        source.container(),
        source.info()
    );

    let duration = source.info().duration_ms;
    for (label, at) in [
        ("start", 0),
        ("mid", duration / 2),
        ("end", duration.saturating_sub(100)),
    ] {
        let t = Instant::now();
        let thumb = source.frame_rgba(at, 320)?;
        let file = out.join(format!("{stem}-{label}-{at}ms.png"));
        thumb.save(&file)?;
        println!(
            "thumbnail {label} @{at}ms: {}x{} in {:?} -> {}",
            thumb.width(),
            thumb.height(),
            t.elapsed(),
            file.display()
        );
    }
    let t = Instant::now();
    let jpeg = jl_media::jpeg_thumbnail(path, duration / 3, 640, 80)?;
    println!(
        "jpeg_thumbnail 640px: {} bytes in {:?}",
        jpeg.len(),
        t.elapsed()
    );
    let t = Instant::now();
    let png = jl_media::frame_png(path, duration / 2)?;
    let file = out.join(format!("{stem}-frame.png"));
    std::fs::write(&file, &png)?;
    println!(
        "frame_png: {} bytes in {:?} -> {}",
        png.len(),
        t.elapsed(),
        file.display()
    );

    if source.container() == Container::WebM {
        bench_webm(path)?;
    }
    smoke_test_player(source, out, &stem)
}

fn bench_webm(path: &Path) -> Result<()> {
    let index = WebmIndex::open(path)?;
    println!(
        "index: {} frames, {} keyframes (every {:.2}s), frame duration {} ms",
        index.packets.len(),
        index.keyframe_count(),
        index.duration_ms as f64 / 1000.0 / index.keyframe_count().max(1) as f64,
        index.frame_duration_ms
    );
    let file = File::open(path)?;
    let mut buf = Vec::new();
    for threads in [1, 4] {
        let mut decoder = Decoder::new(index.codec, threads)?;
        let t = Instant::now();
        for i in 0..index.packets.len() {
            index.read_packet(&file, i, &mut buf)?;
            decoder.decode(&buf)?;
        }
        let elapsed = t.elapsed();
        println!(
            "decode only ({threads} thread{}): {:.0} fps",
            if threads == 1 { "" } else { "s" },
            index.packets.len() as f64 / elapsed.as_secs_f64()
        );
    }
    let pool = SurfacePool::new(index.width as usize, index.height as usize)?;
    let mut decoder = Decoder::new(index.codec, 4)?;
    let (mut decode_time, mut upload_time) = (Duration::ZERO, Duration::ZERO);
    for i in 0..index.packets.len() {
        index.read_packet(&file, i, &mut buf)?;
        let t = Instant::now();
        decoder.decode(&buf)?;
        decode_time += t.elapsed();
        let t = Instant::now();
        if let Some(picture) = decoder.last_picture() {
            let _frame = pool.upload(&picture)?;
        }
        upload_time += t.elapsed();
    }
    let n = index.packets.len() as f64;
    println!(
        "decode + 420f upload: {:.0} fps (decode {:.2} ms/frame, I420->NV12 into pooled CVPixelBuffer {:.2} ms/frame)",
        n / (decode_time + upload_time).as_secs_f64(),
        decode_time.as_secs_f64() * 1000.0 / n,
        upload_time.as_secs_f64() * 1000.0 / n
    );
    // Worst-case exact seek: the frame just before a keyframe.
    let worst = index
        .packets
        .iter()
        .rposition(|p| p.keyframe)
        .unwrap_or(0)
        .saturating_sub(1);
    let t = Instant::now();
    index.decode_at(path, index.packets[worst].pts_ms, |_| ())?;
    println!(
        "worst-case exact seek (decode {} frames from keyframe): {:?}",
        worst - index.keyframe_before(worst) + 1,
        t.elapsed()
    );
    Ok(())
}

fn spin(duration: Duration) {
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.01, false);
    }
}

fn spin_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, 0.005, false);
    }
    done()
}

fn smoke_test_player(source: MediaSource, out: &Path, stem: &str) -> Result<()> {
    let t = Instant::now();
    let player = Player::from_source(source)?;
    let notified = Arc::new(AtomicUsize::new(0));
    player.set_frame_listener(Some({
        let notified = notified.clone();
        Arc::new(move || {
            notified.fetch_add(1, Ordering::Relaxed);
        })
    }));
    let first = spin_until(Duration::from_secs(5), || player.current_frame().is_some());
    println!(
        "player: first frame {} after {:?}, size {:?}",
        if first { "ready" } else { "MISSING" },
        t.elapsed(),
        player.video_size()
    );

    // Play 1 s at 1x, then 1 s at 2x, counting distinct frames.
    let distinct = std::cell::Cell::new(0);
    let mut last: Option<usize> = None;
    let mut count_frames = |player: &Player| {
        if let Some(frame) = player.current_frame() {
            let ptr = objc2_core_foundation::CFRetained::as_ptr(&frame).as_ptr() as usize;
            if last != Some(ptr) {
                distinct.set(distinct.get() + 1);
                last = Some(ptr);
            }
        }
    };
    let start = player.position_ms();
    player.play();
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(1) {
        count_frames(&player);
        spin(Duration::from_millis(8));
    }
    let after_1x = player.position_ms();
    player.set_rate(2.0);
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(1) {
        count_frames(&player);
        spin(Duration::from_millis(8));
    }
    let after_2x = player.position_ms();
    player.pause();
    let paused_at = player.position_ms();
    spin(Duration::from_millis(300));
    println!(
        "play: {start} -> {after_1x} ms after 1s at 1x, -> {after_2x} ms after 1s at 2x ({} distinct frames); paused at {paused_at}, still {} after 300ms",
        distinct.get(),
        player.position_ms()
    );

    // Scrub: fast seeks every 16 ms across the file, then an exact seek.
    let duration = player.duration_ms();
    let before = notified.load(Ordering::Relaxed);
    let t = Instant::now();
    for step in 0..60 {
        player.seek(duration * step / 60, SeekMode::Fast);
        spin(Duration::from_millis(16));
        count_frames(&player);
    }
    let target = duration * 2 / 3;
    player.seek(target, SeekMode::Exact);
    let landed = spin_until(Duration::from_secs(5), || !player.is_seeking());
    println!(
        "scrub: 60 fast seeks + exact seek to {target} ms {} in {:?}; position {}, {} frame notifications",
        if landed { "landed" } else { "DID NOT LAND" },
        t.elapsed(),
        player.position_ms(),
        notified.load(Ordering::Relaxed) - before
    );
    for target in [
        duration / 5,
        duration / 2 + 777,
        duration.saturating_sub(1000),
    ] {
        let t = Instant::now();
        player.seek(target, SeekMode::Exact);
        spin_until(Duration::from_secs(5), || !player.is_seeking());
        let cold = t.elapsed();
        let t = Instant::now();
        player.seek(target, SeekMode::Exact);
        spin_until(Duration::from_secs(5), || !player.is_seeking());
        println!(
            "exact seek to {target} ms: {cold:?}; again on the shown frame: {:?}",
            t.elapsed()
        );
    }
    player.seek(target, SeekMode::Exact);
    spin_until(Duration::from_secs(5), || !player.is_seeking());
    let png = player.current_frame_png()?;
    let file = out.join(format!("{stem}-player-{target}ms.png"));
    std::fs::write(&file, png)?;
    println!("current_frame_png -> {}", file.display());

    // Play to the end.
    player.seek(duration.saturating_sub(300), SeekMode::Exact);
    spin_until(Duration::from_secs(5), || !player.is_seeking());
    player.play();
    let ended = spin_until(Duration::from_secs(5), || {
        player.current_frame();
        player.ended()
    });
    println!(
        "end: ended={ended} playing={} position {} / {duration}; error {:?}",
        player.is_playing(),
        player.position_ms(),
        player.error()
    );
    Ok(())
}
