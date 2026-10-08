import {
  formatBytes,
  type StorageArtifactKind,
  type StorageUsageGranularity,
  type StorageUsageReport
} from "./storage";

// Organisation storage pages (evidence-web and desktop): period presets and chart rows for the
// usage report.

export const storagePeriods = [
  { id: "30d", label: "30 days", granularity: "day", days: 30 },
  { id: "90d", label: "90 days", granularity: "day", days: 90 },
  { id: "12m", label: "12 months", granularity: "month", months: 12 }
] as const;
export type StoragePeriodId = (typeof storagePeriods)[number]["id"];

const isoDay = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 10);

// Whole UTC days (or months) ending today.
export function storagePeriodRange(id: StoragePeriodId, now: number): { granularity: StorageUsageGranularity; from: string; to: string } {
  const period = storagePeriods.find((item) => item.id === id) ?? storagePeriods[0];
  const to = isoDay(now);
  if (period.granularity === "day") {
    return { granularity: "day", from: isoDay(Date.parse(`${to}T00:00:00Z`) - (period.days - 1) * 86_400_000), to };
  }
  const today = new Date(now);
  return {
    granularity: "month",
    from: isoDay(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (period.months - 1), 1)),
    to
  };
}

export function formatBucketLabel(bucket: string, granularity: StorageUsageGranularity): string {
  const date = new Date(granularity === "day" ? `${bucket}T00:00:00Z` : `${bucket}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return bucket;
  return new Intl.DateTimeFormat("en-GB", granularity === "day" ? { day: "numeric", month: "short", timeZone: "UTC" } : { month: "short", year: "2-digit", timeZone: "UTC" }).format(date);
}

export type UsageBar = {
  bucket: string;
  label: string;
  addedBytes: number;
  storedBytes: number;
  // Heights relative to the largest value of each series, 0..1.
  addedRatio: number;
  storedRatio: number;
  description: string;
};

export function usageBars(report: Pick<StorageUsageReport, "timeline" | "granularity">): UsageBar[] {
  const maxAdded = Math.max(0, ...report.timeline.map((point) => point.addedBytes));
  const maxStored = Math.max(0, ...report.timeline.map((point) => point.storedBytes));
  return report.timeline.map((point) => {
    const label = formatBucketLabel(point.bucket, report.granularity);
    return {
      bucket: point.bucket,
      label,
      addedBytes: point.addedBytes,
      storedBytes: point.storedBytes,
      addedRatio: maxAdded > 0 ? point.addedBytes / maxAdded : 0,
      storedRatio: maxStored > 0 ? point.storedBytes / maxStored : 0,
      description: `${label}: ${formatBytes(point.addedBytes)} added, ${formatBytes(point.storedBytes)} stored`
    };
  });
}

export type StorageShareRow = { key: string; label: string; bytes: number; share: number; detail: string; muted?: boolean };

const share = (bytes: number, total: number) => (total > 0 ? bytes / total : 0);
const plural = (count: number, noun: string) => `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;

export function memberShareRows(report: Pick<StorageUsageReport, "byMember" | "totals">, currentUserId: string | null): StorageShareRow[] {
  return report.byMember.map((member, index) => ({
    key: member.userId ?? `unknown-${index}`,
    label: member.userId && member.userId === currentUserId ? `${member.name} (you)` : member.name,
    bytes: member.bytes,
    share: share(member.bytes, report.totals.bytes),
    // "evidence" is uncountable: 1 evidence, 5 evidence.
    detail: [`${member.evidenceCount.toLocaleString()} evidence`, member.email].filter(Boolean).join(" · ")
  }));
}

export function storageShareRows(report: Pick<StorageUsageReport, "byStorage" | "totals">): StorageShareRow[] {
  return report.byStorage.map((storage) => ({
    key: storage.storageId ?? "default",
    label: storage.name,
    bytes: storage.bytes,
    share: share(storage.bytes, report.totals.bytes),
    detail: storage.removed ? `${plural(storage.artifactCount, "file")} · storage removed, files unavailable` : plural(storage.artifactCount, "file"),
    ...(storage.removed ? { muted: true } : {})
  }));
}

export const artifactKindLabels: Record<StorageArtifactKind, string> = {
  recording: "Recordings",
  "network-log": "Session archives",
  screenshot: "Screenshots",
  attachment: "Attachments",
  transcript: "Transcripts"
};

export function kindShareRows(report: Pick<StorageUsageReport, "byKind" | "totals">): StorageShareRow[] {
  return report.byKind.map((kind) => ({
    key: kind.kind,
    label: artifactKindLabels[kind.kind],
    bytes: kind.bytes,
    share: share(kind.bytes, report.totals.bytes),
    detail: plural(kind.artifactCount, "file")
  }));
}

export function formatShare(value: number): string {
  if (value === 0) return "0%";
  if (value < 0.001) return "<0.1%";
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

// CORS rule the bucket needs so browsers can play presigned URLs from the web app.
export function corsRuleFor(origin: string): string {
  return JSON.stringify(
    [
      {
        AllowedOrigins: [origin],
        AllowedMethods: ["GET", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"],
        MaxAgeSeconds: 3600
      }
    ],
    null,
    2
  );
}
