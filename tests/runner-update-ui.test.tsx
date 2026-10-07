import { describe, expect, it } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerPool } from "@jittle-lamp/shared";
import { RunnerUpdatePanel } from "../apps/evidence-web/src/pages/settings-test-cases/runner-update";

function pool(phase: NonNullable<RunnerPool["updateProgress"]>["phase"] = "downloading"): RunnerPool {
  return {
    id: "pool", name: "cloud", kind: "cloud", maxConcurrentRuns: 1, queued: 0, running: 0, explorationsQueued: 0, explorationsRunning: 0, createdAt: 1,
    serverVersion: "2.0.0", targetVersion: "2.0.0",
    workers: [{ id: "worker", hostname: "cloud-01", version: "1.0.0", versionSkew: true, managedUpdates: true, status: "online", currentRunId: null, lastHeartbeatAt: Date.now() }],
    updateProgress: { updateId: 1, targetVersion: "2.0.0", phase, startedAt: 1, reportedAt: Date.now(), downloadPercent: 42, downloadedBytes: 420, totalBytes: 1000, errorCode: null }
  };
}
const render = (data: RunnerPool) => renderToStaticMarkup(<RunnerUpdatePanel pool={data} canManage busy={false} onUpdate={() => undefined} />);

describe("runner update status", () => {
  it("shows measured download percentage and an accessible current stage", () => {
    const html = render(pool());
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("42%");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Cancel update");
  });
  it("does not invent a percentage for unmeasured stages and blocks cancellation during replacement", () => {
    const html = render(pool("restarting"));
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("42%");
    expect(html).not.toContain("Cancel update");
  });
  it("replaces stale percentage with recovery guidance", () => {
    const data = pool();
    if (!data.updateProgress) throw new Error("Expected progress");
    data.updateProgress.reportedAt = Date.now() - 60_000;
    const html = render(data);
    expect(html).not.toContain("42%");
    expect(html).toContain("Waiting for the runner host to report progress");
    expect(html).toContain("Check that the host updater is running");
  });
  it("shows the failed step, a retry action and completion without a lingering loading bar", () => {
    const data = pool("failed");
    if (!data.updateProgress) throw new Error("Expected progress");
    data.updateProgress.errorCode = "VERIFY_FAILED";
    expect(render(data)).toContain("Existing runners were kept");
    expect(render(data)).toContain("Retry update");
    expect(render(data)).toContain('aria-current="step"');
    const completed = pool("completed");
    const worker = completed.workers[0];
    if (!worker) throw new Error("Expected worker");
    worker.version = "2.0.0";
    worker.versionSkew = false;
    const html = render(completed);
    expect(html).toContain("Cloud runners are up to date");
    expect(html).not.toContain('role="progressbar"');
    worker.status = "offline";
    expect(render(completed)).not.toContain("Cloud runners are up to date");
    expect(render(completed)).toContain("No runner online");
  });
});
