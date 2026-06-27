export const notesStyles = `
.jl-vm-tagbar {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 46px;
  padding: 8px 16px;
  border-top: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: color-mix(in srgb, var(--jl-vm-bg, #0b0d0e) 92%, transparent);
}

.jl-vm-tagbar-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 8px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-tagbar-list {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}

.jl-vm-tagbar-empty {
  font-size: 12px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-tag-pill {
  display: inline-flex;
  max-width: 140px;
  align-items: center;
  border: 1px solid;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jl-vm-tag-picker {
  position: relative;
  flex: 0 0 auto;
}

.jl-vm-tag-add {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid rgba(34, 197, 94, 0.28);
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.1);
  color: var(--jl-vm-accent-soft-text, #b6f3cf);
  padding: 5px 9px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.jl-vm-tag-add:hover {
  border-color: rgba(34, 197, 94, 0.48);
  background: rgba(34, 197, 94, 0.16);
}

.jl-vm-tag-add:disabled {
  cursor: wait;
  opacity: 0.6;
}

.jl-vm-tag-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 80;
  width: min(280px, calc(100vw - 32px));
  border: 1px solid var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16));
  border-radius: 8px;
  background: var(--jl-vm-surface, #111314);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.34);
  overflow: hidden;
}

.jl-vm-tag-search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-tag-search input {
  min-width: 0;
  flex: 1;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--jl-vm-text, #efefef);
  font-size: 13px;
}

.jl-vm-tag-options {
  max-height: 220px;
  overflow-y: auto;
  padding: 5px;
}

.jl-vm-tag-option {
  appearance: none;
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  padding: 7px;
  color: var(--jl-vm-text, #efefef);
  cursor: pointer;
}

.jl-vm-tag-option:hover,
.jl-vm-tag-option[data-selected="true"] {
  background: var(--jl-vm-surface-2, #171a1b);
}

.jl-vm-tag-check {
  display: inline-flex;
  width: 16px;
  height: 16px;
  align-items: center;
  justify-content: center;
  color: var(--jl-vm-accent, #22c55e);
}

.jl-vm-tag-no-results {
  padding: 10px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: 12px;
}

.jl-vm-notes {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px 14px;
  min-height: 0;
  background: var(--jl-vm-bg, #0b0d0e);
}

.jl-vm-discussion {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 16px;
  min-height: 0;
  border-top: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: #0b0d0e;
}

.jl-vm-notes-label {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.jl-vm-saving {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}

.jl-vm-comments {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 2px;
}

.jl-vm-comment {
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 8px;
  background: var(--jl-vm-surface, #111314);
  padding: 10px 12px;
}

.jl-vm-comment-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: 12px;
  margin-bottom: 6px;
}

.jl-vm-comment-meta span {
  color: var(--jl-vm-accent-soft-text, #b6f3cf);
  font-weight: 600;
}

.jl-vm-comment p {
  margin: 0;
  color: var(--jl-vm-text, #efefef);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.jl-vm-composer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  align-items: end;
}

.jl-vm-composer .jl-vm-notes-textarea {
  min-height: 76px;
}

.jl-vm-notes-textarea {
  flex: 1;
  min-height: 60px;
  resize: none;
  background: var(--jl-vm-surface, #111314);
  color: var(--jl-vm-text, #efefef);
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.45;
}

.jl-vm-notes-notice {
  font-size: 12px;
  color: var(--jl-vm-warn, #f59e0b);
  background: rgba(240, 136, 62, 0.12);
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid rgba(240, 136, 62, 0.3);
}
`;
