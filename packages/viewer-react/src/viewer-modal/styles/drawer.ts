export const drawerStyles = `
.jl-vm-drawer {
  position: relative;
  background: var(--jl-vm-bg, #0b0d0e);
  border-top: 1px solid var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16));
  max-height: 70%;
  display: flex;
  flex-direction: column;
  box-shadow:
    0 -18px 42px rgba(0, 0, 0, 0.42),
    0 -1px 0 rgba(34, 197, 94, 0.18);
  z-index: 5;
}

.jl-vm-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jl-vm-soft, rgba(239, 239, 239, 0.68));
  font-weight: 600;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-drawer-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.jl-vm-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)) transparent;
}

.jl-vm-drawer-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.jl-vm-drawer-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-weight: 600;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  font-size: 12px;
  align-items: baseline;
}

.jl-vm-kv-key {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-kv-val {
  text-align: left;
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--jl-vm-text, #efefef);
  padding: 0;
  cursor: pointer;
  word-break: break-all;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: inherit;
}

.jl-vm-kv-val:hover {
  color: var(--jl-vm-accent, #22c55e);
}

.jl-vm-kv-val[data-tone="ok"] { color: #22c55e; }
.jl-vm-kv-val[data-tone="err"] { color: #ef4444; }

.jl-vm-pre {
  background: var(--jl-vm-surface, #111314);
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 8px;
  padding: 8px 10px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 320px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  cursor: pointer;
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-pre:hover {
  border-color: rgba(34, 197, 94, 0.38);
}

.jl-vm-pre-compact {
  max-height: 120px;
}

.jl-vm-empty-line {
  font-size: 12px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-cookie {
  display: grid;
  width: 100%;
  gap: 4px;
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 8px;
  background: var(--jl-vm-surface, #111314);
  padding: 8px 10px;
  text-align: left;
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-cookie:hover {
  border-color: rgba(34, 197, 94, 0.38);
}

.jl-vm-cookie-main {
  display: grid;
  grid-template-columns: minmax(80px, 0.4fr) minmax(0, 1fr);
  gap: 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
}

.jl-vm-cookie-main strong,
.jl-vm-cookie-main span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.jl-vm-cookie-main strong {
  color: var(--jl-vm-accent-soft-text, #b6f3cf);
}

.jl-vm-cookie-meta,
.jl-vm-cookie-blocked {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-cookie-blocked {
  color: var(--jl-vm-danger, #ef4444);
}
`;
