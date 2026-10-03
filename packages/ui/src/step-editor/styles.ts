// Styles of the step editor, injected once like RunStepList so the web and desktop apps render it
// without sharing a Tailwind build. Colours come from the host's tokens with neutral fallbacks.

const css = `
.jl-se,.jl-se-workbench,.jl-se-picker{--se-border:var(--border,rgba(127,127,127,.22));--se-input:var(--input,rgba(127,127,127,.3));--se-muted:var(--muted-foreground,rgba(127,127,127,.9));--se-bg:var(--background,#fff);--se-card:var(--card,#f4f4f4);--se-subtle:var(--muted,#f3f3f5);--se-hover:var(--accent,#ececef);--se-pop:var(--popover,#fff);--se-fg:var(--foreground,#222);--se-accent:var(--primary,#22c55e);--se-on-accent:var(--primary-foreground,#04140a);--se-ring:var(--ring,#22c55e);--se-danger:var(--destructive,#ef4444);--se-warn:var(--warning,#f59e0b);--se-ease:cubic-bezier(.23,1,.32,1);--se-mono:var(--font-mono-proto,ui-monospace,monospace)}
.jl-se-workbench{display:flex;flex-direction:column;gap:12px;color:var(--se-fg)}
.jl-se-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.jl-se-modes{display:inline-flex;align-items:center;gap:2px;height:28px;padding:2px;border-radius:7px;background:var(--se-subtle);box-sizing:border-box}
.jl-se-mode{appearance:none;height:100%;border:0;border-radius:5px;background:transparent;color:var(--se-muted);font:inherit;font-size:12.5px;font-weight:500;padding:0 10px;cursor:pointer;transition:background-color .15s var(--se-ease),color .15s var(--se-ease)}
.jl-se-mode:hover{color:var(--se-fg)}
.jl-se-mode[aria-selected="true"]{background:var(--se-bg);color:var(--se-fg);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dark .jl-se-mode[aria-selected="true"]{background:var(--se-hover)}
.jl-se-mode:disabled{opacity:.5;cursor:not-allowed}
.jl-se-mode:focus-visible{outline:2px solid color-mix(in srgb,var(--se-ring) 55%,transparent);outline-offset:1px}
.jl-se-notice{margin:0;font-size:13px;line-height:1.45;color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se{font:inherit;color:var(--se-fg);display:flex;flex-direction:column;gap:2px}
.jl-se-summary{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:12.5px;color:var(--se-muted);padding:0 2px 6px}
.jl-se-summary [data-tone="error"]{color:var(--se-danger)}
.jl-se-summary [data-tone="warning"]{color:color-mix(in srgb,var(--se-warn) 80%,var(--se-fg))}
.jl-se-row{position:relative;display:grid;grid-template-columns:16px 22px auto minmax(0,1fr) auto;align-items:start;gap:8px;padding:4px 6px;border-radius:6px;border:1px solid transparent}
.jl-se-row:hover{background:color-mix(in srgb,var(--se-fg) 3%,transparent)}
.jl-se-row[data-focused="true"]{border-color:var(--se-input);background:var(--se-bg);box-shadow:0 0 0 3px color-mix(in srgb,var(--se-ring) 14%,transparent)}
.jl-se-row[data-disabled="true"] .jl-se-field,.jl-se-row[data-disabled="true"] .jl-se-chip{opacity:.5;text-decoration:line-through}
.jl-se-row[data-drop="before"]::before,.jl-se-row[data-drop="after"]::after{content:"";position:absolute;left:6px;right:6px;height:2px;border-radius:2px;background:var(--se-accent)}
.jl-se-row[data-drop="before"]::before{top:-2px}
.jl-se-row[data-drop="after"]::after{bottom:-2px}
.jl-se-row[data-kind="heading"]{grid-template-columns:16px 22px minmax(0,1fr) auto;margin-top:8px;padding-top:6px;padding-bottom:6px}
.jl-se-handle{cursor:grab;color:var(--se-muted);opacity:0;font-size:12px;line-height:24px;text-align:center;user-select:none;border:0;background:none;padding:0}
.jl-se-row:hover .jl-se-handle,.jl-se-row[data-focused="true"] .jl-se-handle,.jl-se-handle:focus-visible{opacity:.8}
.jl-se-num{font-size:12px;line-height:24px;color:var(--se-muted);text-align:right;font-variant-numeric:tabular-nums}
.jl-se-chipgroup{display:inline-flex;flex-wrap:wrap;gap:4px;align-items:center;max-width:280px}
.jl-se-chip{appearance:none;display:inline-flex;align-items:center;height:22px;box-sizing:border-box;margin-top:1px;border:1px solid var(--se-border);background:var(--se-subtle);color:inherit;font:inherit;font-size:12px;font-weight:500;padding:0 7px;border-radius:5px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease);white-space:nowrap}
.jl-se-chip:hover{border-color:var(--se-input)}
.jl-se-chip:active{transform:scale(.97)}
.jl-se-chip:focus-visible,.jl-se-params:focus-visible,.jl-se-iconbtn:focus-visible,.jl-se-handle:focus-visible,.jl-se-btn:focus-visible,.jl-se-add:focus-visible,.jl-se-fix:focus-visible{outline:2px solid color-mix(in srgb,var(--se-ring) 55%,transparent);outline-offset:1px}
.jl-se-chip[data-type="assert"]{background:color-mix(in srgb,var(--se-accent) 14%,transparent);border-color:color-mix(in srgb,var(--se-accent) 32%,transparent)}
.jl-se-chip[data-type="open"]{background:color-mix(in srgb,#3b82f6 13%,transparent);border-color:color-mix(in srgb,#3b82f6 32%,transparent)}
.jl-se-chip[data-type="login"],.jl-se-chip[data-type="macro"]{background:color-mix(in srgb,var(--se-warn) 14%,transparent);border-color:color-mix(in srgb,var(--se-warn) 36%,transparent)}
.jl-se-chip[data-type="note"],.jl-se-chip[data-type="screenshot"]{color:var(--se-muted)}
.jl-se-params{appearance:none;display:inline-flex;align-items:center;height:22px;box-sizing:border-box;margin-top:1px;border:1px dashed color-mix(in srgb,var(--se-warn) 55%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:0 7px;border-radius:5px;cursor:pointer;font-family:var(--se-mono);transition:transform .15s var(--se-ease)}
.jl-se-params:active{transform:scale(.97)}
.jl-se-field{position:relative;min-width:0}
.jl-se-input{width:100%;box-sizing:border-box;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:13.5px;line-height:24px;padding:0 2px;min-height:24px}
.jl-se-input::placeholder{color:var(--se-muted);opacity:.75}
.jl-se-input[data-hidden="true"]{position:absolute;inset:0;opacity:0;pointer-events:none}
.jl-se-display{font-size:13.5px;line-height:24px;padding:0 2px;min-height:24px;cursor:text;overflow-wrap:anywhere}
.jl-se-display[data-empty="true"]{color:var(--se-muted);opacity:.75}
.jl-se-heading-input{font-weight:600;font-size:13.5px}
.jl-se-heading-label{font-size:12px;font-weight:500;color:var(--se-muted);margin-right:6px}
.jl-se-token{display:inline-flex;align-items:center;gap:3px;border-radius:4px;padding:0 5px;margin:0 1px;font-size:12.5px;line-height:19px;vertical-align:1px;font-family:var(--se-mono)}
.jl-se-token[data-kind="variable"]{background:color-mix(in srgb,#3b82f6 14%,transparent);color:color-mix(in srgb,#3b82f6 75%,var(--se-fg))}
.jl-se-token[data-kind="credential"]{background:color-mix(in srgb,var(--se-warn) 18%,transparent)}
.jl-se-token[data-kind="file"]{background:color-mix(in srgb,var(--se-fg) 8%,transparent)}
.jl-se-token[data-kind="quoted"]{background:var(--se-subtle);border:1px solid var(--se-border);font-family:inherit}
.jl-se-status{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:24px;color:var(--se-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.jl-se-dot{width:7px;height:7px;border-radius:999px;background:currentColor;display:inline-block}
.jl-se-badge{display:inline-flex;align-items:center;height:18px;box-sizing:border-box;border:1px solid var(--se-border);border-radius:4px;padding:0 6px;font-size:11.5px;font-weight:500}
.jl-se-badge[data-tone="ok"]{border-color:color-mix(in srgb,var(--se-accent) 40%,transparent);background:color-mix(in srgb,var(--se-accent) 10%,transparent);color:color-mix(in srgb,var(--se-accent) 70%,var(--se-fg))}
.jl-se-badge[data-tone="warn"]{border-color:color-mix(in srgb,var(--se-warn) 45%,transparent);background:color-mix(in srgb,var(--se-warn) 10%,transparent);color:color-mix(in srgb,var(--se-warn) 70%,var(--se-fg))}
.jl-se-badge[data-tone="error"]{border-color:color-mix(in srgb,var(--se-danger) 40%,transparent);background:color-mix(in srgb,var(--se-danger) 10%,transparent);color:var(--se-danger)}
.jl-se-outcome[data-outcome="passed"]{color:var(--se-accent)}
.jl-se-outcome[data-outcome="failed"]{color:var(--se-danger)}
.jl-se-outcome[data-outcome="blocked"]{color:var(--se-warn)}
.jl-se-outcome[data-outcome="skipped"]{color:var(--se-muted)}
.jl-se-below{grid-column:4 / 6;display:flex;flex-direction:column;gap:4px;padding-bottom:2px}
.jl-se-lint{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12.5px;line-height:1.4}
.jl-se-lint[data-severity="error"]{color:var(--se-danger)}
.jl-se-lint[data-severity="warning"]{color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se-lint[data-severity="info"]{color:var(--se-muted)}
.jl-se-fix{appearance:none;display:inline-flex;align-items:center;height:22px;box-sizing:border-box;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:12px;font-weight:500;border-radius:5px;padding:0 8px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-fix:hover{background:var(--se-hover)}
.jl-se-fix:active{transform:scale(.97)}
.jl-se-expansion{border-left:2px solid color-mix(in srgb,var(--se-warn) 50%,transparent);padding:2px 0 2px 10px;font-size:12.5px;color:var(--se-muted);font-family:var(--se-mono);line-height:1.5}
.jl-se-suggest{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:12px;color:var(--se-muted)}
.jl-se-suggest button{appearance:none;display:inline-flex;align-items:center;height:20px;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:12px;border-radius:4px;padding:0 6px;cursor:pointer;font-family:var(--se-mono);transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-suggest button:hover{background:var(--se-hover)}
.jl-se-suggest button:active{transform:scale(.97)}
.jl-se-picker{position:absolute;z-index:40;top:calc(100% + 4px);left:0;min-width:300px;max-width:min(440px,90vw);max-height:300px;overflow:auto;background:var(--se-pop);color:var(--se-fg);border:1px solid var(--se-border);border-radius:8px;box-shadow:0 16px 40px -8px rgba(0,0,0,.25),0 4px 12px -4px rgba(0,0,0,.12);padding:4px;transform-origin:top left;animation:jl-se-pop .16s var(--se-ease)}
.jl-se-picker-head{font-size:12px;font-weight:500;color:var(--se-muted);padding:6px 8px 4px}
.jl-se-option{display:flex;justify-content:space-between;gap:12px;align-items:center;min-height:28px;box-sizing:border-box;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:13px}
.jl-se-option[aria-selected="true"]{background:var(--se-hover)}
.jl-se-option-detail{font-size:12px;color:var(--se-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jl-se-option code{font-family:var(--se-mono);font-size:12.5px}
.jl-se-form{display:flex;flex-direction:column;gap:6px;padding:6px 8px 8px}
.jl-se-form label{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;font-size:12.5px;color:var(--se-muted)}
.jl-se-form input{height:28px;box-sizing:border-box;border:1px solid var(--se-input);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:13px;border-radius:6px;padding:0 8px;outline:none}
.jl-se-form input:focus-visible{border-color:color-mix(in srgb,var(--se-ring) 60%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--se-ring) 25%,transparent)}
.jl-se-form-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.jl-se-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;box-sizing:border-box;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:12.5px;font-weight:500;border-radius:6px;padding:0 10px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-btn:hover{background:var(--se-hover)}
.jl-se-btn:active{transform:scale(.97)}
.jl-se-btn[data-variant="primary"]{background:var(--se-accent);border-color:transparent;color:var(--se-on-accent)}
.jl-se-btn[data-variant="primary"]:hover{background:color-mix(in srgb,var(--se-accent) 90%,black)}
.jl-se-iconbtn{appearance:none;display:inline-grid;place-items:center;min-width:22px;height:22px;border:0;background:transparent;color:var(--se-muted);cursor:pointer;border-radius:5px;padding:0 4px;font-size:13px;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease)}
.jl-se-iconbtn:hover{background:var(--se-hover);color:var(--se-fg)}
.jl-se-iconbtn:active{transform:scale(.97)}
.jl-se-footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:12px;color:var(--se-muted);padding:10px 4px 0}
.jl-se-footer kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;box-sizing:border-box;font-family:inherit;font-size:11px;font-weight:500;border:1px solid var(--se-border);background:var(--se-subtle);border-radius:4px;padding:0 4px;margin-right:4px;vertical-align:0}
.jl-se-add{appearance:none;display:flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;border:1px dashed var(--se-input);background:transparent;color:var(--se-muted);font:inherit;font-size:13px;font-weight:500;border-radius:6px;padding:0 10px;cursor:pointer;margin-top:6px;text-align:left;transition:transform .15s var(--se-ease),background-color .15s var(--se-ease),color .15s var(--se-ease)}
.jl-se-add:hover{background:var(--se-hover);color:var(--se-fg);border-style:solid}
.jl-se-add:active{transform:scale(.99)}
@keyframes jl-se-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
.jl-se-picker[data-keyboard="true"]{animation:none}
.jl-se-text{width:100%;box-sizing:border-box;min-height:360px;font-family:var(--se-mono);font-size:13px;line-height:1.55;border:1px solid var(--se-input);border-radius:8px;padding:10px 12px;background:var(--se-bg);color:var(--se-fg);resize:vertical;tab-size:2;outline:none;box-shadow:0 1px 2px rgba(16,17,20,.04)}
.jl-se-text:focus-visible{border-color:color-mix(in srgb,var(--se-ring) 60%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--se-ring) 25%,transparent)}
@media (prefers-reduced-motion: reduce){.jl-se *,.jl-se-picker,.jl-se-workbench *{transition:none !important;animation:none !important}.jl-se-chip:active,.jl-se-fix:active,.jl-se-btn:active,.jl-se-add:active{transform:none}}
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
