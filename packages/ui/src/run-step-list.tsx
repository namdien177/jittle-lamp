import React from "react";
import { Check, LoaderCircle, Minus, TriangleAlert, X } from "lucide-react";

// Step list of a test run, shared by the web and desktop run pages (design.md §7 "Review parity:
// the step list component lives in packages/ui"). Presentational only: the host passes steps
// shaped like TestRunStep from @jittle-lamp/shared and decides what selecting a step does (seek
// the viewer to its video offset and filter the timeline by `step:<id>`).

export type RunStepListStep = {
  stepId: string;
  parentStepId: string | null;
  ordinal: number;
  type: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
  mode: "agent" | "replayed" | "handoff" | "deterministic" | null;
  cacheReason: string | null;
  durationMs: number | null;
  videoOffsetMs: number | null;
  observed: string | null;
  error: { code: string; message: string } | null;
  screenshotUrl: string | null;
  usage: { modelCalls: number; costUsd: number | null };
};

export type RunStepListProps = {
  steps: readonly RunStepListStep[];
  activeStepId?: string | null;
  onSelect?: (step: RunStepListStep) => void;
  // Expand macro calls (Login, …) to show their expanded steps.
  expandMacros?: boolean;
  // Per-step screenshots: every step (live progress, default), only the active step (when a
  // recording is next to the list), or none.
  screenshots?: "all" | "active" | "none";
  // The step under the recording's playhead (run page with a recording beside the list).
  playingStepId?: string | null;
  // Extra details shown under the selected step, e.g. mode, timing and model usage.
  renderDetail?: (step: RunStepListStep) => React.ReactNode;
  // "full" lists duration, model calls and cost on every row; "duration" keeps rows to the
  // duration when the host shows usage in renderDetail.
  meta?: "full" | "duration";
  className?: string;
};

const statusLabel: Record<RunStepListStep["status"], string> = {
  pending: "Pending",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  skipped: "Skipped"
};

const modeLabel: Record<NonNullable<RunStepListStep["mode"]>, string> = {
  agent: "agent",
  replayed: "replayed",
  handoff: "hand-off",
  deterministic: "direct"
};

export function formatStepDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

// Position in the recording, as the player shows it (m:ss).
export function formatVideoOffset(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

export function formatCostUsd(cost: number | null): string {
  if (cost === null) return "";
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

const styles = `
.jl-run-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;font:inherit;--jl-rs-rail:color-mix(in srgb,currentColor 14%,transparent)}
.jl-run-steps>li{position:relative}
.jl-run-steps>li:not(:last-child)::before{content:"";position:absolute;left:19px;top:30px;bottom:-6px;width:1.5px;border-radius:2px;background:var(--jl-rs-rail)}
.jl-run-steps>li[data-child="true"]::before,.jl-run-steps>li:has(+li[data-child="true"])::before{display:none}
.jl-run-step{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:10px;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;transition:background-color .15s ease,border-color .15s ease,transform .16s cubic-bezier(.23,1,.32,1)}
@media (hover: hover) and (pointer: fine){.jl-run-step:hover{background:color-mix(in srgb,currentColor 5%,transparent)}}
.jl-run-step:active{transform:scale(.985)}
.jl-run-step:focus-visible{outline:2px solid color-mix(in srgb,#22c55e 60%,transparent);outline-offset:-2px}
.jl-run-step[data-active="true"]{background:color-mix(in srgb,currentColor 7%,transparent);border-color:color-mix(in srgb,currentColor 14%,transparent)}
.jl-run-step[data-status="failed"][data-active="true"]{background:color-mix(in srgb,#ef4444 9%,transparent);border-color:color-mix(in srgb,#ef4444 35%,transparent)}
.jl-run-step-icon{position:relative;z-index:1;display:grid;place-items:center;width:20px;height:20px;margin-top:1px;border-radius:999px;color:#fff;background:#6b7280}
.jl-run-step-icon svg{width:12px;height:12px;stroke-width:3}
.jl-run-step[data-status="passed"] .jl-run-step-icon{background:#16a34a}
.jl-run-step[data-status="failed"] .jl-run-step-icon{background:#dc2626}
.jl-run-step[data-status="blocked"] .jl-run-step-icon{background:#d97706}
.jl-run-step[data-status="running"] .jl-run-step-icon{background:#2563eb}
.jl-run-step[data-status="running"] .jl-run-step-icon svg{animation:jl-run-step-spin 1s linear infinite}
.jl-run-step[data-status="pending"] .jl-run-step-icon,.jl-run-step[data-status="skipped"] .jl-run-step-icon{background:transparent;color:inherit;opacity:.55;box-shadow:inset 0 0 0 1.5px currentColor}
.jl-run-step[data-status="skipped"] .jl-run-step-main,.jl-run-step[data-status="pending"] .jl-run-step-main{opacity:.6}
.jl-run-step-main{display:flex;flex-direction:column;gap:3px;min-width:0}
.jl-run-step-head{display:flex;align-items:center;gap:6px;min-width:0;min-height:20px;font-size:calc(11px * var(--jl-font-scale, 1));line-height:1}
.jl-run-step-num{font-variant-numeric:tabular-nums;opacity:.6}
.jl-run-step-type{text-transform:uppercase;letter-spacing:.06em;font-weight:600;opacity:.7}
.jl-run-step-mode{padding:2px 6px;border-radius:999px;background:color-mix(in srgb,currentColor 8%,transparent);opacity:.8}
.jl-run-step-mode[data-mode="replayed"]{background:color-mix(in srgb,#22c55e 16%,transparent);opacity:1}
.jl-run-step-mode[data-mode="handoff"]{background:color-mix(in srgb,#f59e0b 20%,transparent);opacity:1}
.jl-run-step-dur{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.5}
.jl-run-step-dur+.jl-run-step-at{margin-left:0}
.jl-run-step-at{margin-left:auto;padding:2px 6px;border-radius:5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;opacity:.65;transition:color .15s ease,background-color .15s ease,opacity .15s ease}
.jl-run-step[data-playing="true"] .jl-run-step-at{opacity:1;color:#22c55e;background:color-mix(in srgb,#22c55e 14%,transparent)}
.jl-run-step-label{font-size:calc(13.5px * var(--jl-font-scale, 1));line-height:1.45;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.jl-run-step[data-active="true"] .jl-run-step-label{-webkit-line-clamp:unset;display:block}
.jl-run-step-label[data-mono="true"]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:calc(12.5px * var(--jl-font-scale, 1))}
.jl-run-step-meta{font-size:calc(11.5px * var(--jl-font-scale, 1));opacity:.6;font-variant-numeric:tabular-nums}
.jl-run-step-detail{font-size:calc(12px * var(--jl-font-scale, 1));line-height:1.45;opacity:.85;overflow-wrap:anywhere}
.jl-run-step-detail[data-tone="error"]{color:#ef4444;opacity:1}
.jl-run-step-shot{max-width:100%;max-height:180px;object-fit:contain;object-position:left;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);margin-top:4px}
.jl-run-step-extra{margin:2px 10px 6px 40px;transition:opacity .18s cubic-bezier(.23,1,.32,1),transform .18s cubic-bezier(.23,1,.32,1)}
@starting-style{.jl-run-step-extra{opacity:0;transform:translateY(-4px)}}
.jl-run-steps>li[data-child="true"] .jl-run-step{padding-left:40px;grid-template-columns:12px minmax(0,1fr);padding-top:5px;padding-bottom:5px}
.jl-run-steps>li[data-child="true"] .jl-run-step-icon{width:8px;height:8px;margin-top:6px}
.jl-run-steps>li[data-child="true"] .jl-run-step-icon svg{display:none}
.jl-run-steps>li[data-child="true"] .jl-run-step-label{font-size:calc(12.5px * var(--jl-font-scale, 1))}
@keyframes jl-run-step-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.jl-run-step,.jl-run-step-extra{transition:none}.jl-run-step:active{transform:none}.jl-run-step[data-status="running"] .jl-run-step-icon svg{animation:none}}
`;

let injected = false;
function injectStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.jlRunSteps = "true";
  style.textContent = styles;
  document.head.append(style);
}

const statusIcon: Record<RunStepListStep["status"], React.ReactNode> = {
  pending: null,
  running: <LoaderCircle aria-hidden />,
  passed: <Check aria-hidden />,
  failed: <X aria-hidden />,
  blocked: <TriangleAlert aria-hidden />,
  skipped: <Minus aria-hidden />
};

// Labels that are a path or URL read better in a monospace face.
function isPathLabel(step: RunStepListStep): boolean {
  return /^(\/|https?:\/\/)\S*$/.test(step.label.trim());
}

export function RunStepList(props: RunStepListProps): React.JSX.Element {
  injectStyles();
  const listRef = React.useRef<HTMLOListElement | null>(null);
  const visible = props.expandMacros ? props.steps : props.steps.filter((step) => step.parentStepId === null);
  // While the recording plays, keep its step in view; "nearest" leaves the list alone when the
  // step is already visible, so it never fights the reviewer's own scrolling.
  React.useEffect(() => {
    if (!props.playingStepId) return;
    const row = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-step-id]") ?? []).find((node) => node.dataset.stepId === props.playingStepId);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    row?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [props.playingStepId]);
  return (
    <ol ref={listRef} className={["jl-run-steps", props.className].filter(Boolean).join(" ")} aria-label="Test run steps">
      {visible.map((step) => {
        const isChild = step.parentStepId !== null;
        const active = props.activeStepId === step.stepId;
        // What the judge saw reads better than the error code it produced.
        const detail = step.status === "failed" || step.status === "blocked" ? (step.observed ?? (step.error ? `${step.error.code}: ${step.error.message}` : null)) : step.error ? `${step.error.code}: ${step.error.message}` : null;
        const usage = props.meta === "duration" ? [] : [step.usage.modelCalls > 0 ? `${step.usage.modelCalls} call${step.usage.modelCalls === 1 ? "" : "s"}` : "", step.usage.costUsd ? formatCostUsd(step.usage.costUsd) : ""];
        const meta = props.meta === "duration" ? "" : [formatStepDuration(step.durationMs), ...usage].filter(Boolean).join(" · ");
        const headDuration = props.meta === "duration" ? formatStepDuration(step.durationMs) : "";
        // Agent and direct are the ordinary modes; only the cache outcomes earn a badge.
        const badgeMode = step.mode === "replayed" || step.mode === "handoff" ? step.mode : null;
        const showShot = Boolean(step.screenshotUrl) && (props.screenshots ?? "all") !== "none" && ((props.screenshots ?? "all") === "all" || active);
        const extra = active ? props.renderDetail?.(step) : null;
        return (
          <li key={step.stepId} data-child={isChild ? "true" : "false"}>
            <button
              type="button"
              className="jl-run-step"
              data-status={step.status}
              data-child={isChild ? "true" : "false"}
              data-active={active ? "true" : "false"}
              data-playing={props.playingStepId === step.stepId ? "true" : "false"}
              data-step-id={step.stepId}
              aria-current={active ? "step" : undefined}
              aria-expanded={props.renderDetail ? active : undefined}
              onClick={() => props.onSelect?.(step)}
              title={`${statusLabel[step.status]}${step.mode ? ` · ${modeLabel[step.mode]}` : ""}${step.cacheReason && step.mode !== "replayed" ? ` · cache: ${step.cacheReason}` : ""}`}
            >
              <span className="jl-run-step-icon" role="img" aria-label={statusLabel[step.status]}>
                {statusIcon[step.status]}
              </span>
              <span className="jl-run-step-main">
                <span className="jl-run-step-head">
                  {isChild ? null : <span className="jl-run-step-num">{step.ordinal}</span>}
                  <span className="jl-run-step-type">{step.type}</span>
                  {badgeMode ? (
                    <span className="jl-run-step-mode" data-mode={badgeMode}>
                      {modeLabel[badgeMode]}
                    </span>
                  ) : null}
                  {headDuration ? <span className="jl-run-step-dur">{headDuration}</span> : null}
                  {step.videoOffsetMs !== null ? (
                    <span className="jl-run-step-at" aria-label={`At ${formatVideoOffset(step.videoOffsetMs)} in the recording`}>
                      {formatVideoOffset(step.videoOffsetMs)}
                    </span>
                  ) : null}
                </span>
                <span className="jl-run-step-label" data-mono={isPathLabel(step) ? "true" : "false"}>
                  {step.label}
                </span>
                {meta ? <span className="jl-run-step-meta">{meta}</span> : null}
                {detail ? (
                  <span className="jl-run-step-detail" data-tone={step.error ? "error" : "neutral"}>
                    {detail}
                  </span>
                ) : null}
                {showShot && step.screenshotUrl ? <img className="jl-run-step-shot" src={step.screenshotUrl} alt={`Screen after step ${step.ordinal}`} loading="lazy" /> : null}
              </span>
            </button>
            {extra ? <div className="jl-run-step-extra">{extra}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}
