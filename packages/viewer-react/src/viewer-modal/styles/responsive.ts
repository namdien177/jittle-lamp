export const responsiveStyles = `
@media (max-width: 900px) {
  .jl-vm-overlay {
    padding: 0;
  }

  .jl-vm-overlay .jl-vm-modal {
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    border-radius: 0;
    border: 0;
  }

  .jl-vm-root {
    height: auto;
    min-height: calc(100vh - 56px);
    min-height: calc(100dvh - 56px);
  }

  .jl-vm-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
    padding: 10px 14px;
    min-height: 0;
  }

  .jl-vm-root .jl-vm-header {
    padding: 10px 14px;
  }

  .jl-vm-actions,
  .jl-vm-header-left {
    width: 100%;
    flex-wrap: wrap;
  }

  /* The whole viewer becomes one scrollable column: video first, then tags,
     discussion, and the evidence stream. Nothing overlaps; the stream keeps
     its own internal scroll so the tabs stay reachable. */
  .jl-vm-body {
    flex-direction: column;
    overflow: hidden auto;
    -webkit-overflow-scrolling: touch;
  }

  .jl-vm-left {
    flex: 0 0 auto;
    border-right: 0;
    border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
    min-width: 0;
    min-height: 0;
  }

  .jl-vm-video-wrap {
    flex: 0 0 auto;
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 46vh;
    max-height: 46svh;
  }

  .jl-vm-discussion,
  .jl-vm-notes {
    flex: 0 0 auto;
    max-height: 280px;
  }

  .jl-vm-right {
    flex: 0 0 auto;
    width: 100%;
    min-height: 0;
  }

  .jl-vm-right[data-collapsed="true"] {
    flex-basis: 44px;
    width: 100%;
  }

  .jl-vm-list {
    max-height: 62vh;
    max-height: 62svh;
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
    min-width: 320px;
  }

  .jl-vm-row[data-kind="network"] {
    min-width: 480px;
    grid-template-columns: 46px 48px minmax(0, 1fr) 38px;
  }

  .jl-vm-row[data-kind="network"] .jl-vm-row-duration {
    display: none;
  }

  .jl-vm-feedback {
    top: auto;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    left: 12px;
    justify-content: space-between;
  }
}
`;
