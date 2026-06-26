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

.jl-vm-video-inner .video-js.vjs-user-inactive.vjs-playing {
  cursor: none;
}

.jl-vm-video-inner .video-js .vjs-control-bar {
  right: 16px;
  bottom: 16px;
  left: 16px;
  display: flex;
  align-items: center;
  width: auto;
  height: 56px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.32);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  opacity: 1;
  transition:
    opacity 180ms ease,
    transform 180ms ease;
}

.jl-vm-video-inner .video-js.vjs-user-inactive.vjs-playing .vjs-control-bar {
  pointer-events: none;
  opacity: 0;
  transform: translateY(8px);
}

.jl-vm-video-inner .video-js .vjs-control {
  width: 36px;
  height: 36px;
}

.jl-vm-video-inner .video-js .vjs-button {
  border-radius: 9999px;
  transition:
    background 160ms ease,
    color 160ms ease,
    transform 160ms ease;
}

.jl-vm-video-inner .video-js .vjs-button:hover,
.jl-vm-video-inner .video-js .vjs-button:focus-visible {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.jl-vm-video-inner .video-js .vjs-play-control {
  margin-right: 8px;
  background: #fff;
  color: #050505;
}

.jl-vm-video-inner .video-js .vjs-play-control:hover,
.jl-vm-video-inner .video-js .vjs-play-control:focus-visible {
  background: #fff;
  color: #050505;
  transform: scale(1.05);
}

.jl-vm-video-inner .video-js .vjs-button > .vjs-icon-placeholder::before {
  line-height: 36px;
}

.jl-vm-video-inner .video-js .vjs-time-control {
  display: flex;
  align-items: center;
  width: 44px;
  min-width: 44px;
  padding: 0 4px;
  color: rgba(255, 255, 255, 0.76);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 12px;
  line-height: 1;
}

.jl-vm-video-inner .video-js .vjs-current-time {
  justify-content: flex-end;
}

.jl-vm-video-inner .video-js .vjs-duration {
  justify-content: flex-start;
}

.jl-vm-video-inner .video-js .vjs-progress-control {
  min-width: 80px;
  height: 36px;
  padding: 0 8px;
}

.jl-vm-video-inner .video-js .vjs-progress-holder,
.jl-vm-video-inner .video-js .vjs-volume-bar {
  height: 4px;
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.25);
}

.jl-vm-video-inner .video-js .vjs-load-progress,
.jl-vm-video-inner .video-js .vjs-load-progress div {
  border-radius: inherit;
  background: rgba(255, 255, 255, 0.18);
}

.jl-vm-video-inner .video-js .vjs-play-progress,
.jl-vm-video-inner .video-js .vjs-volume-level {
  border-radius: inherit;
  background: linear-gradient(90deg, #fff, var(--jl-vm-accent, #22c55e));
}

.jl-vm-video-inner .video-js .vjs-play-progress::before,
.jl-vm-video-inner .video-js .vjs-volume-level::before {
  display: none;
}

.jl-vm-video-inner .video-js .vjs-volume-panel {
  width: 44px;
  transition: width 160ms ease;
}

.jl-vm-video-inner .video-js .vjs-volume-panel:hover,
.jl-vm-video-inner .video-js .vjs-volume-panel:focus-within,
.jl-vm-video-inner .video-js .vjs-volume-panel.vjs-hover {
  width: 112px;
}

.jl-vm-video-inner .video-js .vjs-volume-horizontal {
  width: 62px;
}

.jl-vm-video-inner .video-js .vjs-volume-bar {
  width: 56px;
  margin: 16px 8px;
}

.jl-vm-video-inner .video-js .vjs-playback-rate {
  color: rgba(255, 255, 255, 0.82);
}

.jl-vm-video-inner .video-js .vjs-playback-rate .vjs-playback-rate-value {
  font-size: 12px;
  font-weight: 700;
  line-height: 36px;
}

.jl-vm-video-inner .video-js .vjs-big-play-button {
  top: 50%;
  left: 50%;
  width: 64px;
  height: 64px;
  border: 0;
  border-radius: 9999px;
  background: rgba(0, 0, 0, 0.58);
  color: #fff;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  transform: translate(-50%, -50%);
  transition:
    background 160ms ease,
    transform 160ms ease;
}

.jl-vm-video-inner .video-js:hover .vjs-big-play-button,
.jl-vm-video-inner .video-js .vjs-big-play-button:focus {
  background: rgba(0, 0, 0, 0.72);
  transform: translate(-50%, -50%) scale(1.05);
}

.jl-vm-video-inner .video-js .vjs-big-play-button .vjs-icon-placeholder::before {
  line-height: 64px;
}

@media (max-width: 700px) {
  .jl-vm-video-inner .video-js .vjs-control-bar {
    right: 8px;
    bottom: 8px;
    left: 8px;
    height: 48px;
    padding: 8px;
    border-radius: 14px;
  }

  .jl-vm-video-inner .video-js .vjs-control {
    width: 32px;
    height: 32px;
  }

  .jl-vm-video-inner .video-js .vjs-button > .vjs-icon-placeholder::before {
    line-height: 32px;
  }

  .jl-vm-video-inner .video-js .vjs-time-control,
  .jl-vm-video-inner .video-js .vjs-volume-panel,
  .jl-vm-video-inner .video-js .vjs-playback-rate {
    display: none;
  }
}
`;
