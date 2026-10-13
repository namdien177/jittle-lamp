// Styles of the step editor, injected once like RunStepList so the web and desktop apps render it
// without sharing a Tailwind build. Colours come from the host's tokens with neutral fallbacks.
//
// Layout (roadmap §3.3): one grid row per step, columns handle | ordinal | verb | instruction |
// status | lint dot. The verb is the step's kind in a word (Login, Use, Query, Assert…), tinted by
// type; plain steps carry none. Checkpoints are section headers spanning the row. Motion follows §3.7: colour
// and opacity only on hover and focus, no transition on keyboard moves, a short stagger for rows
// that arrive from a paste, and no transforms under reduced motion.

const css = `
.jl-se,.jl-se-workbench,.jl-se-picker{--se-border:var(--border,rgba(127,127,127,.22));--se-input:var(--input,rgba(127,127,127,.3));--se-muted:var(--muted-foreground,rgba(127,127,127,.9));--se-bg:var(--background,#fff);--se-card:var(--card,#f4f4f4);--se-subtle:var(--muted,#f3f3f5);--se-hover:var(--accent,#ececef);--se-pop:var(--popover,#fff);--se-fg:var(--foreground,#222);--se-accent:var(--primary,#22c55e);--se-on-accent:var(--primary-foreground,#04140a);--se-ring:var(--ring,#22c55e);--se-danger:var(--destructive,#ef4444);--se-warn:var(--warning,#f59e0b);--se-ease:var(--ease-out,cubic-bezier(.23,1,.32,1));--se-mono:var(--font-mono-proto,ui-monospace,monospace);--se-t-act:#16a34a;--se-t-assert:#2563eb;--se-t-open:#6b7280;--se-t-login:#d97706;--se-t-macro:#d97706;--se-t-use:#7c3aed;--se-t-wait:#64748b;--se-t-extract:#0d9488;--se-t-screenshot:#a8a29e;--se-t-note:#c4c4cc;--se-t-query:#0f766e;--se-t-api:#ea580c}
.jl-se-workbench{display:flex;flex-direction:column;gap:12px;color:var(--se-fg)}
.jl-se-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.jl-se-modes{display:inline-flex;align-items:center;gap:2px;height:28px;padding:2px;border-radius:7px;background:var(--se-subtle);box-sizing:border-box}
.jl-se-mode{appearance:none;height:100%;border:0;border-radius:5px;background:transparent;color:var(--se-muted);font:inherit;font-size:calc(12.5px * var(--jl-font-scale, 1));font-weight:500;padding:0 10px;cursor:pointer;transition:background-color .12s var(--se-ease),color .12s var(--se-ease)}
.jl-se-mode[aria-selected="true"]{background:var(--se-bg);color:var(--se-fg);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dark .jl-se-mode[aria-selected="true"]{background:var(--se-hover)}
.jl-se-mode:disabled{opacity:.5;cursor:not-allowed}
.jl-se-mode:focus-visible{outline:2px solid color-mix(in srgb,var(--se-ring) 55%,transparent);outline-offset:1px}
.jl-se-notice{margin:0;font-size:calc(13px * var(--jl-font-scale, 1));line-height:1.45;color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se{font:inherit;color:var(--se-fg);display:flex;flex-direction:column;gap:0;width:100%;min-width:0}
.jl-se-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px 8px;min-height:28px}
.jl-se-summary{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;font-size:calc(12px * var(--jl-font-scale, 1));line-height:1.4;color:var(--se-muted);font-variant-numeric:tabular-nums}
.jl-se-summary [data-tone="error"]{color:var(--se-danger)}
.jl-se-summary [data-tone="warning"]{color:color-mix(in srgb,var(--se-warn) 80%,var(--se-fg))}
.jl-se-empty{margin:0;padding:4px 0 6px 48px;font-size:calc(13px * var(--jl-font-scale, 1));color:var(--se-muted)}
.jl-se[data-readonly="true"] .jl-se-empty{padding-left:28px}
.jl-se-row{position:relative;display:grid;grid-template-columns:20px 28px var(--se-verb-w,64px) minmax(0,1fr) auto 20px;grid-template-rows:auto;column-gap:0;align-items:start;min-height:44px;padding:0 4px 0 0;border-radius:8px;transition:background-color .12s var(--se-ease)}
.jl-se-row>*{grid-row:1}
.jl-se[data-readonly="true"] .jl-se-row{grid-template-columns:0 28px var(--se-verb-w,64px) minmax(0,1fr) auto 20px}
.jl-se[data-instant="true"] .jl-se-row{transition:none}
@media (hover: hover) and (pointer: fine){.jl-se-row:hover{background:color-mix(in srgb,var(--se-fg) 3%,transparent)}}
.jl-se-row[data-focused="true"]{background:color-mix(in srgb,var(--se-fg) 5%,transparent)}
.jl-se-row[data-selected="true"]{background:color-mix(in srgb,var(--se-accent,var(--se-fg)) 8%,transparent);box-shadow:inset 2px 0 0 var(--se-accent,var(--se-fg))}
.jl-se-row[data-disabled="true"] .jl-se-field{opacity:.5;text-decoration:line-through}
.jl-se-row[data-disabled="true"] .jl-se-verb{opacity:.4}
.jl-se-row[data-drop="before"]::before,.jl-se-row[data-drop="after"]::after{content:"";position:absolute;left:0;right:4px;height:2px;border-radius:2px;background:var(--se-accent);z-index:1}
.jl-se-row[data-drop="before"]::before{top:-1px}
.jl-se-row[data-drop="after"]::after{bottom:-1px}
.jl-se-row[data-enter="true"]{animation:jl-se-enter .24s var(--se-ease) both}
.jl-se-row[data-type="act"]{--se-type:var(--se-t-act)}
.jl-se-row[data-type="assert"]{--se-type:var(--se-t-assert)}
.jl-se-row[data-type="open"]{--se-type:var(--se-t-open)}
.jl-se-row[data-type="login"]{--se-type:var(--se-t-login)}
.jl-se-row[data-type="macro"]{--se-type:var(--se-t-macro)}
.jl-se-row[data-type="use"]{--se-type:var(--se-t-use)}
.jl-se-row[data-type="wait"]{--se-type:var(--se-t-wait)}
.jl-se-row[data-type="extract"]{--se-type:var(--se-t-extract)}
.jl-se-row[data-type="screenshot"]{--se-type:var(--se-t-screenshot)}
.jl-se-row[data-type="note"]{--se-type:var(--se-t-note)}
.jl-se-verb{grid-column:3;margin-top:10px;display:block;box-sizing:border-box;min-width:0;padding:0 8px 0 0;border:0;background:none;color:var(--se-type,var(--se-muted));font:inherit;font-size:calc(12px * var(--jl-font-scale, 1));font-weight:600;letter-spacing:.01em;line-height:24px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:default}
button.jl-se-verb{cursor:pointer;border-radius:4px;transition:background-color .12s var(--se-ease)}
.jl-se-verb[data-type="act"]{pointer-events:none}
.jl-se-handle{grid-column:1;margin-top:10px;cursor:grab;color:var(--se-muted);opacity:0;font-size:calc(12px * var(--jl-font-scale, 1));line-height:24px;text-align:center;user-select:none;border:0;background:none;padding:0;width:20px;transition:opacity .12s var(--se-ease)}
@media (hover: hover) and (pointer: fine){.jl-se-row:hover .jl-se-handle{opacity:.7}}
.jl-se-row[data-focused="true"] .jl-se-handle,.jl-se-handle:focus-visible{opacity:.7}
.jl-se-num{grid-column:2;margin-top:10px;font-size:calc(12px * var(--jl-font-scale, 1));line-height:24px;color:var(--se-muted);text-align:right;padding-right:10px;box-sizing:border-box;font-variant-numeric:tabular-nums}
.jl-se-field{grid-column:4;position:relative;min-width:0;padding:10px 0}
.jl-se-line{display:flex;align-items:flex-start;gap:8px;min-width:0}
.jl-se-input{flex:1 1 auto;min-width:0;width:100%;box-sizing:border-box;border:0;outline:none;background:transparent;color:inherit;font:inherit;font-size:calc(15px * var(--jl-font-scale, 1));line-height:24px;padding:0;height:24px}
.jl-se-input::placeholder{color:var(--se-muted);opacity:.7}
.jl-se-input[data-hidden="true"]{position:absolute;inset:0;width:auto;height:auto;opacity:0;pointer-events:none}
.jl-se-display{flex:1 1 auto;min-width:0;font-size:calc(15px * var(--jl-font-scale, 1));line-height:24px;cursor:text;overflow-wrap:anywhere}
.jl-se[data-readonly="true"] .jl-se-display{cursor:default}
.jl-se-display[data-empty="true"]{color:var(--se-muted);opacity:.7}
.jl-se-note{color:var(--se-muted)}
.jl-se-params{appearance:none;display:inline-block;vertical-align:-1px;margin:0 6px 0 0;line-height:20px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:22px;box-sizing:border-box;border:1px dashed color-mix(in srgb,var(--se-type,var(--se-warn)) 55%,transparent);background:transparent;color:inherit;font:inherit;font-size:calc(12px * var(--jl-font-scale, 1));padding:0 7px;border-radius:5px;cursor:default;font-family:var(--se-mono);transition:transform .15s var(--se-ease),background-color .12s var(--se-ease)}
.jl-se-line>.jl-se-params{flex:0 0 auto;max-width:45%;margin:1px 0 0}
button.jl-se-params{cursor:pointer}
button.jl-se-params:active{transform:scale(.97)}
.jl-se-token{display:inline-flex;align-items:center;gap:3px;border-radius:4px;padding:0 5px;margin:0 1px;font-size:calc(13px * var(--jl-font-scale, 1));line-height:20px;vertical-align:1px;font-family:var(--se-mono)}
.jl-se-token[data-kind="variable"]{background:color-mix(in srgb,#3b82f6 14%,transparent);color:color-mix(in srgb,#3b82f6 75%,var(--se-fg))}
.jl-se-token[data-kind="credential"]{background:color-mix(in srgb,var(--se-warn) 18%,transparent)}
.jl-se-token[data-kind="file"]{background:color-mix(in srgb,var(--se-fg) 8%,transparent)}
.jl-se-token[data-kind="quoted"]{background:var(--se-subtle);border:1px solid var(--se-border);font-family:inherit}
.jl-se-status{grid-column:5;margin-top:10px;display:flex;align-items:center;gap:6px;padding-left:10px;font-size:calc(11.5px * var(--jl-font-scale, 1));line-height:24px;color:var(--se-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.jl-se-dot{width:8px;height:8px;border-radius:999px;background:currentColor;display:inline-block}
.jl-se-badge{display:inline-grid;place-items:center;width:20px;height:20px;box-sizing:border-box;border:1px solid var(--se-border);border-radius:999px;font-size:calc(11px * var(--jl-font-scale, 1));font-weight:600;line-height:1}
.jl-se-badge[data-tone="ok"]{border-color:color-mix(in srgb,var(--se-accent) 40%,transparent);background:color-mix(in srgb,var(--se-accent) 12%,transparent);color:color-mix(in srgb,var(--se-accent) 75%,var(--se-fg))}
.jl-se-badge[data-tone="warn"]{border-color:color-mix(in srgb,var(--se-warn) 45%,transparent);background:color-mix(in srgb,var(--se-warn) 12%,transparent);color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se-outcome{display:inline-grid;place-items:center;width:20px;height:20px}
.jl-se-outcome[data-outcome="passed"]{color:var(--se-accent)}
.jl-se-outcome[data-outcome="failed"]{color:var(--se-danger)}
.jl-se-outcome[data-outcome="blocked"]{color:var(--se-warn)}
.jl-se-outcome[data-outcome="skipped"]{color:var(--se-muted)}
.jl-se-lintdot{grid-column:6;margin-top:18px;justify-self:center;width:8px;height:8px;border-radius:999px;background:var(--se-muted)}
.jl-se-lintdot[data-severity="error"]{background:var(--se-danger)}
.jl-se-lintdot[data-severity="warning"]{background:var(--se-warn)}
.jl-se-chip{appearance:none;display:inline-flex;align-items:center;height:22px;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--se-type,var(--se-fg)) 45%,transparent);background:color-mix(in srgb,var(--se-type,var(--se-fg)) 12%,transparent);color:inherit;font:inherit;font-size:calc(12px * var(--jl-font-scale, 1));font-weight:500;padding:0 7px;border-radius:5px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .12s var(--se-ease);white-space:nowrap}
.jl-se-chip:active{transform:scale(.97)}
.jl-se-chip:focus-visible,.jl-se-params:focus-visible,.jl-se-iconbtn:focus-visible,.jl-se-handle:focus-visible,.jl-se-btn:focus-visible,.jl-se-add:focus-visible,.jl-se-fix:focus-visible,.jl-se-verb:focus-visible,.jl-se-expansion summary:focus-visible{outline:2px solid color-mix(in srgb,var(--se-ring) 55%,transparent);outline-offset:1px}
.jl-se-row[data-kind="heading"]{grid-template-columns:20px 28px var(--se-verb-w,64px) minmax(0,1fr) auto 20px;margin-top:14px;padding-top:12px;padding-bottom:4px;min-height:0;border-radius:0 0 8px 8px}
.jl-se-row[data-kind="heading"]::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:var(--se-border)}
.jl-se-row[data-kind="heading"]:first-of-type{margin-top:4px}
.jl-se-section{grid-column:2 / 7;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:4px}
.jl-se-section-top{display:flex;align-items:center;gap:10px;min-width:0}
.jl-se-heading-input,.jl-se-heading-text{flex:1 1 auto;min-width:0;font-weight:600;font-size:calc(15px * var(--jl-font-scale, 1));line-height:24px}
.jl-se-heading-text{overflow-wrap:anywhere}
.jl-se-heading-text[data-empty="true"]{color:var(--se-muted)}
.jl-se-section-count{font-size:calc(12px * var(--jl-font-scale, 1));line-height:1.3;color:var(--se-muted);font-variant-numeric:tabular-nums}
.jl-se-chip-status{display:inline-flex;align-items:center;height:20px;box-sizing:border-box;padding:0 8px;border-radius:999px;font-size:calc(11.5px * var(--jl-font-scale, 1));font-weight:500;border:1px solid var(--se-border);color:var(--se-muted);white-space:nowrap}
.jl-se-chip-status[data-outcome="passed"]{border-color:color-mix(in srgb,var(--se-accent) 40%,transparent);background:color-mix(in srgb,var(--se-accent) 12%,transparent);color:color-mix(in srgb,var(--se-accent) 75%,var(--se-fg))}
.jl-se-chip-status[data-outcome="failed"]{border-color:color-mix(in srgb,var(--se-danger) 40%,transparent);background:color-mix(in srgb,var(--se-danger) 10%,transparent);color:var(--se-danger)}
.jl-se-chip-status[data-outcome="blocked"]{border-color:color-mix(in srgb,var(--se-warn) 45%,transparent);background:color-mix(in srgb,var(--se-warn) 12%,transparent);color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se-remove{opacity:0;transition:opacity .12s var(--se-ease),background-color .12s var(--se-ease)}
@media (hover: hover) and (pointer: fine){.jl-se-row:hover .jl-se-remove{opacity:1}}
.jl-se-row[data-focused="true"] .jl-se-remove,.jl-se-remove:focus-visible{opacity:1}
.jl-se-popover{position:absolute;z-index:30;top:calc(100% - 4px);left:0;max-width:min(100%,520px);min-width:min(100%,260px);box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 10px;background:var(--se-pop);color:var(--se-fg);border:1px solid var(--se-border);border-radius:8px;box-shadow:0 12px 32px -8px rgba(0,0,0,.22),0 3px 10px -4px rgba(0,0,0,.12);animation:jl-se-fade .12s var(--se-ease)}
.jl-se-lint{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:calc(12.5px * var(--jl-font-scale, 1));line-height:1.4}
.jl-se-lint[data-severity="error"]{color:var(--se-danger)}
.jl-se-lint[data-severity="warning"]{color:color-mix(in srgb,var(--se-warn) 75%,var(--se-fg))}
.jl-se-lint[data-severity="info"]{color:var(--se-muted)}
.jl-se-fix{appearance:none;display:inline-flex;align-items:center;height:22px;box-sizing:border-box;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:calc(12px * var(--jl-font-scale, 1));font-weight:500;border-radius:5px;padding:0 8px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .12s var(--se-ease)}
.jl-se-fix:active{transform:scale(.97)}
.jl-se-expansion{margin:2px 0 0;font-size:calc(12.5px * var(--jl-font-scale, 1));color:var(--se-muted)}
.jl-se-expansion summary{cursor:pointer;list-style:none;display:inline-block;line-height:20px;border-radius:4px;padding:0 4px;margin-left:-4px;user-select:none}
.jl-se-expansion summary::-webkit-details-marker{display:none}
.jl-se-expansion ol{margin:4px 0 2px;padding:0 0 0 10px;list-style:none;border-left:2px solid color-mix(in srgb,var(--se-type,var(--se-warn)) 50%,transparent);font-family:var(--se-mono);line-height:1.6}
.jl-se-expansion-tag{display:inline-block;margin-right:6px;color:color-mix(in srgb,var(--se-muted) 70%,transparent)}
.jl-se-suggest{display:flex;flex-wrap:wrap;gap:4px;align-items:center;font-size:calc(12px * var(--jl-font-scale, 1));color:var(--se-muted)}
.jl-se-suggest button{appearance:none;display:inline-flex;align-items:center;height:20px;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:calc(12px * var(--jl-font-scale, 1));border-radius:4px;padding:0 6px;cursor:pointer;font-family:var(--se-mono);transition:transform .15s var(--se-ease),background-color .12s var(--se-ease)}
.jl-se-suggest button:active{transform:scale(.97)}
.jl-se-picker{position:absolute;z-index:40;top:calc(100% + 2px);left:0;min-width:300px;max-width:min(440px,90vw);max-height:300px;overflow:auto;background:var(--se-pop);color:var(--se-fg);border:1px solid var(--se-border);border-radius:8px;box-shadow:0 16px 40px -8px rgba(0,0,0,.25),0 4px 12px -4px rgba(0,0,0,.12);padding:4px;transform-origin:top left;animation:jl-se-pop .16s var(--se-ease)}
.jl-se-picker-head{font-size:calc(12px * var(--jl-font-scale, 1));font-weight:500;color:var(--se-muted);padding:6px 8px 4px}
.jl-se-option{display:flex;justify-content:space-between;gap:12px;align-items:center;min-height:28px;box-sizing:border-box;padding:4px 8px;border-radius:5px;cursor:pointer;font-size:calc(13px * var(--jl-font-scale, 1))}
.jl-se-option[aria-selected="true"]{background:var(--se-hover)}
.jl-se-option-main{display:inline-flex;align-items:center;gap:8px;min-width:0}
.jl-se-option-rail{width:4px;height:14px;border-radius:2px;background:var(--se-t-act);flex:none}
.jl-se-option-rail[data-type="assert"]{background:var(--se-t-assert)}
.jl-se-option-rail[data-type="open"]{background:var(--se-t-open)}
.jl-se-option-rail[data-type="login"],.jl-se-option-rail[data-type="macro"]{background:var(--se-t-login)}
.jl-se-option-rail[data-type="use"]{background:var(--se-t-use)}
.jl-se-option-rail[data-type="wait"]{background:var(--se-t-wait)}
.jl-se-option-rail[data-type="extract"]{background:var(--se-t-extract)}
.jl-se-option-rail[data-type="screenshot"]{background:var(--se-t-screenshot)}
.jl-se-option-rail[data-type="note"]{background:var(--se-t-note)}
.jl-se-option-detail{font-size:calc(12px * var(--jl-font-scale, 1));color:var(--se-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jl-se-option code{font-family:var(--se-mono);font-size:calc(12.5px * var(--jl-font-scale, 1))}
.jl-se-form{display:flex;flex-direction:column;gap:6px;padding:6px 8px 8px}
.jl-se-form label{display:grid;grid-template-columns:110px 1fr;gap:8px;align-items:center;font-size:calc(12.5px * var(--jl-font-scale, 1));color:var(--se-muted)}
.jl-se-form input{height:28px;box-sizing:border-box;border:1px solid var(--se-input);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:calc(13px * var(--jl-font-scale, 1));border-radius:6px;padding:0 8px;outline:none}
.jl-se-form input:focus-visible{border-color:color-mix(in srgb,var(--se-ring) 60%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--se-ring) 25%,transparent)}
.jl-se-form-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.jl-se-btn{appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;box-sizing:border-box;border:1px solid var(--se-border);background:var(--se-bg);color:var(--se-fg);font:inherit;font-size:calc(12.5px * var(--jl-font-scale, 1));font-weight:500;border-radius:6px;padding:0 10px;cursor:pointer;transition:transform .15s var(--se-ease),background-color .12s var(--se-ease)}
.jl-se-btn:active{transform:scale(.97)}
.jl-se-btn[data-variant="primary"]{background:var(--se-accent);border-color:transparent;color:var(--se-on-accent)}
.jl-se-iconbtn{appearance:none;display:inline-grid;place-items:center;min-width:24px;height:24px;border:0;background:transparent;color:var(--se-muted);cursor:pointer;border-radius:6px;padding:0 4px;font-size:calc(13px * var(--jl-font-scale, 1));transition:transform .15s var(--se-ease),background-color .12s var(--se-ease),color .12s var(--se-ease)}
.jl-se-iconbtn:active{transform:scale(.97)}
.jl-se-help{position:relative;flex:none}
.jl-se-helpbtn{width:24px;height:24px;border:1px solid var(--se-border);border-radius:999px;font-weight:600;font-size:calc(12px * var(--jl-font-scale, 1))}
.jl-se-helpbtn[aria-expanded="true"]{background:var(--se-hover);color:var(--se-fg)}
.jl-se-cheat{position:absolute;z-index:40;right:0;top:calc(100% + 6px);display:grid;gap:7px;min-width:250px;box-sizing:border-box;padding:10px 12px;background:var(--se-pop);color:var(--se-muted);border:1px solid var(--se-border);border-radius:8px;box-shadow:0 12px 32px -8px rgba(0,0,0,.22),0 3px 10px -4px rgba(0,0,0,.12);font-size:calc(12px * var(--jl-font-scale, 1));line-height:18px;transform-origin:top right;animation:jl-se-pop .16s var(--se-ease)}
.jl-se-cheat span{display:flex;align-items:center;white-space:nowrap}
.jl-se-cheat kbd{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;box-sizing:border-box;font-family:inherit;font-size:calc(11px * var(--jl-font-scale, 1));font-weight:500;color:var(--se-fg);border:1px solid var(--se-border);background:var(--se-subtle);border-radius:4px;padding:0 4px;margin-right:4px}
.jl-se-cheat kbd + kbd{margin-left:-1px}
.jl-se-add{appearance:none;display:flex;align-items:center;gap:6px;height:36px;box-sizing:border-box;border:1px dashed var(--se-input);background:transparent;color:var(--se-muted);font:inherit;font-size:calc(13px * var(--jl-font-scale, 1));font-weight:500;border-radius:8px;padding:0 12px;cursor:pointer;margin:8px 4px 0 0;text-align:left;transition:transform .15s var(--se-ease),background-color .12s var(--se-ease),color .12s var(--se-ease)}
.jl-se-add:active{transform:scale(.99)}
@media (hover: hover) and (pointer: fine){.jl-se-mode:hover{color:var(--se-fg)}button.jl-se-verb:hover{background:color-mix(in srgb,var(--se-type,var(--se-fg)) 10%,transparent)}button.jl-se-params:hover{background:color-mix(in srgb,var(--se-type,var(--se-fg)) 8%,transparent)}.jl-se-fix:hover,.jl-se-suggest button:hover,.jl-se-btn:hover{background:var(--se-hover)}.jl-se-btn[data-variant="primary"]:hover{background:color-mix(in srgb,var(--se-accent) 90%,black)}.jl-se-iconbtn:hover{background:var(--se-hover);color:var(--se-fg)}.jl-se-add:hover{background:var(--se-hover);color:var(--se-fg);border-style:solid}.jl-se-expansion summary:hover{background:var(--se-hover);color:var(--se-fg)}}
@keyframes jl-se-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
@keyframes jl-se-fade{from{opacity:0}to{opacity:1}}
@keyframes jl-se-enter{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.jl-se-picker[data-keyboard="true"]{animation:none}
.jl-se-text{width:100%;box-sizing:border-box;min-height:360px;font-family:var(--se-mono);font-size:calc(13px * var(--jl-font-scale, 1));line-height:1.55;border:1px solid var(--se-input);border-radius:8px;padding:10px 12px;background:var(--se-bg);color:var(--se-fg);resize:vertical;tab-size:2;outline:none;box-shadow:0 1px 2px rgba(16,17,20,.04)}
.jl-se-text:focus-visible{border-color:color-mix(in srgb,var(--se-ring) 60%,transparent);box-shadow:0 0 0 2px color-mix(in srgb,var(--se-ring) 25%,transparent)}
@media (prefers-reduced-motion: reduce){.jl-se-row[data-enter="true"],.jl-se-picker,.jl-se-cheat{animation-name:jl-se-fade;animation-duration:.12s}.jl-se-chip:active,.jl-se-fix:active,.jl-se-btn:active,.jl-se-add:active,.jl-se-iconbtn:active,button.jl-se-params:active,.jl-se-suggest button:active{transform:none}.jl-se-mode,.jl-se-chip,.jl-se-fix,.jl-se-btn,.jl-se-add,.jl-se-iconbtn,.jl-se-params,.jl-se-suggest button{transition-property:background-color,color,border-color}}
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
