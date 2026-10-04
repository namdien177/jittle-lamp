import { getStepAnnotations, type SessionArchive } from "@jittle-lamp/shared";

import type { ViewerStepChip } from "./types";

// Top-level test-run steps of an archive as chips for the evidence stream and seek bar. Macro
// sub-steps are grouped under their parent, so they are not listed separately. The run page knows
// better video offsets than the archive (`stepOffsetsMs`); those win when present.
export function buildViewerStepChips(
  archive: Pick<SessionArchive, "annotations">,
  stepOffsetsMs?: Readonly<Record<string, number>> | null
): ViewerStepChip[] {
  return getStepAnnotations(archive)
    .filter((step) => step.parentStepId === null)
    .map((step) => {
      const startMs = stepOffsetsMs?.[step.stepId] ?? step.videoOffsetMs;
      const endMs = step.videoEndOffsetMs === null ? null : Math.max(startMs, step.videoEndOffsetMs + startMs - step.videoOffsetMs);
      return {
        stepId: step.stepId,
        ordinal: step.ordinal,
        type: step.type,
        label: step.label,
        status: step.status,
        mode: step.mode,
        startMs,
        endMs
      };
    })
    .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
}
