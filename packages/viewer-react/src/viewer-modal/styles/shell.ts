export const shellStyles = `
.jl-vm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(2, 4, 8, 0.72);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 800;
  padding: 5vh 5vw;
}

.jl-vm-modal {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  width: min(90vw, 1600px);
  height: 90vh;
  background: var(--surface, #0d1117);
  color: var(--text, #e6edf3);
  font-size: 16px;
  border: 1px solid var(--border-strong, #30363d);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
}

.jl-vm-page {
  min-height: calc(100vh - 56px);
  background: var(--background, #08090a);
  color: var(--text, #e6edf3);
}

.jl-vm-page .jl-vm-modal {
  width: 100%;
  height: calc(100vh - 56px);
  min-height: 720px;
  border: 0;
  border-radius: 0;
  background: var(--background, #08090a);
  box-shadow: none;
}

.jl-vm-page .jl-vm-header {
  padding: 14px 24px;
  background: color-mix(in srgb, var(--surface, #0d1117) 82%, transparent);
}

.jl-vm-page .jl-vm-title {
  font-size: 16px;
}

.jl-vm-page .jl-vm-body {
  grid-template-columns: minmax(420px, 1.35fr) minmax(360px, 0.9fr);
}

.jl-vm-page .jl-vm-video-wrap {
  background: #020304;
}

.jl-vm-body {
  display: grid;
  grid-template-columns: 3fr minmax(0, 600px);
  min-height: 0;
  overflow: hidden;
}

.jl-vm-left {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border, #30363d);
  min-width: 0;
  min-height: 0;
}

.jl-vm-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
}
`;
