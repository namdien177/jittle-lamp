import { describe, expect, it } from "bun:test";
import { webhookRuleSchema } from "@jittle-lamp/shared";

import {
  channelFilterSummary,
  credentialKindForProvider,
  deliveryTone,
  describeRule,
  draftToRule,
  emptyRuleDraft,
  notesBudget,
    providerSetup,
  reportSummary,
  ruleToDraft,
  splitList
} from "../apps/evidence-web/src/test-config/webhook-ui";

const SUITE = "0199a000-0000-7000-8000-000000000001";
const ENV = "0199a000-0000-7000-8000-000000000002";
const CREDENTIAL = "0199a000-0000-7000-8000-000000000003";

describe("webhook rule drafts", () => {
  it("splits comma and newline lists", () => {
    expect(splitList(" main, release/* ,\nmain, ")).toEqual(["main", "release/*"]);
    expect(splitList("")).toEqual([]);
  });

  it("turns a draft into a contract rule and back", () => {
    const draft = {
      ...emptyRuleDraft(),
      events: ["merge_request" as const, "deployment" as const],
      branches: "main, feature/**",
      labels: "e2e",
      suiteId: SUITE,
            environmentMode: "review_app_url" as const,
      environmentId: ENV,
      allowedHosts: "*.review.example.test, MR-*.Preview.example.test",
      priority: "60",
      commitStatus: true,
      mrNote: true,
      callbackUrl: "https://ci.example.test/hook",
      credentialId: CREDENTIAL
    };
    const result = draftToRule(draft);
    if (!result.ok) throw new Error(result.error);
    expect(webhookRuleSchema.parse(result.rule)).toEqual(result.rule);
    expect(result.rule).toEqual({
      when: { events: ["merge_request", "deployment"], branches: ["main", "feature/**"], labels: ["e2e"] },
      run: { suiteId: SUITE },
            environment: {
        fromPayload: "review_app_url",
        baseEnvironmentId: ENV,
        allowedHosts: ["*.review.example.test", "mr-*.preview.example.test"]
      },
      priority: 60,
      report: { commitStatus: true, mrNote: true, callbackUrl: "https://ci.example.test/hook", credentialId: CREDENTIAL }
    });
    expect(draftToRule(ruleToDraft(result.rule))).toEqual(result);
  });

  it("explains what is missing", () => {
    const base = { ...emptyRuleDraft(), suiteId: SUITE, environmentId: ENV, credentialId: CREDENTIAL };
    expect(draftToRule({ ...base, events: [] })).toEqual({ ok: false, error: "Pick at least one event." });
    expect(draftToRule({ ...base, suiteId: "" })).toEqual({ ok: false, error: "Pick the suite to run." });
    expect(draftToRule({ ...base, environmentId: "", environmentMode: "deployment_url" })).toEqual({ ok: false, error: "Pick the base environment." });
    expect(draftToRule({ ...base, priority: "101" }).ok).toBe(false);
        expect(draftToRule({ ...base, callbackUrl: "ftp://x" }).ok).toBe(false);
    expect(draftToRule({ ...base, environmentMode: "review_app_url", allowedHosts: "https://evil.example.net/x" }).ok).toBe(false);
    expect(draftToRule({ ...base, credentialId: "" })).toEqual({ ok: false, error: "Commit status and MR notes need a GitHub or GitLab credential." });
    expect(draftToRule({ ...base, credentialId: "", commitStatus: false, mrNote: false }).ok).toBe(true);
  });

  it("describes rules in words", () => {
    const rule = webhookRuleSchema.parse({
      when: { events: ["merge_request"], branches: ["main"], labels: ["e2e"] },
      run: { suiteId: SUITE },
      environment: { id: ENV },
      priority: 10,
      report: { commitStatus: true, mrNote: false, callbackUrl: null, credentialId: CREDENTIAL }
    });
    expect(describeRule(rule, { suites: { [SUITE]: "Smoke" }, environments: { [ENV]: "pcf-uat" } })).toEqual({
      when: "merge request / pull request on main labelled e2e",
      run: "Smoke on pcf-uat · priority 10",
      report: "commit status"
    });
    expect(describeRule(rule, { suites: {}, environments: {} }).run).toBe("a deleted suite on a deleted environment · priority 10");
  });

  it("matches providers to report credentials, setup steps and delivery tones", () => {
    expect(credentialKindForProvider("github")).toBe("github_app");
    expect(credentialKindForProvider("gitlab")).toBe("gitlab_token");
    expect(credentialKindForProvider("generic")).toBeNull();
    expect(providerSetup("github").join(" ")).toContain("application/json");
    expect(providerSetup("gitlab").join(" ")).toContain("Secret token");
    expect(deliveryTone("matched")).toBe("success");
    expect(deliveryTone("rejected")).toBe("danger");
    expect(deliveryTone("ignored")).toBe("muted");
  });
});

describe("notification channel and agent notes helpers", () => {
  it("summarises channel filters", () => {
    expect(channelFilterSummary({ kinds: [], tags: [] })).toBe("All events");
    expect(channelFilterSummary({ kinds: ["run.finished", "batch.finished"], tags: ["team:qa"] })).toBe("Run finished, Batch finished · cases tagged team:qa");
  });

  it("counts agent notes in UTF-8 bytes against 16 KB", () => {
    expect(notesBudget("abc")).toEqual({ bytes: 3, remaining: 16_381, over: false, label: "3 / 16,384 bytes" });
    const accents = notesBudget("é".repeat(8_200));
    expect(accents.bytes).toBe(16_400);
    expect(accents.over).toBe(true);
  });
});

describe("webhook delivery report states", () => {
  it("shows retries and dead-lettered reports", () => {
    expect(reportSummary(null)).toBeNull();
    expect(reportSummary({ stage: "final", state: "sent", attempts: 0, error: null })).toEqual({ label: "result reported", tone: "success" });
    expect(reportSummary({ stage: "pending", state: "retrying", attempts: 2, error: "GitHub commit status answered 502" })).toEqual({
      label: "pending status retrying (2 of 5): GitHub commit status answered 502",
      tone: "warning"
    });
    expect(reportSummary({ stage: "final", state: "failed", attempts: 5, error: "Callback refused" })?.tone).toBe("danger");
  });
});

