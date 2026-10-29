//! WebM (Matroska) demuxing: one pass over the file builds a packet index for the video
//! track, so playback, seeking and duration do not depend on Cues or a Duration element
//! (Chrome's MediaRecorder writes neither).

use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::os::unix::fs::FileExt;
use std::path::Path;
use std::rc::Rc;

use anyhow::{Context, Result, anyhow, bail};
use matroska_demuxer::{Frame, MatroskaFile, TrackType};

use crate::vpx::{Decoder, VpxCodec, YuvPlanes};

/// One compressed video frame, located by byte range in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Packet {
    pub pts_ms: u64,
    pub offset: u64,
    pub size: u32,
    pub keyframe: bool,
}

#[derive(Clone, Debug)]
pub struct WebmIndex {
    pub codec: VpxCodec,
    pub width: u32,
    pub height: u32,
    /// Video packets in decode order, with non-decreasing `pts_ms`.
    pub packets: Vec<Packet>,
    pub duration_ms: u64,
    pub frame_duration_ms: u64,
    pub has_audio: bool,
}

impl WebmIndex {
    pub fn open(path: &Path) -> Result<Self> {
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        let reads = Rc::new(RefCell::new(VecDeque::with_capacity(READ_HISTORY)));
        let reader = TrackingReader {
            inner: BufReader::with_capacity(256 * 1024, file),
            pos: 0,
            reads: reads.clone(),
        };
        let mut mkv =
            MatroskaFile::open(reader).map_err(|err| anyhow!("not a readable WebM file: {err}"))?;

        let video = mkv
            .tracks()
            .iter()
            .find(|track| track.track_type() == TrackType::Video)
            .ok_or_else(|| anyhow!("WebM file has no video track"))?;
        let video_track = video.track_number().get();
        let codec = match video.codec_id() {
            "V_VP8" => VpxCodec::Vp8,
            "V_VP9" => VpxCodec::Vp9,
            other => bail!("unsupported WebM video codec {other}"),
        };
        let (width, height) = video
            .video()
            .map(|v| (v.pixel_width().get() as u32, v.pixel_height().get() as u32))
            .unwrap_or((0, 0));
        let default_duration_ms = video.default_duration().map(|ns| ns.get() / 1_000_000);
        let has_audio = mkv
            .tracks()
            .iter()
            .any(|track| track.track_type() == TrackType::Audio);
        let scale_ns = mkv.info().timestamp_scale().get();
        let header_duration_ms = mkv
            .info()
            .duration()
            .map(|ticks| (ticks * scale_ns as f64 / 1e6) as u64);
        let to_ms = |ticks: u64| (ticks as u128 * scale_ns as u128 / 1_000_000) as u64;

        let mut packets: Vec<Packet> = Vec::new();
        let mut last_other_ms = 0;
        let mut frame = Frame::default();
        loop {
            match mkv.next_frame(&mut frame) {
                Ok(true) => {}
                Ok(false) => break,
                // A recording cut short (crash, partial download) still plays up to the damage.
                Err(err) => {
                    log::warn!(
                        "{}: stopped indexing at a damaged block: {err}",
                        path.display()
                    );
                    break;
                }
            }
            let pts_ms = to_ms(frame.timestamp);
            if frame.track != video_track {
                last_other_ms = last_other_ms.max(pts_ms);
                continue;
            }
            let Some(offset) = locate(&reads.borrow(), frame.data.len()) else {
                bail!("could not locate a video block in {}", path.display());
            };
            // Decode order is display order for VP8/VP9, so clamp the rare backwards timestamp
            // that Chrome emits to keep the index sorted.
            let pts_ms = packets
                .last()
                .map_or(pts_ms, |prev| pts_ms.max(prev.pts_ms));
            let keyframe = is_keyframe(codec, &frame.data)
                .or(frame.is_keyframe)
                .unwrap_or(false);
            packets.push(Packet {
                pts_ms,
                offset,
                size: frame.data.len() as u32,
                keyframe,
            });
        }
        if packets.is_empty() {
            bail!("WebM file has no video frames");
        }
        if !packets[0].keyframe {
            // Decoding has to start somewhere; libvpx reports an error if this is wrong.
            packets[0].keyframe = true;
        }

        let frame_duration_ms = default_duration_ms
            .filter(|&d| d > 0)
            .unwrap_or_else(|| median_delta(&packets));
        let scanned_ms = (packets.last().unwrap().pts_ms + frame_duration_ms).max(last_other_ms);
        let duration_ms = header_duration_ms.filter(|&d| d > 0).unwrap_or(scanned_ms);
        Ok(Self {
            codec,
            width,
            height,
            packets,
            duration_ms,
            frame_duration_ms,
            has_audio,
        })
    }

    /// Index of the frame shown at `ms`: the last packet with `pts_ms <= ms` (or the first).
    pub fn frame_at(&self, ms: u64) -> usize {
        self.packets
            .partition_point(|p| p.pts_ms <= ms)
            .saturating_sub(1)
    }

    /// Index of the keyframe that decoding must start from to show packet `index`.
    pub fn keyframe_before(&self, index: usize) -> usize {
        self.packets[..=index]
            .iter()
            .rposition(|p| p.keyframe)
            .unwrap_or(0)
    }

    pub fn keyframe_count(&self) -> usize {
        self.packets.iter().filter(|p| p.keyframe).count()
    }

    /// Decodes the frame shown at `ms` (exact: from the preceding keyframe) and hands the
    /// picture to `f`.
    pub fn decode_at<T>(
        &self,
        path: &Path,
        ms: u64,
        f: impl FnOnce(&YuvPlanes<'_>) -> T,
    ) -> Result<T> {
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        let target = self.frame_at(ms);
        let mut decoder = Decoder::new(self.codec, 4)?;
        let mut buf = Vec::new();
        for i in self.keyframe_before(target)..=target {
            self.read_packet(&file, i, &mut buf)?;
            match decoder.decode(&buf) {
                Ok(_) => {}
                Err(err) if i < target => log::warn!("{}: packet {i}: {err:#}", path.display()),
                Err(err) => return Err(err),
            }
        }
        let picture = decoder
            .last_picture()
            .ok_or_else(|| anyhow!("no picture decoded at {ms} ms"))?;
        Ok(f(&picture))
    }

    pub fn read_packet(&self, file: &File, index: usize, buf: &mut Vec<u8>) -> Result<()> {
        let packet = self.packets[index];
        buf.resize(packet.size as usize, 0);
        file.read_exact_at(buf, packet.offset)
            .context("read WebM block")
    }
}

fn median_delta(packets: &[Packet]) -> u64 {
    let mut deltas: Vec<u64> = packets
        .windows(2)
        .map(|w| w[1].pts_ms - w[0].pts_ms)
        .filter(|&d| d > 0)
        .collect();
    if deltas.is_empty() {
        return 33;
    }
    let mid = deltas.len() / 2;
    *deltas.select_nth_unstable(mid).1
}

/// Reads the keyframe bit from the VP8/VP9 frame header.
pub fn is_keyframe(codec: VpxCodec, data: &[u8]) -> Option<bool> {
    let first = *data.first()?;
    match codec {
        // RFC 6386 §9.1: bit 0 of the frame tag is 0 for key frames.
        VpxCodec::Vp8 => Some(first & 1 == 0),
        // VP9 uncompressed header: frame_marker(2) profile_low(1) profile_high(1)
        // [reserved_zero(1) if profile 3] show_existing_frame(1) frame_type(1).
        VpxCodec::Vp9 => {
            if first >> 6 != 0b10 {
                return None;
            }
            let profile = ((first >> 5) & 1) | (((first >> 4) & 1) << 1);
            let show_existing_bit = if profile == 3 { 2 } else { 3 };
            if (first >> show_existing_bit) & 1 == 1 {
                return Some(false);
            }
            Some((first >> (show_existing_bit - 1)) & 1 == 0)
        }
    }
}

const READ_HISTORY: usize = 16;

/// Records the byte range of each `read_exact` so a demuxed frame can be mapped back to its
/// file offset; the demuxer reads frame payloads with a single `read_exact`.
struct TrackingReader {
    inner: BufReader<File>,
    pos: u64,
    reads: Rc<RefCell<VecDeque<(u64, usize)>>>,
}

fn locate(reads: &VecDeque<(u64, usize)>, len: usize) -> Option<u64> {
    reads
        .iter()
        .rev()
        .find(|&&(_, n)| n == len)
        .map(|&(offset, _)| offset)
}

impl Read for TrackingReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.pos += n as u64;
        Ok(n)
    }

    fn read_exact(&mut self, buf: &mut [u8]) -> std::io::Result<()> {
        let start = self.pos;
        self.inner.read_exact(buf)?;
        self.pos += buf.len() as u64;
        let mut reads = self.reads.borrow_mut();
        if reads.len() == READ_HISTORY {
            reads.pop_front();
        }
        reads.push_back((start, buf.len()));
        Ok(())
    }
}

impl Seek for TrackingReader {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        self.pos = match to {
            // Short forward hops (block headers, skipped elements) keep the read buffer.
            SeekFrom::Start(target) if target >= self.pos && target - self.pos < 64 * 1024 => {
                self.inner.seek_relative((target - self.pos) as i64)?;
                target
            }
            _ => self.inner.seek(to)?,
        };
        Ok(self.pos)
    }

    fn stream_position(&mut self) -> std::io::Result<u64> {
        Ok(self.pos)
    }
}
