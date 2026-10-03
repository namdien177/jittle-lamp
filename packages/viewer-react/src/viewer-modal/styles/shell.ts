export const shellStyles = `
.jl-vm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
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
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto 1fr;
  min-width: 0;
  width: min(90vw, 1600px);
  height: 90vh;
  background: var(--jl-vm-bg);
  color: var(--jl-vm-text);
  font-family: var(--font-sans, "Inter", system-ui, -apple-system, "Segoe UI", sans-serif);
  font-size: 13px;
  border: 1px solid var(--jl-vm-border-strong);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);

  /* Dark theme (default): neutral greys, green only as the accent. Hosts may override the
     --jl-vm-* tokens to match their own theme. */
  --jl-vm-bg: #0f1012;
  --jl-vm-bg-deep: #0b0c0e;
  --jl-vm-surface: #16171a;
  --jl-vm-surface-2: #1c1d21;
  --jl-vm-surface-3: #26272c;
  --jl-vm-text: #eeeff1;
  --jl-vm-soft: #b4b7be;
  --jl-vm-muted: #8b8f98;
  --jl-vm-border: #24252a;
  --jl-vm-border-strong: #303137;
  --jl-vm-tab-active: #2a2b31;
  --jl-vm-video-bg: #050506;
  --jl-vm-accent: #22c55e;
  --jl-vm-accent-on: #06120a;
  --jl-vm-accent-soft-text: #b6f3cf;
  --jl-vm-warn: #f59e0b;
  --jl-vm-danger: #ef4444;
}

.jl-vm-modal[data-jl-theme="light"],
.jl-vm-root[data-jl-theme="light"] {
  --jl-vm-bg: #ffffff;
  --jl-vm-bg-deep: #f6f6f8;
  --jl-vm-surface: #f6f6f8;
  --jl-vm-surface-2: #efeff2;
  --jl-vm-surface-3: #e6e6ea;
  --jl-vm-text: #1c1d21;
  --jl-vm-soft: #4b4e55;
  --jl-vm-muted: #6b6f78;
  --jl-vm-border: #e7e7ea;
  --jl-vm-border-strong: #d6d6db;
  --jl-vm-tab-active: #ffffff;
  --jl-vm-video-bg: #ececef;
  --jl-vm-accent: #178a42;
  --jl-vm-accent-on: #ffffff;
  --jl-vm-accent-soft-text: #15803d;
  --jl-vm-warn: #b45309;
  --jl-vm-danger: #dc2626;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.16);
}

.jl-vm-root {
  width: 100%;
  height: 100%;
  min-height: 720px;
  border: 0;
  border-radius: 0;
  background: var(--jl-vm-bg-deep);
  box-shadow: none;
}

.jl-vm-root .jl-vm-header {
  padding: 0 12px;
  background: var(--jl-vm-bg);
}

.jl-vm-root .jl-vm-body {
  --jl-vm-stream-width: 560px;
}

.jl-vm-root .jl-vm-video-wrap {
  background: var(--jl-vm-video-bg);
}

.jl-vm-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: minmax(0, 1fr) auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  box-sizing: border-box;
}

.jl-vm-left {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  min-width: min(420px, 100%);
  min-height: 0;
  background: var(--jl-vm-bg-deep);
}

.jl-vm-supplemental {
  grid-column: 1;
  grid-row: 2;
  min-height: 0;
  max-height: 34vh;
  overflow: auto;
  background: var(--jl-vm-bg-deep);
  border-right: 1px solid var(--jl-vm-border);
}

.jl-vm-right {
  grid-column: 2;
  grid-row: 1 / 3;
  flex: 0 0 min(var(--jl-vm-stream-width, 560px), 50vw);
  width: min(var(--jl-vm-stream-width, 560px), 50vw);
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  position: relative;
}

.jl-vm-right[data-collapsed="true"] {
  flex-basis: 48px;
  width: 48px;
}
`;
