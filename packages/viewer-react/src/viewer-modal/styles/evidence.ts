export const evidenceStyles = `
.jl-vm-evidence {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: #0b0d0e;
}

.jl-vm-pane-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
}

.jl-vm-pane-heading > div {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.jl-vm-pane-heading strong {
  font-family: var(--font-display, system-ui, sans-serif);
  font-size: 18px;
  line-height: 1.2;
}

.jl-vm-pane-heading > span {
  flex: 0 0 auto;
  border-radius: 999px;
  border: 1px solid rgba(34, 197, 94, 0.22);
  background: rgba(34, 197, 94, 0.1);
  color: #b6f3cf;
  padding: 3px 8px;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
}

.jl-vm-eyebrow {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.jl-vm-tabs-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: color-mix(in srgb, var(--jl-vm-bg, #0b0d0e) 88%, transparent);
}

.jl-vm-tabs {
  display: flex;
  gap: 4px;
}

.jl-vm-tab {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-display, system-ui, sans-serif);
  font-size: 12px;
  font-weight: 600;
  padding: 7px 10px;
  border-radius: 8px;
  cursor: pointer;
  letter-spacing: 0;
}

.jl-vm-tab:hover {
  color: var(--jl-vm-text, #efefef);
  background: var(--jl-vm-surface-2, #171a1b);
}

.jl-vm-tab[data-active="true"] {
  background: var(--jl-vm-surface-3, #1f2324);
  color: var(--jl-vm-text, #efefef);
  box-shadow:
    inset 0 0 0 1px var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)),
    inset 3px 0 0 var(--jl-vm-accent, #22c55e);
}

.jl-vm-search {
  flex: 1;
  min-width: 120px;
  background: var(--jl-vm-surface, #111314);
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  color: var(--jl-vm-text, #efefef);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
}

.jl-vm-filters {
  display: flex;
  gap: 4px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  flex-wrap: wrap;
}

.jl-vm-chip {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 999px;
  cursor: pointer;
}

.jl-vm-chip:hover {
  color: var(--jl-vm-text, #efefef);
  background: var(--jl-vm-surface-2, #171a1b);
}

.jl-vm-chip[data-active="true"] {
  border-color: rgba(34, 197, 94, 0.3);
  color: #b6f3cf;
  background: rgba(34, 197, 94, 0.1);
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
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  scrollbar-width: thin;
  scrollbar-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)) transparent;
}

.jl-vm-row {
  display: grid;
  grid-template-columns: 58px 10px minmax(0, 1fr) auto;
  gap: 8px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom-color: rgba(239, 239, 239, 0.055);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
  color: var(--jl-vm-text, #efefef);
  align-items: center;
  min-width: 0;
  transition: background 120ms ease, border-color 120ms ease;
}

.jl-vm-row[data-kind="network"] {
  grid-template-columns: 52px 54px minmax(0, 1fr) 42px 52px;
}

.jl-vm-row:hover {
  background: var(--jl-vm-surface, #111314);
  border-color: var(--jl-vm-border, rgba(239, 239, 239, 0.1));
}

.jl-vm-row[data-active="true"] {
  background: rgba(34, 197, 94, 0.12);
  border-color: rgba(34, 197, 94, 0.32);
}

.jl-vm-row[data-selected="true"] {
  background: rgba(34, 197, 94, 0.2);
}

.jl-vm-row-offset {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-row-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #9fbbe0;
}

.jl-vm-row-dot[data-kind="error"] { background: var(--jl-vm-danger, #ef4444); }
.jl-vm-row-dot[data-kind="interaction"] { background: var(--jl-vm-accent, #22c55e); }
.jl-vm-row-dot[data-kind="lifecycle"] { background: #9fbbe0; }

.jl-vm-row-method {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-weight: 700;
  color: var(--jl-vm-soft, rgba(239, 239, 239, 0.68));
}

.jl-vm-row-method[data-method="GET"] { color: #22c55e; }
.jl-vm-row-method[data-method="POST"] { color: #7dd3fc; }
.jl-vm-row-method[data-method="PUT"],
.jl-vm-row-method[data-method="PATCH"] { color: #f59e0b; }
.jl-vm-row-method[data-method="DELETE"] { color: #ef4444; }

.jl-vm-row-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.jl-vm-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-row-sub,
.jl-vm-row-duration {
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: 11px;
}

.jl-vm-row-status {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-row-status[data-tone="ok"] { color: #22c55e; }
.jl-vm-row-status[data-tone="err"] { color: #ef4444; }

.jl-vm-empty {
  padding: 24px 16px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: inherit;
  text-align: center;
}

.jl-vm-focus-btn {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: var(--jl-vm-accent, #22c55e);
  color: var(--jl-vm-accent-on, #06120a);
  border: 0;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: inherit;
  cursor: pointer;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
}
`;
