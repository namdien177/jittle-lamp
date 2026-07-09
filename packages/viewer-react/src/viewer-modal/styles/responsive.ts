export const responsiveStyles = `
@media (max-width: 900px) {
  .jl-vm-overlay {
    padding: 0;
  }

  .jl-vm-overlay .jl-vm-modal {
    width: 100vw;
    height: 100vh;
    border-radius: 0;
  }

  .jl-vm-root {
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
    flex-direction: column;
  }

  .jl-vm-left {
    border-right: 0;
    border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
    min-width: 0;
  }

  .jl-vm-right {
    flex: 1 1 50%;
    width: 100%;
  }

  .jl-vm-right[data-collapsed="true"] {
    flex-basis: 44px;
    width: 100%;
  }

  .jl-vm-stream-resizer {
    display: none;
  }

  .jl-vm-stream-rail {
    grid-template-columns: auto 1fr;
    grid-template-rows: 1fr;
    width: 100%;
    height: 44px;
    padding: 0 12px;
    border-top: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
    border-left: 0;
  }

  .jl-vm-stream-rail span {
    writing-mode: horizontal-tb;
  }

  .jl-vm-pane-heading-actions {
    align-self: center;
  }

  .jl-vm-pane-count {
    min-width: 28px;
    padding: 3px 7px;
    font-size: 0;
  }

  .jl-vm-pane-count::before {
    content: attr(data-count);
    font-size: 11px;
  }

  .jl-vm-tabs-row {
    align-items: center;
    flex-direction: row;
  }

  .jl-vm-row {
    min-width: 360px;
  }

  .jl-vm-row[data-kind="network"] {
    min-width: 520px;
    grid-template-columns: 46px 48px minmax(0, 1fr) 38px;
  }

  .jl-vm-row[data-kind="network"] .jl-vm-row-duration {
    display: none;
  }

  .jl-vm-video-controls {
    padding: 0 8px 6px;
  }

  .jl-vm-video-control {
    width: 34px;
    height: 34px;
  }

  .jl-vm-video-volume:hover .jl-vm-video-volume-slider,
  .jl-vm-video-volume:focus-within .jl-vm-video-volume-slider {
    width: 52px;
  }

  .jl-vm-video-time {
    padding: 0 6px;
    font-size: inherit;
  }

  .jl-vm-video-time-sep,
  .jl-vm-video-time-total {
    display: none;
  }
}
`;
