import { useState } from "react";
import type * as React from "react";
import { SkipBack, SkipForward } from "lucide-react";

import type { ViewerStepChip } from "./types";

// Seek bar shared by both players (native and video.js). With test-run steps the track is split
// into one segment per step, coloured by its result, so a reviewer sees where each step sits in
// the recording and which one failed before pressing play. The native range input stays on top
// for dragging and keyboard seeking.

export type StepSegment = {
  step: ViewerStepChip;
  startSeconds: number;
  endSeconds: number;
};

// A step without an end runs until the next step starts, the last one to the end of the video.
export function buildStepSegments(steps: readonly ViewerStepChip[] | undefined, durationSeconds: number): StepSegment[] {
  if (!steps || steps.length === 0 || durationSeconds <= 0) return [];
  const ordered = [...steps].sort((a, b) => a.startMs - b.startMs);
  return ordered.flatMap((step, index) => {
    const startSeconds = Math.min(step.startMs / 1000, durationSeconds);
    const nextStart = ordered[index + 1]?.startMs;
    const endMs = step.endMs ?? nextStart ?? durationSeconds * 1000;
    const endSeconds = Math.min(Math.max(endMs / 1000, startSeconds), durationSeconds);
    if (startSeconds >= durationSeconds) return [];
    return [{ step, startSeconds, endSeconds }];
  });
}

/** The step playing at `seconds`: the last one that started at or before it. */
export function stepAtTime(segments: readonly StepSegment[], seconds: number): StepSegment | null {
  let found: StepSegment | null = null;
  for (const segment of segments) {
    if (segment.startSeconds <= seconds + 0.05) found = segment;
    else break;
  }
  return found;
}

// Previous restarts the current step once it has played a moment, like a music player's back
// button; pressed right at a step start it goes one step further back.
export function adjacentStepStart(segments: readonly StepSegment[], seconds: number, direction: -1 | 1): number | null {
  if (direction === 1) return segments.find((segment) => segment.startSeconds > seconds + 0.05)?.startSeconds ?? null;
  const started = segments.filter((segment) => segment.startSeconds <= seconds + 0.05);
  const current = started.at(-1);
  if (!current) return null;
  if (seconds - current.startSeconds > 1.5) return current.startSeconds;
  return started.at(-2)?.startSeconds ?? 0;
}

function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function pct(seconds: number, duration: number): string {
  return `${duration > 0 ? (seconds / duration) * 100 : 0}%`;
}

type SeekBarProps = {
  currentTime: number;
  duration: number;
  segments: readonly StepSegment[];
  activeStepId?: string | null | undefined;
  onSeek: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export function SeekBar(props: SeekBarProps): React.JSX.Element {
  const [hover, setHover] = useState<{ ratio: number; seconds: number } | null>(null);
  const { duration, segments } = props;
  const progress = pct(Math.min(props.currentTime, duration || props.currentTime), duration);
  const hoverSegment = hover ? stepAtTime(segments, hover.seconds) : null;
  const hoverInside = hoverSegment && hover && hover.seconds <= hoverSegment.endSeconds + 0.05 ? hoverSegment : null;

  const track = (
    <>
      <span className="jl-vm-seek-base" />
      {segments.map((segment) => (
        <span
          key={segment.step.stepId}
          className="jl-vm-seek-seg"
          data-status={segment.step.status}
          data-active={segment.step.stepId === props.activeStepId ? "true" : "false"}
          style={{ left: pct(segment.startSeconds, duration), width: pct(segment.endSeconds - segment.startSeconds, duration) }}
        />
      ))}
    </>
  );

  return (
    <div
      className="jl-vm-vc-progress jl-vm-seek"
      data-steps={segments.length > 0 ? "true" : "false"}
      style={{ "--jl-vm-seek-progress": progress } as React.CSSProperties}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || duration <= 0) return;
        const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        setHover({ ratio, seconds: ratio * duration });
      }}
      onPointerLeave={() => setHover(null)}
    >
      <span className="jl-vm-seek-track" aria-hidden>
        <span className="jl-vm-seek-layer" data-layer="ahead">{track}</span>
        <span className="jl-vm-seek-layer" data-layer="played">{track}</span>
      </span>
      <input
        type="range"
        className="jl-vm-vc-range jl-vm-seek-input"
        min={0}
        max={duration || 0}
        step={0.1}
        value={Math.min(props.currentTime, duration || props.currentTime)}
        onChange={props.onSeek}
        aria-label="Seek"
        aria-valuetext={`${formatClock(props.currentTime)} of ${formatClock(duration)}${
          segments.length > 0 ? `, step ${stepAtTime(segments, props.currentTime)?.step.ordinal ?? "—"}` : ""
        }`}
      />
      {hover ? (
        <span className="jl-vm-seek-tip" style={{ left: `${hover.ratio * 100}%` }} data-edge={hover.ratio < 0.15 ? "start" : hover.ratio > 0.85 ? "end" : "middle"} aria-hidden>
          {hoverInside ? (
            <>
              <span className="jl-vm-seek-tip-head">
                <span className="jl-vm-seek-tip-dot" data-status={hoverInside.step.status} />
                Step {hoverInside.step.ordinal} · {hoverInside.step.type}
                <span className="jl-vm-seek-tip-time">{formatClock(hover.seconds)}</span>
              </span>
              <span className="jl-vm-seek-tip-label">{hoverInside.step.label}</span>
            </>
          ) : (
            <span className="jl-vm-seek-tip-time">{formatClock(hover.seconds)}</span>
          )}
        </span>
      ) : null}
    </div>
  );
}

export function StepNavButtons(props: { segments: readonly StepSegment[]; currentTime: number; onSeekTo: (seconds: number) => void }): React.JSX.Element | null {
  if (props.segments.length === 0) return null;
  const previous = adjacentStepStart(props.segments, props.currentTime, -1);
  const next = adjacentStepStart(props.segments, props.currentTime, 1);
  return (
    <>
      <button
        type="button"
        className="jl-vm-vc-icon jl-vm-vc-step-prev"
        aria-label="Previous step"
        data-tip="Previous step"
        data-tip-side="top"
        disabled={previous === null}
        onClick={() => previous !== null && props.onSeekTo(previous)}
      >
        <SkipBack aria-hidden size={16} fill="currentColor" />
      </button>
      <button
        type="button"
        className="jl-vm-vc-icon jl-vm-vc-step-next"
        aria-label="Next step"
        data-tip="Next step"
        data-tip-side="top"
        disabled={next === null}
        onClick={() => next !== null && props.onSeekTo(next)}
      >
        <SkipForward aria-hidden size={16} fill="currentColor" />
      </button>
    </>
  );
}

/** "Step 3" for the step under the playhead; the label is in the title and the step list. */
export function StepCaption(props: { segments: readonly StepSegment[]; currentTime: number }): React.JSX.Element | null {
  if (props.segments.length === 0) return null;
  const current = stepAtTime(props.segments, props.currentTime);
  if (!current) return <span className="jl-vm-vc-step-caption" />;
  return (
    <span className="jl-vm-vc-step-caption" title={current.step.label}>
      <span className="jl-vm-seek-tip-dot" data-status={current.step.status} aria-hidden />
      <span className="jl-vm-vc-step-index">Step {current.step.ordinal}</span>
    </span>
  );
}
