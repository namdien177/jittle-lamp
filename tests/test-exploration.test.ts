import { describe, expect, it } from "bun:test";

import {
  claimRunResponseSchema,
  explorationFallbackTranscript,
  explorationGoal,
  explorationTranscriptPrompt,
  parseTestCaseTranscript,
  splitInstructions,
  type ExplorationRecord
} from "@jittle-lamp/shared";

import { explorationLabel } from "../apps/evidence-web/src/test-cases/import/batch-state";

const record: ExplorationRecord = {
  goal: "g",
  ended: "finished",
  summary: "The   new interest\nis listed.",
  steps: [
    { index: 1, title: "Sign in", instruction: "Sign in as the HQ admin", status: "passed", summary: "Dashboard shown" },
    { index: 2, title: "Blocked", instruction: "Open billing", status: "blocked", summary: null },
    { index: 3, title: "Add", instruction: "Open Interests and click New interest", status: "exhausted", summary: null }
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
    expect(prompt).toContain("never write passwords");
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
    const base = { environmentName: "pcf-uat", attempts: 1, error: null, ended: null, steps: 0, findings: 0 };
    expect(explorationLabel({ exploration: null })).toBeNull();
    expect(explorationLabel({ exploration: { ...base, status: "queued" } })).toEqual({ text: "Waiting for a runner on pcf-uat", tone: "muted" });
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
});
