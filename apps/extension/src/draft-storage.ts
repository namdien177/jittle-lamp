import type { CaptureSessionDraft, SessionEvent } from "@jittle-lamp/shared";

export const defaultDraftStorageBudgetBytes = 256 * 1024;

export function estimateSerializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function createDraftStorageCheckpoint(
  draft: CaptureSessionDraft,
  maxBytes: number = defaultDraftStorageBudgetBytes
): CaptureSessionDraft {
  const redactedDraft = redactDurableDraft(draft);

  if (estimateSerializedBytes(redactedDraft) <= maxBytes) {
    return redactedDraft;
  }

  const selectedIndices = collectAnchorEventIndices(redactedDraft);
  let bestCheckpoint = checkpointFromIndices(redactedDraft, selectedIndices);

  if (estimateSerializedBytes(bestCheckpoint) > maxBytes) {
    bestCheckpoint = reduceAnchorEventsToFit(redactedDraft, selectedIndices, maxBytes);
  } else {
    bestCheckpoint = fillCheckpointWithRecentEvents(
      redactedDraft,
      selectedIndices,
      maxBytes,
      bestCheckpoint
    );
  }

  if (estimateSerializedBytes(bestCheckpoint) <= maxBytes) {
    return bestCheckpoint;
  }

  const latestEvent = redactedDraft.events.at(-1);

  return {
    ...redactedDraft,
    events: latestEvent ? [latestEvent] : []
  };
}

function fillCheckpointWithRecentEvents(
  draft: CaptureSessionDraft,
  anchorIndices: number[],
  maxBytes: number,
  anchorCheckpoint: CaptureSessionDraft
): CaptureSessionDraft {
  const anchors = new Set(anchorIndices);
  const recentIndices: number[] = [];

  for (let index = draft.events.length - 1; index >= 0; index -= 1) {
    if (!anchors.has(index)) {
      recentIndices.push(index);
    }
  }

  let bestCheckpoint = anchorCheckpoint;
  let low = 0;
  let high = recentIndices.length;

  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = checkpointFromIndices(draft, [
      ...anchorIndices,
      ...recentIndices.slice(0, count)
    ]);

    if (estimateSerializedBytes(candidate) <= maxBytes) {
      bestCheckpoint = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }

  return bestCheckpoint;
}

function redactDurableDraft(draft: CaptureSessionDraft): CaptureSessionDraft {
  return {
    ...draft,
    events: draft.events.map(redactDurableEvent)
  };
}

function redactDurableEvent(event: SessionEvent): SessionEvent {
  if (event.payload.kind !== "network") {
    return event;
  }

  return {
    ...event,
    payload: {
      kind: "network",
      method: event.payload.method,
      url: event.payload.url,
      ...(event.payload.subtype ? { subtype: event.payload.subtype } : {}),
      ...(typeof event.payload.status === "number" ? { status: event.payload.status } : {}),
      ...(event.payload.statusText ? { statusText: event.payload.statusText } : {}),
      ...(typeof event.payload.durationMs === "number" ? { durationMs: event.payload.durationMs } : {}),
      ...(event.payload.requestId ? { requestId: event.payload.requestId } : {}),
      request: {
        headers: [],
        cookies: []
      },
      ...(event.payload.response
        ? {
            response: {
              headers: [],
              setCookieHeaders: [],
              setCookies: []
            }
          }
        : {}),
      ...(event.payload.failureText ? { failureText: event.payload.failureText } : {})
    }
  };
}

function collectAnchorEventIndices(draft: CaptureSessionDraft): number[] {
  const selected = new Set<number>();

  if (draft.events.length > 0) {
    selected.add(0);
  }

  for (let index = 0; index < draft.events.length; index += 1) {
    const payload = draft.events[index]?.payload;

    if (payload?.kind === "lifecycle" && (payload.phase === "armed" || payload.phase === "recording")) {
      selected.add(index);
    }
  }

  return Array.from(selected).sort((a, b) => a - b);
}

function reduceAnchorEventsToFit(
  draft: CaptureSessionDraft,
  anchorIndices: number[],
  maxBytes: number
): CaptureSessionDraft {
  const reduced = [...anchorIndices];

  while (reduced.length > 1) {
    reduced.shift();
    const checkpoint = checkpointFromIndices(draft, reduced);

    if (estimateSerializedBytes(checkpoint) <= maxBytes) {
      return checkpoint;
    }
  }

  return checkpointFromIndices(draft, reduced);
}

function checkpointFromIndices(draft: CaptureSessionDraft, indices: number[]): CaptureSessionDraft {
  const orderedIndices = Array.from(new Set(indices)).sort((a, b) => a - b);

  return {
    ...draft,
    events: orderedIndices
      .map((index) => draft.events[index])
      .filter((event): event is CaptureSessionDraft["events"][number] => event !== undefined)
  };
}
