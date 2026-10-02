import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { zipSync } from "fflate";

import { recordingFileName, sessionArchiveFileName, type RunReport } from "@jittle-lamp/shared";

import type { RunTranscriptResult } from "../run";
import { buildRunArchive, type EngineEvent } from "./archive";

// Evidence for one run (design.md §5.3): recording.webm, session.archive.json (v4) and
// run-report.json, plus a ZIP in the shape `POST /automation/evidences/zip` accepts.

export type EvidenceBundle = {
  dir: string;
  archivePath: string;
  recordingPath: string;
  reportPath: string;
  zipPath: string;
  report: RunReport;
};

function engineEvents(runDir: string): EngineEvent[] {
  const path = join(runDir, "progress.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; progress?: { phase?: string; event?: { kind?: string; startedAt?: string; name?: string; detail?: string } } };
        const inner = event.progress?.event;
        if (event.type !== "step" || event.progress?.phase !== "event" || inner?.kind !== "engine" || !inner.startedAt) return [];
        return [{ at: inner.startedAt, name: inner.name ?? "", detail: inner.detail ?? "" }];
      } catch {
        return [];
      }
    });
}

function webmDurationHint(report: RunReport): number | null {
  const ends = report.steps.flatMap((step) => (step.videoOffsetMs !== null && step.durationMs !== null ? [step.videoOffsetMs + step.durationMs] : []));
  return ends.length > 0 ? Math.max(...ends) : null;
}

export function writeEvidenceBundle(result: RunTranscriptResult): EvidenceBundle {
  if (!result.recordingPath || !existsSync(result.recordingPath)) {
    throw new Error("The run produced no recording; there is no evidence to write.");
  }
  const dir = join(result.runDir, "evidence");
  mkdirSync(dir, { recursive: true });
  const traceZip = result.tracePath && existsSync(result.tracePath) ? new Uint8Array(readFileSync(result.tracePath)) : null;
  const sessionId = `jl_${(result.report.runId ?? "run").replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 120);
  const { archive, videoStartedAt } = buildRunArchive({
    traceZip,
    report: result.report,
    engineEvents: engineEvents(result.runDir),
    sessionId,
    name: result.report.testCase.key ? `${result.report.testCase.key} ${result.report.testCase.title}` : result.report.testCase.title || "Test run",
    videoDurationMs: webmDurationHint(result.report),
    redact: result.redact
  });

  // Video offsets in the report follow the archive's anchor (page creation = first video frame).
  const videoStartMs = Date.parse(videoStartedAt);
  const report: RunReport = {
    ...result.report,
    steps: result.report.steps.map((step) => ({
      ...step,
      videoOffsetMs: step.startedAt ? Math.max(0, Date.parse(step.startedAt) - videoStartMs) : null
    })),
    artifacts: [
      ...result.report.artifacts,
      { kind: "archive", path: sessionArchiveFileName, mimeType: "application/json" },
      { kind: "run-report", path: "run-report.json", mimeType: "application/json" }
    ]
  };

  const archiveJson = new TextEncoder().encode(`${JSON.stringify(archive, null, 2)}\n`);
  const recording = new Uint8Array(readFileSync(result.recordingPath));
  const archivePath = join(dir, sessionArchiveFileName);
  const recordingPath = join(dir, recordingFileName);
  const reportPath = join(dir, "run-report.json");
  const zipPath = join(dir, "evidence.zip");
  writeFileSync(archivePath, archiveJson);
  writeFileSync(recordingPath, recording);
  writeFileSync(reportPath, result.redact(`${JSON.stringify(report, null, 2)}\n`));
  writeFileSync(result.reportPath, result.redact(`${JSON.stringify(report, null, 2)}\n`));
  // Keep the project-level copy in step with the run's.
  writeFileSync(join(result.runDir, "..", "..", "report.json"), result.redact(`${JSON.stringify(report, null, 2)}\n`));
  writeFileSync(zipPath, zipSync({ [sessionArchiveFileName]: archiveJson, [recordingFileName]: [recording, { level: 0 }] }));
  return { dir, archivePath, recordingPath, reportPath, zipPath, report };
}

export type UploadedEvidence = { evidenceId: string; orgId: string | null; url: string | null };

export async function uploadRunEvidence(
  result: RunTranscriptResult,
  options: { env: Readonly<Record<string, string | undefined>>; cwd: string; fetch?: typeof fetch }
): Promise<UploadedEvidence> {
  const token = result.config.apiToken?.value ?? options.env.JL_API_TOKEN;
  const origin = result.config.apiOrigin ?? options.env.JL_API_ORIGIN;
  if (!token) throw new Error("--upload needs JL_API_TOKEN (an automation token).");
  if (!origin) throw new Error("--upload needs JL_API_ORIGIN.");
  const bundle = writeEvidenceBundle(result);
  const zip = readFileSync(bundle.zipPath);
  const title = bundle.report.testCase.key ? `${bundle.report.testCase.key} ${bundle.report.testCase.title}` : bundle.report.testCase.title;
  const url = new URL("/automation/evidences/zip", origin);
  url.searchParams.set("title", `${bundle.report.outcome.toUpperCase()} · ${title}`.slice(0, 200));
  if (bundle.report.runId) url.searchParams.set("sourceExternalId", bundle.report.runId);
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/zip", "content-length": String(statSync(bundle.zipPath).size) },
    body: zip
  });
  const body = (await response.json().catch(() => ({}))) as { evidence?: { id?: string; orgId?: string }; message?: string; code?: string };
  if (!response.ok || !body.evidence?.id) {
    throw new Error(`Evidence upload failed (${response.status}): ${body.code ?? ""} ${body.message ?? ""}`.trim());
  }
  const web = options.env.JL_WEB_ORIGIN;
  return { evidenceId: body.evidence.id, orgId: body.evidence.orgId ?? null, url: web ? new URL(`/evidence/${body.evidence.id}`, web).toString() : null };
}
