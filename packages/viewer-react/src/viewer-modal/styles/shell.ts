export const shellStyles = `
.jl-vm-overlay {
  position: fixed;
  inset: 0;
  background:
    radial-gradient(circle at 18% 0%, rgba(34, 197, 94, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(4, 7, 6, 0.84), rgba(4, 5, 5, 0.94));
  backdrop-filter: blur(14px) saturate(150%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 800;
  padding: 5vh 5vw;
}

.jl-vm-modal,
.jl-vm-root {
  position: relative;
  display: grid;
  grid-template-rows: auto 1fr;
  width: min(90vw, 1600px);
  height: 90vh;
  background: #0b0d0e;
  color: #efefef;
  font-size: 16px;
  border: 1px solid rgba(239, 239, 239, 0.12);
  border-radius: 8px;
  overflow: hidden;
  box-shadow:
    0 30px 90px rgba(0, 0, 0, 0.56),
    0 0 0 1px rgba(34, 197, 94, 0.08) inset;
  --jl-vm-bg: #0b0d0e;
  --jl-vm-surface: #111314;
  --jl-vm-surface-2: #171a1b;
  --jl-vm-surface-3: #1f2324;
  --jl-vm-text: #efefef;
  --jl-vm-soft: rgba(239, 239, 239, 0.68);
  --jl-vm-muted: rgba(239, 239, 239, 0.46);
  --jl-vm-border: rgba(239, 239, 239, 0.1);
  --jl-vm-border-strong: rgba(239, 239, 239, 0.16);
  --jl-vm-accent: #22c55e;
  --jl-vm-accent-on: #06120a;
  --jl-vm-warn: #f59e0b;
  --jl-vm-danger: #ef4444;
}

.jl-vm-root {
  width: 100%;
  height: 100%;
  min-height: 720px;
  border: 0;
  border-radius: 0;
  background: #08090a;
  box-shadow: none;
}

.jl-vm-root .jl-vm-header {
  padding: 14px 24px;
  background: color-mix(in srgb, var(--jl-vm-bg, #0b0d0e) 86%, transparent);
}

.jl-vm-root .jl-vm-title {
  font-size: 16px;
}

.jl-vm-root .jl-vm-body {
  grid-template-columns: minmax(420px, 1.35fr) minmax(360px, 600px);
}

.jl-vm-root .jl-vm-video-wrap {
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
  border-right: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  min-width: 0;
  min-height: 0;
  background: #090a0a;
}

.jl-vm-right {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
}
`;
