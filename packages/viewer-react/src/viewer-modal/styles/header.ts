export const headerStyles = `
.jl-vm-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  min-height: 64px;
  background: color-mix(in srgb, var(--jl-vm-bg, #0b0d0e) 88%, transparent);
  backdrop-filter: blur(18px) saturate(160%);
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
  font-family: var(--font-display, system-ui, sans-serif);
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0;
}

.jl-vm-title-meta {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
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
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(34, 197, 94, 0.12);
  color: var(--jl-vm-accent-soft-text, #b6f3cf);
  border: 1px solid rgba(34, 197, 94, 0.22);
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
  border: 1px solid var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16));
  background: var(--jl-vm-surface-2, #171a1b);
  color: var(--jl-vm-text, #efefef);
  font-family: var(--font-display, system-ui, sans-serif);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
}

.jl-vm-btn:hover {
  background: var(--jl-vm-surface-3, #1f2324);
  border-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.24));
}

.jl-vm-btn:active {
  transform: scale(0.98);
}

.jl-vm-btn-primary {
  background: var(--jl-vm-accent, #22c55e);
  color: var(--jl-vm-accent-on, #06120a);
  border-color: transparent;
}

.jl-vm-btn-primary:hover {
  background: color-mix(in srgb, var(--jl-vm-accent, #22c55e) 88%, white);
}

.jl-vm-btn-icon {
  width: 28px;
  height: 28px;
  padding: 0;
}
`;
