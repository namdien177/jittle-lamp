import React from "react";

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

export function formatCostUsd(cost: number | null): string {
  if (cost === null) return "";
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

const styles = `
.jl-run-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;font:inherit}
.jl-run-step{display:grid;grid-template-columns:20px 1fr auto;gap:2px 10px;align-items:start;width:100%;text-align:left;padding:8px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;cursor:pointer;transition:background-color .15s cubic-bezier(.23,1,.32,1),transform .15s cubic-bezier(.23,1,.32,1)}
.jl-run-step:hover{background:color-mix(in srgb,currentColor 6%,transparent)}
.jl-run-step:active{transform:scale(.97)}
.jl-run-step[data-active="true"]{border-color:color-mix(in srgb,#22c55e 45%,transparent);background:color-mix(in srgb,#22c55e 10%,transparent)}
.jl-run-step[data-child="true"]{padding-left:28px}
.jl-run-step-dot{width:10px;height:10px;border-radius:999px;margin-top:5px;background:#9ca3af}
.jl-run-step[data-status="passed"] .jl-run-step-dot{background:#22c55e}
.jl-run-step[data-status="failed"] .jl-run-step-dot{background:#ef4444}
.jl-run-step[data-status="blocked"] .jl-run-step-dot{background:#f59e0b}
.jl-run-step[data-status="running"] .jl-run-step-dot{background:#3b82f6;animation:jl-run-step-pulse 1.2s ease-in-out infinite}
.jl-run-step[data-status="skipped"],.jl-run-step[data-status="pending"]{opacity:.6}
.jl-run-step-label{overflow-wrap:anywhere;line-height:1.35}
.jl-run-step-type{font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.65;margin-right:6px}
.jl-run-step-meta{font-size:12px;opacity:.7;white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.jl-run-step-mode{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);margin-left:6px}
.jl-run-step-mode[data-mode="replayed"]{border-color:color-mix(in srgb,#22c55e 50%,transparent)}
.jl-run-step-mode[data-mode="handoff"]{border-color:color-mix(in srgb,#f59e0b 60%,transparent)}
.jl-run-step-detail{grid-column:2 / 4;font-size:12px;line-height:1.4;opacity:.85;overflow-wrap:anywhere}
.jl-run-step-detail[data-tone="error"]{color:#ef4444;opacity:1}
.jl-run-step-shot{grid-column:2 / 4;max-width:220px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);margin-top:4px}
@keyframes jl-run-step-pulse{50%{opacity:.35}}
@media (prefers-reduced-motion: reduce){.jl-run-step,.jl-run-step:active{transition:none;transform:none}.jl-run-step[data-status="running"] .jl-run-step-dot{animation:none}}
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

export function RunStepList(props: RunStepListProps): React.JSX.Element {
  injectStyles();
  const visible = props.expandMacros ? props.steps : props.steps.filter((step) => step.parentStepId === null);
  return (
    <ol className={["jl-run-steps", props.className].filter(Boolean).join(" ")} aria-label="Test run steps">
      {visible.map((step) => {
        const isChild = step.parentStepId !== null;
        const detail = step.error ? `${step.error.code}: ${step.error.message}` : step.status === "failed" || step.status === "blocked" ? step.observed : null;
        const meta = [formatStepDuration(step.durationMs), step.usage.modelCalls > 0 ? `${step.usage.modelCalls} call${step.usage.modelCalls === 1 ? "" : "s"}` : "", formatCostUsd(step.usage.costUsd)]
          .filter(Boolean)
          .join(" · ");
        return (
          <li key={step.stepId}>
            <button
              type="button"
              className="jl-run-step"
              data-status={step.status}
              data-child={isChild ? "true" : "false"}
              data-active={props.activeStepId === step.stepId ? "true" : "false"}
              data-step-id={step.stepId}
              aria-current={props.activeStepId === step.stepId ? "step" : undefined}
              onClick={() => props.onSelect?.(step)}
              title={`${statusLabel[step.status]}${step.cacheReason && step.mode !== "replayed" ? ` · cache: ${step.cacheReason}` : ""}`}
            >
              <span className="jl-run-step-dot" aria-label={statusLabel[step.status]} />
              <span className="jl-run-step-label">
                <span className="jl-run-step-type">{isChild ? "" : `${step.ordinal}. `}{step.type}</span>
                {step.label}
                {step.mode ? (
                  <span className="jl-run-step-mode" data-mode={step.mode}>
                    {modeLabel[step.mode]}
                  </span>
                ) : null}
              </span>
              <span className="jl-run-step-meta">{meta}</span>
              {detail ? (
                <span className="jl-run-step-detail" data-tone={step.error ? "error" : "neutral"}>
                  {detail}
                </span>
              ) : null}
              {step.screenshotUrl && (props.screenshots ?? "all") !== "none" && ((props.screenshots ?? "all") === "all" || props.activeStepId === step.stepId) ? <img className="jl-run-step-shot" src={step.screenshotUrl} alt={`Screen after step ${step.ordinal}`} loading="lazy" /> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
