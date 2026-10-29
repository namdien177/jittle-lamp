import { useCallback, useEffect, useRef, useState } from "react";
import type * as React from "react";
import { Camera, Check, CircleAlert } from "lucide-react";

const RESULT_MS = 1600;
const PROBE_TIMEOUT_MS = 10_000;

type CopyState = "idle" | "copied" | "failed";

async function drawFramePng(video: HTMLVideoElement): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("The recording has no frame to copy yet.");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to draw the frame.");
  context.drawImage(video, 0, 0, width, height);
  // toBlob throws a SecurityError when the frame came from an origin without CORS.
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode the frame."))), "image/png");
  });
}

/**
 * The player's <video> loads without CORS, which taints any canvas it is drawn on.
 * Re-reads the same source with CORS at the same time to get readable pixels.
 */
function drawCorsFramePng(src: string, seconds: number): Promise<Blob> {
  const probe = document.createElement("video");
  probe.crossOrigin = "anonymous";
  probe.muted = true;
  probe.preload = "auto";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = (): void => {
    clearTimeout(timer);
    probe.removeAttribute("src");
    probe.load();
  };
  return new Promise<Blob>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Timed out reading the frame.")), PROBE_TIMEOUT_MS);
    probe.addEventListener("error", () => reject(new Error("The recording's host does not allow copying frames.")), { once: true });
    probe.addEventListener("loadedmetadata", () => {
      probe.currentTime = seconds;
    }, { once: true });
    probe.addEventListener("seeked", () => {
      drawFramePng(probe).then(resolve, reject);
    }, { once: true });
    probe.src = src;
  }).finally(release);
}

async function captureFramePng(video: HTMLVideoElement): Promise<Blob> {
  try {
    return await drawFramePng(video);
  } catch (error) {
    const src = video.currentSrc;
    if (!(error instanceof DOMException && error.name === "SecurityError") || !src) throw error;
    return drawCorsFramePng(src, video.currentTime);
  }
}

export async function copyVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
    throw new Error("This browser cannot copy images to the clipboard.");
  }
  // Hand the clipboard a pending blob so the write starts inside the click's user activation.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": captureFramePng(video) })]);
}

export function CopyFrameButton(props: { videoRef: React.RefObject<HTMLVideoElement | null> }): React.JSX.Element {
  const [state, setState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);

  const showResult = useCallback((next: CopyState): void => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setState(next);
    resetTimerRef.current = setTimeout(() => setState("idle"), RESULT_MS);
  }, []);

  const { videoRef } = props;
  const handleClick = useCallback((): void => {
    const video = videoRef.current;
    if (!video) return;
    copyVideoFrame(video).then(
      () => showResult("copied"),
      () => showResult("failed")
    );
  }, [videoRef, showResult]);

  const label = state === "copied" ? "Frame copied" : state === "failed" ? "Couldn't copy frame" : "Copy frame";
  return (
    <button
      type="button"
      className="jl-vm-vc-icon jl-vm-vc-frame"
      aria-label={label}
      data-state={state}
      data-tip={label}
      data-tip-side="top"
      onClick={handleClick}
    >
      {state === "copied" ? (
        <Check aria-hidden size={18} />
      ) : state === "failed" ? (
        <CircleAlert aria-hidden size={18} />
      ) : (
        <Camera aria-hidden size={18} />
      )}
    </button>
  );
}
