import { useEffect, useRef, useState } from "react";
import type * as React from "react";
import { ChevronsRight } from "lucide-react";
import { gapSkipTarget, nextGapMarker } from "@jittle-lamp/viewer-core";

// Skip gaps during review: while playing, jump over idle stretches to 1.5 s before the next step.
// Both players (native and video.js) use this; the markers come from viewer-core's
// deriveGapMarkers so web and desktop skip to the same places.

const STORAGE_KEY = "jl-viewer-skip-gaps";

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

/** On by default; the choice is remembered on this device. */
export function useSkipGapsPreference(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabled] = useState(() => (typeof window === "undefined" ? true : readPreference()));
  const update = (next: boolean): void => {
    setEnabled(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this view.
    }
  };
  return [enabled, update];
}

export type GapSkipper = {
  // Called on every time update; seeks forward when the playhead sits in a gap.
  onTime: (currentSeconds: number, playing: boolean, seekTo: (seconds: number) => void) => void;
  // A seek by the user: do not skip out of the gap they chose until the next step is reached.
  onManualSeek: (seconds: number) => void;
};

/** A stable skipper for long-lived player listeners; it always reads the latest markers. */
export function useGapSkipper(markersMs: readonly number[] | undefined, enabled: boolean): GapSkipper {
  const state = useRef({ markers: markersMs ?? [], enabled, suppressedMarker: null as number | null });
  useEffect(() => {
    state.current.markers = markersMs ?? [];
    state.current.enabled = enabled;
  });
  const skipper = useRef<GapSkipper>({
    onTime(currentSeconds, playing, seekTo) {
      const { markers } = state.current;
      if (!state.current.enabled || !playing || markers.length === 0) return;
      const currentMs = currentSeconds * 1000;
      if (state.current.suppressedMarker !== null) {
        if (nextGapMarker(markers, currentMs) === state.current.suppressedMarker) return;
        state.current.suppressedMarker = null;
      }
      const target = gapSkipTarget(markers, currentMs);
      if (target !== null) seekTo(target / 1000);
    },
    onManualSeek(seconds) {
      state.current.suppressedMarker = nextGapMarker(state.current.markers, seconds * 1000);
    }
  });
  return skipper.current;
}

export function SkipGapsButton(props: { enabled: boolean; onChange: (next: boolean) => void; hasMarkers: boolean }): React.JSX.Element | null {
  if (!props.hasMarkers) return null;
  const label = props.enabled ? "Skip gaps: on" : "Skip gaps: off";
  return (
    <button
      type="button"
      className="jl-vm-vc-icon jl-vm-vc-skip"
      aria-label="Skip gaps between steps"
      aria-pressed={props.enabled}
      data-active={props.enabled ? "true" : "false"}
      data-tip={label}
      data-tip-side="top"
      onClick={() => props.onChange(!props.enabled)}
    >
      <ChevronsRight aria-hidden size={18} />
    </button>
  );
}
