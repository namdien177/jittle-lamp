//! Media clock: maps wall time to media time across play, pause, seek and rate changes.

use std::time::Instant;

#[derive(Clone, Copy, Debug)]
pub struct Clock {
    /// Media time at `anchor_at`.
    anchor_ms: f64,
    anchor_at: Instant,
    rate: f64,
    playing: bool,
    /// While held (a seek is decoding), media time stays at `anchor_ms`.
    held: bool,
}

impl Clock {
    pub fn new(now: Instant) -> Self {
        Self {
            anchor_ms: 0.0,
            anchor_at: now,
            rate: 1.0,
            playing: false,
            held: false,
        }
    }

    pub fn position_ms(&self, now: Instant) -> f64 {
        if self.playing && !self.held {
            self.anchor_ms
                + now.saturating_duration_since(self.anchor_at).as_secs_f64() * 1000.0 * self.rate
        } else {
            self.anchor_ms
        }
    }

    pub fn is_playing(&self) -> bool {
        self.playing
    }

    pub fn rate(&self) -> f64 {
        self.rate
    }

    fn rebase(&mut self, now: Instant) {
        self.anchor_ms = self.position_ms(now);
        self.anchor_at = now;
    }

    pub fn play(&mut self, now: Instant) {
        self.rebase(now);
        self.playing = true;
    }

    pub fn pause(&mut self, now: Instant) {
        self.rebase(now);
        self.playing = false;
    }

    pub fn set_rate(&mut self, rate: f64, now: Instant) {
        self.rebase(now);
        self.rate = rate;
    }

    /// Jumps to `ms` and holds there until [`Clock::release`].
    pub fn seek_and_hold(&mut self, ms: f64, now: Instant) {
        self.anchor_ms = ms;
        self.anchor_at = now;
        self.held = true;
    }

    /// Starts counting from the held position again (the seek's frame is on screen).
    pub fn release(&mut self, now: Instant) {
        if self.held {
            self.held = false;
            self.anchor_at = now;
        }
    }

    pub fn is_held(&self) -> bool {
        self.held
    }

    /// Stops at `ms` (end of media).
    pub fn stop_at(&mut self, ms: f64, now: Instant) {
        self.anchor_ms = ms;
        self.anchor_at = now;
        self.playing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    #[test]
    fn counts_only_while_playing() {
        let t0 = Instant::now();
        let mut clock = Clock::new(t0);
        assert_eq!(clock.position_ms(at(t0, 500)), 0.0);
        clock.play(at(t0, 500));
        assert_eq!(clock.position_ms(at(t0, 1500)), 1000.0);
        clock.pause(at(t0, 1500));
        assert_eq!(clock.position_ms(at(t0, 9000)), 1000.0);
        clock.play(at(t0, 9000));
        assert_eq!(clock.position_ms(at(t0, 9250)), 1250.0);
    }

    #[test]
    fn rate_change_keeps_position_continuous() {
        let t0 = Instant::now();
        let mut clock = Clock::new(t0);
        clock.play(t0);
        clock.set_rate(2.0, at(t0, 1000));
        assert_eq!(clock.position_ms(at(t0, 1000)), 1000.0);
        assert_eq!(clock.position_ms(at(t0, 1500)), 2000.0);
        clock.set_rate(0.5, at(t0, 1500));
        assert_eq!(clock.position_ms(at(t0, 2500)), 2500.0);
    }

    #[test]
    fn seek_holds_until_released() {
        let t0 = Instant::now();
        let mut clock = Clock::new(t0);
        clock.play(t0);
        clock.seek_and_hold(40_000.0, at(t0, 100));
        assert_eq!(clock.position_ms(at(t0, 400)), 40_000.0);
        clock.release(at(t0, 400));
        assert_eq!(clock.position_ms(at(t0, 500)), 40_100.0);
        // A seek while paused stays put after release.
        clock.pause(at(t0, 500));
        clock.seek_and_hold(10.0, at(t0, 600));
        clock.release(at(t0, 700));
        assert_eq!(clock.position_ms(at(t0, 5000)), 10.0);
    }
}
