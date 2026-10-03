// The single tooltip rendered by ViewerTooltipLayer (tooltip-layer.tsx).
export const tooltipStyles = `
.jl-vm-tip {
  position: absolute;
  z-index: 95;
  max-width: min(280px, 80%);
  padding: 4px 8px;
  border: 1px solid var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16));
  border-radius: 6px;
  background: var(--jl-vm-bg, #0f1012);
  color: var(--jl-vm-text, #eeeff1);
  box-shadow: 0 8px 24px -6px rgba(0, 0, 0, 0.3);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  overflow-wrap: anywhere;
  pointer-events: none;
  opacity: 0;
  transform: scale(0.97);
  transition: opacity 100ms ease, transform 100ms ease;
}

.jl-vm-tip[data-visible="true"] {
  opacity: 1;
  transform: none;
}

.jl-vm-tip[data-visible="false"] {
  visibility: hidden;
  transition: none;
}

@media (prefers-reduced-motion: reduce) {
  .jl-vm-tip { transition: none; }
}
`;
