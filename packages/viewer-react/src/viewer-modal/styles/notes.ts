export const notesStyles = `
.jl-vm-notes {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 16px 14px;
  min-height: 0;
}

.jl-vm-discussion {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px 16px;
  min-height: 0;
}

.jl-vm-notes-label {
  font-size: inherit;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.jl-vm-saving {
  color: var(--text-muted, #8b949e);
  font-size: inherit;
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
  border: 1px solid var(--border, #30363d);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-raised, #161b22) 72%, transparent);
  padding: 10px 12px;
}

.jl-vm-comment-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-muted, #8b949e);
  font-size: inherit;
  margin-bottom: 6px;
}

.jl-vm-comment-meta span {
  color: var(--text-soft, #c9d1d9);
  font-weight: 600;
}

.jl-vm-comment p {
  margin: 0;
  color: var(--text, #e6edf3);
  font-size: inherit;
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
  background: var(--surface-raised, #161b22);
  color: var(--text, #e6edf3);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 16px;
  line-height: 1.45;
}

.jl-vm-notes-notice {
  font-size: inherit;
  color: var(--warning, #f0883e);
  background: rgba(240, 136, 62, 0.12);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid rgba(240, 136, 62, 0.3);
}
`;
