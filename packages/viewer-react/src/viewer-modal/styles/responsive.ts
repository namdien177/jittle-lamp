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

  .jl-vm-page .jl-vm-modal {
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
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
  .jl-vm-left {
    border-right: 0;
    border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  }

  .jl-vm-tabs-row {
    align-items: stretch;
    flex-direction: column;
  }

  .jl-vm-row[data-kind="network"] {
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
