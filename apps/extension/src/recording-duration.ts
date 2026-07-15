export class RecordingDurationClock {
  private readonly startedAtMs: number;
  private pausedAtMs: number | null = null;
  private pausedDurationMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startedAtMs = now();
  }

  elapsedMs(): number {
    const endedAtMs = this.pausedAtMs ?? this.now();
    return Math.max(0, Math.round(endedAtMs - this.startedAtMs - this.pausedDurationMs));
  }

  pause(): void {
    if (this.pausedAtMs === null) {
      this.pausedAtMs = this.now();
    }
  }

  resume(): void {
    if (this.pausedAtMs === null) return;

    this.pausedDurationMs += Math.max(0, this.now() - this.pausedAtMs);
    this.pausedAtMs = null;
  }
}

export function resolveRecordingDurationMs(
  metadataDurationMs: number | null,
  elapsedDurationMs: number | null
): number | null {
  if (typeof metadataDurationMs === "number" && Number.isFinite(metadataDurationMs) && metadataDurationMs > 0) {
    return Math.round(metadataDurationMs);
  }

  if (typeof elapsedDurationMs === "number" && Number.isFinite(elapsedDurationMs) && elapsedDurationMs > 0) {
    return Math.round(elapsedDurationMs);
  }

  return null;
}
