import { useEffect, useRef } from "react";
import type * as React from "react";
import videojs from "video.js";
import type Player from "video.js/dist/types/player";

export type VideoPlayerProps = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  videoSrc?: string | null;
  videoDurationHintMs?: number;
  onVideoTimeUpdate: () => void;
  onVideoError?: () => void;
};

const playbackRates = [0.25, 0.5, 1, 1.5, 2];

function assignVideoRef(ref: React.RefObject<HTMLVideoElement | null>, videoEl: HTMLVideoElement | null): void {
  (ref as { current: HTMLVideoElement | null }).current = videoEl;
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

export function EvidenceVideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const videoNodeRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<Player | null>(null);
  const latestCallbacksRef = useRef({
    onVideoTimeUpdate: props.onVideoTimeUpdate,
    onVideoError: props.onVideoError
  });
  const durationHintMsRef = useRef(props.videoDurationHintMs);
  durationHintMsRef.current = props.videoDurationHintMs;
  latestCallbacksRef.current = {
    onVideoTimeUpdate: props.onVideoTimeUpdate,
    onVideoError: props.onVideoError
  };

  useEffect(() => {
    const videoEl = videoNodeRef.current;
    if (!videoEl || playerRef.current) return;

    const player = videojs(videoEl, {
      controls: true,
      fill: true,
      fluid: false,
      responsive: true,
      preload: "metadata",
      playbackRates,
          controlBar: {
            currentTimeDisplay: true,
            durationDisplay: true,
            liveDisplay: false,
            pictureInPictureToggle: false,
            progressControl: true,
            seekToLive: false,
            remainingTimeDisplay: false
          },
          liveui: false,
          sources: []
        });
    playerRef.current = player;

    const syncArchivedDuration = (): void => {
      const durationHintMs = durationHintMsRef.current;
      if (!durationHintMs || durationHintMs <= 0) return;

      const durationHintSeconds = durationHintMs / 1000;
      const currentDuration = player.duration();
      if (currentDuration === undefined || !Number.isFinite(currentDuration) || currentDuration <= 0) {
        player.duration(durationHintSeconds);
      }
      player.removeClass("vjs-live");
      player.removeClass("vjs-liveui");
    };
    const handleTimeUpdate = (): void => latestCallbacksRef.current.onVideoTimeUpdate();
    const handleDurationChange = (): void => {
      syncArchivedDuration();
      handleTimeUpdate();
    };
    const handleError = (): void => latestCallbacksRef.current.onVideoError?.();

    player.on("timeupdate", handleTimeUpdate);
    player.on("seeked", handleTimeUpdate);
    player.on("durationchange", handleDurationChange);
    player.on("loadedmetadata", handleDurationChange);
    player.on("error", handleError);

    return () => {
      player.off("timeupdate", handleTimeUpdate);
      player.off("seeked", handleTimeUpdate);
      player.off("durationchange", handleDurationChange);
      player.off("loadedmetadata", handleDurationChange);
      player.off("error", handleError);
      player.dispose();
      playerRef.current = null;
      assignVideoRef(props.videoRef, null);
    };
  }, [props.videoRef]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (!props.videoSrc) {
      player.reset();
      return;
    }
    if (player.currentSrc() === props.videoSrc) return;
    player.src({ src: props.videoSrc, type: videoSourceType(props.videoSrc) });
    player.load();
  }, [props.videoSrc]);

  return (
    <div className="jl-vm-video-wrap">
      <div className="jl-vm-video-inner" data-vjs-player>
        <video
          key={props.videoSrc ?? "empty-video"}
          ref={(videoEl) => {
            videoNodeRef.current = videoEl;
            assignVideoRef(props.videoRef, videoEl);
          }}
          className="video-js vjs-big-play-centered vjs-theme-city"
          playsInline
          preload="metadata"
        />
      </div>
    </div>
  );
}
