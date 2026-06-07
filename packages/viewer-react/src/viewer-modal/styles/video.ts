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
  aspect-ratio: 4 / 3;
  max-width: 100%;
  max-height: 100%;
  display: block;
}

.jl-vm-video-inner video {
  width: 100%;
  height: 100%;
  display: block;
  background: #000;
  cursor: pointer;
}

.jl-vm-video-stage-button {
  appearance: none;
  position: absolute;
  inset: 50% auto auto 50%;
  transform: translate(-50%, -50%) scale(0.86);
  width: 78px;
  height: 78px;
  border-radius: 999px;
  border: 0;
  background: rgba(15, 18, 22, 0.55);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  z-index: 3;
  transition: opacity 180ms ease, transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), background 180ms ease;
  backdrop-filter: blur(12px) saturate(140%);
  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.46);
}

.jl-vm-video-stage-button[data-paused="true"] {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, -50%) scale(1);
}

.jl-vm-video-stage-button:hover {
  transform: translate(-50%, -50%) scale(1.06);
  background: rgba(15, 18, 22, 0.72);
}

.jl-vm-video-stage-button:focus-visible {
  opacity: 1;
  pointer-events: auto;
  outline: 2px solid var(--jl-vm-accent, #22c55e);
  outline-offset: 3px;
}

.jl-vm-video-scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 46%;
  z-index: 1;
  pointer-events: none;
  background: linear-gradient(
    to top,
    rgba(0, 0, 0, 0.82) 0%,
    rgba(0, 0, 0, 0.46) 36%,
    rgba(0, 0, 0, 0) 100%
  );
  opacity: 0;
  transition: opacity 220ms ease;
}

.jl-vm-video-wrap[data-controls="visible"] .jl-vm-video-scrim {
  opacity: 1;
}

.jl-vm-video-wrap[data-controls="hidden"] {
  cursor: none;
}

.jl-vm-video-wrap:focus-visible {
  outline: none;
}

.jl-vm-video-controls {
  --jl-vm-accent: #22c55e;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 10px 6px;
  color: #fff;
  opacity: 0;
  transform: translateY(10px);
  pointer-events: none;
  transition: opacity 200ms ease, transform 200ms ease;
}

.jl-vm-video-wrap[data-controls="visible"] .jl-vm-video-controls {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.jl-vm-video-scrub-region {
  position: relative;
  height: 20px;
  margin: 0 6px;
  display: flex;
  align-items: center;
}

.jl-vm-video-scrub-tip {
  position: absolute;
  bottom: 24px;
  transform: translateX(-50%);
  padding: 3px 8px;
  border-radius: 7px;
  background: rgba(8, 10, 13, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-variant-numeric: tabular-nums;
  font-size: inherit;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
}

.jl-vm-video-scrub {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  min-width: 0;
  height: 20px;
  background: transparent;
  cursor: pointer;
  margin: 0;
}

.jl-vm-video-scrub::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--jl-vm-accent, #22c55e) 0%,
    var(--jl-vm-accent, #22c55e) var(--jl-vm-video-progress, 0%),
    rgba(255, 255, 255, 0.42) var(--jl-vm-video-progress, 0%),
    rgba(255, 255, 255, 0.42) var(--jl-vm-video-buffered, 0%),
    rgba(255, 255, 255, 0.22) var(--jl-vm-video-buffered, 0%),
    rgba(255, 255, 255, 0.22) 100%
  );
  transition: height 120ms ease;
}

.jl-vm-video-scrub-region:hover .jl-vm-video-scrub::-webkit-slider-runnable-track {
  height: 6px;
}

.jl-vm-video-scrub::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border-radius: 999px;
  background: var(--jl-vm-accent, #22c55e);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25), 0 2px 6px rgba(0, 0, 0, 0.4);
  transform: scale(0);
  transition: transform 130ms ease, margin-top 120ms ease;
}

.jl-vm-video-scrub-region:hover .jl-vm-video-scrub::-webkit-slider-thumb,
.jl-vm-video-scrub:focus-visible::-webkit-slider-thumb {
  transform: scale(1);
  margin-top: -4px;
}

.jl-vm-video-scrub::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.22);
}

.jl-vm-video-scrub::-moz-range-progress {
  height: 4px;
  border-radius: 999px;
  background: var(--jl-vm-accent, #22c55e);
}

.jl-vm-video-scrub::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 999px;
  background: var(--jl-vm-accent, #22c55e);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  transform: scale(0);
  transition: transform 130ms ease;
}

.jl-vm-video-scrub-region:hover .jl-vm-video-scrub::-moz-range-thumb,
.jl-vm-video-scrub:focus-visible::-moz-range-thumb {
  transform: scale(1);
}

.jl-vm-video-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 2px 0;
}

.jl-vm-video-group {
  display: flex;
  align-items: center;
  gap: 2px;
}

.jl-vm-video-control {
  appearance: none;
  border: 0;
  background: transparent;
  color: #fff;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0.9;
  transition: background 140ms ease, opacity 140ms ease, transform 120ms ease;
}

.jl-vm-video-control:hover {
  background: rgba(255, 255, 255, 0.16);
  opacity: 1;
}

.jl-vm-video-control:active {
  transform: scale(0.9);
}

.jl-vm-video-control:focus-visible {
  outline: 2px solid var(--jl-vm-accent, #22c55e);
  outline-offset: 1px;
  opacity: 1;
}

.jl-vm-video-play {
  width: 42px;
}

.jl-vm-video-volume {
  display: flex;
  align-items: center;
}

.jl-vm-video-volume-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 0;
  height: 30px;
  opacity: 0;
  background: transparent;
  cursor: pointer;
  margin: 0;
  transition: width 200ms ease, opacity 180ms ease, margin 200ms ease;
}

.jl-vm-video-volume:hover .jl-vm-video-volume-slider,
.jl-vm-video-volume:focus-within .jl-vm-video-volume-slider {
  width: 74px;
  opacity: 1;
  margin: 0 8px 0 2px;
}

.jl-vm-video-volume-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    #fff 0%,
    #fff var(--jl-vm-video-volume, 100%),
    rgba(255, 255, 255, 0.28) var(--jl-vm-video-volume, 100%),
    rgba(255, 255, 255, 0.28) 100%
  );
}

.jl-vm-video-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  margin-top: -4px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}

.jl-vm-video-volume-slider::-moz-range-track {
  height: 4px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.28);
}

.jl-vm-video-volume-slider::-moz-range-progress {
  height: 4px;
  border-radius: 999px;
  background: #fff;
}

.jl-vm-video-volume-slider::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border: 0;
  border-radius: 999px;
  background: #fff;
}

.jl-vm-video-time {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-variant-numeric: tabular-nums;
  font-size: inherit;
  color: rgba(255, 255, 255, 0.94);
  white-space: nowrap;
}

.jl-vm-video-time-sep {
  color: rgba(255, 255, 255, 0.42);
}

.jl-vm-video-time-total {
  color: rgba(255, 255, 255, 0.62);
}

.jl-vm-video-recovering {
  font-size: inherit;
  color: rgba(255, 255, 255, 0.86);
  background: rgba(255, 255, 255, 0.14);
  border-radius: 999px;
  padding: 4px 11px;
  white-space: nowrap;
}

.jl-vm-video-speed {
  position: relative;
  display: inline-flex;
}

.jl-vm-video-speed-btn {
  width: auto;
  min-width: 42px;
  padding: 0 9px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-variant-numeric: tabular-nums;
  font-size: inherit;
  font-weight: 600;
}

.jl-vm-video-speed-menu {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  min-width: 132px;
  padding: 6px;
  border-radius: 12px;
  background: rgba(20, 24, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(20px) saturate(135%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 4;
}

.jl-vm-video-speed-menu button {
  appearance: none;
  border: 0;
  background: transparent;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  font-size: inherit;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}

.jl-vm-video-speed-menu button:hover {
  background: rgba(255, 255, 255, 0.12);
}

.jl-vm-video-speed-menu button[data-active="true"] {
  color: var(--jl-vm-accent, #22c55e);
  font-weight: 600;
}
`;
