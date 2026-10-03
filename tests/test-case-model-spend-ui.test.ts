import { describe, expect, it } from "bun:test";
import { modelCostReportSchema } from "@jittle-lamp/shared";

import {
  averagePerRun,
  costPeriodRange,
  dailyBars,
  formatShare,
  formatTokens,
  formatUsd,
  modelShareRows,
  userShareRows
} from "../apps/evidence-web/src/test-config/cost-report";

describe("model spend", () => {
  const day = 86_400_000;
  const now = Date.UTC(2026, 9, 3, 15, 30);

  it("covers whole UTC days ending today", () => {
    const range = costPeriodRange(7, now);
    expect(new Date(range.from).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(range.to).toBe(now);
    expect(Math.round((range.to - range.from) / day)).toBe(7);
  });

  it("zero-fills days and scales bars to the busiest day", () => {
    const report = modelCostReportSchema.parse({
      from: Date.UTC(2026, 9, 1),
      to: Date.UTC(2026, 9, 3, 12),
      totalCostUsd: 3,
      runs: 4,
      byUser: [
        { userId: "u1", name: "Linh", costUsd: 1, runs: 1 },
        { userId: null, name: null, costUsd: 2, runs: 3 }
      ],
      byModel: [{ modelId: "anthropic/claude-sonnet-5-5", costUsd: 3, tokens: 1_250_000 }],
      byDay: [
        { day: "2026-10-01", costUsd: 2 },
        { day: "2026-10-03", costUsd: 1 }
      ]
    });
    expect(dailyBars(report).map((bar) => [bar.day, bar.ratio, bar.label])).toEqual([
      ["2026-10-01", 1, "1 Oct: $2.00"],
      ["2026-10-02", 0, "2 Oct: $0.00"],
      ["2026-10-03", 0.5, "3 Oct: $1.00"]
    ]);
    expect(userShareRows(report).map((row) => [row.label, formatShare(row.share), row.detail])).toEqual([
      ["Automation and deleted users", "67%", "3 runs"],
      ["Linh", "33%", "1 run"]
    ]);
    expect(userShareRows(report, { currentUserId: "u1" }).map((row) => row.label)).toEqual(["Automation and deleted users", "Linh (you)"]);
    expect(userShareRows({ ...report, byUser: [{ userId: "01a0fede-a47d", name: null, costUsd: 1, runs: 1 }] }).map((row) => row.label)).toEqual(["User 01a0fede"]);
    expect(userShareRows({ ...report, byUser: [{ userId: "u9", name: null, costUsd: 1, runs: 1 }] }, { currentUserId: "u9" })[0]?.label).toBe("You");
    expect(modelShareRows(report)[0]?.detail).toBe("1.3M tokens");
    expect(averagePerRun(report)).toBe(0.75);
  });

  it("formats money, tokens and shares", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatShare(0.004)).toBe("<1%");
    expect(averagePerRun({ totalCostUsd: 0, runs: 0 })).toBeNull();
  });
});
