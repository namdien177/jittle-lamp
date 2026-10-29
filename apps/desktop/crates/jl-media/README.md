# jl-media

Video playback to `CVPixelBuffer` and frame extraction for the macOS app.

| Container | Backend | Audio |
| --- | --- | --- |
| MP4 / MOV (native recordings, cloud evidence) | AVPlayer + AVPlayerItemVideoOutput; AVAssetImageGenerator for stills | yes |
| WebM VP8/VP9 (extension recordings) | `matroska-demuxer` index + libvpx on a decode thread | no (Opus is skipped) |

Frames are `kCVPixelFormatType_420YpCbCr8BiPlanarFullRange` (`420f`, NV12) from a
`CVPixelBufferPool` of IOSurface-backed buffers. GPUI's Metal renderer asserts this format for
`surface()` and converts it with a BT.601 full-range matrix, so libvpx's studio-range I420 is
expanded to full range while interleaving chroma.

## Use

```rust
// background thread
let source = jl_media::MediaSource::open(&path, Some("video/webm"))?;
// main thread
let player = jl_media::Player::from_source(source)?;
player.set_frame_listener(Some(Arc::new(move || { /* wake the UI to repaint */ })));
player.play();
// every frame while playing or seeking:
if let Some(frame) = player.current_frame() { /* gpui::surface(frame) */ }
// scrubbing: player.seek(ms, SeekMode::Fast); on release: player.seek(ms, SeekMode::Exact)
```

`probe`, `thumbnail`, `jpeg_thumbnail` and `frame_png` are blocking and run on any thread.
`Player::current_frame_png` copies the frame on screen without decoding again.

## libvpx

`build.rs` links `libvpx.a` statically, so the app bundle needs no extra dylib.

- Development: `brew install libvpx`. Homebrew's archive is built for the host macOS version, so
  the linker may warn when the app targets an older one.
- Release: `crates/jl-media/scripts/build-libvpx.sh` builds a decoder-only libvpx (about 700 KB)
  for macOS 15 into `target/libvpx`. Build with `JL_LIBVPX_DIR=$PWD/target/libvpx/lib`.
- `JL_LIBVPX_DYLIB=1` forces dynamic linking. The dylib then has to be copied into
  `Contents/Frameworks` and its install name rewritten with `install_name_tool`.

## Checks

```sh
cargo test -p jl-media
cargo run --release -p jl-media --example probe -- recording.webm recording.mp4
```

`tests/fixtures/*.frames` hold real libvpx output (`gen-frames.c`). The tests mux it into WebM
the way Chrome's MediaRecorder writes it: no Cues, no Duration, unknown-size clusters.
