export const drawerStyles = `
.jl-vm-drawer {
  position: relative;
  background: var(--surface, #0d1117);
  border-top: 1px solid var(--border-strong, #30363d);
  max-height: 70%;
  display: flex;
  flex-direction: column;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
  z-index: 5;
}

.jl-vm-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #30363d);
  font-size: inherit;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
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
}

.jl-vm-drawer-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.jl-vm-drawer-label {
  font-size: inherit;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
}

.jl-vm-kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  font-size: inherit;
  align-items: baseline;
}

.jl-vm-kv-key {
  color: var(--text-muted, #8b949e);
}

.jl-vm-kv-val {
  text-align: left;
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--text, #e6edf3);
  padding: 0;
  cursor: pointer;
  word-break: break-all;
  font-family: inherit;
  font-size: inherit;
}

.jl-vm-kv-val:hover {
  color: var(--accent, #2f81f7);
}

.jl-vm-kv-val[data-tone="ok"] { color: #3fb950; }
.jl-vm-kv-val[data-tone="err"] { color: #f85149; }

.jl-vm-pre {
  background: var(--surface-raised, #161b22);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  max-height: 320px;
  overflow-y: auto;
  cursor: pointer;
  color: var(--text, #e6edf3);
}

.jl-vm-pre:hover {
  border-color: var(--accent, #2f81f7);
}

.jl-vm-empty-line {
  font-size: inherit;
  color: var(--text-muted, #8b949e);
}
`;
