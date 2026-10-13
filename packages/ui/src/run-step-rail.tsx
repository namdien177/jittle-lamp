import React from "react";
import { Zap } from "lucide-react";

// Horizontal step rail of a test run (roadmap 2026-10-13 §3.5): one pill per top-level step,
// number plus a status dot, macro children folded under their parent with a count. Presentational:
// the host owns the selection and says whether it moved by pointer (160 ms colour transition) or
// by key (no transition). A failed step pulses once when its status changes to failed, never on
// mount, so a finished run opens still.

export type RunStepRailStep = {
  stepId: string;
  parentStepId: string | null;
  ordinal: number;
  type: string;
  label: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
  mode: "agent" | "replayed" | "handoff" | "deterministic" | "api-replayed" | "api-handoff" | "query" | null;
};

export type RunStepRailPill = {
  step: RunStepRailStep;
  // Expanded macro steps under this one; shown as a count, never as pills.
  childCount: number;
};

export type RunStepRailProps = {
  steps: readonly RunStepRailStep[];
  activeStepId: string | null;
  // The step under the recording's playhead; marked when it differs from the selection.
  playingStepId?: string | null;
  onSelect: (stepId: string) => void;
  // The last selection came from the keyboard: the highlight moves without transition.
  instant?: boolean;
  // Wraps a pill, e.g. in the host's tooltip. The pill is the trigger and carries its own props.
  renderPill?: (pill: RunStepRailPill, element: React.ReactElement) => React.ReactNode;
  // Right end of the rail (the Details toggle).
  trailing?: React.ReactNode;
  className?: string;
};

export const railStatusLabel: Record<RunStepRailStep["status"], string> = {
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  skipped: "skipped"
};

const railModeLabel: Record<NonNullable<RunStepRailStep["mode"]>, string> = {
  agent: "agent",
  replayed: "replayed",
  handoff: "hand-off",
  deterministic: "direct",
  "api-replayed": "API replayed",
  "api-handoff": "API hand-off",
  query: "query"
};

// Top-level steps in order, each with the number of expanded macro steps it owns.
export function railPills(steps: readonly RunStepRailStep[]): RunStepRailPill[] {
  const counts = new Map<string, number>();
  for (const step of steps) {
    if (step.parentStepId === null) continue;
    counts.set(step.parentStepId, (counts.get(step.parentStepId) ?? 0) + 1);
  }
  return steps.filter((step) => step.parentStepId === null).map((step) => ({ step, childCount: counts.get(step.stepId) ?? 0 }));
}

// The pill to select for prev/next from `activeStepId`; from no selection, next is the first pill
// and prev the last. Null when the rail is empty or the move runs off its end.
export function adjacentPillId(pills: readonly RunStepRailPill[], activeStepId: string | null, direction: -1 | 1): string | null {
  if (pills.length === 0) return null;
  const index = activeStepId === null ? -1 : pills.findIndex((pill) => pill.step.stepId === activeStepId);
  if (index === -1) return (direction === 1 ? pills[0] : pills[pills.length - 1])?.step.stepId ?? null;
  return pills[index + direction]?.step.stepId ?? null;
}

// `n`/`j` move to the next step, `p`/`k` to the previous one; nothing else is a rail key.
export function railKeyCommand(key: string): "next" | "prev" | null {
  if (key === "n" || key === "j") return "next";
  if (key === "p" || key === "k") return "prev";
  return null;
}

// Where the rail should scroll so `pill` is fully visible with `padding` on either side, or null
// when it already is. Pure so the overflow logic is testable without a layout engine.
export function railScrollTarget(
  container: { scrollLeft: number; clientWidth: number },
  pill: { offsetLeft: number; offsetWidth: number },
  padding = 16
): number | null {
  const start = pill.offsetLeft - padding;
  const end = pill.offsetLeft + pill.offsetWidth + padding;
  if (start < container.scrollLeft) return Math.max(0, start);
  if (end > container.scrollLeft + container.clientWidth) return end - container.clientWidth;
  return null;
}

export function railPillTitle(pill: RunStepRailPill): string {
  const { step } = pill;
  const parts = [`Step ${step.ordinal} · ${step.type}`, railStatusLabel[step.status]];
  if (step.mode) parts.push(railModeLabel[step.mode]);
  if (pill.childCount > 0) parts.push(`${pill.childCount} macro step${pill.childCount === 1 ? "" : "s"}`);
  return `${parts.join(" · ")}\n${step.label}`;
}

// Colours reuse the run step list's palette so both step views agree; tokens let a host retune.
const styles = `
.jl-rail{display:flex;align-items:center;gap:8px;min-width:0;font:inherit;--jl-rail-c-passed:var(--jl-rail-passed,#16a34a);--jl-rail-c-failed:var(--jl-rail-failed,#dc2626);--jl-rail-c-blocked:var(--jl-rail-blocked,#d97706);--jl-rail-c-running:var(--jl-rail-running,#2563eb);--jl-rail-c-replayed:var(--jl-rail-replayed,#22c55e);--jl-rail-c-idle:var(--jl-rail-idle,#6b7280);--jl-rail-ease:var(--ease-out,cubic-bezier(.23,1,.32,1))}
.jl-rail-track{display:flex;align-items:center;gap:6px;flex:1 1 auto;min-width:0;height:44px;padding:0 8px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;list-style:none;margin:0}
.jl-rail-track::-webkit-scrollbar{display:none}
.jl-rail-track>li{flex:0 0 auto;display:flex}
.jl-rail-pill{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px 0 9px;border-radius:999px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;font-size:calc(12px * var(--jl-font-scale,1));font-weight:500;font-variant-numeric:tabular-nums;line-height:1;cursor:pointer;transition:background-color .16s var(--jl-rail-ease),border-color .16s var(--jl-rail-ease),color .16s var(--jl-rail-ease),transform .16s var(--jl-rail-ease)}
.jl-rail[data-instant="true"] .jl-rail-pill{transition:transform .16s var(--jl-rail-ease)}
@media (hover: hover) and (pointer: fine){.jl-rail-pill:hover{background:color-mix(in srgb,currentColor 6%,transparent)}}
.jl-rail-pill:active{transform:scale(.97)}
.jl-rail-pill:focus-visible{outline:2px solid color-mix(in srgb,var(--jl-rail-c-replayed) 60%,transparent);outline-offset:-2px}
.jl-rail-pill[data-active="true"]{background:color-mix(in srgb,currentColor 9%,transparent);border-color:color-mix(in srgb,currentColor 16%,transparent)}
.jl-rail-pill[data-status="failed"][data-active="true"]{background:color-mix(in srgb,var(--jl-rail-c-failed) 12%,transparent);border-color:color-mix(in srgb,var(--jl-rail-c-failed) 40%,transparent)}
.jl-rail-pill[data-status="failed"]{color:var(--jl-rail-c-failed)}
.jl-rail-pill[data-status="pending"],.jl-rail-pill[data-status="skipped"]{opacity:.55}
.jl-rail-pill[data-playing="true"]:not([data-active="true"]){border-color:color-mix(in srgb,var(--jl-rail-c-replayed) 45%,transparent)}
.jl-rail-pill[data-pulse="true"]{animation:jl-rail-pulse .3s var(--jl-rail-ease) 1}
.jl-rail-dot{position:relative;flex:0 0 auto;width:8px;height:8px;border-radius:999px;background:var(--jl-rail-c-idle);transition:background-color .2s ease}
.jl-rail-pill[data-status="passed"] .jl-rail-dot{background:var(--jl-rail-c-passed)}
.jl-rail-pill[data-status="failed"] .jl-rail-dot{background:var(--jl-rail-c-failed)}
.jl-rail-pill[data-status="blocked"] .jl-rail-dot{background:var(--jl-rail-c-blocked)}
.jl-rail-pill[data-status="running"] .jl-rail-dot{background:var(--jl-rail-c-running)}
.jl-rail-pill[data-status="running"] .jl-rail-dot::after{content:"";position:absolute;inset:-3px;border-radius:999px;border:1.5px solid transparent;border-top-color:var(--jl-rail-c-running);animation:jl-rail-spin .8s linear infinite}
.jl-rail-pill[data-status="pending"] .jl-rail-dot,.jl-rail-pill[data-status="skipped"] .jl-rail-dot{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.jl-rail-num{display:inline-block;min-width:1ch;text-align:center}
.jl-rail-bolt{flex:0 0 auto;width:10px;height:10px;color:var(--jl-rail-c-replayed)}
.jl-rail-bolt svg{display:block;width:10px;height:10px;stroke-width:2.5}
.jl-rail-kids{font-size:calc(10px * var(--jl-font-scale,1));opacity:.6;letter-spacing:.02em}
.jl-rail-trailing{flex:0 0 auto;display:flex;align-items:center;padding-right:8px}
@keyframes jl-rail-spin{to{transform:rotate(360deg)}}
@keyframes jl-rail-pulse{50%{transform:scale(1.02)}}
@media (prefers-reduced-motion: reduce){.jl-rail-pill{transition:background-color .16s var(--jl-rail-ease),border-color .16s var(--jl-rail-ease),color .16s var(--jl-rail-ease)}.jl-rail-pill:active{transform:none}.jl-rail-pill[data-pulse="true"]{animation:none}.jl-rail-pill[data-status="running"] .jl-rail-dot::after{animation:none;border-color:var(--jl-rail-c-running)}}
`;

let injected = false;
function injectStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.dataset.jlRunStepRail = "true";
  style.textContent = styles;
  document.head.append(style);
}

// Steps whose status just turned failed (known before as something else) pulse once.
function newlyFailed(previous: ReadonlyMap<string, RunStepRailStep["status"]>, pills: readonly RunStepRailPill[]): string | null {
  for (const pill of pills) {
    const before = previous.get(pill.step.stepId);
    if (before !== undefined && before !== "failed" && pill.step.status === "failed") return pill.step.stepId;
  }
  return null;
}

export function RunStepRail(props: RunStepRailProps): React.JSX.Element {
  injectStyles();
  const trackRef = React.useRef<HTMLOListElement | null>(null);
  const pills = React.useMemo(() => railPills(props.steps), [props.steps]);
  const statuses = React.useRef(new Map<string, RunStepRailStep["status"]>());
  const [pulseId, setPulseId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const failed = newlyFailed(statuses.current, pills);
    statuses.current = new Map(pills.map((pill) => [pill.step.stepId, pill.step.status]));
    if (failed) setPulseId(failed);
  }, [pills]);

  // The selected pill stays in view; a keyboard move jumps, a click glides.
  React.useEffect(() => {
    const track = trackRef.current;
    if (!track || !props.activeStepId) return;
    const pill = Array.from(track.querySelectorAll<HTMLElement>("[data-step-id]")).find((node) => node.dataset.stepId === props.activeStepId);
    if (!pill) return;
    const left = railScrollTarget(track, pill);
    if (left === null) return;
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({ left, behavior: props.instant || reduce ? "auto" : "smooth" });
  }, [props.activeStepId, props.instant]);

  return (
    <div className={["jl-rail", props.className].filter(Boolean).join(" ")} data-instant={props.instant ? "true" : "false"}>
      <ol ref={trackRef} className="jl-rail-track" aria-label="Test run steps">
        {pills.map((pill) => {
          const { step } = pill;
          const active = props.activeStepId === step.stepId;
          const element = (
            <button
              type="button"
              className="jl-rail-pill"
              data-step-id={step.stepId}
              data-status={step.status}
              data-active={active ? "true" : "false"}
              data-playing={props.playingStepId === step.stepId ? "true" : "false"}
              data-pulse={pulseId === step.stepId ? "true" : "false"}
              aria-current={active ? "step" : undefined}
              aria-label={`Step ${step.ordinal}, ${railStatusLabel[step.status]}: ${step.label}`}
              {...(props.renderPill ? {} : { title: railPillTitle(pill) })}
              onClick={() => props.onSelect(step.stepId)}
              onAnimationEnd={() => setPulseId((current) => (current === step.stepId ? null : current))}
            >
              <span className="jl-rail-dot" aria-hidden />
              <span className="jl-rail-num">{step.ordinal}</span>
              {pill.childCount > 0 ? <span className="jl-rail-kids">{`+${pill.childCount}`}</span> : null}
              {step.mode === "replayed" ? (
                <span className="jl-rail-bolt" role="img" aria-label="replayed">
                  <Zap aria-hidden />
                </span>
              ) : null}
            </button>
          );
          return <li key={step.stepId}>{props.renderPill ? props.renderPill(pill, element) : element}</li>;
        })}
      </ol>
      {props.trailing ? <div className="jl-rail-trailing">{props.trailing}</div> : null}
    </div>
  );
}
