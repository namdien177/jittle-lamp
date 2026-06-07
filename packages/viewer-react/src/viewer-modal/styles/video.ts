export const videoStyles = `
	.jl-vm-video-wrap {
	  position: relative;
	  background: #000;
	  flex: 2 1 0;
	  min-height: 0;
	  display: flex;
	  align-items: stretch;
	  justify-content: stretch;
	  overflow: hidden;
	  isolation: isolate;
	}

	.jl-vm-video-inner {
	  position: relative;
	  width: 100%;
	  height: 100%;
	  min-height: 0;
	}

	.jl-vm-video-inner .video-js,
	.jl-vm-video-inner .video-js .vjs-tech {
	  width: 100%;
	  height: 100%;
	  background: #000;
	  color: #fff;
	  font-family: inherit;
	}

	.jl-vm-video-inner .video-js {
	  position: absolute;
	  inset: 0;
	  overflow: hidden;
	}

	.jl-vm-video-inner .vjs-hidden,
	.jl-vm-video-inner .vjs-control-text {
	  position: absolute;
	  width: 1px;
	  height: 1px;
	  margin: -1px;
	  padding: 0;
	  overflow: hidden;
	  clip: rect(0 0 0 0);
	  white-space: nowrap;
	  border: 0;
	}

	.jl-vm-video-inner .vjs-loading-spinner {
	  position: absolute;
	  inset: 50% auto auto 50%;
	  width: 54px;
	  height: 54px;
	  margin: -27px 0 0 -27px;
	  border-radius: 999px;
	  border: 3px solid rgba(255, 255, 255, 0.18);
	  border-top-color: var(--jl-vm-accent, #22c55e);
	  opacity: 0;
	  pointer-events: none;
	  animation: jl-vjs-spin 900ms linear infinite;
	}

	.jl-vm-video-inner .vjs-waiting .vjs-loading-spinner,
	.jl-vm-video-inner .vjs-seeking .vjs-loading-spinner {
	  opacity: 1;
	}

	@keyframes jl-vjs-spin {
	  to {
	    transform: rotate(360deg);
	  }
	}

	.jl-vm-video-inner .vjs-big-play-button {
	  appearance: none;
	  position: absolute;
	  inset: 50% auto auto 50%;
	  transform: translate(-50%, -50%);
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
	  backdrop-filter: blur(12px) saturate(140%);
	  box-shadow: 0 14px 44px rgba(0, 0, 0, 0.46);
	  transition: transform 180ms ease, background 180ms ease, opacity 180ms ease;
	}

	.jl-vm-video-inner .vjs-has-started .vjs-big-play-button {
	  opacity: 0;
	  pointer-events: none;
	}

	.jl-vm-video-inner .vjs-big-play-button:hover,
	.jl-vm-video-inner .vjs-big-play-button:focus-visible {
	  transform: translate(-50%, -50%) scale(1.06);
	  background: rgba(15, 18, 22, 0.72);
	  outline: 2px solid var(--jl-vm-accent, #22c55e);
	  outline-offset: 3px;
	}

	.jl-vm-video-inner .vjs-big-play-button .vjs-icon-placeholder::before,
	.jl-vm-video-inner .vjs-play-control .vjs-icon-placeholder::before,
	.jl-vm-video-inner .vjs-mute-control .vjs-icon-placeholder::before,
	.jl-vm-video-inner .vjs-fullscreen-control .vjs-icon-placeholder::before {
	  display: block;
	  font-size: 0;
	  line-height: 1;
	}

	.jl-vm-video-inner .vjs-big-play-button .vjs-icon-placeholder::before {
	  content: "";
	  width: 0;
	  height: 0;
	  margin-left: 6px;
	  border-top: 15px solid transparent;
	  border-bottom: 15px solid transparent;
	  border-left: 23px solid currentColor;
	}

	.jl-vm-video-inner .vjs-control-bar {
	  --jl-vm-accent: #22c55e;
	  position: absolute;
	  left: 10px;
	  right: 10px;
	  bottom: 10px;
	  z-index: 2;
	  min-height: 52px;
	  display: flex;
	  align-items: center;
	  gap: 4px;
	  padding: 6px 8px;
	  border-radius: 12px;
	  color: #fff;
	  background: rgba(13, 16, 20, 0.66);
	  border: 1px solid rgba(255, 255, 255, 0.13);
	  backdrop-filter: blur(16px) saturate(145%);
	  box-shadow: 0 18px 46px rgba(0, 0, 0, 0.42);
	  opacity: 0;
	  transform: translateY(8px);
	  transition: opacity 180ms ease, transform 180ms ease;
	}

	.jl-vm-video-inner .vjs-has-started.vjs-user-active .vjs-control-bar,
	.jl-vm-video-inner .vjs-paused .vjs-control-bar,
	.jl-vm-video-inner .vjs-user-inactive:focus-within .vjs-control-bar {
	  opacity: 1;
	  transform: none;
	}

	.jl-vm-video-inner .vjs-control {
	  appearance: none;
	  border: 0;
	  background: transparent;
	  color: inherit;
	  min-width: 36px;
	  height: 36px;
	  border-radius: 9px;
	  display: inline-flex;
	  align-items: center;
	  justify-content: center;
	  cursor: pointer;
	  opacity: 0.92;
	}

	.jl-vm-video-inner .vjs-control:hover,
	.jl-vm-video-inner .vjs-control:focus-visible {
	  background: rgba(255, 255, 255, 0.16);
	  opacity: 1;
	  outline: none;
	}

	.jl-vm-video-inner .vjs-play-control .vjs-icon-placeholder::before {
	  content: "";
	  width: 0;
	  height: 0;
	  border-top: 7px solid transparent;
	  border-bottom: 7px solid transparent;
	  border-left: 11px solid currentColor;
	}

	.jl-vm-video-inner .vjs-playing .vjs-play-control .vjs-icon-placeholder::before {
	  content: "II";
	  font-size: 17px;
	  font-weight: 700;
	  letter-spacing: 0;
	}

	.jl-vm-video-inner .vjs-mute-control .vjs-icon-placeholder::before {
	  content: "Vol";
	  font-size: 12px;
	  font-weight: 700;
	}

	.jl-vm-video-inner .vjs-vol-0 .vjs-mute-control .vjs-icon-placeholder::before,
	.jl-vm-video-inner .vjs-muted .vjs-mute-control .vjs-icon-placeholder::before {
	  content: "Mute";
	}

	.jl-vm-video-inner .vjs-fullscreen-control .vjs-icon-placeholder::before {
	  content: "[]";
	  font-size: 15px;
	  font-weight: 700;
	}

	.jl-vm-video-inner .vjs-time-control {
	  width: auto;
	  min-width: 0;
	  padding: 0 2px;
	  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
	  font-variant-numeric: tabular-nums;
	  font-size: 13px;
	  white-space: nowrap;
	  cursor: default;
	}

	.jl-vm-video-inner .vjs-time-divider {
	  min-width: 8px;
	  opacity: 0.55;
	}

	.jl-vm-video-inner .vjs-progress-control {
	  flex: 1 1 auto;
	  min-width: 80px;
	  height: 36px;
	  padding: 0 8px;
	}

	.jl-vm-video-inner .vjs-progress-holder {
	  position: relative;
	  width: 100%;
	  height: 6px;
	  border-radius: 999px;
	  background: rgba(255, 255, 255, 0.2);
	  overflow: hidden;
	}

	.jl-vm-video-inner .vjs-load-progress,
	.jl-vm-video-inner .vjs-play-progress {
	  position: absolute;
	  inset: 0 auto 0 0;
	  border-radius: inherit;
	}

	.jl-vm-video-inner .vjs-load-progress {
	  background: rgba(255, 255, 255, 0.32);
	}

	.jl-vm-video-inner .vjs-play-progress {
	  background: var(--jl-vm-accent, #22c55e);
	}

	.jl-vm-video-inner .vjs-play-progress::before {
	  content: "";
	  position: absolute;
	  top: 50%;
	  right: -6px;
	  width: 12px;
	  height: 12px;
	  border-radius: 999px;
	  background: var(--jl-vm-accent, #22c55e);
	  transform: translateY(-50%) scale(0);
	  transition: transform 120ms ease;
	}

	.jl-vm-video-inner .vjs-progress-control:hover .vjs-play-progress::before,
	.jl-vm-video-inner .vjs-progress-control:focus-within .vjs-play-progress::before {
	  transform: translateY(-50%) scale(1);
	}

	.jl-vm-video-inner .vjs-volume-panel {
	  display: flex;
	  align-items: center;
	}

	.jl-vm-video-inner .vjs-volume-control {
	  width: 72px;
	  min-width: 72px;
	  padding: 0 8px;
	}

	.jl-vm-video-inner .vjs-volume-bar {
	  position: relative;
	  width: 100%;
	  height: 5px;
	  border-radius: 999px;
	  background: rgba(255, 255, 255, 0.24);
	  overflow: hidden;
	}

	.jl-vm-video-inner .vjs-volume-level {
	  position: absolute;
	  inset: 0 auto 0 0;
	  border-radius: inherit;
	  background: rgba(255, 255, 255, 0.86);
	}

	.jl-vm-video-inner .vjs-playback-rate {
	  position: relative;
	}

	.jl-vm-video-inner .vjs-playback-rate .vjs-playback-rate-value {
	  font-size: 13px;
	  font-weight: 700;
	}

	.jl-vm-video-inner .vjs-menu {
	  position: absolute;
	  right: 0;
	  bottom: 44px;
	  min-width: 118px;
	  padding: 6px;
	  border-radius: 10px;
	  background: rgba(8, 10, 13, 0.94);
	  border: 1px solid rgba(255, 255, 255, 0.14);
	  backdrop-filter: blur(16px);
	  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.4);
	}

	.jl-vm-video-inner .vjs-menu-content {
	  list-style: none;
	  margin: 0;
	  padding: 0;
	}

	.jl-vm-video-inner .vjs-menu-item {
	  border-radius: 8px;
	  padding: 7px 9px;
	  color: #fff;
	  cursor: pointer;
	}

	.jl-vm-video-inner .vjs-menu-item:hover,
	.jl-vm-video-inner .vjs-menu-item:focus-visible,
	.jl-vm-video-inner .vjs-selected {
	  background: rgba(255, 255, 255, 0.14);
	}

	.jl-vm-video-inner .vjs-error-display {
	  position: absolute;
	  inset: 0;
	  display: none;
	  align-items: center;
	  justify-content: center;
	  padding: 24px;
	  color: #fff;
	  background: rgba(0, 0, 0, 0.72);
	  text-align: center;
	}

	.jl-vm-video-inner .vjs-error .vjs-error-display {
	  display: flex;
	}
`;
