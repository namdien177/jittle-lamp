export const contextMenuStyles = `
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
  font-size: inherit;
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
}

.jl-vm-ctx-item:hover {
  background: rgba(47, 129, 247, 0.18);
  color: var(--accent, #2f81f7);
}
`;
