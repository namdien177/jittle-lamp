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
  right: 12px;
  bottom: 12px;
  left: 12px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(10, 10, 12, 0.62);
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
  /* Sans digits sit on the optical centre; monospace glyphs ride high with line-height 1. */
  font-family: inherit;
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-weight: 600;
  font-variant-numeric: tabular-nums;
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
  font-family: inherit;
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  text-align: right;
}

.jl-vm-video-inner .jl-vm-vc-time-total {
  text-align: left;
}

.jl-vm-video-inner .jl-vm-vc-range {
  -webkit-appearance: none;
  appearance: none;
  height: 20px;
  border-radius: 9999px;
  background-color: transparent;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 4px;
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
    grid-template-columns: 44px auto auto minmax(0, 1fr) 44px 44px 44px;
    grid-template-rows: 24px 44px;
    align-items: center;
    column-gap: 6px;
    row-gap: 4px;
    height: auto;
    min-height: 82px;
    padding: 6px 8px 8px;
    border-radius: 14px;
    background: rgba(0, 0, 0, 0.68);
  }

  .jl-vm-video-inner button.jl-vm-vc-play,
  .jl-vm-video-inner button.jl-vm-vc-icon {
    width: 44px;
    height: 44px;
  }

  .jl-vm-video-inner .jl-vm-vc-time {
    grid-column: 2;
    grid-row: 2;
    width: auto;
    min-width: 34px;
    font-size:calc(11px * var(--jl-font-scale, 1));
    text-align: left;
  }

  .jl-vm-video-inner .jl-vm-vc-time-total {
    grid-column: 3;
    grid-row: 2;
    min-width: 0;
    color: rgba(255, 255, 255, 0.55);
  }

  .jl-vm-video-inner .jl-vm-vc-time-total::before {
    content: "/ ";
  }

  .jl-vm-video-inner .jl-vm-vc-progress {
    grid-column: 1 / -1;
    grid-row: 1;
    width: 100%;
    min-width: 0;
    height: 24px;
  }

  .jl-vm-video-inner button.jl-vm-vc-play {
    grid-column: 1;
    grid-row: 2;
  }

  .jl-vm-video-inner button.jl-vm-vc-mute {
    grid-column: 5;
    grid-row: 2;
  }

  .jl-vm-video-inner button.jl-vm-vc-rate {
    grid-column: 6;
    grid-row: 2;
    min-width: 44px;
    height: 44px;
    padding: 0 6px;
    font-size:calc(11px * var(--jl-font-scale, 1));
  }

  .jl-vm-video-inner button.jl-vm-vc-fullscreen {
    grid-column: 7;
    grid-row: 2;
  }

  .jl-vm-video-inner .jl-vm-vc-volume {
    display: none;
  }

  .jl-vm-video-inner .jl-vm-vc-step-caption {
    grid-column: 4;
    grid-row: 2;
  }

  .jl-vm-video-inner button.jl-vm-vc-step-prev,
  .jl-vm-video-inner button.jl-vm-vc-step-next,
  .jl-vm-video-inner button.jl-vm-vc-skip {
    display: none;
  }

  /* Widen the seek thumb for touch. */
  .jl-vm-video-inner .jl-vm-seek-input::-webkit-slider-thumb {
    width: 16px;
    height: 16px;
  }

  .jl-vm-video-inner .jl-vm-seek-input::-moz-range-thumb {
    width: 16px;
    height: 16px;
  }
}

@container (max-width: 360px) {
  .jl-vm-video-inner .jl-vm-vc-bar {
    grid-template-columns: 44px auto auto minmax(0, 1fr) 44px 44px;
    column-gap: 5px;
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

.jl-vm-video-inner button.jl-vm-vc-skip[data-active="true"] {
  color: var(--jl-vm-accent, #22c55e);
}

.jl-vm-video-inner button.jl-vm-vc-step-prev:active:not(:disabled),
.jl-vm-video-inner button.jl-vm-vc-step-next:active:not(:disabled) {
  transform: scale(0.94);
}

@media (prefers-reduced-motion: reduce) {
  .jl-vm-video-inner .jl-vm-seek-track { transition: none; }
}

.jl-vm-video-inner button.jl-vm-vc-icon:disabled {
  opacity: 0.35;
  cursor: default;
  background: transparent;
}

/* Seek bar: the range input sits on top of a drawn track. With test-run steps the track is one
   segment per step, coloured by result; the played part is drawn at full strength. */
.jl-vm-video-inner .jl-vm-seek {
  position: relative;
  display: flex;
  align-items: center;
  height: 20px;
  --jl-vm-seek-h: 4px;
  --jl-vm-seek-passed: #22c55e;
  --jl-vm-seek-failed: #ef4444;
  --jl-vm-seek-blocked: #f59e0b;
  --jl-vm-seek-running: #60a5fa;
}

.jl-vm-video-inner .jl-vm-seek[data-steps="true"] {
  --jl-vm-seek-h: 6px;
}

/* Thicker track under a precise pointer; scaled, not resized, so hovering never re-lays out. */
@media (hover: hover) and (pointer: fine) {
  .jl-vm-video-inner .jl-vm-seek:hover .jl-vm-seek-track {
    transform: translateY(-50%) scaleY(1.5);
  }
}

.jl-vm-video-inner .jl-vm-seek-track {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: var(--jl-vm-seek-h);
  transform: translateY(-50%);
  pointer-events: none;
  transition: transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
}

.jl-vm-video-inner .jl-vm-seek-layer {
  position: absolute;
  inset: 0;
}

.jl-vm-video-inner .jl-vm-seek-layer[data-layer="played"] {
  clip-path: inset(0 calc(100% - var(--jl-vm-seek-progress, 0%)) 0 0);
}

.jl-vm-video-inner .jl-vm-seek-base {
  position: absolute;
  inset: 0;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.2);
}

.jl-vm-video-inner .jl-vm-seek-layer[data-layer="played"] .jl-vm-seek-base {
  background: rgba(255, 255, 255, 0.85);
}

.jl-vm-video-inner .jl-vm-seek[data-steps="true"] .jl-vm-seek-layer[data-layer="played"] .jl-vm-seek-base {
  background: rgba(255, 255, 255, 0.45);
}

.jl-vm-video-inner .jl-vm-seek-seg {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 3px;
  border-radius: 2px;
  /* 1px of the base track shows between neighbouring steps. */
  box-shadow: 1px 0 0 0 rgba(0, 0, 0, 0.9), -1px 0 0 0 rgba(0, 0, 0, 0.9);
  background: rgba(255, 255, 255, 0.55);
  opacity: 0.42;
}

.jl-vm-video-inner .jl-vm-seek-seg[data-status="passed"] { background: var(--jl-vm-seek-passed); }
.jl-vm-video-inner .jl-vm-seek-seg[data-status="failed"] { background: var(--jl-vm-seek-failed); opacity: 0.75; }
.jl-vm-video-inner .jl-vm-seek-seg[data-status="blocked"] { background: var(--jl-vm-seek-blocked); opacity: 0.7; }
.jl-vm-video-inner .jl-vm-seek-seg[data-status="running"] { background: var(--jl-vm-seek-running); }

.jl-vm-video-inner .jl-vm-seek-layer[data-layer="played"] .jl-vm-seek-seg {
  opacity: 1;
}

.jl-vm-video-inner .jl-vm-seek-seg[data-active="true"] {
  opacity: 1;
  outline: 2px solid #fff;
  outline-offset: 1px;
}

.jl-vm-video-inner .jl-vm-seek-input {
  position: relative;
  z-index: 1;
  width: 100%;
  margin: 0;
  background: transparent;
}

.jl-vm-video-inner .jl-vm-seek-input::-webkit-slider-runnable-track {
  background: transparent;
}

.jl-vm-video-inner .jl-vm-seek-tip {
  position: absolute;
  bottom: calc(100% + 8px);
  z-index: 2;
  display: grid;
  gap: 2px;
  max-width: 280px;
  padding: 6px 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  background: rgba(12, 12, 14, 0.94);
  color: #fff;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
  font-size: calc(12px * var(--jl-font-scale, 1));
  line-height: 1.35;
  pointer-events: none;
  transform: translateX(-50%);
  white-space: nowrap;
}

.jl-vm-video-inner .jl-vm-seek-tip[data-edge="start"] { transform: translateX(-12px); }
.jl-vm-video-inner .jl-vm-seek-tip[data-edge="end"] { transform: translateX(calc(-100% + 12px)); }

.jl-vm-video-inner .jl-vm-seek-tip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  color: rgba(255, 255, 255, 0.7);
  font-size: calc(11px * var(--jl-font-scale, 1));
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.jl-vm-video-inner .jl-vm-seek-tip-time {
  margin-left: auto;
  padding-left: 10px;
  color: rgba(255, 255, 255, 0.85);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}

.jl-vm-video-inner .jl-vm-seek-tip > .jl-vm-seek-tip-time {
  margin: 0;
  padding: 0;
}

.jl-vm-video-inner .jl-vm-seek-tip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  min-width: 160px;
}

.jl-vm-video-inner .jl-vm-seek-tip-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 9999px;
  background: #9ca3af;
}

.jl-vm-video-inner .jl-vm-seek-tip-dot[data-status="passed"] { background: var(--jl-vm-seek-passed, #22c55e); }
.jl-vm-video-inner .jl-vm-seek-tip-dot[data-status="failed"] { background: var(--jl-vm-seek-failed, #ef4444); }
.jl-vm-video-inner .jl-vm-seek-tip-dot[data-status="blocked"] { background: var(--jl-vm-seek-blocked, #f59e0b); }
.jl-vm-video-inner .jl-vm-seek-tip-dot[data-status="running"] { background: var(--jl-vm-seek-running, #60a5fa); }

/* "Step 3" for the playhead; only the docked bar shows it. */
.jl-vm-video-inner .jl-vm-vc-step-caption {
  display: none;
  align-items: center;
  gap: 7px;
  min-width: 0;
  color: rgba(255, 255, 255, 0.85);
  font-size: calc(12.5px * var(--jl-font-scale, 1));
}

.jl-vm-video-inner .jl-vm-vc-step-index {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

/* Docked bar (web workspace): the controls sit under the recording instead of over it, so no
   part of the page under review is covered, and the seek bar spans the full width above them. */
[data-compact="true"] .jl-vm-video-inner {
  display: flex;
  flex-direction: column;
}

[data-compact="true"] .jl-vm-video-inner .jl-vm-video-host {
  position: relative;
  inset: auto;
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}

[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar,
[data-compact="true"] .jl-vm-video-inner[data-fullscreen="true"] .jl-vm-vc-bar {
  position: relative;
  inset: auto;
  display: grid;
  grid-template-columns: auto auto auto auto auto minmax(0, 1fr) auto auto auto auto auto;
  grid-template-rows: 18px 36px;
  align-items: center;
  column-gap: 4px;
  row-gap: 2px;
  height: auto;
  padding: 4px 10px 6px;
  border: 0;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 0;
  background: #101114;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar[data-visible="false"] {
  pointer-events: auto;
  opacity: 1;
  transform: none;
}

[data-compact="true"] .jl-vm-video-inner[data-playing="true"][data-controls="hidden"] {
  cursor: auto;
}

[data-compact="true"] .jl-vm-video-inner button.jl-vm-vc-surface {
  bottom: 60px;
}

[data-compact="true"] .jl-vm-video-inner button.jl-vm-vc-bigplay {
  top: calc(50% - 30px);
}

[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > * { grid-row: 2; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-progress { grid-column: 1 / -1; grid-row: 1; min-width: 0; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-play { grid-column: 1; width: 30px; height: 30px; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-step-prev { grid-column: 2; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-step-next { grid-column: 3; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-time { grid-column: 4; width: auto; padding-left: 6px; font-size: calc(12.5px * var(--jl-font-scale, 1)); color: #fff; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-time-total { grid-column: 5; padding-left: 0; color: rgba(255, 255, 255, 0.5); }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-time-total::before { padding: 0 4px; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-time-total::before { content: "/"; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-step-caption { grid-column: 6; display: flex; padding: 0 10px; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-mute { grid-column: 7; }
/* Recordings carry no sound worth adjusting; mute stays, the slider goes. */
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-volume { display: none; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-skip { grid-column: 9; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-rate { grid-column: 10; height: 24px; min-width: 34px; padding: 0 7px; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-fullscreen { grid-column: 11; }
[data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar button.jl-vm-vc-icon { width: 30px; height: 30px; }

@container (max-width: 560px) {
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar {
    grid-template-columns: auto auto auto minmax(0, 1fr) auto auto auto;
  }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-play { grid-column: 1; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-time { grid-column: 2; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-time-total { grid-column: 3; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-step-caption { grid-column: 4; padding: 0 6px; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-mute { grid-column: 5; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-rate { grid-column: 6; min-width: 36px; height: 26px; }
  [data-compact="true"] .jl-vm-video-inner .jl-vm-vc-bar > .jl-vm-vc-fullscreen { grid-column: 7; }
}
`;
