import { describe, expect, spyOn, test } from "bun:test";

import { strToU8, unzipSync, zipSync } from "fflate";
import {
  buildSectionTimeline,
  createSessionArchive,
  createSessionDraft,
  type ActionMergeGroup,
  type SessionArchive
} from "@jittle-lamp/shared";
import { createMergeGroup, deriveSectionTimeline, getContiguousMergeableSelection } from "@jittle-lamp/viewer-core";
import { buildViewerStepChips } from "@jittle-lamp/viewer-react";

import { makeDesktopRecorderArchive, mp4Bytes } from "./fixtures/desktop-recorder-archive";
import { makeRunnerArchive } from "./fixtures/e2e/runner-archive";

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

describe("review E2E parity: native macOS recordings in the web evidence app", () => {
  test("loads an MP4 bundle and exports it back under recording.mp4", async () => {
    const zipBytes = zipSync({
      "session.archive.json": strToU8(JSON.stringify(makeDesktopRecorderArchive())),
      "recording.mp4": mp4Bytes
    });
    const createObjectUrl = spyOn(URL, "createObjectURL");
    const loaded = await loadSessionZip(new File([zipBytes as Uint8Array<ArrayBuffer>], "mac.zip", { type: "application/zip" }));
    const videoBlob = createObjectUrl.mock.calls[0]?.[0];
    createObjectUrl.mockRestore();
    expect(videoBlob instanceof Blob ? videoBlob.type : null).toBe("video/mp4");
    expect(loaded.archive.recorder.kind).toBe("desktop-recorder");
    expect(loaded.recordingBytes).toEqual(mp4Bytes);
    expect(loaded.timeline.filter((item) => item.section === "console")).toHaveLength(2);

    const exported = buildReviewedSessionZip({ archive: loaded.archive, mergeGroups: [], recordingBytes: loaded.recordingBytes });
    expect(Object.keys(unzipSync(exported)).sort()).toEqual(["recording.mp4", "session.archive.json"]);
    const reloaded = await loadSessionZip(new File([exported as Uint8Array<ArrayBuffer>], "reviewed.zip", { type: "application/zip" }));
    expect(reloaded.archive.recorder).toEqual(loaded.archive.recorder);
    expect(reloaded.recordingBytes).toEqual(mp4Bytes);
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

  test("web shows the run's steps and step-filtered timelines, and reviewed exports keep steps", async () => {
    const web = await loadSessionZip(new File([runnerZip() as Uint8Array<ArrayBuffer>], "run.zip", { type: "application/zip" }));

    expect(web.archive.recorder.kind).toBe("e2e-runner");
    expect(stepView(web.archive).chips.map((chip) => chip.status)).toEqual(["passed", "passed"]);
    expect(stepView(web.archive).filtered[1]?.network).toHaveLength(1);

    // The reviewed export keeps step annotations next to the new merge groups.
    const exported = buildReviewedSessionZip({
      archive: web.archive,
      mergeGroups: [],
      recordingBytes: web.recordingBytes,
      now: new Date("2026-10-03T09:00:00.000Z")
    });
    const reloaded = await loadSessionZip(new File([exported as Uint8Array<ArrayBuffer>], "reviewed.zip", { type: "application/zip" }));
    expect(stepView(reloaded.archive)).toEqual(stepView(web.archive));
  });
});
