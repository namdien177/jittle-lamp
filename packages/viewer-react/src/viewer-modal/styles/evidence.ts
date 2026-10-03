export const evidenceStyles = `
.jl-vm-evidence {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: var(--jl-vm-bg, #0b0d0e);
}

.jl-vm-right[data-collapsed="true"] .jl-vm-evidence,
.jl-vm-right[data-collapsed="true"] .jl-vm-stream-resizer {
  display: none;
}

.jl-vm-stream-resizer {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -8px;
  z-index: 30;
  display: grid;
  width: 16px;
  place-items: center;
  border: 0;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  cursor: col-resize;
}

.jl-vm-stream-resizer::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 7px;
  width: 1px;
  background: var(--jl-vm-border, rgba(239, 239, 239, 0.1));
}

.jl-vm-stream-resizer svg {
  position: relative;
  z-index: 1;
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 999px;
  background: var(--jl-vm-surface, #111314);
}

.jl-vm-stream-resizer:hover,
.jl-vm-stream-resizer:focus-visible {
  color: var(--jl-vm-text, #efefef);
  outline: none;
}

.jl-vm-stream-resizer:hover::before,
.jl-vm-stream-resizer:focus-visible::before {
  background: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16));
}

.jl-vm-stream-rail {
  appearance: none;
  display: grid;
  grid-template-rows: auto 1fr;
  place-items: center;
  gap: 10px;
  width: 48px;
  height: 100%;
  padding: 12px 0;
  border: 0;
  border-left: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: var(--jl-vm-bg, #0b0d0e);
  color: var(--jl-vm-soft, rgba(239, 239, 239, 0.68));
  cursor: pointer;
}

.jl-vm-stream-rail:hover,
.jl-vm-stream-rail:focus-visible {
  color: var(--jl-vm-text, #efefef);
  background: var(--jl-vm-surface, #111314);
  outline: none;
}

.jl-vm-stream-rail span {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  color: inherit;
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-weight: 500;
}

.jl-vm-pane-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
}

.jl-vm-pane-title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.jl-vm-pane-heading strong {
  font-size:calc(14px * var(--jl-font-scale, 1));
  line-height: 1.2;
}

.jl-vm-pane-heading .jl-vm-pane-heading-actions {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  align-self: center;
  gap: 8px;
  min-width: 0;
}

.jl-vm-pane-count {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-height: 20px;
  border-radius: 4px;
  border: 0;
  background: var(--jl-vm-surface-2, #171a1b);
  color: var(--jl-vm-soft, rgba(239, 239, 239, 0.68));
  padding: 2px 6px;
  font-size:calc(11.5px * var(--jl-font-scale, 1));
  font-variant-numeric: tabular-nums;
  line-height: 1;
  white-space: nowrap;
}

.jl-vm-icon-btn {
  appearance: none;
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  cursor: pointer;
}

.jl-vm-icon-btn:hover,
.jl-vm-icon-btn:focus-visible {
  background: var(--jl-vm-surface-2, #171a1b);
  color: var(--jl-vm-text, #efefef);
  outline: none;
}

.jl-vm-eyebrow {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-weight: 500;
}

.jl-vm-tabs-row {
  display: flex;
  align-items: center;
  max-width: 100%;
  min-width: 0;
  gap: 8px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  background: var(--jl-vm-bg, #0b0d0e);
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)) transparent;
  -webkit-overflow-scrolling: touch;
}

.jl-vm-tabs {
  --jl-vm-tab-size: 24px;
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 2px;
  padding: 2px;
  border-radius: 7px;
  background: var(--jl-vm-surface-2, #171a1b);
}

.jl-vm-tabs > .jl-vm-tab,
.jl-vm-tabs > .jl-vm-icon-btn {
  box-sizing: border-box;
  height: var(--jl-vm-tab-size);
  min-height: var(--jl-vm-tab-size);
}

.jl-vm-tabs > .jl-vm-icon-btn {
  flex: 0 0 var(--jl-vm-tab-size);
  width: var(--jl-vm-tab-size);
  padding: 0;
}

.jl-vm-tab {
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: inherit;
  font-size:calc(12.5px * var(--jl-font-scale, 1));
  font-weight: 500;
  padding: 0 10px;
  border-radius: 5px;
  cursor: pointer;
  letter-spacing: 0;
  border: 0;
  white-space: nowrap;
}

.jl-vm-tab:hover {
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-tab[data-active="true"] {
  background: var(--jl-vm-tab-active, #2a2b31);
  color: var(--jl-vm-text, #efefef);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.jl-vm-search {
  flex: 1 0 160px;
  min-width: 160px;
  height: 28px;
  box-sizing: border-box;
  background: var(--jl-vm-bg, #0b0d0e);
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  color: var(--jl-vm-text, #efefef);
  border-radius: 6px;
  padding: 0 10px;
  font-family: inherit;
  font-size:calc(12.5px * var(--jl-font-scale, 1));
  outline: none;
}

.jl-vm-search:focus {
  border-color: color-mix(in srgb, var(--jl-vm-accent, #22c55e) 55%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jl-vm-accent, #22c55e) 18%, transparent);
}

.jl-vm-filters {
  display: flex;
  max-width: 100%;
  min-width: 0;
  gap: 4px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 6px 12px;
  border-bottom: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)) transparent;
  -webkit-overflow-scrolling: touch;
}

.jl-vm-chip {
  appearance: none;
  flex: 0 0 auto;
  border: 1px solid transparent;
  background: transparent;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: inherit;
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-weight: 500;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
}

.jl-vm-chip:hover {
  color: var(--jl-vm-text, #efefef);
  background: var(--jl-vm-surface-2, #171a1b);
}

.jl-vm-chip[data-active="true"] {
  color: var(--jl-vm-text, #efefef);
  background: var(--jl-vm-surface-3, #1f2324);
}

.jl-vm-step-chip::before {
  content: "";
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 6px;
  border-radius: 999px;
  vertical-align: middle;
  background: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-step-chip[data-status="passed"]::before { background: #22c55e; }
.jl-vm-step-chip[data-status="failed"]::before { background: #ef4444; }
.jl-vm-step-chip[data-status="blocked"]::before { background: #f59e0b; }

.jl-vm-list-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.jl-vm-list {
  flex: 1;
  max-width: 100%;
  overflow: auto;
  padding: 4px 6px;
  display: flex;
  flex-direction: column;
  gap: 0;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: var(--jl-vm-border-strong, rgba(239, 239, 239, 0.16)) transparent;
  -webkit-overflow-scrolling: touch;
}

.jl-vm-row {
  display: grid;
  grid-template-columns: 58px 10px minmax(0, 1fr) auto;
  gap: 8px;
  height: 40px;
  box-sizing: border-box;
  padding: 0 8px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  font-size:calc(12.5px * var(--jl-font-scale, 1));
  color: var(--jl-vm-text, #efefef);
  align-items: center;
  min-width: 0;
  transition: background 120ms ease, box-shadow 120ms ease;
}

.jl-vm-row[data-kind="network"] {
  grid-template-columns: 52px 54px minmax(0, 1fr) 42px 52px;
}

.jl-vm-row:hover {
  background: var(--jl-vm-surface-2, #111314);
}

/* The row at the playhead: a quiet tint and a left rule, not a box. */
.jl-vm-row[data-active="true"] {
  background:
    linear-gradient(var(--jl-vm-accent, #22c55e), var(--jl-vm-accent, #22c55e)) left center / 2px 60% no-repeat,
    color-mix(in srgb, var(--jl-vm-accent, #22c55e) 10%, transparent);
}

.jl-vm-row[data-selected="true"] {
  background: color-mix(in srgb, var(--jl-vm-accent, #22c55e) 18%, transparent);
}

.jl-vm-row-offset {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size:calc(11.5px * var(--jl-font-scale, 1));
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-variant-numeric: tabular-nums;
}

.jl-vm-row-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: #9fbbe0;
}

.jl-vm-row-dot[data-kind="error"] { background: var(--jl-vm-danger, #ef4444); }
.jl-vm-row-dot[data-kind="interaction"] { background: var(--jl-vm-accent, #22c55e); }
.jl-vm-row-dot[data-kind="lifecycle"] { background: #9fbbe0; }

.jl-vm-row-method {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size:calc(11.5px * var(--jl-font-scale, 1));
  font-weight: 600;
  color: var(--jl-vm-soft, rgba(239, 239, 239, 0.68));
}

.jl-vm-row-method[data-method="GET"] { color: #22c55e; }
.jl-vm-row-method[data-method="POST"] { color: #7dd3fc; }
.jl-vm-row-method[data-method="PUT"],
.jl-vm-row-method[data-method="PATCH"] { color: #f59e0b; }
.jl-vm-row-method[data-method="DELETE"] { color: #ef4444; }

.jl-vm-row-main {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0;
  line-height: 1.3;
}

.jl-vm-row-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-row[data-kind="network"] .jl-vm-row-label {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size:calc(12px * var(--jl-font-scale, 1));
}

.jl-vm-row-sub,
.jl-vm-row-duration {
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size:calc(11px * var(--jl-font-scale, 1));
}

.jl-vm-row-status {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-family: var(--font-mono, ui-monospace, monospace);
}

.jl-vm-row-status[data-tone="ok"] { color: #22c55e; }
.jl-vm-row-status[data-tone="err"] { color: #ef4444; }

.jl-vm-empty {
  padding: 24px 16px;
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
  font-size: inherit;
  text-align: center;
}

.jl-vm-about {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.jl-vm-about-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.1));
  border-radius: 8px;
  background: var(--jl-vm-bg, #111314);
  padding: 12px 14px;
}

.jl-vm-about-card strong {
  color: var(--jl-vm-text, #efefef);
  font-size:calc(13px * var(--jl-font-scale, 1));
  line-height: 1.25;
}

.jl-vm-about-list {
  display: grid;
  gap: 0;
  margin: 0;
}

.jl-vm-about-row {
  display: grid;
  grid-template-columns: minmax(110px, 0.35fr) minmax(0, 1fr);
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--jl-vm-border, rgba(239, 239, 239, 0.08));
  font-size:calc(12.5px * var(--jl-font-scale, 1));
}

.jl-vm-about-row dd {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size:calc(12px * var(--jl-font-scale, 1));
}

.jl-vm-about-row dt {
  color: var(--jl-vm-muted, rgba(239, 239, 239, 0.46));
}

.jl-vm-about-row dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--jl-vm-text, #efefef);
}

.jl-vm-focus-btn {
  position: absolute;
  bottom: 12px;
  right: 12px;
  background: var(--jl-vm-accent, #22c55e);
  color: var(--jl-vm-accent-on, #06120a);
  border: 0;
  border-radius: 6px;
  padding: 5px 10px;
  font-family: inherit;
  font-size:calc(12px * var(--jl-font-scale, 1));
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.3);
}
`;
