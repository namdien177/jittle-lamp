//! AVFoundation backend for MP4/MOV: AVPlayer for playback (with audio), an
//! AVPlayerItemVideoOutput for `420f` frames, AVAssetImageGenerator for stills.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use block2::RcBlock;
use image::RgbaImage;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool};
use objc2::{AnyThread, MainThreadMarker};
use objc2_av_foundation::{
    AVAssetImageGenerator, AVMediaTypeAudio, AVMediaTypeVideo, AVPlayer, AVPlayerActionAtItemEnd,
    AVPlayerItem, AVPlayerItemStatus, AVPlayerItemVideoOutput, AVURLAsset,
    AVURLAssetPreferPreciseDurationAndTimingKey,
};
use objc2_core_foundation::{CFRetained, CFString, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, kCGColorSpaceSRGB,
};
use objc2_core_media::{CMFormatDescription, CMTime, kCMTimePositiveInfinity, kCMTimeZero};
use objc2_core_video::{
    CVPixelBuffer, kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferMetalCompatibilityKey,
    kCVPixelBufferPixelFormatTypeKey,
};
use objc2_foundation::{NSDictionary, NSError, NSNumber, NSString, NSURL};
use parking_lot::Mutex;

use crate::yuv::SURFACE_PIXEL_FORMAT;
use crate::{FrameListener, MediaInfo, SeekMode, VideoCodec};

/// An AVURLAsset; immutable once loaded, and AVAsset is documented as thread-safe.
pub(crate) struct AvAsset(Retained<AVURLAsset>);

unsafe impl Send for AvAsset {}
unsafe impl Sync for AvAsset {}

fn ms_to_time(ms: u64) -> CMTime {
    unsafe { CMTime::with_seconds(ms as f64 / 1000.0, 600) }
}

fn time_to_ms(time: CMTime) -> Option<u64> {
    let seconds = unsafe { time.seconds() };
    seconds
        .is_finite()
        .then(|| (seconds.max(0.0) * 1000.0).round() as u64)
}

fn cf_key(key: &CFString) -> &NSString {
    // SAFETY: CFString and NSString are toll-free bridged.
    unsafe { &*(key as *const CFString as *const NSString) }
}

/// Opens an MP4/MOV and reads duration, video size and codec (blocking).
pub(crate) fn load(path: &Path) -> Result<(AvAsset, MediaInfo)> {
    let path_str = path
        .to_str()
        .ok_or_else(|| anyhow!("non-UTF-8 path {}", path.display()))?;
    if !path.exists() {
        bail!("{} does not exist", path.display());
    }
    let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
    let precise = NSNumber::new_bool(true);
    let options = NSDictionary::<NSString, AnyObject>::from_slices(
        &[unsafe { AVURLAssetPreferPreciseDurationAndTimingKey }],
        &[precise.as_ref()],
    );
    let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, Some(&options)) };

    #[allow(deprecated)]
    let (duration, tracks, audio_tracks) = unsafe {
        let video = AVMediaTypeVideo.ok_or_else(|| anyhow!("AVMediaTypeVideo unavailable"))?;
        let audio = AVMediaTypeAudio.ok_or_else(|| anyhow!("AVMediaTypeAudio unavailable"))?;
        (
            asset.duration(),
            asset.tracksWithMediaType(video),
            asset.tracksWithMediaType(audio),
        )
    };
    let track = tracks
        .firstObject()
        .ok_or_else(|| anyhow!("AVFoundation found no video track in {}", path.display()))?;
    let (size, transform) = unsafe { (track.naturalSize(), track.preferredTransform()) };
    // Rotated recordings (phone video) report their stored size; apply the track transform.
    let width = (transform.a * size.width + transform.c * size.height)
        .abs()
        .round() as u32;
    let height = (transform.b * size.width + transform.d * size.height)
        .abs()
        .round() as u32;

    let codec = unsafe { track.formatDescriptions() }
        .firstObject()
        .map(|description| {
            // SAFETY: formatDescriptions holds CMFormatDescriptionRefs.
            let description =
                unsafe { &*(Retained::as_ptr(&description) as *const CMFormatDescription) };
            let subtype = unsafe { description.media_sub_type() };
            match &subtype.to_be_bytes() {
                b"avc1" | b"avc3" => VideoCodec::H264,
                b"hvc1" | b"hev1" => VideoCodec::Hevc,
                other => VideoCodec::Other(String::from_utf8_lossy(other).trim().to_owned()),
            }
        })
        .unwrap_or(VideoCodec::Other(String::new()));

    let duration_ms =
        time_to_ms(duration).ok_or_else(|| anyhow!("{} has no duration", path.display()))?;
    let info = MediaInfo {
        duration_ms,
        width,
        height,
        codec,
        has_audio: audio_tracks.count() > 0,
    };
    Ok((AvAsset(asset), info))
}

/// Grabs the frame at `ms` as RGBA, scaled to fit `max_edge` (0 = full size).
pub(crate) fn still(asset: &AvAsset, ms: u64, max_edge: u32) -> Result<RgbaImage> {
    // Exact first; past the last video frame (audio often runs longer) take the nearest
    // earlier frame instead.
    still_with_tolerance(asset, ms, max_edge, unsafe { kCMTimeZero })
        .or_else(|_| still_with_tolerance(asset, ms, max_edge, unsafe { kCMTimePositiveInfinity }))
}

fn still_with_tolerance(
    asset: &AvAsset,
    ms: u64,
    max_edge: u32,
    before: CMTime,
) -> Result<RgbaImage> {
    let generator = unsafe { AVAssetImageGenerator::assetImageGeneratorWithAsset(&asset.0) };
    unsafe {
        generator.setAppliesPreferredTrackTransform(true);
        generator.setRequestedTimeToleranceBefore(before);
        generator.setRequestedTimeToleranceAfter(kCMTimeZero);
        if max_edge > 0 {
            generator.setMaximumSize(CGSize::new(max_edge as f64, max_edge as f64));
        }
    }
    let (tx, rx) = mpsc::sync_channel::<Result<RgbaImage>>(1);
    let handler = RcBlock::new(
        move |image: *mut CGImage, _actual: CMTime, error: *mut NSError| {
            let result = match unsafe { image.as_ref() } {
                Some(image) => cg_image_to_rgba(image),
                None => Err(anyhow!(
                    "AVAssetImageGenerator failed: {}",
                    unsafe { error.as_ref() }.map_or_else(
                        || "unknown error".to_owned(),
                        |e| e.localizedDescription().to_string()
                    )
                )),
            };
            let _ = tx.try_send(result);
        },
    );
    unsafe {
        generator.generateCGImageAsynchronouslyForTime_completionHandler(ms_to_time(ms), &handler)
    };
    rx.recv_timeout(Duration::from_secs(20))
        .map_err(|_| anyhow!("timed out generating a frame"))?
}

pub(crate) fn cg_image_to_rgba(image: &CGImage) -> Result<RgbaImage> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    if width == 0 || height == 0 {
        bail!("empty image");
    }
    let mut data = vec![0u8; width * height * 4];
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }));
    let context: Option<CFRetained<CGContext>> = unsafe {
        CGBitmapContextCreate(
            data.as_mut_ptr().cast(),
            width,
            height,
            8,
            width * 4,
            space.as_deref(),
            CGImageAlphaInfo::PremultipliedLast.0,
        )
    };
    let context = context.ok_or_else(|| anyhow!("CGBitmapContextCreate failed"))?;
    let rect = CGRect::new(
        CGPoint::new(0.0, 0.0),
        CGSize::new(width as f64, height as f64),
    );
    CGContext::draw_image(Some(&context), rect, Some(image));
    drop(context);
    RgbaImage::from_raw(width as u32, height as u32, data)
        .ok_or_else(|| anyhow!("bad image buffer"))
}

#[derive(Default)]
struct SeekState {
    generation: u64,
    /// The in-flight seek target; reported as the position until AVPlayer lands.
    pending: Option<(u64, u64)>,
}

pub struct AvPlayer {
    player: Retained<AVPlayer>,
    item: Retained<AVPlayerItem>,
    output: Retained<AVPlayerItemVideoOutput>,
    info: MediaInfo,
    rate: Cell<f32>,
    seek: Arc<Mutex<SeekState>>,
    /// After a fast (keyframe) seek the playhead stays where the user put it, not on the keyframe.
    hold_position: Cell<Option<u64>>,
    last_frame: RefCell<Option<CFRetained<CVPixelBuffer>>>,
    primed: Cell<bool>,
    listener: Arc<Mutex<Option<FrameListener>>>,
}

impl AvPlayer {
    pub(crate) fn new(asset: &AvAsset, info: MediaInfo, mtm: MainThreadMarker) -> Result<Self> {
        let format = NSNumber::new_u32(SURFACE_PIXEL_FORMAT);
        let metal = NSNumber::new_bool(true);
        let iosurface = NSDictionary::<NSString, AnyObject>::new();
        let attributes = unsafe {
            NSDictionary::<NSString, AnyObject>::from_slices(
                &[
                    cf_key(kCVPixelBufferPixelFormatTypeKey),
                    cf_key(kCVPixelBufferMetalCompatibilityKey),
                    cf_key(kCVPixelBufferIOSurfacePropertiesKey),
                ],
                &[format.as_ref(), metal.as_ref(), iosurface.as_ref()],
            )
        };
        let output = unsafe {
            AVPlayerItemVideoOutput::initWithPixelBufferAttributes(
                AVPlayerItemVideoOutput::alloc(),
                Some(&attributes),
            )
        };
        let item = unsafe { AVPlayerItem::playerItemWithAsset(&asset.0, mtm) };
        unsafe { item.addOutput(&output) };
        let player = unsafe { AVPlayer::playerWithPlayerItem(Some(&item), mtm) };
        unsafe {
            player.setActionAtItemEnd(AVPlayerActionAtItemEnd::Pause);
            player.setAutomaticallyWaitsToMinimizeStalling(false);
        }
        Ok(Self {
            player,
            item,
            output,
            info,
            rate: Cell::new(1.0),
            seek: Arc::default(),
            hold_position: Cell::new(None),
            last_frame: RefCell::new(None),
            primed: Cell::new(false),
            listener: Arc::default(),
        })
    }

    fn current_ms(&self) -> u64 {
        time_to_ms(unsafe { self.item.currentTime() })
            .unwrap_or(0)
            .min(self.info.duration_ms)
    }

    pub fn play(&self) {
        if self.ended() {
            self.seek(0, SeekMode::Exact);
        }
        self.hold_position.set(None);
        unsafe { self.player.setRate(self.rate.get()) };
    }

    pub fn pause(&self) {
        unsafe { self.player.pause() };
    }

    pub fn seek(&self, ms: u64, mode: SeekMode) {
        let ms = ms.min(self.info.duration_ms);
        let generation = {
            let mut seek = self.seek.lock();
            seek.generation += 1;
            seek.pending = Some((seek.generation, ms));
            seek.generation
        };
        self.hold_position
            .set((mode == SeekMode::Fast).then_some(ms));
        let tolerance = match mode {
            SeekMode::Fast => unsafe { kCMTimePositiveInfinity },
            SeekMode::Exact => unsafe { kCMTimeZero },
        };
        let state = self.seek.clone();
        let listener = self.listener.clone();
        let done = RcBlock::new(move |_finished: Bool| {
            {
                let mut seek = state.lock();
                if seek.pending.is_some_and(|(g, _)| g == generation) {
                    seek.pending = None;
                }
            }
            if let Some(listener) = listener.lock().clone() {
                listener();
            }
        });
        unsafe {
            self.player
                .seekToTime_toleranceBefore_toleranceAfter_completionHandler(
                    ms_to_time(ms),
                    tolerance,
                    tolerance,
                    &done,
                )
        };
    }

    pub fn set_rate(&self, rate: f32) {
        let rate = rate.clamp(1.0 / 16.0, 16.0);
        self.rate.set(rate);
        unsafe {
            self.player.setDefaultRate(rate);
            if self.player.rate() != 0.0 {
                self.player.setRate(rate);
            }
        }
    }

    pub fn rate(&self) -> f32 {
        self.rate.get()
    }

    pub fn position_ms(&self) -> u64 {
        if let Some((_, ms)) = self.seek.lock().pending {
            return ms;
        }
        if !self.is_playing()
            && let Some(ms) = self.hold_position.get()
        {
            return ms;
        }
        self.current_ms()
    }

    pub fn duration_ms(&self) -> u64 {
        self.info.duration_ms
    }

    pub fn is_playing(&self) -> bool {
        unsafe { self.player.rate() != 0.0 }
    }

    pub fn ended(&self) -> bool {
        !self.is_playing()
            && self.seek.lock().pending.is_none()
            && self.hold_position.get().is_none()
            && self.current_ms() + 30 >= self.info.duration_ms
    }

    pub fn is_seeking(&self) -> bool {
        self.seek.lock().pending.is_some()
    }

    pub fn video_size(&self) -> (u32, u32) {
        (self.info.width, self.info.height)
    }

    pub fn error(&self) -> Option<String> {
        unsafe { self.item.error() }.map(|error| error.localizedDescription().to_string())
    }

    pub fn set_frame_listener(&self, listener: Option<FrameListener>) {
        *self.listener.lock() = listener;
    }

    pub fn current_frame(&self) -> Option<CFRetained<CVPixelBuffer>> {
        let time = unsafe { self.item.currentTime() };
        if unsafe { self.output.hasNewPixelBufferForItemTime(time) } {
            let buffer = unsafe {
                self.output
                    .copyPixelBufferForItemTime_itemTimeForDisplay(time, std::ptr::null_mut())
            };
            if let Some(buffer) = buffer {
                // SAFETY: the same CoreFoundation object; ownership moves from Retained to CFRetained.
                let raw = NonNull::new(Retained::into_raw(buffer)).expect("non-null");
                *self.last_frame.borrow_mut() = Some(unsafe { CFRetained::from_raw(raw) });
            }
        }
        let mut last = self.last_frame.borrow_mut();
        if last.is_none()
            && !self.primed.get()
            && unsafe { self.item.status() } == AVPlayerItemStatus::ReadyToPlay
        {
            // The video output only vends frames the player has rendered; a seek renders one.
            self.primed.set(true);
            drop(last);
            self.seek(self.current_ms(), SeekMode::Exact);
            last = self.last_frame.borrow_mut();
        }
        last.clone()
    }
}
