import { describe, expect, it } from "bun:test";

import {
  createOrganizationStorageInputSchema,
  formatBytes,
  formatShare,
  memberShareRows,
  storagePeriodRange,
  storageShareRows,
  updateOrganizationStorageInputSchema,
  usageBars,
  type StorageUsageReport
} from "../packages/shared/src";

const credentials = { accessKeyId: "AKIAFAKE", secretAccessKey: "fake-secret" };

describe("storage contract", () => {
  it("treats blank optional connection fields as unset", () => {
    const parsed = createOrganizationStorageInputSchema.parse({
      name: "Bucket",
      region: "auto",
      bucket: "qa-evidence",
      endpoint: "  ",
      keyPrefix: "",
      ...credentials
    });
    expect(parsed).toMatchObject({ endpoint: null, keyPrefix: null, forcePathStyle: false, serverSideEncryption: true });
  });

  it("rejects invalid buckets, prefixes and endpoints", () => {
    const base = { name: "Bucket", region: "auto", ...credentials };
    expect(createOrganizationStorageInputSchema.safeParse({ ...base, bucket: "Bad_Bucket" }).success).toBe(false);
    expect(createOrganizationStorageInputSchema.safeParse({ ...base, bucket: "ok-bucket", keyPrefix: "../escape" }).success).toBe(false);
    expect(createOrganizationStorageInputSchema.safeParse({ ...base, bucket: "ok-bucket", endpoint: "not a url" }).success).toBe(false);
  });

  it("keeps omitted update fields omitted and blank ones cleared", () => {
    expect(updateOrganizationStorageInputSchema.parse({ name: "Renamed" })).toEqual({ name: "Renamed" });
    expect(updateOrganizationStorageInputSchema.parse({ endpoint: "", keyPrefix: "" })).toEqual({ endpoint: null, keyPrefix: null });
  });

  it("builds day and month ranges ending today", () => {
    const now = Date.parse("2026-10-09T15:00:00Z");
    expect(storagePeriodRange("30d", now)).toEqual({ granularity: "day", from: "2026-09-10", to: "2026-10-09" });
    expect(storagePeriodRange("12m", now)).toEqual({ granularity: "month", from: "2025-11-01", to: "2026-10-09" });
  });

  it("scales chart bars and share rows", () => {
    const report: StorageUsageReport = {
      orgId: "org",
      generatedAt: 0,
      from: "2026-10-01",
      to: "2026-10-02",
      granularity: "day",
      totals: { bytes: 300, artifactCount: 3, evidenceCount: 2, binBytes: 0 },
      byStorage: [
        { storageId: null, name: "JittleLamp storage", removed: false, bytes: 200, artifactCount: 2 },
        { storageId: "s1", name: "Old bucket", removed: true, bytes: 100, artifactCount: 1 }
      ],
      byMember: [{ userId: "u1", name: "Ada", email: null, bytes: 300, artifactCount: 3, evidenceCount: 2 }],
      byKind: [],
      timeline: [
        { bucket: "2026-10-01", addedBytes: 100, addedArtifacts: 1, storedBytes: 100 },
        { bucket: "2026-10-02", addedBytes: 200, addedArtifacts: 2, storedBytes: 300 }
      ]
    };
    expect(usageBars(report).map((bar) => [bar.addedRatio, bar.storedRatio])).toEqual([
      [0.5, 1 / 3],
      [1, 1]
    ]);
    expect(memberShareRows(report, "u1")[0]?.label).toBe("Ada (you)");
    const storages = storageShareRows(report);
    expect(storages[1]).toMatchObject({ muted: true, share: 1 / 3 });
    expect(storages[1]?.detail).toContain("storage removed");
    expect(formatShare(1 / 3)).toBe("33%");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});
