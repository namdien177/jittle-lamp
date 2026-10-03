import { sessionArchiveSchema, stepTag, type SessionArchive } from "@jittle-lamp/shared";

// A schema-v4 archive as the e2e runner writes it: two steps, actions and network tagged by step,
// one console entry without a step tag that falls inside step 2's time window.
export const RUNNER_T0 = "2026-10-03T08:00:00.000Z";
const at = (ms: number) => new Date(Date.parse(RUNNER_T0) + ms).toISOString();

export const runnerSteps = {
  open: "st_open000000000001",
  logout: "st_logout0000000002"
} as const;

export function makeRunnerArchive(): SessionArchive {
  const sessionId = "jl_runner_fixture";
  return sessionArchiveSchema.parse({
    schemaVersion: 4,
    sessionId,
    name: "HQ admin logout returns a clean login form",
    createdAt: RUNNER_T0,
    updatedAt: at(6000),
    phase: "ready",
    page: { url: "https://uat.example.test/login", title: "Login" },
    recorder: {
      kind: "e2e-runner",
      runner: {
        name: "jl-e2e",
        version: "1.8.2",
        engine: { name: "e2e", version: "0.16.0" },
        browser: { name: "chromium", version: "147.0", headless: true },
        viewport: { width: 1440, height: 900 }
      },
      testRun: { runId: "run_1", testCaseKey: "TC-0412", transcriptVersion: 3, environment: "pcf-uat" }
    },
    summary: { videoDurationMs: 6000, actionCount: 2, requestCount: 2 },
    artifacts: [
      { kind: "recording.webm", relativePath: `${sessionId}/recording.webm`, mimeType: "video/webm" },
      { kind: "session.archive.json", relativePath: `${sessionId}/session.archive.json`, mimeType: "application/json" }
    ],
    sections: {
      actions: [
        {
          id: `${sessionId}:actions:000000`,
          seq: 0,
          at: RUNNER_T0,
          tags: [],
          payload: { kind: "lifecycle", phase: "recording", detail: "Runner started recording." }
        },
        {
          id: `${sessionId}:actions:000001`,
          seq: 1,
          at: at(500),
          tags: [stepTag(runnerSteps.open)],
          payload: { kind: "interaction", type: "navigation", url: "https://uat.example.test/login" }
        },
        {
          id: `${sessionId}:actions:000002`,
          seq: 2,
          at: at(3200),
          tags: [stepTag(runnerSteps.logout), "checkpoint:cp_logout"],
          payload: {
            kind: "interaction",
            type: "click",
            target: { role: "menuitem", name: "Đăng xuất", selectorAlternates: [] }
          }
        }
      ],
      console: [
        {
          id: `${sessionId}:console:000000`,
          seq: 3,
          at: at(3500),
          payload: { kind: "console", level: "info", message: "logout complete", args: [] }
        }
      ],
      network: [
        {
          id: `${sessionId}:network:000000`,
          seq: 4,
          at: at(600),
          tags: [stepTag(runnerSteps.open)],
          subtype: "document",
          payload: {
            kind: "network",
            method: "GET",
            url: "https://uat.example.test/login",
            subtype: "document",
            status: 200,
            request: { headers: [], cookies: [] }
          }
        },
        {
          id: `${sessionId}:network:000001`,
          seq: 5,
          at: at(3300),
          tags: [stepTag(runnerSteps.logout)],
          subtype: "xhr",
          payload: {
            kind: "network",
            method: "POST",
            url: "https://uat.example.test/api/logout",
            subtype: "xhr",
            status: 204,
            request: { headers: [], cookies: [] }
          }
        }
      ]
    },
    annotations: [
      {
        id: "step-1",
        kind: "step",
        stepId: runnerSteps.open,
        ordinal: 1,
        type: "open",
        label: "/login",
        status: "passed",
        mode: "deterministic",
        startedAt: at(400),
        endedAt: at(1200),
        videoOffsetMs: 400,
        videoEndOffsetMs: 1200,
        tags: [stepTag(runnerSteps.open)]
      },
      {
        id: "step-2",
        kind: "step",
        stepId: runnerSteps.logout,
        ordinal: 2,
        type: "act",
        label: 'mở menu tài khoản ở góc trên bên phải và chọn "Đăng xuất"',
        checkpointId: "cp_logout",
        status: "passed",
        mode: "replayed",
        startedAt: at(3000),
        endedAt: at(4000),
        videoOffsetMs: 3000,
        videoEndOffsetMs: 4000,
        tags: [stepTag(runnerSteps.logout)]
      },
      {
        id: "merge-1",
        kind: "merge-group",
        memberIds: [`${sessionId}:actions:000001`, `${sessionId}:actions:000002`],
        tags: [],
        label: "Reviewer merge",
        createdAt: at(7000)
      }
    ],
    notes: []
  });
}
