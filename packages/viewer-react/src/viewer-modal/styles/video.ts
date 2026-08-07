export const videoStyles = `
.jl-vm-video-wrap {
  position: relative;
  background: #000;
  flex: 2 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  isolation: isolate;
}

.jl-vm-video-inner {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: #000;
  container-type: inline-size;
}

.jl-vm-video-inner .jl-vm-video-host,
.jl-vm-video-inner .video-js {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: inherit;
  background: #000;
  color: #fff;
}

.jl-vm-video-inner .video-js .vjs-tech,
.jl-vm-video-inner .jl-vm-video-host .vjs-tech {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

/* The viewer ships its own control bar — suppress every native video.js chrome
   element (including the globally imported video-js.css skin in evidence-web). */
.jl-vm-video-inner .video-js .vjs-control-bar,
.jl-vm-video-inner .video-js .vjs-big-play-button,
.jl-vm-video-inner .video-js .vjs-text-track-settings {
  display: none !important;
}

.jl-vm-video-inner[data-playing="true"][data-controls="hidden"] {
  cursor: none;
}

/* The wrapper itself goes fullscreen so the custom control bar rides along. */
.jl-vm-video-inner:fullscreen {
  width: 100%;
  height: 100%;
  background: #000;
}

.jl-vm-video-inner[data-fullscreen="true"] .jl-vm-vc-bar {
  right: max(16px, env(safe-area-inset-right));
  bottom: max(16px, env(safe-area-inset-bottom));
  left: max(16px, env(safe-area-inset-left));
}

/* Click-to-toggle surface sits over the video, beneath the controls. */
.jl-vm-video-inner button.jl-vm-vc-surface {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: block;
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.jl-vm-video-inner button.jl-vm-vc-bigplay {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 72px;
  height: 72px;
  line-height: 0;
  padding: 0;
  border: 0;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  cursor: pointer;
  transform: translate(-50%, -50%);
  transition: background 160ms ease, transform 160ms ease;
}

.jl-vm-video-inner button.jl-vm-vc-bigplay svg,
.jl-vm-video-inner button.jl-vm-vc-play svg,
.jl-vm-video-inner button.jl-vm-vc-icon svg {
  display: block;
  flex: 0 0 auto;
}

.jl-vm-video-inner button.jl-vm-vc-bigplay:hover,
.jl-vm-video-inner button.jl-vm-vc-bigplay:focus-visible {
  background: rgba(0, 0, 0, 0.72);
  transform: translate(-50%, -50%) scale(1.05);
  outline: none;
}

.jl-vm-video-inner .jl-vm-vc-bar {
  position: absolute;
  right: 16px;
  bottom: 16px;
  left: 16px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 52px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.42);
  color: #fff;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  box-sizing: border-box;
  opacity: 1;
  transition: opacity 200ms ease, transform 200ms ease;
  --jl-vm-vc-fill: #ffffff;
}

.jl-vm-video-inner .jl-vm-vc-bar[data-visible="false"] {
  pointer-events: none;
  opacity: 0;
  transform: translateY(10px);
}

.jl-vm-video-inner button.jl-vm-vc-play,
.jl-vm-video-inner button.jl-vm-vc-icon,
.jl-vm-video-inner button.jl-vm-vc-rate {
  appearance: none;
  border: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 1;
  transition: background 150ms ease, color 150ms ease, transform 150ms ease;
}

.jl-vm-video-inner button.jl-vm-vc-play {
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  background: #fff;
  color: #0a0a0a;
}

.jl-vm-video-inner button.jl-vm-vc-play:hover,
.jl-vm-video-inner button.jl-vm-vc-play:focus-visible {
  transform: scale(1.06);
  outline: none;
}

.jl-vm-video-inner button.jl-vm-vc-icon {
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
}

.jl-vm-video-inner button.jl-vm-vc-icon:hover,
.jl-vm-video-inner button.jl-vm-vc-icon:focus-visible {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  outline: none;
}

.jl-vm-video-inner button.jl-vm-vc-rate {
  min-width: 38px;
  height: 28px;
  padding: 0 8px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  font-weight: 700;
}

.jl-vm-video-inner button.jl-vm-vc-rate:hover,
.jl-vm-video-inner button.jl-vm-vc-rate:focus-visible {
  background: rgba(255, 255, 255, 0.22);
  outline: none;
}

.jl-vm-video-inner .jl-vm-vc-time {
  flex-shrink: 0;
  width: 42px;
  color: rgba(255, 255, 255, 0.78);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.jl-vm-video-inner .jl-vm-vc-time-total {
  text-align: left;
}

.jl-vm-video-inner .jl-vm-vc-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.24);
  cursor: pointer;
  outline: none;
}

.jl-vm-video-inner .jl-vm-vc-progress {
  flex: 1;
  min-width: 80px;
}

.jl-vm-video-inner .jl-vm-vc-volume {
  flex-shrink: 0;
  width: 72px;
}

.jl-vm-video-inner .jl-vm-vc-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}

.jl-vm-video-inner .jl-vm-vc-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}

.jl-vm-video-inner .jl-vm-vc-range::-moz-range-track {
  height: 4px;
  border-radius: 9999px;
  background: transparent;
}

@container (max-width: 560px) {
  .jl-vm-video-inner .jl-vm-vc-bar {
    right: 8px;
    bottom: 8px;
    left: 8px;
    display: grid;
    grid-template-columns: 36px auto auto minmax(0, 1fr) 36px 40px 36px;
    grid-template-rows: 36px 24px;
    align-items: center;
    column-gap: 6px;
    row-gap: 6px;
    height: auto;
    min-height: 76px;
    padding: 8px;
    border-radius: 14px;
  }

  .jl-vm-video-inner button.jl-vm-vc-play,
  .jl-vm-video-inner button.jl-vm-vc-icon {
    width: 36px;
    height: 36px;
  }

  .jl-vm-video-inner .jl-vm-vc-time {
    grid-column: 2;
    grid-row: 1;
    width: auto;
    min-width: 34px;
    font-size: 11px;
    text-align: left;
  }

  .jl-vm-video-inner .jl-vm-vc-time-total {
    grid-column: 3;
    grid-row: 1;
    min-width: 0;
    color: rgba(255, 255, 255, 0.55);
  }

  .jl-vm-video-inner .jl-vm-vc-time-total::before {
    content: "/ ";
  }

  .jl-vm-video-inner .jl-vm-vc-progress {
    grid-column: 1 / -1;
    grid-row: 2;
    width: 100%;
    min-width: 0;
  }

  .jl-vm-video-inner button.jl-vm-vc-play {
    grid-column: 1;
    grid-row: 1;
  }

  .jl-vm-video-inner button.jl-vm-vc-mute {
    grid-column: 5;
    grid-row: 1;
  }

  .jl-vm-video-inner button.jl-vm-vc-rate {
    grid-column: 6;
    grid-row: 1;
    min-width: 40px;
    height: 30px;
    padding: 0 6px;
    font-size: 11px;
  }

  .jl-vm-video-inner button.jl-vm-vc-fullscreen {
    grid-column: 7;
    grid-row: 1;
  }

  .jl-vm-video-inner .jl-vm-vc-volume {
    display: none;
  }

  /* Widen the seek thumb for touch. */
  .jl-vm-video-inner .jl-vm-vc-progress::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
  }

  .jl-vm-video-inner .jl-vm-vc-progress::-moz-range-thumb {
    width: 16px;
    height: 16px;
  }
}

@container (max-width: 400px) {
  .jl-vm-video-inner .jl-vm-vc-bar {
    grid-template-columns: 36px auto auto minmax(0, 1fr) 36px 36px;
    column-gap: 5px;
    min-height: 74px;
    padding: 7px;
  }

  .jl-vm-video-inner button.jl-vm-vc-rate {
    display: none;
  }

  .jl-vm-video-inner button.jl-vm-vc-mute {
    grid-column: 5;
  }

  .jl-vm-video-inner button.jl-vm-vc-fullscreen {
    grid-column: 6;
  }
}

@media (max-width: 700px) {
  .jl-vm-video-inner .jl-vm-vc-bar {
    right: max(8px, env(safe-area-inset-right));
    bottom: max(8px, env(safe-area-inset-bottom));
    left: max(8px, env(safe-area-inset-left));
  }
}
`;
