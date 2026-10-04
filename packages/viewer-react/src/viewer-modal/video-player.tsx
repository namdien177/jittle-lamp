import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";

import { SkipGapsButton, useGapSkipper, useSkipGapsPreference } from "./gap-skip";
import { SeekBar, StepCaption, StepNavButtons, buildStepSegments } from "./seek-bar";
import type { ViewerStepChip } from "./types";

import { seekVideo } from "../seek-video";

export type VideoPlayerProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  videoDurationHintMs?: number;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;
  // Video offsets (ms) of the steps, for Skip gaps; see viewer-core deriveGapMarkers.
  gapMarkersMs?: readonly number[];
  // Test-run steps: drawn on the seek bar, with previous/next step buttons.
  steps?: readonly ViewerStepChip[];
  activeStepId?: string | null;
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
    backgroundImage: `linear-gradient(to right, var(--jl-vm-vc-fill) ${clamped}%, rgba(255, 255, 255, 0.24) ${clamped}%)`
  };
}

const AdaptivePlayer = lazy(() => import("./adaptive-video-player").then(module => ({ default: module.AdaptiveEvidenceVideoPlayer })));

export function EvidenceVideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const type = videoSourceType(props.videoSrc);
  if (type.includes("mpegURL") || type.includes("dash+xml")) {
    return <Suspense fallback={<div className="jl-vm-video-wrap" role="status">Loading stream…</div>}><AdaptivePlayer {...props} /></Suspense>;
  }
  return <NativeEvidenceVideoPlayer {...props} />;
}

function NativeEvidenceVideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const videoNodeRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
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
  const [skipGaps, setSkipGaps] = useSkipGapsPreference();
  const gapSkipper = useGapSkipper(props.gapMarkersMs, skipGaps);
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
    const player = videoNodeRef.current;
    if (player && !player.paused) {
      hideTimerRef.current = setTimeout(() => setControlsVisible(false), AUTO_HIDE_MS);
    }
  }, [clearHideTimer]);

  useEffect(() => {
    const videoEl = videoNodeRef.current;
    if (!videoEl) return;
    const player = videoEl;
    assignVideoRef(props.videoRef, videoEl);

    const syncArchivedDuration = (): void => {
      const actual = player.duration;
      const hint = (durationHintMsRef.current ?? 0) / 1000;
      setDuration(Number.isFinite(actual) && actual > 0 ? actual : hint);
    };
    const handleTimeUpdate = (): void => {
      const t = player.currentTime;
      if (typeof t === "number" && Number.isFinite(t)) {
        setCurrentTime(t);
        gapSkipper.onTime(t, !player.paused && !player.seeking, (seconds) => {
          void seekVideo(player, seconds).catch(() => latestCallbacksRef.current.onVideoError?.());
        });
      }
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
      const v = player.volume;
      if (typeof v === "number") setVolume(v);
      setMuted(Boolean(player.muted));
    };
    const handleRate = (): void => {
      const r = player.playbackRate;
      if (typeof r === "number") setRate(r);
    };
    const handleError = (): void => latestCallbacksRef.current.onVideoError?.();

    player.addEventListener("timeupdate", handleTimeUpdate);
    player.addEventListener("seeked", handleTimeUpdate);
    player.addEventListener("durationchange", handleDurationChange);
    player.addEventListener("loadedmetadata", handleDurationChange);
    player.addEventListener("play", handlePlay);
    player.addEventListener("pause", handlePause);
    player.addEventListener("volumechange", handleVolume);
    player.addEventListener("ratechange", handleRate);
    player.addEventListener("error", handleError);
    handleVolume();
    syncArchivedDuration();

    return () => {
      clearHideTimer();
      player.removeEventListener("timeupdate", handleTimeUpdate);
      player.removeEventListener("seeked", handleTimeUpdate);
      player.removeEventListener("durationchange", handleDurationChange);
      player.removeEventListener("loadedmetadata", handleDurationChange);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("pause", handlePause);
      player.removeEventListener("volumechange", handleVolume);
      player.removeEventListener("ratechange", handleRate);
      player.removeEventListener("error", handleError);
      player.pause();
      assignVideoRef(props.videoRef, null);
    };
    // The video and listeners live for this mount. `revealControls`/
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

  const togglePlay = useCallback((): void => {
    const player = videoNodeRef.current;
    if (!player) return;
    if (player.paused) void player.play().catch(() => latestCallbacksRef.current.onVideoError?.());
    else player.pause();
  }, []);

  const handleSeek = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const player = videoNodeRef.current;
    const next = Number(event.target.value);
    setCurrentTime(next);
    gapSkipper.onManualSeek(next);
    if (player) void seekVideo(player, next).catch(() => latestCallbacksRef.current.onVideoError?.());
  }, [gapSkipper]);

  const seekToStep = useCallback((seconds: number): void => {
    const player = videoNodeRef.current;
    setCurrentTime(seconds);
    gapSkipper.onManualSeek(seconds);
    if (player) void seekVideo(player, seconds).catch(() => latestCallbacksRef.current.onVideoError?.());
  }, [gapSkipper]);

  const handleVolumeChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const player = videoNodeRef.current;
    const next = Number(event.target.value);
    setVolume(next);
    if (player) {
      player.volume = next;
      player.muted = next === 0;
    }
  }, []);

  const toggleMute = useCallback((): void => {
    const player = videoNodeRef.current;
    if (!player) return;
    player.muted = !player.muted;
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (getFullscreenElement()) exitAnyFullscreen();
    else requestWrapperFullscreen(wrapper, videoNodeRef.current);
  }, []);

  const cycleRate = useCallback((): void => {
    const player = videoNodeRef.current;
    if (!player) return;
    const idx = playbackRates.indexOf(player.playbackRate ?? 1);
    const next = playbackRates[(idx + 1) % playbackRates.length] ?? 1;
    player.playbackRate = next;
    setRate(next);
  }, []);

  const segments = useMemo(() => buildStepSegments(props.steps, duration), [props.steps, duration]);
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
        <div className="jl-vm-video-host">
          <video
            ref={(videoEl) => {
              videoNodeRef.current = videoEl;
              assignVideoRef(props.videoRef, videoEl);
            }}
            className="vjs-tech"
            src={props.videoSrc ?? undefined}
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
            data-tip={isPlaying ? "Pause" : "Play"}
            data-tip-side="top"
            onClick={togglePlay}
          >
            {isPlaying ? (
              <Pause aria-hidden size={17} fill="currentColor" />
            ) : (
              <Play aria-hidden size={17} fill="currentColor" />
            )}
          </button>
          <StepNavButtons segments={segments} currentTime={currentTime} onSeekTo={seekToStep} />

          <span className="jl-vm-vc-time">{formatTime(currentTime)}</span>
          <SeekBar currentTime={currentTime} duration={duration} segments={segments} activeStepId={props.activeStepId} onSeek={handleSeek} />
          <span className="jl-vm-vc-time jl-vm-vc-time-total">{formatTime(duration)}</span>
          <StepCaption segments={segments} currentTime={currentTime} />

          <button
            type="button"
            className="jl-vm-vc-icon jl-vm-vc-mute"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
            data-tip={muted || volume === 0 ? "Unmute" : "Mute"}
            data-tip-side="top"
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

          <SkipGapsButton enabled={skipGaps} onChange={setSkipGaps} hasMarkers={(props.gapMarkersMs?.length ?? 0) > 0} />

          <button type="button" className="jl-vm-vc-rate" aria-label="Playback speed" data-tip="Playback speed" data-tip-side="top" onClick={cycleRate}>
            {rate}×
          </button>

          <button
            type="button"
            className="jl-vm-vc-icon jl-vm-vc-fullscreen"
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            data-tip={isFullscreen ? "Exit full screen" : "Full screen"}
            data-tip-side="top"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? <Minimize aria-hidden size={18} /> : <Maximize aria-hidden size={18} />}
          </button>
        </div>
      </div>
    </div>
  );
}
