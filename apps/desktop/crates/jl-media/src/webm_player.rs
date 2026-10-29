//! WebM playback: a decode thread feeds a short queue of `420f` pixel buffers; the caller's
//! clock picks the frame to show.

use std::collections::VecDeque;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use objc2_core_foundation::CFRetained;
use objc2_core_video::CVPixelBuffer;
use parking_lot::{Condvar, Mutex};

use crate::clock::Clock;
use crate::vpx::Decoder;
use crate::webm::WebmIndex;
use crate::yuv::SurfacePool;
use crate::{FrameListener, SeekMode};

/// Decoded frames kept ahead of the clock.
const QUEUE_AHEAD: usize = 3;
/// While scrubbing, show an intermediate frame at least this often.
const SCRUB_REFRESH: Duration = Duration::from_millis(40);

pub(crate) struct PixelBuffer(pub CFRetained<CVPixelBuffer>);

// SAFETY: CVPixelBuffer retain/release is thread-safe and a buffer is never written after it
// leaves the decode thread.
unsafe impl Send for PixelBuffer {}
unsafe impl Sync for PixelBuffer {}

struct Shown {
    index: usize,
    pts_ms: u64,
    buffer: PixelBuffer,
}

#[derive(Clone, Copy)]
struct SeekRequest {
    ms: u64,
    mode: SeekMode,
    generation: u64,
}

struct State {
    clock: Clock,
    ended: bool,
    seek: Option<SeekRequest>,
    generation: u64,
    queue: VecDeque<Shown>,
    current: Option<Shown>,
    eos: bool,
    error: Option<String>,
    shutdown: bool,
}

struct Shared {
    index: Arc<WebmIndex>,
    state: Mutex<State>,
    wake: Condvar,
    /// Latest seek generation, read by the decoder between frames without taking the lock.
    requested: AtomicU64,
    listener: Mutex<Option<FrameListener>>,
}

impl Shared {
    fn notify_listener(&self) {
        let listener = self.listener.lock().clone();
        if let Some(listener) = listener {
            listener();
        }
    }
}

pub struct WebmPlayer {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl WebmPlayer {
    pub fn new(path: &Path, index: Arc<WebmIndex>) -> Result<Self> {
        let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
        let now = Instant::now();
        let mut clock = Clock::new(now);
        clock.seek_and_hold(0.0, now);
        let shared = Arc::new(Shared {
            index,
            state: Mutex::new(State {
                clock,
                ended: false,
                seek: Some(SeekRequest {
                    ms: 0,
                    mode: SeekMode::Exact,
                    generation: 1,
                }),
                generation: 1,
                queue: VecDeque::with_capacity(QUEUE_AHEAD + 1),
                current: None,
                eos: false,
                error: None,
                shutdown: false,
            }),
            wake: Condvar::new(),
            requested: AtomicU64::new(1),
            listener: Mutex::new(None),
        });
        let thread = std::thread::Builder::new()
            .name("jl-media-webm".into())
            .spawn({
                let shared = shared.clone();
                move || DecodeThread::new(shared, file).run()
            })
            .context("spawn WebM decode thread")?;
        Ok(Self {
            shared,
            thread: Some(thread),
        })
    }

    fn duration(&self) -> f64 {
        self.shared.index.duration_ms as f64
    }

    /// Advances end-of-media state and returns the clamped position.
    fn tick(&self, state: &mut State, now: Instant) -> f64 {
        let duration = self.duration();
        let position = state.clock.position_ms(now);
        if state.clock.is_playing() && position >= duration {
            state.clock.stop_at(duration, now);
            state.ended = true;
            return duration;
        }
        position.clamp(0.0, duration)
    }

    fn seek_locked(&self, state: &mut State, ms: u64, mode: SeekMode, now: Instant) {
        let ms = ms.min(self.shared.index.duration_ms);
        state.generation += 1;
        self.shared
            .requested
            .store(state.generation, Ordering::Release);
        state.seek = Some(SeekRequest {
            ms,
            mode,
            generation: state.generation,
        });
        state.ended = false;
        state.clock.seek_and_hold(ms as f64, now);
        self.shared.wake.notify_one();
    }

    pub fn play(&self) {
        let now = Instant::now();
        let mut state = self.shared.state.lock();
        if state.ended || self.tick(&mut state, now) >= self.duration() {
            self.seek_locked(&mut state, 0, SeekMode::Exact, now);
        }
        state.clock.play(now);
    }

    pub fn pause(&self) {
        self.shared.state.lock().clock.pause(Instant::now());
    }

    pub fn seek(&self, ms: u64, mode: SeekMode) {
        let mut state = self.shared.state.lock();
        self.seek_locked(&mut state, ms, mode, Instant::now());
    }

    pub fn set_rate(&self, rate: f32) {
        let rate = (rate as f64).clamp(1.0 / 16.0, 16.0);
        self.shared
            .state
            .lock()
            .clock
            .set_rate(rate, Instant::now());
    }

    pub fn rate(&self) -> f32 {
        self.shared.state.lock().clock.rate() as f32
    }

    pub fn position_ms(&self) -> u64 {
        let mut state = self.shared.state.lock();
        self.tick(&mut state, Instant::now()).round() as u64
    }

    pub fn duration_ms(&self) -> u64 {
        self.shared.index.duration_ms
    }

    pub fn is_playing(&self) -> bool {
        self.shared.state.lock().clock.is_playing()
    }

    pub fn ended(&self) -> bool {
        let mut state = self.shared.state.lock();
        self.tick(&mut state, Instant::now());
        state.ended
    }

    pub fn is_seeking(&self) -> bool {
        let state = self.shared.state.lock();
        state.seek.is_some() || state.clock.is_held()
    }

    pub fn video_size(&self) -> (u32, u32) {
        (self.shared.index.width, self.shared.index.height)
    }

    pub fn error(&self) -> Option<String> {
        self.shared.state.lock().error.clone()
    }

    pub fn set_frame_listener(&self, listener: Option<FrameListener>) {
        *self.shared.listener.lock() = listener;
    }

    pub fn current_frame(&self) -> Option<CFRetained<CVPixelBuffer>> {
        let mut state = self.shared.state.lock();
        let position = self.tick(&mut state, Instant::now());
        if !state.clock.is_held() {
            let mut advanced = false;
            while let Some(next) = state.queue.front() {
                if next.pts_ms as f64 > position && state.current.is_some() {
                    break;
                }
                state.current = state.queue.pop_front();
                advanced = true;
            }
            if advanced {
                self.shared.wake.notify_one();
            }
        }
        state.current.as_ref().map(|shown| shown.buffer.0.clone())
    }
}

impl Drop for WebmPlayer {
    fn drop(&mut self) {
        self.shared.state.lock().shutdown = true;
        self.shared.wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

enum Job {
    Seek(SeekRequest),
    Ahead { generation: u64, clock_ms: f64 },
}

struct DecodeThread {
    shared: Arc<Shared>,
    file: File,
    decoder: Option<Decoder>,
    pool: Option<SurfacePool>,
    /// Next packet to feed the decoder.
    next: usize,
    packet: Vec<u8>,
    last_shown: Instant,
}

impl DecodeThread {
    fn new(shared: Arc<Shared>, file: File) -> Self {
        Self {
            shared,
            file,
            decoder: None,
            pool: None,
            next: 0,
            packet: Vec::new(),
            last_shown: Instant::now() - SCRUB_REFRESH,
        }
    }

    fn run(mut self) {
        let threads = std::thread::available_parallelism().map_or(2, |n| n.get().min(4)) as u32;
        match Decoder::new(self.shared.index.codec, threads) {
            Ok(decoder) => self.decoder = Some(decoder),
            Err(err) => {
                self.fail(format!("{err:#}"));
                return;
            }
        }
        while let Some(job) = self.next_job() {
            match job {
                Job::Seek(request) => self.seek(request),
                Job::Ahead {
                    generation,
                    clock_ms,
                } => self.decode_ahead(generation, clock_ms),
            }
        }
    }

    fn next_job(&self) -> Option<Job> {
        let mut state = self.shared.state.lock();
        loop {
            if state.shutdown {
                return None;
            }
            if let Some(request) = state.seek.take() {
                return Some(Job::Seek(request));
            }
            if !state.eos && state.queue.len() < QUEUE_AHEAD && !state.clock.is_held() {
                let clock_ms = state.clock.position_ms(Instant::now());
                return Some(Job::Ahead {
                    generation: state.generation,
                    clock_ms,
                });
            }
            self.shared.wake.wait(&mut state);
        }
    }

    fn fail(&self, message: String) {
        log::error!("WebM decode: {message}");
        let mut state = self.shared.state.lock();
        state.error = Some(message);
        state.eos = true;
        state.clock.release(Instant::now());
    }

    /// Feeds packet `index` to the decoder; returns whether it produced a picture.
    fn feed(&mut self, index: usize) -> bool {
        self.next = index + 1;
        if let Err(err) = self
            .shared
            .index
            .read_packet(&self.file, index, &mut self.packet)
        {
            log::warn!("WebM packet {index}: {err:#}");
            return false;
        }
        match self.decoder.as_mut().expect("decoder").decode(&self.packet) {
            Ok(shown) => shown,
            Err(err) => {
                log::warn!("WebM packet {index}: {err:#}");
                false
            }
        }
    }

    /// Uploads the picture produced by the last [`DecodeThread::feed`].
    fn upload_last(&mut self, index: usize) -> Option<Shown> {
        // Re-borrow the decoder's last picture: `feed` already decoded it, and libvpx keeps
        // the image until the next decode call.
        let picture = self.decoder.as_ref()?.last_picture()?;
        let pool_fits = self
            .pool
            .as_ref()
            .is_some_and(|pool| pool.size() == (picture.width, picture.height));
        if !pool_fits {
            match SurfacePool::new(picture.width, picture.height) {
                Ok(pool) => self.pool = Some(pool),
                Err(err) => {
                    log::error!("WebM: {err:#}");
                    return None;
                }
            }
        }
        match self.pool.as_ref()?.upload(&picture) {
            Ok(buffer) => Some(Shown {
                index,
                pts_ms: self.shared.index.packets[index].pts_ms,
                buffer: PixelBuffer(buffer),
            }),
            Err(err) => {
                log::error!("WebM: {err:#}");
                None
            }
        }
    }

    fn seek(&mut self, request: SeekRequest) {
        let index = &self.shared.index;
        let target = index.frame_at(request.ms);
        let keyframe = index.keyframe_before(target);
        // Scrubbing forward inside one keyframe interval continues from where we are.
        let start = if self.next > keyframe && self.next <= target {
            self.next
        } else {
            keyframe
        };
        {
            let mut state = self.shared.state.lock();
            if state.generation != request.generation {
                return;
            }
            // Releasing the scrubber usually lands on the frame already shown or queued.
            let decoded = state.current.as_ref().is_some_and(|f| f.index == target)
                || state.queue.iter().any(|f| f.index == target);
            if decoded {
                while state.queue.front().is_some_and(|f| f.index <= target) {
                    state.current = state.queue.pop_front();
                }
                state.clock.release(Instant::now());
                drop(state);
                self.shared.notify_listener();
                return;
            }
            state.queue.clear();
            state.eos = false;
        }
        for i in start..=target {
            let has_picture = self.feed(i);
            // A newer seek supersedes this one; while scrubbing, still show progress.
            if self.shared.requested.load(Ordering::Acquire) != request.generation {
                if has_picture
                    && request.mode == SeekMode::Fast
                    && self.last_shown.elapsed() >= SCRUB_REFRESH
                    && let Some(frame) = self.upload_last(i)
                {
                    self.publish(request.generation, frame, false);
                }
                return;
            }
            if i == target
                && has_picture
                && let Some(frame) = self.upload_last(i)
            {
                self.publish(request.generation, frame, true);
                return;
            }
        }
        // The target produced no picture (decode error or hidden frame): keep the previous
        // frame and let the clock run again.
        let mut state = self.shared.state.lock();
        if state.generation == request.generation {
            state.clock.release(Instant::now());
        }
    }

    fn publish(&mut self, generation: u64, frame: Shown, is_final: bool) {
        self.last_shown = Instant::now();
        {
            let mut state = self.shared.state.lock();
            if is_final {
                if state.generation != generation {
                    return;
                }
                state.clock.release(self.last_shown);
            }
            state.current = Some(frame);
        }
        self.shared.notify_listener();
    }

    fn decode_ahead(&mut self, generation: u64, clock_ms: f64) {
        let index = self.shared.index.clone();
        let i = self.next;
        if i >= index.packets.len() {
            let mut state = self.shared.state.lock();
            if state.generation == generation {
                state.eos = true;
            }
            return;
        }
        if !self.feed(i) {
            return;
        }
        // Behind the clock (slow decode or high rate): skip the upload if the next frame is
        // already due.
        if index
            .packets
            .get(i + 1)
            .is_some_and(|next| next.pts_ms as f64 <= clock_ms)
        {
            return;
        }
        if let Some(frame) = self.upload_last(i) {
            let mut state = self.shared.state.lock();
            if state.generation == generation {
                state.queue.push_back(frame);
            }
        }
    }
}
