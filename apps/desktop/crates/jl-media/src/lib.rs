//! Video playback and frame extraction for the macOS app.
//!
//! - MP4/MOV (native recordings, cloud evidence) play through AVPlayer, with audio.
//! - WebM (extension recordings, VP8/VP9) is demuxed in Rust and decoded with libvpx on a
//!   dedicated thread. WebM audio is not played.
//!
//! Frames come out as `CVPixelBuffer`s in [`SURFACE_PIXEL_FORMAT`] (`420f`), the only format
//! GPUI's `surface()` element renders.
//!
//! Threading: [`MediaSource::open`], [`probe`], [`thumbnail`], [`jpeg_thumbnail`] and
//! [`frame_png`] are blocking and may run on any thread. [`Player`] lives on the main thread
//! (AVPlayer is main-thread-only); open the source in the background and hand it to
//! [`Player::from_source`] on the main thread.

mod avf;
mod clock;
pub mod vpx;
pub mod webm;
mod webm_player;
pub mod yuv;

use std::fmt;
use std::fs::File;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use image::RgbaImage;
use image::imageops::FilterType;
use objc2::MainThreadMarker;
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;

pub use yuv::{SURFACE_PIXEL_FORMAT, pixel_buffer_to_rgba};

/// Called (from any thread) when a frame becomes available outside steady playback: a seek
/// landed or the first frame decoded. Use it to schedule a repaint while paused.
pub type FrameListener = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeekMode {
    /// While scrubbing: AVPlayer snaps to a keyframe; WebM decoding can be interrupted by the
    /// next seek and shows intermediate frames. The reported position is the requested one.
    Fast,
    /// On release: lands on the exact frame.
    Exact,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VideoCodec {
    Vp8,
    Vp9,
    H264,
    Hevc,
    Other(String),
}

impl fmt::Display for VideoCodec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VideoCodec::Vp8 => f.write_str("vp8"),
            VideoCodec::Vp9 => f.write_str("vp9"),
            VideoCodec::H264 => f.write_str("h264"),
            VideoCodec::Hevc => f.write_str("hevc"),
            VideoCodec::Other(name) => f.write_str(name),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaInfo {
    pub duration_ms: u64,
    /// Display size (rotation applied).
    pub width: u32,
    pub height: u32,
    pub codec: VideoCodec,
    pub has_audio: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Container {
    WebM,
    /// MP4, MOV or anything else AVFoundation reads.
    AvFoundation,
}

/// Picks the backend from the MIME type, then the file signature, then the extension.
pub fn detect_container(path: &Path, mime_hint: Option<&str>) -> Container {
    if let Some(mime) = mime_hint.map(str::to_ascii_lowercase) {
        if mime.contains("webm") || mime.contains("matroska") {
            return Container::WebM;
        }
        if mime.contains("mp4") || mime.contains("quicktime") {
            return Container::AvFoundation;
        }
    }
    let mut magic = [0u8; 4];
    if File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
    {
        return if magic == [0x1A, 0x45, 0xDF, 0xA3] {
            Container::WebM
        } else {
            Container::AvFoundation
        };
    }
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("webm" | "mkv") => Container::WebM,
        _ => Container::AvFoundation,
    }
}

enum SourceKind {
    WebM(Arc<webm::WebmIndex>),
    Av(avf::AvAsset),
}

/// An opened, indexed media file. `Send + Sync`; open it off the main thread.
pub struct MediaSource {
    path: PathBuf,
    info: MediaInfo,
    kind: SourceKind,
}

impl MediaSource {
    /// Blocking: indexes WebM files (one pass over the file) or loads the AVAsset.
    pub fn open(path: impl AsRef<Path>, mime_hint: Option<&str>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        match detect_container(&path, mime_hint) {
            Container::WebM => {
                let index = webm::WebmIndex::open(&path)?;
                let info = MediaInfo {
                    duration_ms: index.duration_ms,
                    width: index.width,
                    height: index.height,
                    codec: match index.codec {
                        vpx::VpxCodec::Vp8 => VideoCodec::Vp8,
                        vpx::VpxCodec::Vp9 => VideoCodec::Vp9,
                    },
                    has_audio: index.has_audio,
                };
                Ok(Self {
                    path,
                    info,
                    kind: SourceKind::WebM(Arc::new(index)),
                })
            }
            Container::AvFoundation => {
                let (asset, info) = avf::load(&path)?;
                Ok(Self {
                    path,
                    info,
                    kind: SourceKind::Av(asset),
                })
            }
        }
    }

    pub fn info(&self) -> &MediaInfo {
        &self.info
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn container(&self) -> Container {
        match self.kind {
            SourceKind::WebM(_) => Container::WebM,
            SourceKind::Av(_) => Container::AvFoundation,
        }
    }

    /// The frame shown at `at_ms`, as RGBA scaled to fit `max_edge` (0 = full size).
    pub fn frame_rgba(&self, at_ms: u64, max_edge: u32) -> Result<RgbaImage> {
        let at_ms = at_ms.min(self.info.duration_ms);
        let image = match &self.kind {
            SourceKind::WebM(index) => index.decode_at(&self.path, at_ms, yuv::yuv_to_rgba)?,
            SourceKind::Av(asset) => avf::still(asset, at_ms, max_edge)?,
        };
        Ok(fit(image, max_edge))
    }
}

fn fit(image: RgbaImage, max_edge: u32) -> RgbaImage {
    let (w, h) = image.dimensions();
    let longest = w.max(h);
    if max_edge == 0 || longest <= max_edge {
        return image;
    }
    let scale = max_edge as f64 / longest as f64;
    let (nw, nh) = (
        ((w as f64 * scale).round() as u32).max(1),
        ((h as f64 * scale).round() as u32).max(1),
    );
    image::imageops::resize(&image, nw, nh, FilterType::Triangle)
}

/// Duration, size and codec. Blocking; WebM files are scanned once (they often lack a
/// Duration element).
pub fn probe(path: impl AsRef<Path>) -> Result<MediaInfo> {
    Ok(MediaSource::open(path, None)?.info)
}

/// The frame at `at_ms` scaled to fit within `max_edge` pixels (0 = full size).
pub fn thumbnail(path: impl AsRef<Path>, at_ms: u64, max_edge: u32) -> Result<RgbaImage> {
    MediaSource::open(path, None)?.frame_rgba(at_ms, max_edge)
}

/// A JPEG thumbnail for uploads (`quality` 1–100).
pub fn jpeg_thumbnail(
    path: impl AsRef<Path>,
    at_ms: u64,
    max_edge: u32,
    quality: u8,
) -> Result<Vec<u8>> {
    encode_jpeg(&thumbnail(path, at_ms, max_edge)?, quality)
}

/// The full-size frame at `at_ms` as PNG, for "copy frame".
pub fn frame_png(path: impl AsRef<Path>, at_ms: u64) -> Result<Vec<u8>> {
    encode_png(&thumbnail(path, at_ms, 0)?)
}

pub fn encode_png(image: &RgbaImage) -> Result<Vec<u8>> {
    let mut out = Cursor::new(Vec::new());
    image
        .write_to(&mut out, image::ImageFormat::Png)
        .context("encode PNG")?;
    Ok(out.into_inner())
}

pub fn encode_jpeg(image: &RgbaImage, quality: u8) -> Result<Vec<u8>> {
    let rgb = image::DynamicImage::ImageRgba8(image.clone()).into_rgb8();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100))
        .encode_image(&rgb)
        .context("encode JPEG")?;
    Ok(out)
}

enum Backend {
    WebM(webm_player::WebmPlayer),
    Av(avf::AvPlayer),
}

/// Plays one media file. Main thread only (not `Send`).
///
/// Drive it from the render loop: while [`Player::is_playing`] or [`Player::is_seeking`],
/// request an animation frame and draw [`Player::current_frame`]; when paused, repaint from
/// the [`FrameListener`].
pub struct Player {
    backend: Backend,
    info: MediaInfo,
    container: Container,
}

macro_rules! dispatch {
    ($self:ident, $player:ident => $body:expr) => {
        match &$self.backend {
            Backend::WebM($player) => $body,
            Backend::Av($player) => $body,
        }
    };
}

impl Player {
    /// Opens and indexes `path` on the calling thread (which must be the main thread for
    /// MP4/MOV). Prefer [`MediaSource::open`] in the background + [`Player::from_source`].
    pub fn open(path: impl AsRef<Path>, mime_hint: Option<&str>) -> Result<Self> {
        Self::from_source(MediaSource::open(path, mime_hint)?)
    }

    /// Cheap; must run on the main thread (AVPlayer requires it).
    pub fn from_source(source: MediaSource) -> Result<Self> {
        let container = source.container();
        let backend = match source.kind {
            SourceKind::WebM(index) => {
                Backend::WebM(webm_player::WebmPlayer::new(&source.path, index)?)
            }
            SourceKind::Av(asset) => {
                let mtm = MainThreadMarker::new().ok_or_else(|| {
                    anyhow!("an MP4/MOV Player must be created on the main thread")
                })?;
                Backend::Av(avf::AvPlayer::new(&asset, source.info.clone(), mtm)?)
            }
        };
        Ok(Self {
            backend,
            info: source.info,
            container,
        })
    }

    pub fn info(&self) -> &MediaInfo {
        &self.info
    }

    pub fn container(&self) -> Container {
        self.container
    }

    /// Whether audio is audible (false for WebM, whose audio is not decoded).
    pub fn plays_audio(&self) -> bool {
        matches!(self.backend, Backend::Av(_)) && self.info.has_audio
    }

    /// Starts playback; restarts from 0 if the media had ended.
    pub fn play(&self) {
        dispatch!(self, p => p.play())
    }

    pub fn pause(&self) {
        dispatch!(self, p => p.pause())
    }

    pub fn toggle(&self) {
        if self.is_playing() {
            self.pause()
        } else {
            self.play()
        }
    }

    /// Seeks to `ms` (clamped to the duration). [`Player::position_ms`] reports `ms` at once.
    pub fn seek(&self, ms: u64, mode: SeekMode) {
        dispatch!(self, p => p.seek(ms, mode))
    }

    /// Playback rate, clamped to 1/16–16.
    pub fn set_rate(&self, rate: f32) {
        dispatch!(self, p => p.set_rate(rate))
    }

    pub fn rate(&self) -> f32 {
        dispatch!(self, p => p.rate())
    }

    pub fn position_ms(&self) -> u64 {
        dispatch!(self, p => p.position_ms())
    }

    pub fn duration_ms(&self) -> u64 {
        dispatch!(self, p => p.duration_ms())
    }

    pub fn is_playing(&self) -> bool {
        dispatch!(self, p => p.is_playing())
    }

    pub fn ended(&self) -> bool {
        dispatch!(self, p => p.ended())
    }

    /// A seek is still decoding; keep requesting frames.
    pub fn is_seeking(&self) -> bool {
        dispatch!(self, p => p.is_seeking())
    }

    pub fn video_size(&self) -> (u32, u32) {
        dispatch!(self, p => p.video_size())
    }

    /// The last playback error, if any.
    pub fn error(&self) -> Option<String> {
        dispatch!(self, p => p.error())
    }

    pub fn set_frame_listener(&self, listener: Option<FrameListener>) {
        dispatch!(self, p => p.set_frame_listener(listener))
    }

    /// The frame for the current clock time. Cheap (a retain); call it every render frame.
    pub fn current_frame(&self) -> Option<CFRetained<CVPixelBuffer>> {
        dispatch!(self, p => p.current_frame())
    }

    /// The frame on screen as PNG, for "copy frame" (no re-decode).
    pub fn current_frame_png(&self) -> Result<Vec<u8>> {
        let frame = self
            .current_frame()
            .ok_or_else(|| anyhow!("no frame decoded yet"))?;
        encode_png(&pixel_buffer_to_rgba(&frame)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<MediaSource>();
        assert_send_sync::<MediaInfo>();
    }

    #[test]
    fn container_detection() {
        let missing = Path::new("/nonexistent/recording.webm");
        assert_eq!(detect_container(missing, None), Container::WebM);
        assert_eq!(
            detect_container(missing, Some("video/mp4")),
            Container::AvFoundation
        );
        assert_eq!(
            detect_container(
                Path::new("/nonexistent/a.mp4"),
                Some("video/webm;codecs=vp8")
            ),
            Container::WebM
        );
        assert_eq!(
            detect_container(Path::new("/nonexistent/a.mov"), None),
            Container::AvFoundation
        );
    }
}
