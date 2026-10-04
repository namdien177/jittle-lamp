import { describe, expect, it } from "bun:test";

import {
  builtinMacroSignatures,
  claimRunResponseSchema,
  explorationDraftTranscript,
  explorationOutcome,
  summarizeExploration,
  transcriptProblems,
  withBuiltinMacroSignatures,
  explorationFallbackTranscript,
  explorationGoal,
  explorationTranscriptPrompt,
  parseTestCaseTranscript,
  splitInstructions,
  type ExplorationRecord
} from "@jittle-lamp/shared";

import { explorationLabel, poolsWithoutRunner } from "../apps/evidence-web/src/test-cases/import/batch-state";
import { explorationReadiness, poolForEnvironment, poolQueueSummary } from "../apps/evidence-web/src/test-config/config-ui";

const record: ExplorationRecord = {
  goal: "g",
  ended: "finished",
  summary: "The   new interest\nis listed.",
  steps: [
    { index: 1, title: "Sign in", instruction: "Sign in as the HQ admin", status: "passed", summary: "Dashboard shown", errorCode: null },
    { index: 2, title: "Blocked", instruction: "Open billing", status: "blocked", summary: null, errorCode: null },
    { index: 3, title: "Add", instruction: "Open Interests and click New interest", status: "exhausted", summary: null, errorCode: null }
  ],
  findings: [{ kind: "issue", severity: 4, title: "Save does nothing", expected: "saved", actual: "nothing" }]
};

describe("general instructions", () => {
  it("splits on # headings, or on blank lines when there are none", () => {
    expect(splitInstructions("# A\nfirst line\nsecond\n\n# B\nother")).toEqual([
      { title: "A", instructions: "first line\nsecond" },
      { title: "B", instructions: "other" }
    ]);
    expect(splitInstructions("Sign in and open Interests.\nAdd one.\n\n\nSign out.")).toEqual([
      { title: "Sign in and open Interests.", instructions: "Sign in and open Interests.\nAdd one." },
      { title: "Sign out.", instructions: "Sign out." }
    ]);
    expect(splitInstructions("  \n ")).toEqual([]);
  });

  it("tells the explorer to follow the instructions, not to hunt for bugs", () => {
    const goal = explorationGoal({ title: "Admin creates an interest", instructions: "Sign in as PCF_HQ_ADMIN." });
    expect(goal).toContain("Follow these test instructions exactly");
    expect(goal).toContain("Sign in as PCF_HQ_ADMIN.");
    expect(goal).toContain("Do not explore beyond them.");
  });

  it("gives the model the instructions, every step with its status and the findings", () => {
    const prompt = explorationTranscriptPrompt({ title: "T", instructions: "Do it", environmentName: "pcf-uat", record });
    expect(prompt).toContain("Environment: pcf-uat");
    expect(prompt).toContain("1. [passed] Sign in: Sign in as the HQ admin\n   observed: Dashboard shown");
    expect(prompt).toContain("- issue (severity 4): Save does nothing. Expected: saved. Actual: nothing");
    expect(prompt).toContain("Never write passwords");
  });

  it("without a model: one Act per step that ran, the assessment as the Assert", () => {
    const transcript = explorationFallbackTranscript({ title: "Admin creates an interest", record, environmentName: "pcf-uat" });
    const { testCase, diagnostics } = parseTestCaseTranscript(transcript);
    expect(diagnostics).toEqual([]);
    expect(testCase.metadata.env).toBe("pcf-uat");
    expect(testCase.metadata.tags).toEqual(["source:exploration"]);
    expect(testCase.steps.map((step) => `${step.type}: ${step.text}`)).toEqual([
      "act: Sign in as the HQ admin",
      "act: Open Interests and click New interest",
      "assert: The new interest is listed."
    ]);
  });

  it("a claim without an exploration still parses (older backends)", () => {
    expect(claimRunResponseSchema.parse({ run: null })).toEqual({ run: null, exploration: null });
  });

  it("labels an item's exploration on the batch page", () => {
    const base = { outcome: null, environmentName: "pcf-uat", runnerPoolName: "cloud", runnersOnline: null, attempts: 1, error: null, ended: null, steps: 0, findings: 0 };
    expect(explorationLabel({ exploration: null })).toBeNull();
    expect(explorationLabel({ exploration: { ...base, status: "queued", runnersOnline: 2 } })).toEqual({ text: "Waiting for a runner on pcf-uat · 2 online in pool cloud", tone: "muted" });
    // Production 2026-10-04: a General instructions import on pcf-uat (pool cloud, no worker) read
    // "Waiting for a runner on pcf-uat" with no hint that nothing could take it.
    expect(explorationLabel({ exploration: { ...base, status: "queued", runnersOnline: 0 } })).toEqual({
      text: "No runner online in pool cloud; waits until one connects (environment pcf-uat)",
      tone: "danger"
    });
    expect(explorationLabel({ exploration: { ...base, status: "running", attempts: 2 } })?.text).toBe("Trying the instructions on pcf-uat (attempt 2)");
    expect(explorationLabel({ exploration: { ...base, status: "done", ended: "finished", steps: 3, findings: 1 } })).toEqual({
      text: "Explored on pcf-uat: 3 steps · 1 finding",
      tone: "muted"
    });
    expect(explorationLabel({ exploration: { ...base, status: "failed", error: "net::ERR_NAME_NOT_RESOLVED" } })).toEqual({
      text: "Not explored on pcf-uat: net::ERR_NAME_NOT_RESOLVED",
      tone: "danger"
    });
  });

  it("names the pools a batch waits on with no runner online", () => {
    const queued = (runnerPoolName: string, runnersOnline: number) => ({
      exploration: { status: "queued" as const, outcome: null, environmentName: "pcf-uat", runnerPoolName, runnersOnline, attempts: 0, error: null, ended: null, steps: 0, findings: 0 }
    });
    expect(poolsWithoutRunner([queued("cloud", 0), queued("cloud", 0), queued("vpn", 1), { exploration: null }])).toEqual(["cloud"]);
    expect(poolsWithoutRunner([queued("vpn", 1)])).toEqual([]);
  });
});

describe("runner pool readiness and queue accounting", () => {
  const pools = [
    { kind: "cloud" as const, id: "p-cloud", name: "cloud", workers: [] as Array<{ status: "online" | "offline" }> },
    { kind: "self-hosted" as const, id: "p-vpn", name: "vpn", workers: [{ status: "online" as const }, { status: "offline" as const }] }
  ];

  it("resolves an environment's pool reference the way the backend does", () => {
    expect(poolForEnvironment("cloud", pools)?.id).toBe("p-cloud");
    expect(poolForEnvironment("", pools)?.id).toBe("p-cloud");
    expect(poolForEnvironment("self-hosted:vpn", pools)?.id).toBe("p-vpn");
    expect(poolForEnvironment("self-hosted:p-vpn", pools)?.id).toBe("p-vpn");
    expect(poolForEnvironment("self-hosted:gone", pools)).toBeNull();
  });

  it("counts online runners before an explored import starts", () => {
    expect(explorationReadiness("cloud", pools)).toEqual({ poolName: "cloud", runnersOnline: 0 });
    expect(explorationReadiness("self-hosted:vpn", pools)).toEqual({ poolName: "vpn", runnersOnline: 1 });
    expect(explorationReadiness("self-hosted:gone", pools)).toEqual({ poolName: "self-hosted:gone", runnersOnline: 0 });
  });

  it("shows waiting imports next to runs instead of '0 queued'", () => {
    expect(poolQueueSummary({ running: 0, queued: 0, explorationsRunning: 0, explorationsQueued: 0 })).toBe("0 running · 0 queued");
    expect(poolQueueSummary({ running: 0, queued: 0, explorationsRunning: 0, explorationsQueued: 1 })).toBe("0 running · 0 queued · 1 import waiting");
    expect(poolQueueSummary({ running: 1, queued: 2, explorationsRunning: 1, explorationsQueued: 2 })).toBe(
      "1 running · 2 queued · 3 imports exploring (1 running, 2 waiting)"
    );
  });
});

describe("explorations that did not pass are not written as tests", () => {
  // Shape of the production ILHAM exploration 01a10397-69eb-…: e2e said `ended: finished`, but the
  // only step was blocked by AUTH_CREDENTIAL_UNAVAILABLE and the summary reported the failure.
  const blockedLogin: ExplorationRecord = {
    goal: "Đăng nhập bằng ILHAM_ALL_ACCESS_ACCOUNT",
    ended: "finished",
    summary: "Login failed: the credential has no username, so the goal was not achieved.",
    steps: [{ index: 1, title: "Sign in", instruction: "Sign in with ILHAM_ALL_ACCESS_ACCOUNT", status: "blocked", summary: "username is empty", errorCode: "AUTH_CREDENTIAL_UNAVAILABLE" }],
    findings: []
  };
  const passedStep = { index: 1, title: "Sign in", instruction: "Sign in", status: "passed" as const, summary: null, errorCode: null };

  it("classifies a finished run with a blocked step as blocked, and only a clean run as passed", () => {
    expect(explorationOutcome(blockedLogin)).toEqual({ outcome: "blocked", reason: 'step 1 "Sign in" blocked (AUTH_CREDENTIAL_UNAVAILABLE)' });
    expect(explorationOutcome({ ...blockedLogin, steps: [{ ...passedStep, status: "failed" }] }).outcome).toBe("failed");
    expect(explorationOutcome({ ...blockedLogin, steps: [passedStep], findings: [{ kind: "issue", severity: 4, title: "No menu", expected: "menu", actual: "none" }] }).outcome).toBe("failed");
    expect(explorationOutcome({ ...blockedLogin, steps: [passedStep], ended: "step-limit" }).outcome).toBe("incomplete");
    expect(explorationOutcome({ ...blockedLogin, steps: [] }).outcome).toBe("incomplete");
    expect(explorationOutcome({ ...blockedLogin, steps: [passedStep] })).toEqual({ outcome: "passed", reason: null });
  });

  it("keeps the instructions, with the expected outcome, instead of asserting the failure", () => {
    const instructions = "Mở trang đăng nhập. Đăng nhập bằng ILHAM_ALL_ACCESS_ACCOUNT.\nKiểm tra đăng nhập thành công: trang chính hiển thị menu điều hướng.";
    const draft = explorationDraftTranscript({ title: "ILHAM - Đăng nhập thành công", instructions, environmentName: "ilham-uat", ...explorationOutcome(blockedLogin) });
    const { testCase } = parseTestCaseTranscript(draft);
    expect(testCase.steps.map((step) => step.type)).toEqual(["note", "note", "note"]);
    expect(testCase.steps[0]?.text).toBe('Exploration blocked: step 1 "Sign in" blocked (AUTH_CREDENTIAL_UNAVAILABLE). Not written from the exploration; review the instructions below.');
    expect(testCase.steps[2]?.text).toBe("Kiểm tra đăng nhập thành công: trang chính hiển thị menu điều hướng.");
    // Nothing replayable and nothing claiming the login failed or succeeded.
    expect(draft).not.toContain("[Act]");
    expect(draft).not.toContain("[Assert]");
    expect(draft).not.toContain("Login failed");
    expect(transcriptProblems(draft, { macros: withBuiltinMacroSignatures([]), profiles: ["ILHAM_ALL_ACCESS_ACCOUNT"] })).toEqual(["no executable steps"]);
  });

  it("the summary reports the outcome", () => {
    expect(summarizeExploration(blockedLogin)).toEqual({ ended: "finished", steps: 1, findings: 0, outcome: "blocked" });
  });
});

describe("written transcripts are grounded in the DSL, macros and given profiles", () => {
  // The transcript the model wrote for production PCF batch 01a10397-7868-…
  const pcf = [
    "# PCF - Đăng nhập thành công",
    "Tags: source:exploration",
    "Env: pcf-uat",
    "[Open] https://uat.pcf.sv.littlelives.com",
    "## Checkpoint: Truy cập giao diện ban đầu",
    "[Assert] Trang chủ hiển thị form đăng nhập",
    "[Login: PCF_ALL_ACCESS_ACCOUNT]",
    "## Checkpoint: Xác nhận đăng nhập thành công",
    "[Assert] Form đăng nhập biến mất khỏi giao diện",
    "[Assert] Trang chính hiển thị menu điều hướng"
  ].join("\n");
  const grounding = { macros: withBuiltinMacroSignatures([]), profiles: ["PCF_ALL_ACCESS_ACCOUNT"] };

  it("[Login: PROFILE] is the built-in macro, not an unknown one", () => {
    expect(builtinMacroSignatures.map((macro) => macro.name)).toEqual(["Login"]);
    expect(transcriptProblems(pcf, grounding)).toEqual([]);
    // Without the built-in, lint reports what production showed: "No macro named Login."
    expect(transcriptProblems(pcf, { ...grounding, macros: [] })).toEqual(['line 7: No macro named "Login".']);
  });

  it("rejects a hallucinated macro, a profile the exploration was not given, and a missing profile", () => {
    expect(transcriptProblems(pcf.replace("[Login: PCF_ALL_ACCESS_ACCOUNT]", "[Signin: PCF_ALL_ACCESS_ACCOUNT]"), grounding)).toEqual(['line 7: No macro named "Signin".']);
    expect(transcriptProblems(pcf.replace("PCF_ALL_ACCESS_ACCOUNT]", "PCF_SUPER_ADMIN]"), grounding)).toEqual([
      "credential profile PCF_SUPER_ADMIN was not part of the exploration"
    ]);
    expect(transcriptProblems(pcf.replace("[Login: PCF_ALL_ACCESS_ACCOUNT]", "[Login]"), grounding)).toEqual([
      "line 7: [Login] needs a credential profile, e.g. [Login: PCF_HQ_ADMIN].",
      'line 7: Login needs "profile".'
    ]);
  });

  it("the prompt lists the allowed tags, the macros and only the given profiles", () => {
    const prompt = explorationTranscriptPrompt({ title: "T", instructions: "i", environmentName: "pcf-uat", record, grounding });
    expect(prompt).toContain("  [Login: profile]");
    expect(prompt).toContain("only these credential profiles: PCF_ALL_ACCESS_ACCOUNT.");
    expect(prompt).toContain("Do not add steps for stopping");
    expect(explorationTranscriptPrompt({ title: "T", instructions: "i", environmentName: null, record, grounding: { ...grounding, profiles: [] } })).toContain(
      "No credential profile was given; do not write [Login] steps."
    );
  });
});
