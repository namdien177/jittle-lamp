export const evidenceStyles = `
.jl-vm-evidence {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}

.jl-vm-tabs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border, #30363d);
}

.jl-vm-tabs {
  display: flex;
  gap: 4px;
}

.jl-vm-tab {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--text-muted, #8b949e);
  font-size: inherit;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.jl-vm-tab:hover {
  color: var(--text, #e6edf3);
  background: var(--surface-raised, #161b22);
}

.jl-vm-tab[data-active="true"] {
  background: rgba(255, 255, 255, 0.08);
  color: #f5f7fb;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.04);
}

.jl-vm-search {
  flex: 1;
  min-width: 120px;
  background: var(--surface-raised, #161b22);
  border: 1px solid var(--border, #30363d);
  color: var(--text, #e6edf3);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: inherit;
}

.jl-vm-filters {
  display: flex;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #30363d);
  flex-wrap: wrap;
}

.jl-vm-chip {
  appearance: none;
  border: 1px solid var(--border, #30363d);
  background: transparent;
  color: var(--text-muted, #8b949e);
  font-size: inherit;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}

.jl-vm-chip:hover {
  color: var(--text, #e6edf3);
}

.jl-vm-chip[data-active="true"] {
  border-color: rgba(255, 255, 255, 0.14);
  color: #f5f7fb;
  background: rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.jl-vm-list-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.jl-vm-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.jl-vm-row {
  display: grid;
  grid-template-columns: 76px 1fr auto;
  gap: 10px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-size: inherit;
  color: var(--text, #e6edf3);
  align-items: center;
  min-width: 0;
}

.jl-vm-row:hover {
  background: var(--surface-raised, #161b22);
  border-color: var(--border, #30363d);
}

.jl-vm-row[data-active="true"] {
  background: rgba(47, 129, 247, 0.16);
  border-color: rgba(47, 129, 247, 0.4);
}

.jl-vm-row[data-selected="true"] {
  background: rgba(47, 129, 247, 0.28);
}

.jl-vm-row-offset {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: inherit;
  color: var(--text-muted, #8b949e);
}

.jl-vm-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jl-vm-row-status {
  font-size: inherit;
  color: var(--text-muted, #8b949e);
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-row-status[data-tone="ok"] { color: #3fb950; }
.jl-vm-row-status[data-tone="err"] { color: #f85149; }

.jl-vm-empty {
  padding: 24px 16px;
  color: var(--text-muted, #8b949e);
  font-size: inherit;
  text-align: center;
}

.jl-vm-focus-btn {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: var(--accent, #2f81f7);
  color: #fff;
  border: 0;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: inherit;
  cursor: pointer;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
}
`;
