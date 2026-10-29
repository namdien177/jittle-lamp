import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Play } from "lucide-react";

// The paused overlay fades out this long after the pointer stops moving, so it never covers the frame under review.
const BIG_PLAY_IDLE_MS = 500;

export function useBigPlayIdle(isPlaying: boolean): { visible: boolean; poke: () => void } {
  const [awake, setAwake] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const poke = useCallback((): void => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setAwake(true);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setAwake(false);
    }, BIG_PLAY_IDLE_MS);
  }, []);

  useEffect(() => {
    if (!isPlaying) poke();
  }, [isPlaying, poke]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { visible: !isPlaying && awake, poke };
}

export function BigPlayButton(props: { visible: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="jl-vm-vc-bigplay"
      aria-label="Play"
      data-visible={props.visible ? "true" : "false"}
      onClick={props.onClick}
    >
      <Play aria-hidden size={30} fill="currentColor" />
    </button>
  );
}
