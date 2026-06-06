export const VIEWER_MODAL_STYLE_ID = "jl-viewer-modal-styles";

export const viewerModalStyles = `
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

.jl-vm-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border, #30363d);
  min-height: 56px;
}

.jl-vm-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.jl-vm-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jl-vm-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.jl-vm-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(99, 110, 123, 0.18);
  color: var(--text-soft, #c9d1d9);
  border: 1px solid var(--border, #30363d);
}

.jl-vm-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.jl-vm-btn {
  appearance: none;
  border: 1px solid var(--border, #30363d);
  background: var(--surface-raised, #161b22);
  color: var(--text, #e6edf3);
  font-size: 12px;
  font-weight: 500;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

.jl-vm-btn:hover {
  background: rgba(99, 110, 123, 0.18);
}

.jl-vm-btn-primary {
  background: var(--accent, #2f81f7);
  color: #fff;
  border-color: transparent;
}

.jl-vm-btn-primary:hover {
  background: var(--accent-strong, #1f6feb);
}

.jl-vm-btn-icon {
  width: 28px;
  height: 28px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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

.jl-vm-video-wrap {
  position: relative;
  background: #000;
  flex: 2 1 0;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.jl-vm-video-inner {
  aspect-ratio: 4 / 3;
  max-width: 100%;
  max-height: 100%;
  display: block;
}

.jl-vm-video-inner video {
  width: 100%;
  height: 100%;
  display: block;
}

.jl-vm-notes {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px 14px;
  min-height: 0;
}

.jl-vm-notes-label {
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.jl-vm-notes-textarea {
  flex: 1;
  min-height: 60px;
  resize: none;
  background: var(--surface-raised, #161b22);
  color: var(--text, #e6edf3);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 12px;
}

.jl-vm-notes-notice {
  font-size: 11.5px;
  color: var(--warning, #f0883e);
  background: rgba(240, 136, 62, 0.12);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(240, 136, 62, 0.3);
}

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
  font-size: 11px;
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
  background: rgba(47, 129, 247, 0.18);
  color: var(--accent, #2f81f7);
}

.jl-vm-search {
  flex: 1;
  min-width: 120px;
  background: var(--surface-raised, #161b22);
  border: 1px solid var(--border, #30363d);
  color: var(--text, #e6edf3);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 12px;
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
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}

.jl-vm-chip:hover {
  color: var(--text, #e6edf3);
}

.jl-vm-chip[data-active="true"] {
  border-color: var(--accent, #2f81f7);
  color: var(--accent, #2f81f7);
  background: rgba(47, 129, 247, 0.12);
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
  grid-template-columns: 64px 1fr auto;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-size: 12px;
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
  font-size: 10.5px;
  color: var(--text-muted, #8b949e);
}

.jl-vm-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.jl-vm-row-status {
  font-size: 10.5px;
  color: var(--text-muted, #8b949e);
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-row-status[data-tone="ok"] { color: #3fb950; }
.jl-vm-row-status[data-tone="err"] { color: #f85149; }

.jl-vm-empty {
  padding: 24px 16px;
  color: var(--text-muted, #8b949e);
  font-size: 12px;
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
  font-size: 11px;
  cursor: pointer;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
}

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
  padding: 8px 14px;
  border-bottom: 1px solid var(--border, #30363d);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
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
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
}

.jl-vm-kv {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 8px;
  font-size: 12px;
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
  font-size: 12px;
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
  font-size: 11.5px;
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
  font-size: 11.5px;
  color: var(--text-muted, #8b949e);
}

.jl-vm-ctx-menu {
  position: fixed;
  z-index: 900;
  min-width: 160px;
  background: var(--surface-raised, #161b22);
  border: 1px solid var(--border-strong, #30363d);
  border-radius: 8px;
  padding: 4px;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}

.jl-vm-ctx-item {
  appearance: none;
  background: transparent;
  border: 0;
  text-align: left;
  color: var(--text, #e6edf3);
  font-size: 12px;
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
}

.jl-vm-ctx-item:hover {
  background: rgba(47, 129, 247, 0.18);
  color: var(--accent, #2f81f7);
}

.jl-vm-feedback {
  position: absolute;
  top: 64px;
  right: 16px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  background: var(--surface-raised, #161b22);
  border: 1px solid var(--border, #30363d);
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 10;
}

.jl-vm-feedback[data-tone="success"] { border-color: rgba(63, 185, 80, 0.5); color: #3fb950; }
.jl-vm-feedback[data-tone="error"] { border-color: rgba(248, 81, 73, 0.5); color: #f85149; }

.jl-vm-feedback-dismiss {
  appearance: none;
  background: transparent;
  border: 0;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
}

@media (max-width: 900px) {
  .jl-vm-overlay {
    padding: 0;
  }

  .jl-vm-overlay .jl-vm-modal {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }

  .jl-vm-page .jl-vm-modal {
    height: auto;
    min-height: calc(100vh - 56px);
  }

  .jl-vm-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .jl-vm-actions,
  .jl-vm-header-left {
    width: 100%;
    flex-wrap: wrap;
  }

  .jl-vm-body {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .jl-vm-left {
    border-right: 0;
    border-bottom: 1px solid var(--border, #30363d);
  }
}
`;
