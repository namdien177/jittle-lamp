//! WebM index, seeking and decode tests. Fixture frames are real libvpx output
//! (`tests/fixtures/gen-frames.c`), muxed here the way Chrome's MediaRecorder writes WebM:
//! unknown-size Segment and Clusters, no Cues, no Duration.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use jl_media::vpx::{Decoder, VpxCodec};
use jl_media::webm::{WebmIndex, is_keyframe};
use jl_media::{Container, MediaSource, Player, SeekMode, VideoCodec, pixel_buffer_to_rgba, yuv};

struct EncodedFrame {
    pts_ms: u64,
    keyframe: bool,
    data: Vec<u8>,
}

fn fixture(name: &str) -> Vec<EncodedFrame> {
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures")
            .join(name),
    )
    .unwrap();
    let mut frames = Vec::new();
    let mut rest = &bytes[..];
    while !rest.is_empty() {
        let size = u32::from_le_bytes(rest[..4].try_into().unwrap()) as usize;
        let keyframe = rest[4] == 1;
        let pts_ms = u64::from_le_bytes(rest[5..13].try_into().unwrap());
        frames.push(EncodedFrame {
            pts_ms,
            keyframe,
            data: rest[13..13 + size].to_vec(),
        });
        rest = &rest[13 + size..];
    }
    frames
}

// --- minimal EBML writer -------------------------------------------------------------------

fn vint_size(size: u64) -> Vec<u8> {
    // 8-byte size: 0x01 marker followed by 7 bytes.
    let mut out = vec![0x01];
    out.extend_from_slice(&size.to_be_bytes()[1..]);
    out
}

fn element(id: &[u8], body: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend(vint_size(body.len() as u64));
    out.extend_from_slice(body);
    out
}

fn unknown_size(id: &[u8]) -> Vec<u8> {
    let mut out = id.to_vec();
    out.extend_from_slice(&[0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
    out
}

fn uint(id: &[u8], value: u64) -> Vec<u8> {
    element(id, &value.to_be_bytes())
}

fn string(id: &[u8], value: &str) -> Vec<u8> {
    element(id, value.as_bytes())
}

fn float(id: &[u8], value: f64) -> Vec<u8> {
    element(id, &value.to_be_bytes())
}

#[derive(Default)]
struct MuxOptions {
    header_duration_ms: Option<f64>,
    /// (pts_ms) of fake audio blocks on track 2.
    audio_pts: Vec<u64>,
    frames_per_cluster: usize,
}

fn mux(
    codec_id: &str,
    width: u64,
    height: u64,
    frames: &[EncodedFrame],
    options: &MuxOptions,
) -> Vec<u8> {
    let mut out = element(
        &[0x1A, 0x45, 0xDF, 0xA3],
        &[
            uint(&[0x42, 0x86], 1),
            uint(&[0x42, 0xF7], 1),
            uint(&[0x42, 0xF2], 4),
            uint(&[0x42, 0xF3], 8),
            string(&[0x42, 0x82], "webm"),
            uint(&[0x42, 0x87], 4),
            uint(&[0x42, 0x85], 2),
        ]
        .concat(),
    );
    out.extend(unknown_size(&[0x18, 0x53, 0x80, 0x67]));
    let mut info = vec![
        uint(&[0x2A, 0xD7, 0xB1], 1_000_000),
        string(&[0x4D, 0x80], "test"),
        string(&[0x57, 0x41], "test"),
    ];
    if let Some(duration) = options.header_duration_ms {
        info.push(float(&[0x44, 0x89], duration));
    }
    out.extend(element(&[0x15, 0x49, 0xA9, 0x66], &info.concat()));

    let video = element(
        &[0xAE],
        &[
            uint(&[0xD7], 1),
            uint(&[0x73, 0xC5], 1),
            uint(&[0x83], 1),
            string(&[0x86], codec_id),
            element(
                &[0xE0],
                &[uint(&[0xB0], width), uint(&[0xBA], height)].concat(),
            ),
        ]
        .concat(),
    );
    let mut tracks = video;
    if !options.audio_pts.is_empty() {
        tracks.extend(element(
            &[0xAE],
            &[
                uint(&[0xD7], 2),
                uint(&[0x73, 0xC5], 2),
                uint(&[0x83], 2),
                string(&[0x86], "A_OPUS"),
                element(
                    &[0xE1],
                    &[float(&[0xB5], 48000.0), uint(&[0x9F], 2)].concat(),
                ),
            ]
            .concat(),
        ));
    }
    out.extend(element(&[0x16, 0x54, 0xAE, 0x6B], &tracks));

    // Interleave video and audio blocks by time, cutting clusters every N video frames.
    let mut blocks: Vec<(u64, u8, bool, &[u8])> = frames
        .iter()
        .map(|f| (f.pts_ms, 1, f.keyframe, &f.data[..]))
        .collect();
    let audio = [0xFCu8, 0xFF, 0xFE];
    blocks.extend(
        options
            .audio_pts
            .iter()
            .map(|&pts| (pts, 2, true, &audio[..])),
    );
    blocks.sort_by_key(|b| (b.0, b.1));
    let per_cluster = options.frames_per_cluster.max(1);
    let mut video_in_cluster = per_cluster;
    let mut cluster_ts = 0;
    for (pts, track, key, data) in blocks {
        if track == 1 {
            if video_in_cluster == per_cluster {
                out.extend(unknown_size(&[0x1F, 0x43, 0xB6, 0x75]));
                out.extend(uint(&[0xE7], pts));
                cluster_ts = pts;
                video_in_cluster = 0;
            }
            video_in_cluster += 1;
        }
        let mut block = vec![0x80 | track];
        block.extend_from_slice(&((pts as i64 - cluster_ts as i64) as i16).to_be_bytes());
        block.push(if key { 0x80 } else { 0x00 });
        block.extend_from_slice(data);
        out.extend(element(&[0xA3], &block));
    }
    out
}

fn write_temp(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recording.webm");
    std::fs::write(&path, bytes).unwrap();
    (dir, path)
}

fn rgba_sequence(codec: VpxCodec, frames: &[EncodedFrame]) -> Vec<image::RgbaImage> {
    let mut decoder = Decoder::new(codec, 1).unwrap();
    frames
        .iter()
        .map(|frame| {
            assert!(decoder.decode(&frame.data).unwrap());
            yuv::yuv_to_rgba(&decoder.last_picture().unwrap())
        })
        .collect()
}

// --- tests ----------------------------------------------------------------------------------

#[test]
fn fixtures_have_keyframes_mid_stream() {
    for name in ["vp8.frames", "vp9.frames"] {
        let frames = fixture(name);
        assert_eq!(frames.len(), 12, "{name}");
        assert!(frames[0].keyframe, "{name}");
        assert!(
            frames.iter().skip(1).any(|f| f.keyframe),
            "{name}: needs a second keyframe for seek tests"
        );
    }
}

#[test]
fn keyframe_bit_matches_encoder() {
    for (name, codec) in [("vp8.frames", VpxCodec::Vp8), ("vp9.frames", VpxCodec::Vp9)] {
        for (i, frame) in fixture(name).iter().enumerate() {
            assert_eq!(
                is_keyframe(codec, &frame.data),
                Some(frame.keyframe),
                "{name} frame {i}"
            );
        }
    }
}

#[test]
fn index_without_cues_or_duration() {
    let frames = fixture("vp8.frames");
    let bytes = mux(
        "V_VP8",
        66,
        38,
        &frames,
        &MuxOptions {
            frames_per_cluster: 5,
            ..Default::default()
        },
    );
    let (_dir, path) = write_temp(&bytes);
    let index = WebmIndex::open(&path).unwrap();

    assert_eq!(index.codec, VpxCodec::Vp8);
    assert_eq!((index.width, index.height), (66, 38));
    assert_eq!(index.packets.len(), frames.len());
    assert!(!index.has_audio);
    assert_eq!(index.frame_duration_ms, 40);
    // No Duration element: last frame (440 ms) + one frame.
    assert_eq!(index.duration_ms, 480);
    for (packet, frame) in index.packets.iter().zip(&frames) {
        assert_eq!(packet.pts_ms, frame.pts_ms);
        assert_eq!(packet.keyframe, frame.keyframe);
        let at = packet.offset as usize;
        assert_eq!(
            &bytes[at..at + packet.size as usize],
            &frame.data[..],
            "offset of frame at {} ms",
            frame.pts_ms
        );
    }

    assert_eq!(index.frame_at(0), 0);
    assert_eq!(index.frame_at(39), 0);
    assert_eq!(index.frame_at(40), 1);
    assert_eq!(index.frame_at(10_000), frames.len() - 1);
    let second_key = frames.iter().skip(1).position(|f| f.keyframe).unwrap() + 1;
    assert_eq!(index.keyframe_before(second_key), second_key);
    assert_eq!(index.keyframe_before(second_key - 1), 0);
    assert_eq!(index.keyframe_before(second_key + 1), second_key);
}

#[test]
fn header_duration_wins_when_present() {
    let frames = fixture("vp8.frames");
    let options = MuxOptions {
        header_duration_ms: Some(1234.0),
        frames_per_cluster: 4,
        ..Default::default()
    };
    let (_dir, path) = write_temp(&mux("V_VP8", 66, 38, &frames, &options));
    assert_eq!(WebmIndex::open(&path).unwrap().duration_ms, 1234);
}

#[test]
fn audio_track_extends_duration() {
    let frames = fixture("vp9.frames");
    let options = MuxOptions {
        audio_pts: vec![0, 20, 300, 900],
        frames_per_cluster: 6,
        ..Default::default()
    };
    let (_dir, path) = write_temp(&mux("V_VP9", 66, 38, &frames, &options));
    let index = WebmIndex::open(&path).unwrap();
    assert!(index.has_audio);
    assert_eq!(index.packets.len(), frames.len());
    assert_eq!(index.duration_ms, 900);
    let info = MediaSource::open(&path, Some("video/webm"))
        .unwrap()
        .info()
        .clone();
    assert_eq!(info.codec, VideoCodec::Vp9);
    assert!(info.has_audio);
}

#[test]
fn backwards_timestamps_keep_the_index_sorted() {
    let mut frames = fixture("vp8.frames");
    frames[6].pts_ms = 200; // previous frame is at 200 too; next at 280
    frames[7].pts_ms = 190; // goes backwards
    let (_dir, path) = write_temp(&mux(
        "V_VP8",
        66,
        38,
        &frames,
        &MuxOptions {
            frames_per_cluster: 12,
            ..Default::default()
        },
    ));
    let index = WebmIndex::open(&path).unwrap();
    assert!(index.packets.windows(2).all(|w| w[0].pts_ms <= w[1].pts_ms));
    assert_eq!(index.packets[7].pts_ms, 200);
}

#[test]
fn exact_seek_matches_sequential_decode() {
    for (name, codec_id, codec) in [
        ("vp8.frames", "V_VP8", VpxCodec::Vp8),
        ("vp9.frames", "V_VP9", VpxCodec::Vp9),
    ] {
        let frames = fixture(name);
        let expected = rgba_sequence(codec, &frames);
        let (_dir, path) = write_temp(&mux(
            codec_id,
            66,
            38,
            &frames,
            &MuxOptions {
                frames_per_cluster: 5,
                ..Default::default()
            },
        ));
        let index = WebmIndex::open(&path).unwrap();
        let keyframes: Vec<bool> = index.packets.iter().map(|p| p.keyframe).collect();
        assert_eq!(
            keyframes,
            frames.iter().map(|f| f.keyframe).collect::<Vec<_>>(),
            "{name}"
        );
        for (i, frame) in frames.iter().enumerate() {
            // Middle of the frame's display interval.
            let got = index
                .decode_at(&path, frame.pts_ms + 20, yuv::yuv_to_rgba)
                .unwrap();
            assert_eq!(got.dimensions(), (66, 38));
            assert!(got == expected[i], "{name}: frame {i} differs after seek");
        }
        let thumb = MediaSource::open(&path, None)
            .unwrap()
            .frame_rgba(200, 32)
            .unwrap();
        assert_eq!(thumb.dimensions(), (32, 18));
    }
}

fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    done()
}

#[test]
fn player_seeks_plays_and_ends() {
    let frames = fixture("vp9.frames");
    let expected = rgba_sequence(VpxCodec::Vp9, &frames);
    let (_dir, path) = write_temp(&mux(
        "V_VP9",
        66,
        38,
        &frames,
        &MuxOptions {
            frames_per_cluster: 5,
            ..Default::default()
        },
    ));

    let player = Player::open(&path, Some("video/webm")).unwrap();
    assert_eq!(player.container(), Container::WebM);
    assert!(!player.plays_audio());
    assert_eq!(player.duration_ms(), 480);
    assert!(wait_until(Duration::from_secs(2), || player
        .current_frame()
        .is_some()));
    let first = player.current_frame().unwrap();
    assert_eq!(
        objc2_core_video::CVPixelBufferGetPixelFormatType(&first),
        jl_media::SURFACE_PIXEL_FORMAT
    );
    assert_eq!(objc2_core_video::CVPixelBufferGetWidth(&first), 66);
    assert_eq!(objc2_core_video::CVPixelBufferGetHeight(&first), 38);

    // Exact seek lands on frame 7 (280–319 ms) and reports the requested position at once.
    player.seek(300, SeekMode::Exact);
    assert_eq!(player.position_ms(), 300);
    assert!(wait_until(Duration::from_secs(2), || !player.is_seeking()));
    let shown = pixel_buffer_to_rgba(&player.current_frame().unwrap()).unwrap();
    assert_eq!(shown.dimensions(), (66, 38));
    let diff = max_channel_diff(&shown, &expected[7]);
    assert!(diff <= 3, "NV12 round trip differs by {diff}");
    assert_eq!(player.position_ms(), 300, "clock must not run while paused");

    // Fast seeks while scrubbing, then an exact seek on release.
    for ms in [0, 120, 40, 400, 200] {
        player.seek(ms, SeekMode::Fast);
    }
    player.seek(160, SeekMode::Exact);
    assert!(wait_until(Duration::from_secs(2), || !player.is_seeking()));
    let shown = pixel_buffer_to_rgba(&player.current_frame().unwrap()).unwrap();
    assert!(max_channel_diff(&shown, &expected[4]) <= 3);

    // The next frames are already queued; seeking onto one reuses it.
    std::thread::sleep(Duration::from_millis(30)); // let the decoder fill its queue
    player.seek(200, SeekMode::Exact);
    assert!(wait_until(Duration::from_secs(2), || !player.is_seeking()));
    let shown = pixel_buffer_to_rgba(&player.current_frame().unwrap()).unwrap();
    assert!(max_channel_diff(&shown, &expected[5]) <= 3);

    // Play at 4x to the end.
    player.set_rate(4.0);
    player.play();
    assert!(player.is_playing());
    assert!(wait_until(Duration::from_secs(2), || {
        player.current_frame();
        player.ended()
    }));
    assert!(!player.is_playing());
    assert_eq!(player.position_ms(), 480);
    let last = pixel_buffer_to_rgba(&player.current_frame().unwrap()).unwrap();
    assert!(max_channel_diff(&last, &expected[11]) <= 3);

    // Play after the end restarts from the beginning.
    player.play();
    assert!(player.position_ms() < 100);
    assert!(player.error().is_none());
}

fn max_channel_diff(a: &image::RgbaImage, b: &image::RgbaImage) -> u8 {
    a.as_raw()
        .iter()
        .zip(b.as_raw())
        .map(|(x, y)| x.abs_diff(*y))
        .max()
        .unwrap_or(0)
}

/// Real Chrome recording, if present on this machine.
#[test]
fn real_chrome_recording() {
    let path = Path::new("/tmp/jlwebm/sample.webm");
    if !path.exists() {
        eprintln!("skipping: {} not found", path.display());
        return;
    }
    let index = WebmIndex::open(path).unwrap();
    assert_eq!(
        (index.codec, index.width, index.height),
        (VpxCodec::Vp8, 1600, 1000)
    );
    assert_eq!(index.packets.len(), 2151);
    assert_eq!(index.duration_ms, 86_040);
    assert_eq!(index.keyframe_count(), 17);
}
