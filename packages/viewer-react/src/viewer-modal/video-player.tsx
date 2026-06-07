import type * as React from "react";
import {
  Check,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume1,
  Volume2,
  VolumeX
} from "lucide-react";

import { formatClockTime } from "./format";
import { PLAYBACK_RATES, useVideoPlayer, type VideoPlayerProps } from "./use-video-player";

export type { VideoPlayerProps } from "./use-video-player";

export function EvidenceVideoPlayer(props: VideoPlayerProps): React.JSX.Element {
  const player = useVideoPlayer(props);
  const VolumeIcon =
    player.muted || player.effectiveVolume === 0 ? VolumeX : player.effectiveVolume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className="jl-vm-video-wrap"
      data-controls={player.controlsShown ? "visible" : "hidden"}
      tabIndex={0}
      onMouseMove={player.revealControls}
      onMouseLeave={player.handleMouseLeave}
      onFocusCapture={player.revealControls}
      onKeyDown={player.handleKeyDown}
    >
      <div className="jl-vm-video-inner">
        <video
          key={props.videoSrc ?? "empty-video"}
          ref={props.videoRef}
          src={props.videoSrc ?? undefined}
          playsInline
          preload="metadata"
          onClick={player.togglePlayback}
          {...player.videoEventHandlers}
        />
        <button
          type="button"
          className="jl-vm-video-stage-button"
          aria-label={player.paused ? "Play evidence video" : "Pause evidence video"}
          data-paused={player.paused ? "true" : "false"}
          onClick={player.togglePlayback}
        >
          {player.paused ? (
            <Play aria-hidden size={30} strokeWidth={2.1} />
          ) : (
            <Pause aria-hidden size={30} strokeWidth={2.1} />
          )}
        </button>
      </div>

      <div className="jl-vm-video-scrim" aria-hidden />

      <div className="jl-vm-video-controls">
        <div
          className="jl-vm-video-scrub-region"
          onMouseMove={player.handleScrubHover}
          onMouseLeave={player.clearScrubHover}
        >
          {player.scrubHover !== null && player.durationValue > 0 ? (
            <span className="jl-vm-video-scrub-tip" style={{ left: `${player.scrubHover * 100}%` }}>
              {formatClockTime(player.scrubHover * player.durationValue)}
            </span>
          ) : null}
          <input
            className="jl-vm-video-scrub"
            type="range"
            min="0"
            max={player.durationValue || 0}
            step="0.01"
            value={player.durationValue > 0 ? player.boundedCurrentTime : 0}
            aria-label="Evidence video timeline"
            style={
              {
                "--jl-vm-video-progress": `${player.progress}%`,
                "--jl-vm-video-buffered": `${player.bufferedProgress}%`
              } as React.CSSProperties
            }
            onInput={(event) => player.seekTo(event.currentTarget.value)}
            onChange={(event) => player.seekTo(event.currentTarget.value)}
          />
        </div>

        <div className="jl-vm-video-bar">
          <div className="jl-vm-video-group">
            <button
              type="button"
              className="jl-vm-video-control jl-vm-video-play"
              aria-label={player.paused ? "Play" : "Pause"}
              onClick={player.togglePlayback}
            >
              {player.paused ? (
                <Play aria-hidden size={20} strokeWidth={2.2} />
              ) : (
                <Pause aria-hidden size={20} strokeWidth={2.2} />
              )}
            </button>
            <button type="button" className="jl-vm-video-control" aria-label="Back 5 seconds" onClick={() => player.seekBy(-5)}>
              <RotateCcw aria-hidden size={17} strokeWidth={2.1} />
            </button>
            <button type="button" className="jl-vm-video-control" aria-label="Forward 5 seconds" onClick={() => player.seekBy(5)}>
              <RotateCw aria-hidden size={17} strokeWidth={2.1} />
            </button>
            <div className="jl-vm-video-volume">
              <button
                type="button"
                className="jl-vm-video-control"
                aria-label={player.muted ? "Unmute" : "Mute"}
                onClick={player.toggleMute}
              >
                <VolumeIcon aria-hidden size={18} strokeWidth={2.1} />
              </button>
              <input
                className="jl-vm-video-volume-slider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={player.effectiveVolume}
                aria-label="Volume"
                style={{ "--jl-vm-video-volume": `${player.effectiveVolume * 100}%` } as React.CSSProperties}
                onInput={(event) => player.changeVolume(Number(event.currentTarget.value))}
                onChange={(event) => player.changeVolume(Number(event.currentTarget.value))}
              />
            </div>
            <span className="jl-vm-video-time">
              <span className="jl-vm-video-time-now">{formatClockTime(player.boundedCurrentTime)}</span>
              <span className="jl-vm-video-time-sep">/</span>
              <span className="jl-vm-video-time-total">
                {player.durationValue > 0 ? formatClockTime(player.durationValue) : "0:00"}
              </span>
            </span>
          </div>

          <div className="jl-vm-video-group">
            {player.recoveringSeek ? <span className="jl-vm-video-recovering">Buffering…</span> : null}
            <div className="jl-vm-video-speed" ref={player.speedMenuRef}>
              {player.speedMenuOpen ? (
                <div className="jl-vm-video-speed-menu" role="menu">
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      role="menuitemradio"
                      aria-checked={rate === player.playbackRate}
                      data-active={rate === player.playbackRate ? "true" : "false"}
                      onClick={() => player.applyRate(rate)}
                    >
                      <span>{rate === 1 ? "Normal" : `${rate}×`}</span>
                      {rate === player.playbackRate ? <Check aria-hidden size={14} strokeWidth={2.4} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="jl-vm-video-control jl-vm-video-speed-btn"
                aria-label="Playback speed"
                aria-haspopup="menu"
                aria-expanded={player.speedMenuOpen}
                onClick={player.toggleSpeedMenu}
              >
                {player.playbackRate}×
              </button>
            </div>
            <button
              type="button"
              className="jl-vm-video-control"
              aria-label={player.isFullscreen ? "Exit full screen" : "Full screen"}
              onClick={player.toggleFullscreen}
            >
              {player.isFullscreen ? (
                <Minimize2 aria-hidden size={18} strokeWidth={2.1} />
              ) : (
                <Maximize2 aria-hidden size={18} strokeWidth={2.1} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
