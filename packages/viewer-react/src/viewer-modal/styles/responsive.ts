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

  .jl-vm-modal,
  .jl-vm-root {
    max-width: 100vw;
    overflow-x: hidden;
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
    width: 100%;
    min-width: 0;
    padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
    min-height: 0;
    box-sizing: border-box;
  }

  .jl-vm-root .jl-vm-header {
    padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
  }

  .jl-vm-header-left {
    width: 100%;
    min-width: 0;
  }

  .jl-vm-actions {
    width: 100%;
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .jl-vm-actions .jl-vm-btn {
    width: 44px;
    height: 44px;
    min-width: 44px;
  }

  /* Narrow viewers scroll vertically; the evidence list keeps its own scroll. */
  .jl-vm-body {
    flex-direction: column;
    overflow: hidden auto;
    overscroll-behavior-y: contain;
    -webkit-overflow-scrolling: touch;
  }

  .jl-vm-left {
    flex: 0 0 auto;
    width: 100%;
    max-width: 100%;
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

  .jl-vm-composer .jl-vm-btn {
    min-width: 52px;
    min-height: 44px;
  }

  .jl-vm-right {
    flex: 0 0 auto;
    width: 100%;
    max-width: 100%;
    min-height: 0;
  }

  .jl-vm-right[data-collapsed="true"] {
    flex-basis: 44px;
    width: 100%;
  }

  .jl-vm-list {
    max-height: 62vh;
    max-height: 62svh;
    overflow-x: hidden;
    overscroll-behavior: contain;
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
    font-size:calc(11px * var(--jl-font-scale, 1));
  }

  .jl-vm-tabs-row {
    align-items: center;
    flex-direction: row;
  }

  .jl-vm-row {
    min-width: 0;
  }

  .jl-vm-row[data-kind="network"] {
    min-width: 0;
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

  .jl-vm-drawer {
    position: fixed;
    right: 0;
    bottom: 0;
    left: 0;
    width: 100%;
    max-height: min(74vh, 640px);
    max-height: min(74dvh, 640px);
    padding-bottom: env(safe-area-inset-bottom);
    border-radius: 18px 18px 0 0;
    box-sizing: border-box;
    z-index: 120;
  }

  .jl-vm-drawer-header {
    flex: 0 0 auto;
    min-height: 60px;
    padding: 8px 12px;
    background: var(--jl-vm-bg, #0b0d0e);
  }

  .jl-vm-drawer-actions .jl-vm-btn {
    min-height: 44px;
  }

  .jl-vm-drawer-actions .jl-vm-btn-icon {
    width: 44px;
    height: 44px;
  }

  .jl-vm-drawer-body {
    overscroll-behavior: contain;
  }
}

@media (max-width: 600px) {
  .jl-vm-tabs-row {
    align-items: stretch;
    flex-direction: column;
    overflow: visible;
  }

  .jl-vm-tabs {
    --jl-vm-tab-size: 44px;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }

  .jl-vm-tabs::-webkit-scrollbar {
    display: none;
  }

  .jl-vm-tab {
    min-height: 44px;
  }

  .jl-vm-search {
    flex: 0 0 auto;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    box-sizing: border-box;
  }

  .jl-vm-chip {
    min-height: 36px;
  }

  .jl-vm-icon-btn {
    width: 44px;
    height: 44px;
  }

  .jl-vm-pane-count {
    min-height: 36px;
  }
}
`;

// Use the available viewer dimensions, including portrait desktop windows.
export const stackedViewerStyles = `
.jl-vm-modal, .jl-vm-root { container: jl-viewer / size; }
@container jl-viewer (max-width: 900px) or (max-aspect-ratio: 1/1) {
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-body { display: flex; flex-direction: column; overflow: hidden auto; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-left { flex: 0 0 auto; width: 100%; min-width: 0; border-right: 0; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-left .jl-vm-video-wrap { flex: none; width: 100%; height: min(56.25cqw, 46cqh); min-height: 150px; max-height: none; aspect-ratio: auto; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-right { flex: 1 0 280px; width: 100%; max-width: 100%; min-height: 280px; border-top: 1px solid var(--jl-vm-border); }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-right[data-collapsed="true"] { flex: 0 0 44px; width: 100%; min-height: 44px; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-supplemental { flex: 0 0 auto; width: 100%; max-height: 240px; border-right: 0; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-supplemental .jl-vm-secondary { max-height: none; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-right .jl-vm-list { max-height: none; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-stream-resizer { display: none; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-stream-rail { grid-template-columns: auto 1fr; grid-template-rows: 1fr; width: 100%; height: 44px; padding: 0 12px; border-left: 0; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-stream-rail span { writing-mode: horizontal-tb; }
  :is(.jl-vm-root, .jl-vm-modal) .jl-vm-stream-rail svg, .jl-vm-tabs > .jl-vm-icon-btn svg { transform: rotate(90deg); }
}
`;
