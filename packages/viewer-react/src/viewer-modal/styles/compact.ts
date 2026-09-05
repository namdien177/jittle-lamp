export const compactStyles = `
[data-compact="true"].jl-vm-root, [data-compact="true"].jl-vm-modal {
  min-height: 0; height: 100dvh; font: 13px/1.45 "Avenir Next", "Segoe UI", sans-serif;
  --jl-vm-bg: #151918; --jl-vm-bg-deep: #111513; --jl-vm-surface: #1b211e;
  --jl-vm-surface-2: #232b26; --jl-vm-accent: #9fe3b7; --jl-vm-accent-soft-text: #bceccd;
}
[data-compact="true"][data-jl-theme="light"] {
  --jl-vm-bg: #fafcf9; --jl-vm-bg-deep: #f0f3ef; --jl-vm-surface: #edf1ec;
  --jl-vm-surface-2: #e3eae1; --jl-vm-accent: #276942; --jl-vm-accent-soft-text: #276942;
}
[data-compact="true"] .jl-vm-header { min-height: 52px; padding: 8px 16px; gap: 12px; background: var(--jl-vm-bg); }
[data-compact="true"] .jl-vm-heading { gap: 1px; }
[data-compact="true"] .jl-vm-title { font: inherit; font-size: 14px; font-weight: 600; }
[data-compact="true"] .jl-vm-title-meta { font: inherit; font-size: 11px; color: var(--jl-vm-muted); }
[data-compact="true"] .jl-vm-actions { gap: 6px; flex-wrap: nowrap; }
[data-compact="true"] .jl-vm-btn { min-height: 32px; padding: 6px 9px; font: inherit; font-size: 12px; border-radius: 7px; box-shadow: none; }
[data-compact="true"] .jl-vm-btn-primary { background: transparent; color: var(--jl-vm-text); }
.jl-vm-more { position: relative; flex-shrink: 0; }
.jl-vm-more summary { list-style: none; display: grid; place-items: center; width: 32px; height: 32px; cursor: pointer; border-radius: 7px; }
.jl-vm-more summary::-webkit-details-marker { display: none; }
.jl-vm-more summary:hover { background: var(--jl-vm-surface-2); }
.jl-vm-more-menu { position: absolute; right: 0; top: 38px; z-index: 70; width: 180px; display: grid; gap: 4px; padding: 6px; border: 1px solid var(--jl-vm-border); border-radius: 10px; background: var(--jl-vm-bg); box-shadow: 0 8px 30px #0003; }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn { width: 100%; justify-content: flex-start; }
[data-compact="true"] .jl-vm-more-menu .jl-vm-btn-label { display: inline; position: static; clip: auto; clip-path: none; width: auto; height: auto; overflow: visible; }
[data-compact="true"] .jl-vm-left { min-width: 0; }
[data-compact="true"] .jl-vm-video-wrap { flex: 1 1 auto; }
[data-compact="true"] .jl-vm-secondary { flex: 0 0 auto; max-height: 34%; overflow: auto; border-top: 1px solid var(--jl-vm-border); }
.jl-vm-secondary > summary { padding: 10px 16px; color: var(--jl-vm-soft); font-size: 12px; cursor: pointer; }
.jl-vm-secondary-content { padding-bottom: 8px; }
[data-compact="true"] .jl-vm-discussion { padding: 0 16px 8px; }
[data-compact="true"] .jl-vm-tabs-row { padding: 8px 12px; gap: 8px; }
[data-compact="true"] .jl-vm-tab { padding: 7px 8px; border-radius: 6px; font-size: 12px; }
[data-compact="true"] .jl-vm-search { width: 100px; min-width: 70px; flex: 1; font-size: 12px; }
[data-compact="true"] .jl-vm-filters { padding: 4px 12px; }
[data-compact="true"] .jl-vm-list { display: block; padding: 0; overflow-anchor: none; }
[data-compact="true"] .jl-vm-row { width: 100%; height: 52px; min-height: 52px; max-height: 52px; margin: 0; padding: 0 12px; border-radius: 0; border: 0; border-bottom: 1px solid var(--jl-vm-border); box-sizing: border-box; contain: layout style; }
[data-compact="true"] .jl-vm-row-label { font: inherit; font-size: 12px; }
[data-compact="true"] .jl-vm-row-offset { font-size: 10px; }
[data-compact="true"] .jl-vm-row-sub { font-size: 10px; }
[data-compact="true"] .jl-vm-row[data-active="true"] { background: var(--jl-vm-surface-2); box-shadow: inset 3px 0 var(--jl-vm-accent); }
[data-compact="true"] .jl-vm-vc-bar { border-radius: 10px; background: #151918dd; }
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
  [data-compact="true"] .jl-vm-header .jl-vm-btn, .jl-vm-more summary { min-width: 40px; min-height: 40px; }
  [data-compact="true"] .jl-vm-tabs-row { flex-direction: row; flex-wrap: nowrap; align-items: center; }
  [data-compact="true"] .jl-vm-search { width: 70px; min-width: 0; min-height: 36px; flex: 1 1 70px; }
  [data-compact="true"] .jl-vm-tab { min-height: 40px; }
}
`;
