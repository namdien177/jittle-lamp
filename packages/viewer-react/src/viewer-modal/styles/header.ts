export const headerStyles = `
.jl-vm-header {
  position: relative;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  min-height: 44px;
  background: var(--jl-vm-bg, #0b0d0e);
}

.jl-vm-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.jl-vm-header-left > .jl-vm-btn-icon { flex: 0 0 auto; }

.jl-vm-heading {
  display: flex;
  flex-direction: row;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.jl-vm-title {
  margin: 0;
  color: inherit;
  font-size:calc(13px * var(--jl-font-scale, 1));
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: 0;
}

.jl-vm-title-meta {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size:calc(12px * var(--jl-font-scale, 1));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jl-vm-actions {
  position: relative;
  display: flex;
  gap: 6px;
  align-items: center;
  flex: 0 0 auto;
}

.jl-vm-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  appearance: none;
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: transparent;
  color: var(--jl-vm-text, #efefef);
  font-family: inherit;
  font-size:calc(12.5px * var(--jl-font-scale, 1));
  font-weight: 500;
  line-height: 1;
  height: 28px;
  padding: 0 10px;
  border-radius: 6px;
  box-sizing: border-box;
  cursor: pointer;
  white-space: nowrap;
  transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
}

.jl-vm-btn svg {
  flex: 0 0 auto;
}

.jl-vm-btn-label {
  display: inline-flex;
  align-items: center;
}

.jl-vm-btn:hover {
  background: var(--jl-vm-surface-2, #1f2324);
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
  background: color-mix(in srgb, var(--jl-vm-accent, #22c55e) 90%, black);
}

.jl-vm-btn-icon {
  width: 28px;
  height: 28px;
  padding: 0;
}

@media (max-width: 1199px) {
  .jl-vm-actions {
    gap: 6px;
    justify-content: flex-end;
  }

  /* Icon-only below 1200px: quiet like the "more" button next to them. */
  .jl-vm-actions .jl-vm-btn {
    width: 28px;
    height: 28px;
    padding: 0;
    gap: 0;
    border-color: transparent;
    background: transparent;
    color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  }

  .jl-vm-actions .jl-vm-btn:hover {
    background: var(--jl-vm-surface-2, #171a1b);
    color: var(--jl-vm-text, #efefef);
  }

  .jl-vm-actions .jl-vm-btn-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
}
`;
