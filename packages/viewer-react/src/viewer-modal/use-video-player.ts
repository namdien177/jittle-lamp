import { useEffect, useRef, useState } from "react";
import type * as React from "react";

import { mediaDuration } from "./format";

export const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;
const CONTROLS_HIDE_DELAY_MS = 2600;

/** The subset of viewer props the player needs — a narrow, explicit contract. */
export type VideoPlayerProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  videoDurationHintMs?: number;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;
};

/** Media-element event handlers; spread directly onto the `<video>`. */
export type VideoEventHandlers = Pick<
  React.DOMAttributes<HTMLVideoElement>,
  | "onLoadStart"
  | "onLoadedMetadata"
  | "onCanPlay"
  | "onProgress"
  | "onSeeking"
  | "onSeeked"
  | "onWaiting"
  | "onStalled"
  | "onDurationChange"
  | "onPlay"
  | "onPause"
  | "onVolumeChange"
  | "onTimeUpdate"
  | "onError"
>;

export type VideoPlayerController = {
  paused: boolean;
  muted: boolean;
  effectiveVolume: number;
  playbackRate: number;
  durationValue: number;
  boundedCurrentTime: number;
  progress: number;
  bufferedProgress: number;
  recoveringSeek: boolean;
  isFullscreen: boolean;
  controlsShown: boolean;
  speedMenuOpen: boolean;
  scrubHover: number | null;
  speedMenuRef: React.RefObject<HTMLDivElement | null>;
  videoEventHandlers: VideoEventHandlers;
  togglePlayback: () => void;
  seekBy: (deltaSeconds: number) => void;
  seekTo: (value: string) => void;
  changeVolume: (value: number) => void;
  toggleMute: () => void;
  applyRate: (rate: number) => void;
  toggleFullscreen: () => void;
  toggleSpeedMenu: () => void;
  revealControls: () => void;
  handleMouseLeave: () => void;
  handleKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleScrubHover: (event: React.MouseEvent<HTMLDivElement>) => void;
  clearScrubHover: () => void;
};

export function useVideoPlayer(props: VideoPlayerProps): VideoPlayerController {
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recoveringSeek, setRecoveringSeek] = useState(false);
  const [scrubHover, setScrubHover] = useState<number | null>(null);
  const lastRequestedSeekRef = useRef<number | null>(null);
  const controlsHideTimerRef = useRef<number | null>(null);
  const playbackRateRef = useRef(1);
  const speedMenuRef = useRef<HTMLDivElement | null>(null);

  const durationHint = props.videoDurationHintMs && props.videoDurationHintMs > 0 ? props.videoDurationHintMs / 1000 : 0;
  const durationValue = Math.max(Number.isFinite(duration) && duration > 0 ? duration : 0, durationHint);
  const displayCurrentTime = lastRequestedSeekRef.current ?? currentTime;
  const boundedCurrentTime = durationValue > 0 ? Math.min(displayCurrentTime, durationValue) : displayCurrentTime;
  const progress = durationValue > 0 ? (boundedCurrentTime / durationValue) * 100 : 0;
  const bufferedProgress = durationValue > 0 ? Math.min(100, (buffered / durationValue) * 100) : 0;
  const effectiveVolume = muted ? 0 : volume;
  const controlsShown = paused || controlsVisible;

  const clearControlsHideTimer = (): void => {
    if (controlsHideTimerRef.current !== null) {
      window.clearTimeout(controlsHideTimerRef.current);
      controlsHideTimerRef.current = null;
    }
  };

  const revealControls = (): void => {
    setControlsVisible(true);
    clearControlsHideTimer();
    const videoEl = props.videoRef.current;
    if (videoEl && !videoEl.paused) {
      controlsHideTimerRef.current = window.setTimeout(() => {
        controlsHideTimerRef.current = null;
        setControlsVisible(false);
        setSpeedMenuOpen(false);
      }, CONTROLS_HIDE_DELAY_MS);
    }
  };

  const resetVideoState = (): void => {
    setPaused(true);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    setRecoveringSeek(false);
    lastRequestedSeekRef.current = null;
  };

  const settleRequestedSeek = (videoEl: HTMLVideoElement): void => {
    const targetSeconds = lastRequestedSeekRef.current;
    if (targetSeconds === null || Math.abs((videoEl.currentTime || 0) - targetSeconds) > 0.25) return;
    lastRequestedSeekRef.current = null;
    setRecoveringSeek(false);
  };

  const syncVideoState = (): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;
    const nextDuration = mediaDuration(videoEl);
    setPaused(videoEl.paused);
    setMuted(videoEl.muted || videoEl.volume === 0);
    setVolume(videoEl.volume);
    setCurrentTime(videoEl.currentTime || 0);
    setDuration(nextDuration);
    setPlaybackRate(videoEl.playbackRate || 1);
    if (videoEl.buffered.length > 0) {
      setBuffered(videoEl.buffered.end(videoEl.buffered.length - 1));
    }
    if (
      lastRequestedSeekRef.current === null &&
      !videoEl.seeking &&
      videoEl.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      setRecoveringSeek(false);
    }
  };

  const togglePlayback = (): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;

    if (videoEl.paused) {
      if (videoEl.readyState === 0) videoEl.load();
      void videoEl.play().then(syncVideoState).catch(syncVideoState);
    } else {
      videoEl.pause();
    }
    syncVideoState();
    revealControls();
  };

  const seekBy = (deltaSeconds: number): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;
    const max = durationValue > 0 ? durationValue : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(max, boundedCurrentTime + deltaSeconds));
    videoEl.currentTime = target;
    lastRequestedSeekRef.current = target;
    setCurrentTime(target);
    props.onVideoTimeUpdate();
  };

  const seekTo = (value: string): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;
    const nextTime = Math.max(0, Number(value));
    const target = durationValue > 0 ? Math.min(nextTime, durationValue) : nextTime;
    videoEl.currentTime = target;
    lastRequestedSeekRef.current = target;
    setCurrentTime(target);
    props.onVideoTimeUpdate();
  };

  const handleProgress = (): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl || videoEl.buffered.length === 0) return;
    setBuffered(videoEl.buffered.end(videoEl.buffered.length - 1));
  };

  const toggleMute = (): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    if (!videoEl.muted && videoEl.volume === 0) videoEl.volume = 1;
    syncVideoState();
  };

  const changeVolume = (value: number): void => {
    const videoEl = props.videoRef.current;
    if (!videoEl) return;
    const next = Math.max(0, Math.min(1, value));
    videoEl.volume = next;
    videoEl.muted = next === 0;
    syncVideoState();
  };

  const applyRate = (rate: number): void => {
    const videoEl = props.videoRef.current;
    if (videoEl) videoEl.playbackRate = rate;
    playbackRateRef.current = rate;
    setPlaybackRate(rate);
    setSpeedMenuOpen(false);
  };

  const toggleFullscreen = (): void => {
    const host = props.videoRef.current?.closest(".jl-vm-video-wrap") as HTMLElement | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
    } else {
      void host?.requestFullscreen?.().catch(() => undefined);
    }
  };

  const toggleSpeedMenu = (): void => setSpeedMenuOpen((open) => !open);

  const handleMouseLeave = (): void => {
    if (!paused) setControlsVisible(false);
  };

  const clearScrubHover = (): void => setScrubHover(null);

  const handleScrubHover = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (durationValue <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    setScrubHover(fraction);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null;
    const onScrub = target?.classList?.contains("jl-vm-video-scrub") ?? false;
    switch (event.key) {
      case " ":
      case "k":
        event.preventDefault();
        togglePlayback();
        break;
      case "ArrowLeft":
        if (onScrub) return;
        event.preventDefault();
        seekBy(-5);
        break;
      case "ArrowRight":
        if (onScrub) return;
        event.preventDefault();
        seekBy(5);
        break;
      case "j":
        event.preventDefault();
        seekBy(-10);
        break;
      case "l":
        event.preventDefault();
        seekBy(10);
        break;
      case "ArrowUp":
        if (onScrub) return;
        event.preventDefault();
        changeVolume(effectiveVolume + 0.1);
        break;
      case "ArrowDown":
        if (onScrub) return;
        event.preventDefault();
        changeVolume(effectiveVolume - 0.1);
        break;
      case "m":
        event.preventDefault();
        toggleMute();
        break;
      case "f":
        event.preventDefault();
        toggleFullscreen();
        break;
      default:
        return;
    }
    revealControls();
  };

  useEffect(() => {
    const onFullscreenChange = (): void => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      if (controlsHideTimerRef.current !== null) window.clearTimeout(controlsHideTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!speedMenuOpen) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!speedMenuRef.current?.contains(event.target as Node)) setSpeedMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [speedMenuOpen]);

  const videoEventHandlers: VideoEventHandlers = {
    onLoadStart: resetVideoState,
    onLoadedMetadata: () => {
      const videoEl = props.videoRef.current;
      if (videoEl) videoEl.playbackRate = playbackRateRef.current;
      syncVideoState();
    },
    onCanPlay: () => {
      const videoEl = props.videoRef.current;
      if (!videoEl) return;
      settleRequestedSeek(videoEl);
      syncVideoState();
    },
    onProgress: handleProgress,
    onSeeking: () => {
      const targetSeconds = lastRequestedSeekRef.current;
      if (targetSeconds !== null) {
        setCurrentTime(targetSeconds);
        setRecoveringSeek(true);
        return;
      }
      syncVideoState();
    },
    onSeeked: () => {
      const videoEl = props.videoRef.current;
      if (videoEl) settleRequestedSeek(videoEl);
      syncVideoState();
    },
    onWaiting: () => {
      setRecoveringSeek(true);
      syncVideoState();
    },
    onStalled: () => {
      setRecoveringSeek(true);
      syncVideoState();
    },
    onDurationChange: syncVideoState,
    onPlay: () => {
      const videoEl = props.videoRef.current;
      if (!videoEl) return;
      syncVideoState();
      revealControls();
    },
    onPause: syncVideoState,
    onVolumeChange: syncVideoState,
    onTimeUpdate: () => {
      const videoEl = props.videoRef.current;
      if (videoEl) settleRequestedSeek(videoEl);
      syncVideoState();
      props.onVideoTimeUpdate();
    },
    onError: props.onVideoError
  };

  return {
    paused,
    muted,
    effectiveVolume,
    playbackRate,
    durationValue,
    boundedCurrentTime,
    progress,
    bufferedProgress,
    recoveringSeek,
    isFullscreen,
    controlsShown,
    speedMenuOpen,
    scrubHover,
    speedMenuRef,
    videoEventHandlers,
    togglePlayback,
    seekBy,
    seekTo,
    changeVolume,
    toggleMute,
    applyRate,
    toggleFullscreen,
    toggleSpeedMenu,
    revealControls,
    handleMouseLeave,
    handleKeyDown,
    handleScrubHover,
    clearScrubHover
  };
}
