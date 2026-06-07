export const feedbackStyles = `
.jl-vm-feedback {
  position: absolute;
  top: 64px;
  right: 16px;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: inherit;
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
  font-size: inherit;
}
`;
