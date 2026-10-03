// Compact mode (the web workspace): the viewer sits inside the app's content panel, so it keeps
// the host's --jl-vm-* tokens and uses the app's density: a 44px header bar, 28px controls and
// fixed-height rows (evidenceRowHeight in row-window.ts).
export const compactStyles = `
[data-compact="true"].jl-vm-root, [data-compact="true"].jl-vm-modal {
  min-height: 0; height: 100dvh; font-size: 13px; line-height: 1.45;
}
[data-compact="true"] .jl-vm-header { min-height: 44px; padding: 0 10px 0 8px; gap: 8px; background: var(--jl-vm-bg); }
[data-compact="true"] .jl-vm-heading { gap: 8px; }
[data-compact="true"] .jl-vm-title { font: inherit; font-size: 13px; font-weight: 600; }
[data-compact="true"] .jl-vm-title-meta { font: inherit; font-size: 12px; color: var(--jl-vm-muted); }
[data-compact="true"] .jl-vm-actions { gap: 4px; flex-wrap: nowrap; }
[data-compact="true"] .jl-vm-btn { height: 28px; min-height: 28px; padding: 0 10px; font: inherit; font-size: 12.5px; font-weight: 500; border-radius: 6px; box-shadow: none; }
[data-compact="true"] .jl-vm-header-left > .jl-vm-btn-icon { width: 28px; padding: 0; border-color: transparent; color: var(--jl-vm-muted); }
[data-compact="true"] .jl-vm-header-left > .jl-vm-btn-icon:hover { color: var(--jl-vm-text); background: var(--jl-vm-surface-2); }
[data-compact="true"] .jl-vm-btn-primary { background: var(--jl-vm-accent); color: var(--jl-vm-accent-on); border-color: transparent; }
.jl-vm-more { position: relative; flex-shrink: 0; }
.jl-vm-more summary { list-style: none; display: grid; place-items: center; width: 28px; height: 28px; cursor: pointer; border-radius: 6px; color: var(--jl-vm-muted); }
.jl-vm-more summary::-webkit-details-marker { display: none; }
.jl-vm-more summary:hover, .jl-vm-more[open] summary { background: var(--jl-vm-surface-2); color: var(--jl-vm-text); }
.jl-vm-more-menu { position: absolute; right: 0; top: 34px; z-index: 70; width: 200px; display: grid; gap: 1px; padding: 4px; border: 1px solid var(--jl-vm-border); border-radius: 8px; background: var(--jl-vm-bg); box-shadow: 0 16px 40px -8px rgba(0, 0, 0, 0.3); }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn { width: 100%; justify-content: flex-start; border-color: transparent; background: transparent; color: var(--jl-vm-text); }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn:hover { background: var(--jl-vm-surface-2); }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn svg { color: var(--jl-vm-muted); }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn-label { display: inline; position: static; clip: auto; clip-path: none; width: auto; height: auto; overflow: visible; }
[data-compact="true"] .jl-vm-left { min-width: 0; }
[data-compact="true"] .jl-vm-video-wrap { flex: 1 1 auto; }
[data-compact="true"] .jl-vm-secondary { flex: 0 0 auto; max-height: none; overflow: auto; border-top: 1px solid var(--jl-vm-border); background: var(--jl-vm-bg); }
.jl-vm-secondary > summary { display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px; color: var(--jl-vm-soft); font-size: 12.5px; font-weight: 500; cursor: pointer; }
.jl-vm-secondary > summary:hover { color: var(--jl-vm-text); }
.jl-vm-secondary-content { padding-bottom: 8px; }
[data-compact="true"] .jl-vm-discussion { padding: 0 14px 8px; }
[data-compact="true"] .jl-vm-tabs-row { padding: 8px 10px; gap: 8px; }
[data-compact="true"] .jl-vm-tab { padding: 0 9px; border-radius: 5px; font-size: 12.5px; }
[data-compact="true"] .jl-vm-search { width: 100px; min-width: 70px; flex: 1; font-size: 12.5px; }
[data-compact="true"] .jl-vm-filters { padding: 6px 10px; }
[data-compact="true"] .jl-vm-list { display: block; padding: 4px 6px; overflow-anchor: none; }
[data-compact="true"] .jl-vm-row { width: 100%; height: 40px; min-height: 40px; max-height: 40px; margin: 0; padding: 0 8px; border-radius: 6px; border: 0; box-sizing: border-box; contain: layout style; }
[data-compact="true"] .jl-vm-row-label { font-size: 12.5px; }
[data-compact="true"] .jl-vm-row[data-kind="network"] .jl-vm-row-label { font-size: 12px; }
[data-compact="true"] .jl-vm-row-offset { font-size: 11px; }
[data-compact="true"] .jl-vm-row-sub { font-size: 11px; line-height: 1.2; }
[data-compact="true"] .jl-vm-row-main { gap: 0; }
[data-compact="true"] .jl-vm-vc-bar { border-radius: 10px; }
@media (max-width: 900px) {
  [data-compact="true"].jl-vm-root, [data-compact="true"].jl-vm-modal { height: 100dvh; min-height: 0; }
  [data-compact="true"] .jl-vm-body { flex-direction: column; overflow: hidden; }
  [data-compact="true"] .jl-vm-left { flex: 0 0 auto; border-right: 0; }
  [data-compact="true"] .jl-vm-video-wrap { height: min(48vw, 40dvh); min-height: 180px; flex: none; }
  [data-compact="true"] .jl-vm-right { flex: 1 1 auto; min-height: 0; width: 100%; }
  [data-compact="true"] .jl-vm-list { max-height: none; flex: 1; }
  [data-compact="true"] .jl-vm-secondary { max-height: 180px; }
  [data-compact="true"] .jl-vm-header { padding: 6px 10px; flex-direction: row; align-items: center; flex-wrap: nowrap; }
  [data-compact="true"] .jl-vm-header-left { width: auto; }
  [data-compact="true"] .jl-vm-actions { width: auto; }
  [data-compact="true"] .jl-vm-title-meta { display: none; }
  [data-compact="true"] .jl-vm-actions > .jl-vm-btn .jl-vm-btn-label { display: none; }
  [data-compact="true"] .jl-vm-header .jl-vm-btn, .jl-vm-more summary { min-width: 36px; min-height: 36px; }
  [data-compact="true"] .jl-vm-tabs-row { flex-direction: row; flex-wrap: nowrap; align-items: center; }
  [data-compact="true"] .jl-vm-search { width: 70px; min-width: 0; height: 36px; min-height: 36px; flex: 1 1 70px; }
  [data-compact="true"] .jl-vm-tabs { --jl-vm-tab-size: 32px; }
  [data-compact="true"] .jl-vm-tab { min-height: 32px; }
}
`;
