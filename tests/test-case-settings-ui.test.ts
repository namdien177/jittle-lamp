import { describe, expect, it } from "bun:test";

import {
  agentInstructionsCounter,
  groupTagsByNamespace,
  lintMacroBody,
  tagLabel,
  credentialFieldPattern,
  environmentVariablePattern,
  maskedKeyLabel,
  providerFromModelId,
  rowsToRecord,
  runnerCommands,
  runSettingsFromForm,
  runSettingsToForm
} from "../apps/evidence-web/src/test-config/config-ui";
import { bellAccessibleName, notificationHref, unreadBadgeLabel } from "../apps/evidence-web/src/notifications/notification-links";

describe("settings helpers", () => {
  it("validates key/value rows and reports invalid or repeated names", () => {
    expect(
      rowsToRecord(
        [
          { key: "PARENT_URL", value: "https://parent" },
          { key: "", value: "" },
          { key: "1BAD", value: "x" },
          { key: "PARENT_URL", value: "again" }
        ],
        environmentVariablePattern,
        "Variable"
      )
    ).toEqual({
      record: { PARENT_URL: "https://parent" },
      errors: ['Variable "1BAD" is not a valid name.', 'Variable "PARENT_URL" appears twice.']
    });
    expect(rowsToRecord([{ key: "Username", value: "x" }], credentialFieldPattern, "Field").errors).toHaveLength(1);
  });

  it("counts agent instructions against the 16 KB limit", () => {
    expect(agentInstructionsCounter("abc")).toEqual({ used: 3, limit: 16_384, over: false, label: "3 / 16,384" });
    expect(agentInstructionsCounter("x".repeat(16_385)).over).toBe(true);
  });

  it("hints the provider from the model id prefix", () => {
    expect(providerFromModelId("anthropic/claude-opus-5-5").provider).toBe("Anthropic");
    expect(providerFromModelId("openrouter/anthropic/claude-sonnet-5-5").provider).toBe("OpenRouter");
    expect(providerFromModelId("openai-compatible/llama").provider).toBe("OpenAI-compatible");
    expect(providerFromModelId("claude-code/sonnet").tone).toBe("warning");
    expect(providerFromModelId("gpt-5").tone).toBe("unknown");
    expect(maskedKeyLabel(true, "a1b2")).toBe("Configured · ••••a1b2");
    expect(maskedKeyLabel(false, null)).toBe("Not configured");
  });

  it("builds the runner start and docker commands with the token quoted", () => {
    const commands = runnerCommands({ apiOrigin: "https://api.example.com", token: "jlr_abc123" });
    expect(commands.start).toBe("jl-e2e-runner start --api https://api.example.com --token jlr_abc123");
    expect(commands.docker).toContain("JL_RUNNER_TOKEN=jlr_abc123");
    expect(commands.docker).toContain("docker compose -f deploy/runner/compose.yaml up -d --build");
    expect(runnerCommands({ apiOrigin: "http://x", token: "a b'c" }).start).toBe("jl-e2e-runner start --api http://x --token 'a b'\\''c'");
  });

  it("round-trips run settings through the form and validates ranges", () => {
    const settings = {
      maxConcurrentRuns: 1,
      dedupeWindowSeconds: 120,
      maxQueuedRuns: 20,
      maxQueuedPerCase: 3,
      tokenBucketSize: 30,
      tokenBucketWindowSeconds: 600,
      dailyBudgetUsd: null,
      retention: { failedDays: 180, passedDays: 30 }
    };
    expect(runSettingsFromForm(runSettingsToForm(settings))).toEqual({ value: settings, errors: {} });
    const invalid = runSettingsFromForm({ ...runSettingsToForm(settings), maxConcurrentRuns: "0", dailyBudgetUsd: "-1", passedDays: "2.5" });
    expect(invalid.value).toBeNull();
    expect(Object.keys(invalid.errors).sort()).toEqual(["dailyBudgetUsd", "maxConcurrentRuns", "passedDays"]);
    expect(runSettingsFromForm({ ...runSettingsToForm(settings), dailyBudgetUsd: "12.345" }).value?.dailyBudgetUsd).toBe(12.35);
  });
});

describe("notification links", () => {
  it("prefers a same-origin URL and falls back to the subject", () => {
    const base = { url: null, subjectType: "test_run", subjectId: "run_1" } as const;
    expect(notificationHref({ ...base, kind: "run.finished" })).toBe("/test-runs/run_1");
    expect(notificationHref({ ...base, kind: "import.finished", subjectType: "import_batch", subjectId: "b1" })).toBe("/test-cases/import/b1");
    expect(notificationHref({ ...base, kind: "review.pending_count" })).toBe("/test-cases/review");
    expect(notificationHref({ ...base, kind: "runner.offline" })).toBe("/settings/test-cases/runner-pools");
    expect(notificationHref({ ...base, kind: "run.finished", url: "/test-cases?case=x" })).toBe("/test-cases?case=x");
    expect(notificationHref({ ...base, kind: "run.finished", url: "https://app.example/test-cases/review?x=1" }, "https://app.example")).toBe("/test-cases/review?x=1");
    expect(notificationHref({ ...base, kind: "run.finished", url: "https://evil.example/x" }, "https://app.example")).toBe("/test-runs/run_1");
  });

  it("caps the badge and names the bell for screen readers", () => {
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(7)).toBe("7");
    expect(unreadBadgeLabel(140)).toBe("99+");
    expect(bellAccessibleName(3)).toBe("Notifications, 3 unread");
    expect(bellAccessibleName(0)).toBe("Notifications");
  });
});

describe("macro and tag helpers", () => {
  it("lints a macro body with its params as known variables and skips case-only rules", () => {
    const body = "[Open] /login\n[Act] type the username of {profile} into Email\n[Act] click #submit-btn";
    const findings = lintMacroBody(body, [{ name: "profile" }], []);
    expect(findings.map((finding) => finding.ruleId)).toEqual(["selector-in-instruction"]);
    expect(lintMacroBody(body, [], []).map((finding) => finding.ruleId)).toContain("undeclared-variable");
    expect(lintMacroBody("", [], [])).toEqual([]);
    expect(lintMacroBody("# One\n[Act] a\n# Two\n[Act] b", [], [])[0]?.ruleId).toBe("parse");
  });

  it("labels tags and groups them by namespace with free tags last", () => {
    expect(tagLabel({ namespace: "team", name: "qa-pcf" })).toBe("team:qa-pcf");
    expect(tagLabel({ namespace: "", name: "regression" })).toBe("regression");
    const groups = groupTagsByNamespace([
      { namespace: "", name: "smoke" },
      { namespace: "team", name: "qa-pcf" },
      { namespace: "feature", name: "login" },
      { namespace: "feature", name: "enrolment" }
    ]);
    expect(groups.map((group) => [group.namespace, group.tags.map((tag) => tag.name)])).toEqual([
      ["feature", ["enrolment", "login"]],
      ["team", ["qa-pcf"]],
      ["", ["smoke"]]
    ]);
  });
});
