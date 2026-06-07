import { videoJsOfficialStyles } from "./video-js-official";

export const videoStyles = `
${videoJsOfficialStyles}

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

.jl-vm-video-inner .video-js {
  width: 100%;
  height: 100%;
  font-family: inherit;
}

.jl-vm-video-inner .video-js .vjs-tech {
  object-fit: contain;
}
`;
