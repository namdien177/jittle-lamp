import { getStepAnnotations, type SessionArchive } from "@jittle-lamp/shared";

import type { ViewerStepChip } from "./types";

// Top-level test-run steps of an archive as chips for the evidence stream. Macro sub-steps are
// grouped under their parent, so they are not listed separately.
export function buildViewerStepChips(archive: Pick<SessionArchive, "annotations">): ViewerStepChip[] {
  return getStepAnnotations(archive)
    .filter((step) => step.parentStepId === null)
    .map((step) => ({
      stepId: step.stepId,
      ordinal: step.ordinal,
      label: step.label,
      status: step.status,
      mode: step.mode
    }));
}
