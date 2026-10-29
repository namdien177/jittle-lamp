import { memo, useState } from "react";
import type * as React from "react";
import { Bookmark, RotateCcw, RotateCw } from "lucide-react";
import { timelineLanes, type TimelineLane, type TimelineLaneMark } from "@jittle-lamp/viewer-core";

import { SeekTip, formatClock, pct, stepAtTime, type StepSegment } from "./seek-bar";

// The desktop viewer's lane timeline on the web: one lane each for actions, network, console and
// markers (plus the run's steps when there are any) under the controls, with the playhead across
// all of them. Requests are drawn as bars as long as they took. A range input over the lanes does
// the seeking, so dragging tracks the pointer and the keyboard moves 5 s like the desktop arrows.

const NUDGE_SECONDS = 5;

type LaneTimelineProps = {
  currentTime: number;
  duration: number;
  marks: readonly TimelineLaneMark[];
  segments: readonly StepSegment[];
  activeStepId?: string | null | undefined;
  onSeek: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onSeekTo: (seconds: number) => void;
};

function markStyle(mark: TimelineLaneMark, durationMs: number): React.CSSProperties {
  const left = `${(mark.offsetMs / durationMs) * 100}%`;
  // A tick for a moment; a bar for anything that took time.
  if (!mark.durationMs || mark.durationMs <= 0) return { left };
  return { left, width: `${(mark.durationMs / durationMs) * 100}%` };
}

function LaneMark(props: { mark: TimelineLaneMark; durationMs: number }): React.JSX.Element {
  const { mark } = props;
  if (mark.lane === "markers") {
    return (
      <span className="jl-vm-lane-marker" data-severity={mark.severity} style={markStyle(mark, props.durationMs)}>
        <Bookmark aria-hidden size={11} strokeWidth={2.25} />
      </span>
    );
  }
  const spans = Boolean(mark.durationMs && mark.durationMs > 0);
  return (
    <span
      className="jl-vm-lane-mark"
      data-lane={mark.lane}
      data-severity={mark.severity}
      data-span={spans ? "true" : "false"}
      style={markStyle(mark, props.durationMs)}
    />
  );
}

function StepLaneSegment(props: { segment: StepSegment; duration: number; activeStepId?: string | null | undefined }): React.JSX.Element {
  const { segment, duration } = props;
  return (
    <span
      className="jl-vm-lane-step"
      data-status={segment.step.status}
      data-active={segment.step.stepId === props.activeStepId ? "true" : "false"}
      style={{ left: pct(segment.startSeconds, duration), width: pct(segment.endSeconds - segment.startSeconds, duration) }}
    />
  );
}

// Marks past the end of the video (a request still open at stop) have nowhere to go.
function groupMarksByLane(marks: readonly TimelineLaneMark[], durationMs: number): Map<TimelineLane, TimelineLaneMark[]> {
  const groups = new Map<TimelineLane, TimelineLaneMark[]>();
  for (const mark of marks) {
    if (mark.offsetMs > durationMs) continue;
    const group = groups.get(mark.lane) ?? [];
    group.push(mark);
    groups.set(mark.lane, group);
  }
  return groups;
}

// Redrawn only when the recording or its steps change, not on every time update.
const LaneRows = memo(function LaneRows(props: {
  marks: readonly TimelineLaneMark[];
  segments: readonly StepSegment[];
  duration: number;
  activeStepId?: string | null | undefined;
}): React.JSX.Element {
  const durationMs = props.duration * 1000;
  const byLane = groupMarksByLane(props.marks, durationMs);
  return (
    <>
      {props.segments.length > 0 ? (
        <span className="jl-vm-lane" data-lane="steps">
          {props.segments.map((segment) => (
            <StepLaneSegment key={segment.step.stepId} segment={segment} duration={props.duration} activeStepId={props.activeStepId} />
          ))}
        </span>
      ) : null}
      {timelineLanes.map(({ lane }) => (
        <span key={lane} className="jl-vm-lane" data-lane={lane}>
          {(byLane.get(lane) ?? []).map((mark) => (
            <LaneMark key={mark.id} mark={mark} durationMs={durationMs} />
          ))}
        </span>
      ))}
    </>
  );
});

export function LaneTimeline(props: LaneTimelineProps): React.JSX.Element {
  const [hover, setHover] = useState<{ ratio: number; seconds: number } | null>(null);
  const { duration, segments } = props;
  const clamped = Math.min(props.currentTime, duration || props.currentTime);
  const stepCaption = segments.length > 0 ? `, step ${stepAtTime(segments, props.currentTime)?.step.ordinal ?? "—"}` : "";

  const trackHover = (event: React.PointerEvent<HTMLSpanElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    // Nothing to read out before the video reports its length.
    if (rect.width <= 0 || duration <= 0) return;
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHover({ ratio, seconds: ratio * duration });
  };

  const nudgeByKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Other keys keep the range input's own behaviour (Home, End, Page Up/Down).
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    props.onSeekTo(Math.min(duration, Math.max(0, props.currentTime + direction * NUDGE_SECONDS)));
  };

  return (
    <div className="jl-vm-vc-progress jl-vm-lanes" style={{ "--jl-vm-seek-progress": pct(clamped, duration) } as React.CSSProperties}>
      <span className="jl-vm-lanes-labels" aria-hidden>
        {segments.length > 0 ? <span className="jl-vm-lanes-label">Steps</span> : null}
        {timelineLanes.map(({ lane, label }) => (
          <span key={lane} className="jl-vm-lanes-label">{label}</span>
        ))}
      </span>
      <span className="jl-vm-lanes-track" onPointerMove={trackHover} onPointerLeave={() => setHover(null)}>
        {duration > 0 ? <LaneRows marks={props.marks} segments={segments} duration={duration} activeStepId={props.activeStepId} /> : null}
        <span className="jl-vm-lanes-head" aria-hidden />
        <input
          type="range"
          className="jl-vm-lanes-input"
          min={0}
          max={duration || 0}
          step="any"
          value={clamped}
          onChange={props.onSeek}
          onKeyDown={nudgeByKey}
          aria-label="Seek"
          aria-valuetext={`${formatClock(props.currentTime)} of ${formatClock(duration)}${stepCaption}`}
        />
        {hover ? <SeekTip ratio={hover.ratio} seconds={hover.seconds} segments={segments} /> : null}
      </span>
    </div>
  );
}

/** Back and forward 5 s, the desktop transport's rewind and fast-forward. */
export function NudgeButtons(props: { currentTime: number; duration: number; onSeekTo: (seconds: number) => void }): React.JSX.Element {
  const nudge = (direction: -1 | 1): void => {
    props.onSeekTo(Math.min(props.duration, Math.max(0, props.currentTime + direction * NUDGE_SECONDS)));
  };
  return (
    <>
      <button type="button" className="jl-vm-vc-icon jl-vm-vc-back" aria-label="Back 5 seconds" data-tip="Back 5 s" data-tip-side="top" onClick={() => nudge(-1)}>
        <RotateCcw aria-hidden size={17} />
      </button>
      <button type="button" className="jl-vm-vc-icon jl-vm-vc-forward" aria-label="Forward 5 seconds" data-tip="Forward 5 s" data-tip-side="top" onClick={() => nudge(1)}>
        <RotateCw aria-hidden size={17} />
      </button>
    </>
  );
}
