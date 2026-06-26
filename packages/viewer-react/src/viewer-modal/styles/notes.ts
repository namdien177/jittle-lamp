export const notesStyles = `
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
