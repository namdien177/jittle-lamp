export const headerStyles = `
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

.jl-vm-heading {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.jl-vm-title {
  font-size: 16px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jl-vm-title-meta {
  color: var(--text-muted, #8b949e);
  font-size: inherit;
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
  font-size: inherit;
  padding: 3px 8px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  appearance: none;
  border: 1px solid var(--border, #30363d);
  background: var(--surface-raised, #161b22);
  color: var(--text, #e6edf3);
  font-size: inherit;
  font-weight: 500;
  line-height: 1;
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
}
`;
