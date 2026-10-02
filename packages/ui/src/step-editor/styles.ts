// Styles of the step editor, injected once like RunStepList so the web and desktop apps render it
// without sharing a Tailwind build. Colours come from the host's tokens with neutral fallbacks.

const css = `
.jl-se{--se-border:var(--border,rgba(127,127,127,.22));--se-muted:var(--muted-foreground,rgba(127,127,127,.9));--se-bg:var(--background,#fff);--se-card:var(--card,#f4f4f4);--se-pop:var(--popover,#fff);--se-fg:var(--foreground,#222);--se-accent:var(--primary,#22c55e);--se-danger:var(--destructive,#ef4444);--se-warn:var(--warning,#f59e0b);--se-ease:cubic-bezier(.23,1,.32,1);font:inherit;color:var(--se-fg);display:flex;flex-direction:column;gap:2px}
.jl-se-summary{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:13px;color:var(--se-muted);padding:2px 4px 8px}
.jl-se-summary [data-tone="error"]{color:var(--se-danger)}
.jl-se-summary [data-tone="warning"]{color:color-mix(in srgb,var(--se-warn) 80%,var(--se-fg))}
.jl-se-row{position:relative;display:grid;grid-template-columns:16px 22px auto minmax(0,1fr) auto;align-items:start;gap:8px;padding:5px 6px;border-radius:8px;border:1px solid transparent}
.jl-se-row:hover{background:color-mix(in srgb,var(--se-fg) 3%,transparent)}
.jl-se-row[data-focused="true"]{border-color:color-mix(in srgb,var(--se-accent) 45%,transparent);background:color-mix(in srgb,var(--se-accent) 5%,transparent)}
.jl-se-row[data-disabled="true"] .jl-se-field,.jl-se-row[data-disabled="true"] .jl-se-chip{opacity:.5;text-decoration:line-through}
.jl-se-row[data-drop="before"]::before,.jl-se-row[data-drop="after"]::after{content:"";position:absolute;left:6px;right:6px;height:2px;border-radius:2px;background:var(--se-accent)}
.jl-se-row[data-drop="before"]::before{top:-2px}
.jl-se-row[data-drop="after"]::after{bottom:-2px}
.jl-se-row[data-kind="heading"]{grid-template-columns:16px 22px minmax(0,1fr) auto;margin-top:8px;padding-top:7px;padding-bottom:7px}
.jl-se-handle{cursor:grab;color:var(--se-muted);opacity:0;font-size:12px;line-height:26px;text-align:center;user-select:none;border:0;background:none;padding:0}
.jl-se-row:hover .jl-se-handle,.jl-se-row[data-focused="true"] .jl-se-handle,.jl-se-handle:focus-visible{opacity:.8}
.jl-se-num{font-size:12px;line-height:26px;color:var(--se-muted);text-align:right;font-variant-numeric:tabular-nums}
.jl-se-chipgroup{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;max-width:280px}
.jl-se-chip{appearance:none;border:1px solid var(--se-border);background:var(--se-card);color:inherit;font:inherit;font-size:12px;font-weight:600;line-height:20px;padding:2px 8px;border-radius:6px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease);white-space:nowrap}
.jl-se-chip:active{transform:scale(.97)}
.jl-se-chip:focus-visible,.jl-se-params:focus-visible,.jl-se-iconbtn:focus-visible,.jl-se-handle:focus-visible{outline:2px solid color-mix(in srgb,var(--se-accent) 60%,transparent);outline-offset:1px}
.jl-se-chip[data-type="act"]{background:color-mix(in srgb,var(--se-fg) 6%,transparent)}
.jl-se-chip[data-type="assert"]{background:color-mix(in srgb,var(--se-accent) 16%,transparent);border-color:color-mix(in srgb,var(--se-accent) 35%,transparent)}
.jl-se-chip[data-type="open"]{background:color-mix(in srgb,#3b82f6 14%,transparent);border-color:color-mix(in srgb,#3b82f6 35%,transparent)}
.jl-se-chip[data-type="login"],.jl-se-chip[data-type="macro"]{background:color-mix(in srgb,var(--se-warn) 16%,transparent);border-color:color-mix(in srgb,var(--se-warn) 40%,transparent)}
.jl-se-chip[data-type="note"],.jl-se-chip[data-type="screenshot"]{color:var(--se-muted)}
.jl-se-params{appearance:none;border:1px dashed color-mix(in srgb,var(--se-warn) 55%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;line-height:20px;padding:2px 7px;border-radius:6px;cursor:pointer;font-family:var(--font-mono-proto,ui-monospace,monospace);transition:transform .15s var(--se-ease)}
.jl-se-params:active{transform:scale(.97)}
.jl-se-field{position:relative;min-width:0}
.jl-se-input{width:100%;box-sizing:border-box;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:14px;line-height:26px;padding:0 2px;min-height:26px}
.jl-se-input[data-hidden="true"]{position:absolute;inset:0;opacity:0;pointer-events:none}
.jl-se-display{font-size:14px;line-height:26px;padding:0 2px;min-height:26px;cursor:text;overflow-wrap:anywhere}
.jl-se-display[data-empty="true"]{color:var(--se-muted);opacity:.7}
.jl-se-heading-input{font-weight:600;font-size:14px}
.jl-se-heading-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--se-muted);margin-right:6px}
.jl-se-token{display:inline-flex;align-items:center;gap:3px;border-radius:5px;padding:0 5px;margin:0 1px;font-size:12.5px;line-height:20px;vertical-align:1px;font-family:var(--font-mono-proto,ui-monospace,monospace)}
.jl-se-token[data-kind="variable"]{background:color-mix(in srgb,#3b82f6 14%,transparent);color:color-mix(in srgb,#3b82f6 75%,var(--se-fg))}
.jl-se-token[data-kind="credential"]{background:color-mix(in srgb,var(--se-warn) 18%,transparent)}
.jl-se-token[data-kind="file"]{background:color-mix(in srgb,var(--se-fg) 8%,transparent)}
.jl-se-token[data-kind="quoted"]{background:color-mix(in srgb,var(--se-fg) 6%,transparent);border:1px dashed var(--se-border);font-family:inherit}
.jl-se-status{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:26px;color:var(--se-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.jl-se-dot{width:8px;height:8px;border-radius:999px;background:currentColor;display:inline-block}
.jl-se-badge{border:1px solid var(--se-border);border-radius:999px;padding:0 6px;line-height:18px}
.jl-se-badge[data-tone="ok"]{border-color:color-mix(in srgb,var(--se-accent) 45%,transparent);color:color-mix(in srgb,var(--se-accent) 70%,var(--se-fg))}
.jl-se-badge[data-tone="warn"]{border-color:color-mix(in srgb,var(--se-warn) 55%,transparent);color:color-mix(in srgb,var(--se-warn) 70%,var(--se-fg))}
.jl-se-badge[data-tone="error"]{border-color:color-mix(in srgb,var(--se-danger) 50%,transparent);color:var(--se-danger)}
.jl-se-outcome[data-outcome="passed"]{color:var(--se-accent)}
.jl-se-outcome[data-outcome="failed"]{color:var(--se-danger)}
.jl-se-outcome[data-outcome="blocked"]{color:var(--se-warn)}
.jl-se-outcome[data-outcome="skipped"]{color:var(--se-muted)}
.jl-se-below{grid-column:4 / 6;display:flex;flex-direction:column;gap:3px}
.jl-se-lint{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;line-height:1.4}
.jl-se-lint[data-severity="error"]{color:var(--se-danger)}
.jl-se-lint[data-severity="warning"]{color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se-lint[data-severity="info"]{color:var(--se-muted)}
.jl-se-fix{appearance:none;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:18px;border-radius:999px;padding:0 8px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-fix:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
.jl-se-fix:active{transform:scale(.97)}
.jl-se-expansion{border-left:2px solid color-mix(in srgb,var(--se-warn) 55%,transparent);padding:2px 0 2px 10px;font-size:12.5px;color:var(--se-muted);font-family:var(--font-mono-proto,ui-monospace,monospace);line-height:1.5}
.jl-se-suggest{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:12px;color:var(--se-muted)}
.jl-se-suggest button{appearance:none;border:1px dashed var(--se-border);background:transparent;color:var(--se-fg);font:inherit;font-size:12px;border-radius:5px;padding:0 6px;line-height:20px;cursor:pointer;font-family:var(--font-mono-proto,ui-monospace,monospace);transition:transform .15s var(--se-ease)}
.jl-se-suggest button:active{transform:scale(.97)}
.jl-se-picker{position:absolute;z-index:40;top:calc(100% + 4px);left:0;min-width:300px;max-width:min(440px,90vw);max-height:300px;overflow:auto;background:var(--se-pop);color:var(--se-fg);border:1px solid var(--se-border);border-radius:10px;box-shadow:0 12px 32px -12px rgba(0,0,0,.35);padding:4px;transform-origin:top left;animation:jl-se-pop .16s var(--se-ease)}
.jl-se-picker-head{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--se-muted);padding:6px 8px 4px}
.jl-se-option{display:flex;justify-content:space-between;gap:12px;align-items:baseline;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px}
.jl-se-option[aria-selected="true"]{background:color-mix(in srgb,var(--se-accent) 14%,transparent)}
.jl-se-option-detail{font-size:11.5px;color:var(--se-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jl-se-option code{font-family:var(--font-mono-proto,ui-monospace,monospace);font-size:12.5px}
.jl-se-form{display:flex;flex-direction:column;gap:6px;padding:6px 8px 8px}
.jl-se-form label{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;font-size:12.5px;color:var(--se-muted)}
.jl-se-form input{border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:13px;border-radius:6px;padding:4px 8px}
.jl-se-form-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.jl-se-btn{appearance:none;border:1px solid var(--se-border);background:var(--se-card);color:var(--se-fg);font:inherit;font-size:12.5px;font-weight:600;border-radius:6px;padding:3px 10px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-btn:active{transform:scale(.97)}
.jl-se-btn[data-variant="primary"]{background:var(--se-accent);border-color:var(--se-accent);color:var(--primary-foreground,#04140a)}
.jl-se-iconbtn{appearance:none;border:0;background:transparent;color:var(--se-muted);cursor:pointer;border-radius:6px;padding:0 4px;line-height:24px;font-size:13px;transition:transform .15s var(--se-ease)}
.jl-se-iconbtn:active{transform:scale(.97)}
.jl-se-footer{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px;color:var(--se-muted);padding:8px 6px 2px}
.jl-se-footer kbd{font-family:var(--font-mono-proto,ui-monospace,monospace);font-size:11px;border:1px solid var(--se-border);border-radius:4px;padding:0 4px;margin-right:3px}
.jl-se-add{appearance:none;border:1px dashed var(--se-border);background:transparent;color:var(--se-muted);font:inherit;font-size:13px;border-radius:8px;padding:5px 10px;cursor:pointer;margin-top:4px;text-align:left;transition:transform .15s var(--se-ease)}
.jl-se-add:active{transform:scale(.97)}
@keyframes jl-se-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
.jl-se-picker[data-keyboard="true"]{animation:none}
.jl-meta{display:grid;grid-template-columns:120px minmax(0,1fr);gap:8px 12px;align-items:start;font-size:13px}
.jl-meta > .jl-meta-label{color:var(--se-muted,rgba(127,127,127,.9));line-height:30px;font-size:12.5px}
.jl-meta input,.jl-meta textarea,.jl-meta select{border:1px solid var(--border,rgba(127,127,127,.25));background:var(--background,#fff);color:var(--foreground,#222);font:inherit;font-size:13px;border-radius:6px;padding:5px 8px;box-sizing:border-box}
.jl-meta textarea{width:100%;min-height:56px;resize:vertical;line-height:1.45}
.jl-meta-chips{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.jl-meta-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border,rgba(127,127,127,.25));border-radius:6px;padding:1px 4px 1px 7px;font-size:12.5px;line-height:20px;background:var(--card,#f4f4f4)}
.jl-meta-chip button{appearance:none;border:0;background:none;color:inherit;opacity:.6;cursor:pointer;font-size:13px;padding:0 3px;border-radius:4px}
.jl-meta-chip button:hover{opacity:1}
.jl-meta-ns{font-size:11px;color:var(--muted-foreground,rgba(127,127,127,.9));margin-right:2px}
.jl-meta-group{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-right:8px}
.jl-meta-table{border-collapse:collapse;font-size:12.5px;width:100%}
.jl-meta-table th{font-weight:500;text-align:left;color:var(--muted-foreground,rgba(127,127,127,.9));padding:2px 4px;font-size:11.5px}
.jl-meta-table td{padding:2px 4px}
.jl-meta-table input[type="text"]{width:100%;padding:3px 6px;font-family:var(--font-mono-proto,ui-monospace,monospace);font-size:12.5px}
.jl-meta-mini{appearance:none;border:1px dashed var(--border,rgba(127,127,127,.25));background:transparent;color:var(--muted-foreground,rgba(127,127,127,.9));font:inherit;font-size:12px;border-radius:6px;padding:2px 8px;cursor:pointer;transition:transform .15s cubic-bezier(.23,1,.32,1)}
.jl-meta-mini:active{transform:scale(.97)}
.jl-se-text{width:100%;box-sizing:border-box;min-height:360px;font-family:var(--font-mono-proto,ui-monospace,monospace);font-size:13px;line-height:1.55;border:1px solid var(--border,rgba(127,127,127,.25));border-radius:8px;padding:10px 12px;background:var(--background,#fff);color:var(--foreground,#222);resize:vertical;tab-size:2}
@media (prefers-reduced-motion: reduce){.jl-se *,.jl-se-picker,.jl-meta *{transition:none !important;animation:none !important}.jl-se-chip:active,.jl-se-fix:active,.jl-se-btn:active,.jl-se-add:active,.jl-meta-mini:active{transform:none}}
`;

let injected = false;
export function injectStepEditorStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.jlStepEditor = "true";
  style.textContent = css;
  document.head.append(style);
}
