import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";

export type VideoPlayerProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  videoDurationHintMs?: number;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;
};

const playbackRates = [1, 1.5, 2, 0.5];
const AUTO_HIDE_MS = 2400;

function assignVideoRef(ref: React.RefObject<HTMLVideoElement | null>, videoEl: HTMLVideoElement | null): void {
  (ref as { current: HTMLVideoElement | null }).current = videoEl;
}

type WebkitFullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type WebkitFullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

function getFullscreenElement(): Element | null {
  const doc = document as WebkitFullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Fullscreens the wrapper that hosts both the video and the viewer's own
 * control bar (video.js's player fullscreen would only take the <video> host,
 * leaving the custom controls behind). Falls back to the native video
 * fullscreen on iOS Safari where element fullscreen is unavailable.
 */
function requestWrapperFullscreen(wrapper: HTMLElement, videoEl: HTMLVideoElement | null): void {
  if (typeof wrapper.requestFullscreen === "function") {
    void wrapper.requestFullscreen().catch(() => undefined);
    return;
  }
  const webkitWrapper = wrapper as WebkitFullscreenElement;
  if (typeof webkitWrapper.webkitRequestFullscreen === "function") {
    webkitWrapper.webkitRequestFullscreen();
    return;
  }
  const webkitVideo = videoEl as WebkitFullscreenVideo | null;
  webkitVideo?.webkitEnterFullscreen?.();
}

function exitAnyFullscreen(): void {
  const doc = document as WebkitFullscreenDocument;
  if (typeof doc.exitFullscreen === "function") {
    void doc.exitFullscreen().catch(() => undefined);
    return;
  }
  doc.webkitExitFullscreen?.();
}

function videoSourceType(source: string | null | undefined): string {
  if (!source) return "video/webm";
  const url = source.startsWith("blob:") ? null : new URL(source, window.location.href);
  const responseContentType = url?.searchParams.get("response-content-type")?.toLowerCase();
  if (responseContentType?.includes("video/mp4")) return "video/mp4";
  if (responseContentType?.includes("mpegurl")) return "application/x-mpegURL";
  if (responseContentType?.includes("dash+xml")) return "application/dash+xml";

  const pathname = url?.pathname.toLowerCase() ?? "";
  if (pathname.endsWith(".mp4")) return "video/mp4";
  if (pathname.endsWith(".m3u8")) return "application/x-mpegURL";
  if (pathname.endsWith(".mpd")) return "application/dash+xml";
  return "video/webm";
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = (total % 60).toString().padStart(2, "0");
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remMins = (mins % 60).toString().padStart(2, "0");
    return `${hours}:${remMins}:${secs}`;
  }
  return `${mins}:${secs}`;
}

function rangeFill(pct: number): React.CSSProperties {
  const clamped = Math.max(0, Math.min(100, pct));
  return {
    background: `linear-gradient(to right, var(--jl-vm-vc-fill) ${clamped}%, rgba(255, 255, 255, 0.24) ${clamped}%)`
  };
}

export function EvidenceVideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const videoNodeRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestCallbacksRef = useRef({
    onVideoTimeUpdate: props.onVideoTimeUpdate,
    onVideoError: props.onVideoError
  });
  const durationHintMsRef = useRef(props.videoDurationHintMs);

  // Keep the latest props readable from the long-lived player event handlers
  // without re-creating the player. Written after commit, never during render.
  useEffect(() => {
    latestCallbacksRef.current = {
      onVideoTimeUpdate: props.onVideoTimeUpdate,
      onVideoError: props.onVideoError
    };
    durationHintMsRef.current = props.videoDurationHintMs;
  });

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [rate, setRate] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);

  const clearHideTimer = useCallback((): void => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const revealControls = useCallback((): void => {
    clearHideTimer();
    setControlsVisible(true);
    const player = playerRef.current;
    if (player && !player.paused()) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), AUTO_HIDE_MS);
    }
  }, [clearHideTimer]);

  useEffect(() => {
    const videoEl = videoNodeRef.current;
    if (!videoEl || playerRef.current) return;

    const player = videojs(videoEl, {
      controls: false,
      fill: true,
      fluid: false,
      responsive: true,
      preload: "metadata",
      bigPlayButton: false,
      controlBar: false,
      liveui: false,
      sources: []
    });
    playerRef.current = player;

    const syncArchivedDuration = (): void => {
      const durationHintMs = durationHintMsRef.current;
      if (durationHintMs && durationHintMs > 0) {
        const durationHintSeconds = durationHintMs / 1000;
        const currentDuration = player.duration();
        if (currentDuration === undefined || !Number.isFinite(currentDuration) || currentDuration <= 0) {
          player.duration(durationHintSeconds);
        }
        player.removeClass("vjs-live");
        player.removeClass("vjs-liveui");
      }
      const nextDuration = player.duration();
      if (typeof nextDuration === "number" && Number.isFinite(nextDuration)) setDuration(nextDuration);
    };
    const handleTimeUpdate = (): void => {
      const t = player.currentTime();
      if (typeof t === "number" && Number.isFinite(t)) setCurrentTime(t);
      latestCallbacksRef.current.onVideoTimeUpdate();
    };
    const handleDurationChange = (): void => {
      syncArchivedDuration();
      handleTimeUpdate();
    };
    const handlePlay = (): void => {
      setIsPlaying(true);
      revealControls();
    };
    const handlePause = (): void => {
      setIsPlaying(false);
      clearHideTimer();
      setControlsVisible(true);
    };
    const handleVolume = (): void => {
      const v = player.volume();
      if (typeof v === "number") setVolume(v);
      setMuted(Boolean(player.muted()));
    };
    const handleRate = (): void => {
      const r = player.playbackRate();
      if (typeof r === "number") setRate(r);
    };
    const handleError = (): void => latestCallbacksRef.current.onVideoError?.();

    player.on("timeupdate", handleTimeUpdate);
    player.on("seeked", handleTimeUpdate);
    player.on("durationchange", handleDurationChange);
    player.on("loadedmetadata", handleDurationChange);
    player.on("play", handlePlay);
    player.on("pause", handlePause);
    player.on("volumechange", handleVolume);
    player.on("ratechange", handleRate);
    player.on("error", handleError);
    handleVolume();

    return () => {
      clearHideTimer();
      player.off("timeupdate", handleTimeUpdate);
      player.off("seeked", handleTimeUpdate);
      player.off("durationchange", handleDurationChange);
      player.off("loadedmetadata", handleDurationChange);
      player.off("play", handlePlay);
      player.off("pause", handlePause);
      player.off("volumechange", handleVolume);
      player.off("ratechange", handleRate);
      player.off("error", handleError);
      player.dispose();
      playerRef.current = null;
      assignVideoRef(props.videoRef, null);
    };
    // Mount-once: the player is created a single time. `revealControls`/
    // `clearHideTimer` are stable callbacks and `videoRef` is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleFullscreenChange = (): void => {
      const wrapper = wrapperRef.current;
      const fullscreenEl = getFullscreenElement();
      setIsFullscreen(Boolean(wrapper && fullscreenEl && (fullscreenEl === wrapper || wrapper.contains(fullscreenEl))));
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!props.videoSrc) {
      player.reset();
      setIsPlaying(false);
      setCurrentTime(0);
      return;
    }
    if (player.currentSrc() === props.videoSrc) return;
    player.src({ src: props.videoSrc, type: videoSourceType(props.videoSrc) });
    player.load();
  }, [props.videoSrc]);

  const togglePlay = useCallback((): void => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused()) void player.play();
    else player.pause();
  }, []);

  const handleSeek = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const player = playerRef.current;
    const next = Number(event.target.value);
    setCurrentTime(next);
    if (player) player.currentTime(next);
  }, []);

  const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const player = playerRef.current;
    const next = Number(event.target.value);
    setVolume(next);
    if (player) {
      player.volume(next);
      player.muted(next === 0);
    }
  }, []);

  const toggleMute = useCallback((): void => {
    const player = playerRef.current;
    if (!player) return;
    player.muted(!player.muted());
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (getFullscreenElement()) exitAnyFullscreen();
    else requestWrapperFullscreen(wrapper, videoNodeRef.current);
  }, []);

  const cycleRate = useCallback((): void => {
    const player = playerRef.current;
    if (!player) return;
    const idx = playbackRates.indexOf(player.playbackRate() ?? 1);
    const next = playbackRates[(idx + 1) % playbackRates.length] ?? 1;
    player.playbackRate(next);
    setRate(next);
  }, []);

  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const volumePct = muted ? 0 : volume * 100;

  return (
    <div className="jl-vm-video-wrap">
      <div
        ref={wrapperRef}
        className="jl-vm-video-inner"
        data-playing={isPlaying ? "true" : "false"}
        data-controls={controlsVisible ? "visible" : "hidden"}
        data-fullscreen={isFullscreen ? "true" : "false"}
        onPointerMove={revealControls}
        onPointerLeave={() => {
          if (isPlaying) setControlsVisible(false);
        }}
      >
        <div className="jl-vm-video-host" data-vjs-player>
          <video
            ref={(videoEl) => {
              videoNodeRef.current = videoEl;
              assignVideoRef(props.videoRef, videoEl);
            }}
            className="video-js"
            playsInline
            preload="metadata"
          />
        </div>

        <button
          type="button"
          className="jl-vm-vc-surface"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={() => {
            // On touch screens the first tap only reveals the hidden controls;
            // a second tap (controls now visible) toggles playback.
            if (isPlaying && !controlsVisible) {
              revealControls();
              return;
            }
            togglePlay();
          }}
        />

        {!isPlaying ? (
          <button type="button" className="jl-vm-vc-bigplay" aria-label="Play" onClick={togglePlay}>
            <Play aria-hidden size={30} fill="currentColor" />
          </button>
        ) : null}

        <div className="jl-vm-vc-bar" data-visible={controlsVisible ? "true" : "false"}>
          <button
            type="button"
            className="jl-vm-vc-play"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={togglePlay}
          >
            {isPlaying ? (
              <Pause aria-hidden size={17} fill="currentColor" />
            ) : (
              <Play aria-hidden size={17} fill="currentColor" />
            )}
          </button>

          <span className="jl-vm-vc-time">{formatTime(currentTime)}</span>
          <input
            type="range"
            className="jl-vm-vc-range jl-vm-vc-progress"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(currentTime, duration || currentTime)}
            onChange={handleSeek}
            style={rangeFill(progressPct)}
            aria-label="Seek"
          />
          <span className="jl-vm-vc-time jl-vm-vc-time-total">{formatTime(duration)}</span>

          <button
            type="button"
            className="jl-vm-vc-icon jl-vm-vc-mute"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            onClick={toggleMute}
          >
            {muted || volume === 0 ? (
              <VolumeX aria-hidden size={18} />
            ) : (
              <Volume2 aria-hidden size={18} />
            )}
          </button>
          <input
            type="range"
            className="jl-vm-vc-range jl-vm-vc-volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={handleVolumeChange}
            style={rangeFill(volumePct)}
            aria-label="Volume"
          />

          <button type="button" className="jl-vm-vc-rate" aria-label="Playback speed" onClick={cycleRate}>
            {rate}×
          </button>

          <button
            type="button"
            className="jl-vm-vc-icon jl-vm-vc-fullscreen"
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize aria-hidden size={18} /> : <Maximize aria-hidden size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
