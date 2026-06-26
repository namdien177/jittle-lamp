import { videoJsOfficialStyles } from "./video-js-official";

export const videoStyles = `
${videoJsOfficialStyles}

.jl-vm-video-wrap {
  position: relative;
  background:
    linear-gradient(135deg, rgba(34, 197, 94, 0.08), transparent 34%),
    #020304;
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

.jl-vm-video-inner .video-js {
  width: 100%;
  height: 100%;
  font-family: inherit;
  background: #020304;
}

.jl-vm-video-inner .video-js .vjs-tech {
  object-fit: contain;
}

.jl-vm-video-inner .video-js .vjs-control-bar {
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.82));
  color: #efefef;
}

.jl-vm-video-inner .video-js .vjs-play-progress,
.jl-vm-video-inner .video-js .vjs-volume-level {
  background: var(--jl-vm-accent, #22c55e);
}
`;
