import { videoJsOfficialStyles } from "./video-js-official";

export const videoStyles = `
${videoJsOfficialStyles}

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
}

.jl-vm-video-inner .video-js {
  width: 100%;
  height: 100%;
  font-family: inherit;
  background: #000;
  color: #fff;
}

.jl-vm-video-inner .video-js .vjs-tech {
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

/* Click-to-toggle surface sits over the video, beneath the controls. */
.jl-vm-vc-surface {
  position: absolute;
  inset: 0;
  z-index: 1;
  appearance: none;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.jl-vm-vc-bigplay {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 3;
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
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

.jl-vm-vc-bigplay:hover,
.jl-vm-vc-bigplay:focus-visible {
  background: rgba(0, 0, 0, 0.72);
  transform: translate(-50%, -50%) scale(1.05);
  outline: none;
}

.jl-vm-vc-bar {
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
  opacity: 1;
  transition: opacity 200ms ease, transform 200ms ease;
  --jl-vm-vc-fill: #ffffff;
}

.jl-vm-vc-bar[data-visible="false"] {
  pointer-events: none;
  opacity: 0;
  transform: translateY(10px);
}

.jl-vm-vc-play,
.jl-vm-vc-icon,
.jl-vm-vc-rate {
  appearance: none;
  border: 0;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  transition: background 150ms ease, color 150ms ease, transform 150ms ease;
}

.jl-vm-vc-play {
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  background: #fff;
  color: #0a0a0a;
}

.jl-vm-vc-play:hover,
.jl-vm-vc-play:focus-visible {
  transform: scale(1.06);
  outline: none;
}

.jl-vm-vc-icon {
  width: 34px;
  height: 34px;
  border-radius: 9999px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
}

.jl-vm-vc-icon:hover,
.jl-vm-vc-icon:focus-visible {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  outline: none;
}

.jl-vm-vc-rate {
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

.jl-vm-vc-rate:hover,
.jl-vm-vc-rate:focus-visible {
  background: rgba(255, 255, 255, 0.22);
  outline: none;
}

.jl-vm-vc-time {
  flex-shrink: 0;
  width: 42px;
  color: rgba(255, 255, 255, 0.78);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.jl-vm-vc-time-total {
  text-align: left;
}

.jl-vm-vc-range {
  -webkit-appearance: none;
  appearance: none;
  height: 4px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.24);
  cursor: pointer;
  outline: none;
}

.jl-vm-vc-progress {
  flex: 1;
  min-width: 80px;
}

.jl-vm-vc-volume {
  flex-shrink: 0;
  width: 72px;
}

.jl-vm-vc-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 13px;
  height: 13px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}

.jl-vm-vc-range::-moz-range-thumb {
  width: 13px;
  height: 13px;
  border: 0;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.45);
}

.jl-vm-vc-range::-moz-range-track {
  height: 4px;
  border-radius: 9999px;
  background: transparent;
}

@media (max-width: 700px) {
  .jl-vm-vc-bar {
    right: 8px;
    bottom: 8px;
    left: 8px;
    height: 46px;
    gap: 8px;
    padding: 0 10px;
    border-radius: 14px;
  }

  .jl-vm-vc-volume,
  .jl-vm-vc-rate,
  .jl-vm-vc-time-total {
    display: none;
  }
}
`;
