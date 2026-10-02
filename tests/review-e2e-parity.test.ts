import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import {
  buildSectionTimeline,
  createSessionArchive,
  createSessionDraft,
  type ActionMergeGroup,
  type SessionArchive
} from "@jittle-lamp/shared";
import { createMergeGroup, deriveSectionTimeline, getContiguousMergeableSelection } from "@jittle-lamp/viewer-core";
import { buildViewerStepChips } from "@jittle-lamp/viewer-react";

import { makeRunnerArchive } from "./fixtures/e2e/runner-archive";

import { importZipBundle, buildSessionZip } from "../apps/desktop/src/session/zip-import";
import { loadLibrarySession, saveLibrarySessionReviewState, _testOverrideDb } from "../apps/desktop/src/companion/sessions-db";
import { loadSessionZip } from "../apps/evidence-web/src/loader";
import { buildReviewedSessionZip } from "../apps/evidence-web/src/archive-export";

const T0 = "2026-02-10T10:00:00.000Z";
const T1 = "2026-02-10T10:00:01.000Z";
const T2 = "2026-02-10T10:00:02.000Z";
const T3 = "2026-02-10T10:00:03.000Z";

function makeSampleArchive() {
  const draft = createSessionDraft({
    page: { title: "Parity E2E", url: "https://example.test/evidence" },
    now: new Date(T0)
  });

  return createSessionArchive({
    ...draft,
    createdAt: T0,
    updatedAt: T3,
    phase: "ready",
    events: [
      { at: T0, payload: { kind: "lifecycle", phase: "recording", detail: "Started" } },
      { at: T1, payload: { kind: "interaction", type: "click", selector: "#open-panel" } },
      { at: T2, payload: { kind: "interaction", type: "click", selector: "#filter-network" } },
      {
        at: T3,
        payload: {
          kind: "network",
          method: "GET",
          url: "https://example.test/api/reviews?status=open",
          subtype: "xhr",
          request: {
            headers: [{ name: "x-review-token", value: "review-token-42" }],
            cookies: []
          },
          response: {
            headers: [{ name: "content-type", value: "application/json" }],
            setCookieHeaders: [],
            setCookies: [],
            body: {
              disposition: "captured",
              value: '{"status":"open","count":1}',
              encoding: "utf8"
            }
          }
        }
      }
    ]
  });
}

function makeSampleZip(): Uint8Array {
  const archive = makeSampleArchive();
  return zipSync({
    "session.archive.json": strToU8(JSON.stringify(archive)),
    "recording.webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
  });
}

function buildMergeGroupFromArchive(actionArchive: ReturnType<typeof makeSampleArchive>): ActionMergeGroup {
  const actionIds = actionArchive.sections.actions
    .filter((event) => event.payload.kind === "interaction")
    .map((event) => event.id);

  const contiguous = getContiguousMergeableSelection(actionArchive, [], actionIds);
  expect(contiguous).toEqual(actionIds);

  return createMergeGroup({
    id: "merge-e2e-1",
    createdAt: "2026-02-10T11:00:00.000Z",
    label: "Reviewed merged action",
    selectedActionIds: contiguous
  });
}

function assertGoldenReviewFlow(archive: ReturnType<typeof makeSampleArchive>, mergedArchive: ReturnType<typeof makeSampleArchive>) {
  const filteredByHeader = buildSectionTimeline(archive, "network", "all", "review-token-42");
  const filteredByBody = buildSectionTimeline(archive, "network", "all", "\"count\":1");

  expect(filteredByHeader).toHaveLength(1);
  expect(filteredByBody).toHaveLength(1);
  expect(filteredByHeader[0]?.label).toContain("/api/reviews");

  const mergeGroups = (mergedArchive.annotations ?? []).filter((a) => a.kind === "merge-group") as ActionMergeGroup[];
  expect(mergeGroups).toHaveLength(1);
  expect(mergeGroups[0]?.label).toBe("Reviewed merged action");
  expect(mergeGroups[0]?.memberIds).toHaveLength(2);
}

describe("review E2E parity: web evidence app", () => {
  test("loads sample bundle, navigates timeline/filtering, merges actions, exports reviewed ZIP, and re-imports annotations", async () => {
    const zipBytes = makeSampleZip();
    const loaded = await loadSessionZip(new File([zipBytes as Uint8Array<ArrayBuffer>], "sample.zip", { type: "application/zip" }));
    const mergeGroup = buildMergeGroupFromArchive(loaded.archive);

    const exportedZip = buildReviewedSessionZip({
      archive: loaded.archive,
      mergeGroups: [mergeGroup],
      recordingBytes: loaded.recordingBytes,
      now: new Date("2026-02-10T12:00:00.000Z")
    });

    const reloaded = await loadSessionZip(new File([exportedZip as Uint8Array<ArrayBuffer>], "reviewed.zip", { type: "application/zip" }));

    assertGoldenReviewFlow(loaded.archive, reloaded.archive);

    // Environment-specific adapter assertions.
    expect(loaded.videoUrl.startsWith("blob:")).toBe(true);
    expect(reloaded.mergeGroups).toHaveLength(1);
  });
});

describe("review E2E parity: desktop app", () => {
  test("loads sample bundle, navigates timeline/filtering, merges actions, exports reviewed ZIP, and re-imports annotations", async () => {
    _testOverrideDb(":memory:");
    const zipBytes = makeSampleZip();
    const loaded = await importZipBundle(zipBytes);
    const mergeGroup = buildMergeGroupFromArchive(loaded.archive);

    const outputDir = join(tmpdir(), `jl-e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionDir = join(outputDir, loaded.archive.sessionId);

    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.archive.json"), JSON.stringify(loaded.archive, null, 2));
    await writeFile(join(sessionDir, "recording.webm"), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));

    await saveLibrarySessionReviewState({
      sessionId: loaded.archive.sessionId,
      outputDir,
      notes: "review complete",
      annotations: [mergeGroup]
    });

    const exportedZip = await buildSessionZip(sessionDir);
    const reloaded = await importZipBundle(exportedZip);

    assertGoldenReviewFlow(loaded.archive, reloaded.archive as ReturnType<typeof makeSampleArchive>);

    // Environment-specific adapter assertions.
    expect(loaded.source).toBe("zip");
    expect(reloaded.source).toBe("zip");
    const savedArchive = JSON.parse(await readFile(join(sessionDir, "session.archive.json"), "utf8")) as { notes: string[] };
    expect(savedArchive.notes).toEqual(["review complete"]);

    await rm(outputDir, { recursive: true, force: true });
  });
});

describe("review E2E parity: test-run evidence (archive v4)", () => {
  const runnerZip = () =>
    zipSync({
      "session.archive.json": strToU8(JSON.stringify(makeRunnerArchive())),
      "recording.webm": new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])
    });

  const stepView = (archive: SessionArchive) => ({
    chips: buildViewerStepChips(archive),
    filtered: buildViewerStepChips(archive).map((chip) => ({
      stepId: chip.stepId,
      actions: deriveSectionTimeline(archive, "actions", "all", "", chip.stepId).map((item) => item.id),
      network: deriveSectionTimeline(archive, "network", "all", "", chip.stepId).map((item) => item.id),
      console: deriveSectionTimeline(archive, "console", "all", "", chip.stepId).map((item) => item.id)
    }))
  });

  test("desktop and web show the same steps and step-filtered timelines, and review saves keep steps", async () => {
    _testOverrideDb(":memory:");
    const web = await loadSessionZip(new File([runnerZip() as Uint8Array<ArrayBuffer>], "run.zip", { type: "application/zip" }));
    const desktop = await importZipBundle(runnerZip());

    expect(web.archive.recorder.kind).toBe("e2e-runner");
    expect(stepView(desktop.archive)).toEqual(stepView(web.archive));
    expect(stepView(web.archive).chips.map((chip) => chip.status)).toEqual(["passed", "passed"]);
    expect(stepView(web.archive).filtered[1]?.network).toHaveLength(1);

    // Web: reviewed export keeps step annotations next to the new merge groups.
    const exported = buildReviewedSessionZip({
      archive: web.archive,
      mergeGroups: [],
      recordingBytes: web.recordingBytes,
      now: new Date("2026-10-03T09:00:00.000Z")
    });
    const reloaded = await loadSessionZip(new File([exported as Uint8Array<ArrayBuffer>], "reviewed.zip", { type: "application/zip" }));
    expect(stepView(reloaded.archive)).toEqual(stepView(web.archive));

    // Desktop: saving review state keeps step annotations too.
    const outputDir = join(tmpdir(), `jl-e2e-run-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const sessionDir = join(outputDir, desktop.archive.sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.archive.json"), JSON.stringify(desktop.archive, null, 2));
    await writeFile(join(sessionDir, "recording.webm"), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
    const saved = await saveLibrarySessionReviewState({
      sessionId: desktop.archive.sessionId,
      outputDir,
      notes: "",
      annotations: []
    });
    expect(stepView(saved)).toEqual(stepView(web.archive));

    // Desktop library sessions are rebuilt from the catalog database; step tags must survive it.
    const library = await loadLibrarySession(desktop.archive.sessionId, outputDir);
    expect(stepView(library.archive)).toEqual(stepView(web.archive));
    expect(library.archive.sections.network.map((entry) => entry.tags)).toEqual(web.archive.sections.network.map((entry) => entry.tags));
    await rm(outputDir, { recursive: true, force: true });
  });
});
