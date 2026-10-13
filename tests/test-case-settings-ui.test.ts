import { describe, expect, it } from "bun:test";

import {
  agentInstructionsCounter,
  applyVariableChange,
  groupTagsByNamespace,
  groupVariables,
  parseDotenv,
  PartialVariableSaveError,
  saveVariableMaps,
  variableConflicts,
  lintMacroBody,
  tagLabel,
  credentialFieldPattern,
  environmentVariablePattern,
  formatUsdPerMtok,
  maskedKeyLabel,
  modelFormRequirements,
  modelPriceHint,
  modelPriceStatus,
  priceFormFromRow,
  priceFromForm,
  removeOrganizationPrice,
  upsertOrganizationPrice,
  modelPresets,
  modelSettingsRequest,
  presetForModels,
  providerFromModelId,
  rowsToRecord,
  registrationTokenAction,
  runnerCommands,
  runSettingsFromForm,
  runSettingsToForm
} from "../apps/evidence-web/src/test-config/config-ui";
import { bellAccessibleName, notificationHref, unreadBadgeLabel } from "../apps/evidence-web/src/notifications/notification-links";
import {
  addSchemaChips,
  formatQueryParams,
  parseQueryParams,
  postgresFieldsFromForm,
  postgresFormFromFields,
  queryFormErrors,
  queryFormValid,
  removeSchemaChip
} from "../apps/evidence-web/src/pages/settings-test-cases/postgres-form";

// Settings → Credentials (Postgres kind) and Settings → Queries (roadmap 2026-10-13 §5).
describe("postgres credential form and queries page helpers", () => {
  it("maps stored postgres fields onto the form and back, with the chips as one allowlist field", () => {
    const form = postgresFormFromFields({ host: "db.internal", port: "5433", database: "sv", user: "readonly", ssl: "true", schema_allowlist: "public, reporting" });
    expect(form).toEqual({ host: "db.internal", port: "5433", database: "sv", user: "readonly", ssl: "require", schemas: ["public", "reporting"] });
    expect(postgresFormFromFields({}).ssl).toBe("disable");
    expect(postgresFormFromFields({ ssl: "verify-full" }).ssl).toBe("verify-full");
    expect(postgresFieldsFromForm(form)).toEqual({
      fields: { host: "db.internal", port: "5433", database: "sv", user: "readonly", ssl: "require", schema_allowlist: "public,reporting" },
      errors: {}
    });
    const empty = postgresFieldsFromForm({ host: " ", port: "70000", database: "", user: "", ssl: "disable", schemas: [] });
    expect(empty.errors).toEqual({ host: "Required.", port: "1–65535.", database: "Required.", user: "Required.", schemas: "At least one schema." });
  });

  it("adds and removes schema chips from typed text and reports bad names", () => {
    expect(addSchemaChips([], "public, Reporting auth")).toEqual({ schemas: ["public", "reporting", "auth"], rejected: [] });
    expect(addSchemaChips(["public"], "public 1bad")).toEqual({ schemas: ["public"], rejected: ["1bad"] });
    expect(removeSchemaChip(["public", "auth"], "auth")).toEqual(["public"]);
  });

  it("checks a saved query inline: name, profile, the guard against the profile's allowlist and the params", () => {
    const credential = { fields: { schema_allowlist: "public" } };
    const ok = queryFormErrors({ credentialId: "c1", name: "k1-pending", sqlText: "select id from students where level = $1", paramsText: "level" }, credential);
    expect(ok).toEqual({ sql: [] });
    expect(queryFormValid(ok)).toBe(true);
    const bad = queryFormErrors({ credentialId: "", name: "1 bad", sqlText: "delete from auth.users where id = $1", paramsText: "a, b" }, null);
    expect(bad.credentialId).toBe("Choose a profile.");
    expect(bad.name).toContain("starting with a letter");
    expect(bad.sql).toContain('"delete" is not allowed in a query.');
    expect(bad.sql).toContain("The profile has no schema allowlist; nothing may be read.");
    expect(bad.params).toBe("The SQL uses 1 placeholder; 2 params declared.");
    expect(queryFormValid(bad)).toBe(false);
    expect(queryFormErrors({ credentialId: "c1", name: "x", sqlText: "   ", paramsText: "" }, credential).sql).toEqual(["Write a SELECT."]);
    expect(queryFormErrors({ credentialId: "c1", name: "x", sqlText: "select 1 from students", paramsText: "1bad" }, credential).params).toBe("Not a name: 1bad.");
    expect(parseQueryParams("level, centre.id")).toEqual({ params: [{ name: "level", kind: "text" }, { name: "centre.id", kind: "text" }], invalid: [] });
    expect(formatQueryParams([{ name: "level", kind: "text" }, { name: "centre", kind: "number" }])).toBe("level, centre");
  });
});

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

  it("hints every supported provider and names the supported prefixes for an unknown one", () => {
    expect(providerFromModelId("xai/grok-4").provider).toBe("xAI");
    expect(providerFromModelId("google/gemini-2.5-pro").provider).toBe("Google");
    expect(providerFromModelId("gateway/openai/gpt-5").provider).toBe("AI Gateway");
    expect(providerFromModelId("openai-compatible/llama-3.3-70b").note).toContain("base URL");
    const unknown = providerFromModelId("mistral/large");
    expect(unknown).toMatchObject({ provider: "Unknown provider", tone: "unknown" });
    expect(unknown.note).toContain("openrouter/, openai-compatible/, gateway/, openai/, anthropic/, google/, xai/");
    // Every preset is a valid pair the backend accepts.
    for (const preset of modelPresets) {
      expect(providerFromModelId(preset.actModel).tone).toBe("ok");
      expect(providerFromModelId(preset.judgeModel).tone).toBe("ok");
      expect(presetForModels(preset.actModel)).toBe(preset.id);
    }
    expect(presetForModels("mock:fixture.json")).toBe("custom");
  });

  const saved = { actModel: "anthropic/claude-opus-5-5", judgeModel: "anthropic/claude-sonnet-5-5", keyConfigured: true, judgeKeyConfigured: false };
  const form = (patch: Partial<Parameters<typeof modelFormRequirements>[0]> = {}) => ({
    actModel: "anthropic/claude-opus-5-5",
    judgeModel: "anthropic/claude-sonnet-5-5",
    baseUrl: "",
    apiKey: "",
    judgeApiKey: "",
    ...patch
  });

  it("asks for a base URL only for openai-compatible models and validates it", () => {
    expect(modelFormRequirements(form(), saved)).toMatchObject({ showBaseUrl: false, showKey: true, showJudgeKey: false, missing: [], errors: {} });
    const compatible = modelFormRequirements(form({ actModel: "openai-compatible/llama-3.3-70b", judgeModel: "openai-compatible/llama-3.3-70b" }), saved);
    expect(compatible).toMatchObject({ showBaseUrl: true, keyOptional: true, keyDropped: true, missing: [] });
    expect(compatible.errors.baseUrl).toContain("base URL");
    expect(modelFormRequirements(form({ actModel: "openai-compatible/x", judgeModel: "openai-compatible/x", baseUrl: "ftp://host" }), saved).errors.baseUrl).toBe(
      "Use an http or https URL."
    );
    const ok = form({ actModel: "openai-compatible/x", judgeModel: "openai-compatible/x", baseUrl: " https://api.groq.com/openai/v1 " });
    const requirements = modelFormRequirements(ok, saved);
    expect(requirements.errors).toEqual({});
    expect(modelSettingsRequest(ok, requirements)).toEqual({
      actModel: "openai-compatible/x",
      judgeModel: "openai-compatible/x",
      baseUrl: "https://api.groq.com/openai/v1"
    });
    // The URL is dropped from the request when no model needs it.
    expect(modelSettingsRequest(form({ baseUrl: "https://stale.example/v1" }), modelFormRequirements(form(), saved))).toEqual({
      actModel: "anthropic/claude-opus-5-5",
      judgeModel: "anthropic/claude-sonnet-5-5"
    });
  });

  it("shows a judge key when the judge uses another provider and reports what runs would miss", () => {
    const mixed = form({ actModel: "openrouter/anthropic/claude-sonnet-5-5", judgeModel: "xai/grok-4" });
    const requirements = modelFormRequirements(mixed, { ...saved, actModel: "openrouter/anthropic/claude-sonnet-5-5" });
    expect(requirements).toMatchObject({ actProvider: "OpenRouter", judgeProvider: "xAI", showJudgeKey: true, keyDropped: false, missing: ["judgeKey"] });
    const typed = { ...mixed, judgeApiKey: "xai-key-123456" };
    expect(modelFormRequirements(typed, saved).missing).toEqual(["key"]);
    expect(modelSettingsRequest(typed, modelFormRequirements(typed, saved))).toEqual({
      actModel: "openrouter/anthropic/claude-sonnet-5-5",
      judgeModel: "xai/grok-4",
      judgeApiKey: "xai-key-123456"
    });
    // A judge key is never sent while both models share a provider.
    const same = form({ judgeApiKey: "left-over-key-0000" });
    expect(modelSettingsRequest(same, modelFormRequirements(same, saved))).not.toHaveProperty("judgeApiKey");
    // A saved judge key is dropped when the judge moves to the act provider.
    expect(modelFormRequirements(form(), { ...saved, judgeModel: "xai/grok-4", judgeKeyConfigured: true }).judgeKeyDropped).toBe(true);
  });

  it("flags unknown prefixes and short keys before saving", () => {
    const requirements = modelFormRequirements(form({ actModel: "gpt-5", judgeModel: "bedrock/claude", apiKey: "short" }), saved);
    expect(requirements.errors.actModel).toContain("<provider>/<model>");
    expect(requirements.errors.judgeModel).toContain('Unknown model provider "bedrock"');
    expect(requirements.errors.apiKey).toBe("The key looks too short.");
    expect(modelFormRequirements(form({ actModel: "mock:fixture.json", judgeModel: "mock:fixture.json" }), saved)).toMatchObject({
      showKey: false,
      showJudgeKey: false,
      missing: []
    });
  });

  const priceRows = [
    { modelId: "anthropic/claude-sonnet-5-5", inputUsdPerMtok: 2, cachedInputUsdPerMtok: 0.2, outputUsdPerMtok: 10, source: "default" as const },
    { modelId: "anthropic/claude-opus-5-5", inputUsdPerMtok: 5, cachedInputUsdPerMtok: 0.5, outputUsdPerMtok: 25, source: "organization" as const },
    { modelId: "openai/gpt-5", inputUsdPerMtok: 1.25, cachedInputUsdPerMtok: 0.125, outputUsdPerMtok: 10, source: "organization" as const }
  ];

  it("explains how each configured model is costed, including cost unknown", () => {
    expect(modelPriceStatus(priceRows, "anthropic/claude-sonnet-5-5")).toEqual({
      kind: "priced",
      matchedModelId: "anthropic/claude-sonnet-5-5",
      source: "default",
      reportsCost: false
    });
    // Router ids fall back to the vendor's row; OpenRouter also reports its own cost.
    expect(modelPriceStatus(priceRows, "openrouter/anthropic/claude-opus-5.5")).toMatchObject({ kind: "priced", matchedModelId: "anthropic/claude-opus-5-5", source: "organization", reportsCost: true });
    expect(modelPriceHint(priceRows, "openrouter/anthropic/claude-opus-5.5")).toBe(
      "OpenRouter reports the cost of each call; the price table is only a fallback. Priced from the organisation's table (the price of anthropic/claude-opus-5-5)."
    );
    expect(modelPriceHint(priceRows, "gateway/openai/gpt-5")).toBe("Priced from the organisation's table (the price of openai/gpt-5).");
    expect(modelPriceStatus(priceRows, "openai-compatible/llama-3.3-70b")).toEqual({ kind: "unknown", reportsCost: false });
    expect(modelPriceHint(priceRows, "openai-compatible/llama-3.3-70b")).toContain("cost unknown until you add a price");
  });

  it("validates a price form and keeps only organisation rows in the PUT body", () => {
    expect(priceFromForm({ modelId: " ", input: "-1", cachedInput: "", output: "x" }).errors).toEqual({
      modelId: "Enter the model id exactly as runs report it.",
      input: "Enter a price of 0 or more.",
      output: "Enter a price of 0 or more."
    });
    const added = priceFromForm({ modelId: "openai-compatible/llama-3.3-70b", input: "0.59", cachedInput: "", output: "0.79" });
    expect(added.price).toEqual({ modelId: "openai-compatible/llama-3.3-70b", inputUsdPerMtok: 0.59, cachedInputUsdPerMtok: 0, outputUsdPerMtok: 0.79 });
    if (!added.price) throw new Error("expected a price");
    // Defaults are never copied into the organisation's set.
    expect(upsertOrganizationPrice(priceRows, added.price).map((row) => row.modelId)).toEqual([
      "anthropic/claude-opus-5-5",
      "openai-compatible/llama-3.3-70b",
      "openai/gpt-5"
    ]);
    // Editing renames replace the edited row; overriding a default adds an organisation row.
    const renamed = { ...added.price, modelId: "openai/gpt-5.1" };
    expect(upsertOrganizationPrice(priceRows, renamed, "openai/gpt-5").map((row) => row.modelId)).toEqual(["anthropic/claude-opus-5-5", "openai/gpt-5.1"]);
    expect(priceFormFromRow(priceRows[0] ?? null)).toEqual({ modelId: "anthropic/claude-sonnet-5-5", input: "2", cachedInput: "0.2", output: "10" });
    expect(removeOrganizationPrice(priceRows, "openai/gpt-5")).toEqual([
      { modelId: "anthropic/claude-opus-5-5", inputUsdPerMtok: 5, cachedInputUsdPerMtok: 0.5, outputUsdPerMtok: 25 }
    ]);
    expect(formatUsdPerMtok(0.125)).toBe("$0.125");
    expect(formatUsdPerMtok(10)).toBe("$10.00");
  });

  it("builds the runner start and docker commands with the token quoted", () => {
    const commands = runnerCommands({ apiOrigin: "https://api.example.com", token: "jlr_abc123" });
    expect(commands.start).toBe("jl-e2e-runner start --api https://api.example.com --token jlr_abc123");
    expect(commands.docker).toContain("JL_RUNNER_TOKEN=jlr_abc123");
    expect(commands.docker).toContain("docker compose -f deploy/runner/compose.yaml up -d");
    expect(runnerCommands({ apiOrigin: "http://x", token: "a b'c" }).start).toBe("jl-e2e-runner start --api http://x --token 'a b'\\''c'");
  });

  it("offers a new registration token for the cloud pool as well as self-hosted pools, to managers only", () => {
    const cloud = registrationTokenAction({ kind: "cloud", name: "cloud" }, true);
    expect(cloud).toMatchObject({ label: "New token", ariaLabel: "New token for cloud", title: "New registration token for cloud" });
    expect(cloud?.note).toContain("runner.env");
    expect(registrationTokenAction({ kind: "self-hosted", name: "devbox" }, true)?.ariaLabel).toBe("New token for devbox");
    expect(registrationTokenAction({ kind: "cloud", name: "cloud" }, false)).toBeNull();
    expect(registrationTokenAction({ kind: "self-hosted", name: "devbox" }, false)).toBeNull();
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
    expect(notificationHref({ ...base, kind: "runner.offline" })).toBe("/test-cases/settings/runner-pools");
    expect(notificationHref({ ...base, kind: "run.finished", url: "/test-cases?case=x" })).toBe("/test-cases?case=x");
    expect(notificationHref({ ...base, kind: "run.finished", url: "https://app.example/test-cases/review?x=1" }, "https://app.example")).toBe("/test-cases/review?x=1");
    expect(notificationHref({ ...base, kind: "run.finished", url: "https://evil.example/x" }, "https://app.example")).toBe("/test-runs/run_1");
    expect(notificationHref({ ...base, kind: "run.finished", url: "//evil.example/x" })).toBe("/test-runs/run_1");
    expect(notificationHref({ ...base, kind: "review.pending_count", url: "/test-cases?status=review" })).toBe("/test-cases/review");
    expect(notificationHref({ ...base, kind: "runner.offline", url: "/settings/runner-pools" })).toBe("/test-cases/settings/runner-pools");
    expect(notificationHref({ ...base, kind: "runner.offline", url: "/settings/test-cases/runner-pools" })).toBe("/test-cases/settings/runner-pools");
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

describe("variables", () => {
  const environments = [
    { id: "env-uat", name: "pcf-uat", variables: { PARENT_URL: "https://parent.uat", LOCALE: "en" } },
    { id: "env-pre", name: "preprod", variables: { PARENT_URL: "https://parent.pre", LOCALE: "en" } }
  ];

  it("groups environments that share a key and value", () => {
    expect(groupVariables(environments)).toEqual([
      { key: "LOCALE", value: "en", environmentIds: ["env-uat", "env-pre"] },
      { key: "PARENT_URL", value: "https://parent.pre", environmentIds: ["env-pre"] },
      { key: "PARENT_URL", value: "https://parent.uat", environmentIds: ["env-uat"] }
    ]);
  });

  it("returns the next variables only for environments a change touches", () => {
    const next = applyVariableChange(environments, { set: { entries: [{ key: "TIMEOUT", value: "30" }], environmentIds: ["env-uat"] } });
    expect([...next.keys()]).toEqual(["env-uat"]);
    expect(next.get("env-uat")).toEqual({ PARENT_URL: "https://parent.uat", LOCALE: "en", TIMEOUT: "30" });
  });

  it("renames a key by removing it before setting the new one", () => {
    const next = applyVariableChange(environments, {
      remove: { key: "LOCALE", environmentIds: ["env-uat", "env-pre"] },
      set: { entries: [{ key: "LANG", value: "en" }], environmentIds: ["env-pre"] }
    });
    expect(next.get("env-uat")).toEqual({ PARENT_URL: "https://parent.uat" });
    expect(next.get("env-pre")).toEqual({ PARENT_URL: "https://parent.pre", LANG: "en" });
  });

  it("drops environments whose variables end up unchanged", () => {
    const next = applyVariableChange(environments, { set: { entries: [{ key: "LOCALE", value: "en" }], environmentIds: ["env-uat", "env-pre"] } });
    expect(next.size).toBe(0);
  });

  it("reports keys a save would overwrite, except the row being edited", () => {
    const entries = [{ key: "PARENT_URL", value: "https://parent.new" }];
    expect(variableConflicts(environments, entries, ["env-uat", "env-pre"])).toEqual(["PARENT_URL in pcf-uat", "PARENT_URL in preprod"]);
    expect(variableConflicts(environments, entries, ["env-uat"], { key: "PARENT_URL", environmentIds: ["env-uat"] })).toEqual([]);
  });

  it("parses .env text", () => {
    const text = ["# comment", "export API_URL=https://api.example", "QUOTED=\"a b\"", "SINGLE='x=1'", "TRAILING=value # note", "", "not a pair"].join("\n");
    expect(parseDotenv(text)).toEqual([
      { key: "API_URL", value: "https://api.example" },
      { key: "QUOTED", value: "a b" },
      { key: "SINGLE", value: "x=1" },
      { key: "TRAILING", value: "value" }
    ]);
  });

  it("reports which environments saved when a later PATCH fails, after handing each save over", async () => {
    const next = new Map([
      ["env-uat", { A: "1" }],
      ["env-pre", { A: "1" }],
      ["env-local", { A: "1" }]
    ]);
    const names: Record<string, string> = { "env-uat": "pcf-uat", "env-pre": "preprod", "env-local": "local" };
    const handed: string[] = [];
    const attempted: string[] = [];
    const failure = saveVariableMaps(
      next,
      (id) => names[id] ?? id,
      async (id) => {
        attempted.push(id);
        if (id === "env-pre") throw new Error("409 conflict");
        return id;
      },
      (id) => handed.push(id)
    );
    await expect(failure).rejects.toBeInstanceOf(PartialVariableSaveError);
    await failure.catch((error: PartialVariableSaveError) => {
      expect(error.saved).toEqual(["pcf-uat"]);
      expect(error.failed).toBe("preprod");
      expect(error.message).toBe("Updated pcf-uat; preprod failed: 409 conflict");
    });
    expect(handed).toEqual(["env-uat"]);
    expect(attempted).toEqual(["env-uat", "env-pre"]);
    expect(await saveVariableMaps(new Map([["env-uat", {}]]), (id) => id, async (id) => id, () => undefined)).toBe(1);
  });

  it("ends a quoted value at its closing quote, before a trailing comment", () => {
    const text = [
      'PARENT_URL="https://example.test" # UAT',
      "SINGLE='a b' # note",
      'HASH_INSIDE="color #fff"',
      "SINGLE_HASH='x # y'",
      "PLAIN=https://example.test#anchor # comment",
      'ESCAPED="say \\"hi\\"" # quoted',
      'UNCLOSED="abc # rest'
    ].join("\n");
    expect(parseDotenv(text)).toEqual([
      { key: "PARENT_URL", value: "https://example.test" },
      { key: "SINGLE", value: "a b" },
      { key: "HASH_INSIDE", value: "color #fff" },
      { key: "SINGLE_HASH", value: "x # y" },
      { key: "PLAIN", value: "https://example.test#anchor" },
      { key: "ESCAPED", value: 'say "hi"' },
      { key: "UNCLOSED", value: '"abc' }
    ]);
  });
});

// Roadmap 2026-10-13 §2.5: the Execution choice of the run dialog and the API fields of an
// environment; §3.4: the API scripts listed in the Details drawer.
import {
  apiConfigForm,
  apiScriptSummaries,
  defaultExecutionMode,
  executionChoices,
  flagCandidateOptions,
  hasUseBlocks,
  isHttpOrigin,
  parseApiConfig
} from "../apps/evidence-web/src/test-cases/api-mode-model";

describe("API mode settings", () => {
  const configured = { apiOrigins: ["https://api.example.test"] };
  const unconfigured = { apiOrigins: [] as string[] };

  it("greys out the non-Full choices until the environment has API origins, and labels API only", () => {
    expect(executionChoices(unconfigured).map((choice) => [choice.value, choice.disabled])).toEqual([
      ["full", false],
      ["hybrid", true],
      ["api", true]
    ]);
    expect(executionChoices(configured).every((choice) => !choice.disabled)).toBe(true);
    expect(executionChoices(configured).find((choice) => choice.value === "api")?.note).toBe("does not test the UI");
    expect(executionChoices(null).filter((choice) => choice.disabled)).toHaveLength(2);
  });

  it("defaults to Fast preconditions only for cases with [Use] blocks on a configured environment", () => {
    expect(hasUseBlocks([{ type: "open" }, { type: "use" }])).toBe(true);
    expect(hasUseBlocks([{ type: "use", disabled: true }])).toBe(false);
    expect(hasUseBlocks(undefined)).toBe(false);
    expect(defaultExecutionMode({ hasUseBlocks: true, environment: configured })).toBe("hybrid");
    expect(defaultExecutionMode({ hasUseBlocks: true, environment: unconfigured })).toBe("full");
    expect(defaultExecutionMode({ hasUseBlocks: false, environment: configured })).toBe("full");
  });

  it("validates the API fields inline and round-trips them", () => {
    const form = apiConfigForm({
      apiOrigins: ["https://api.example.test"],
      openapiUrl: "https://api.example.test/openapi.json",
      apiPolicy: { allowedPaths: ["/api/**"], maxRequestsPerStep: 20, rateLimitPerSecond: 5 }
    });
    expect(form).toEqual({ origins: "https://api.example.test", openapiUrl: "https://api.example.test/openapi.json", allowedPaths: "/api/**", maxRequestsPerStep: "20", rateLimitPerSecond: "5" });
    const parsed = parseApiConfig({ ...form, origins: "https://api.example.test/\n\n https://other.example.test " });
    expect(parsed.errors).toEqual({});
    expect(parsed.value).toEqual({
      apiOrigins: ["https://api.example.test", "https://other.example.test"],
      openapiUrl: "https://api.example.test/openapi.json",
      apiPolicy: { allowedPaths: ["/api/**"], maxRequestsPerStep: 20, rateLimitPerSecond: 5 }
    });
    expect(apiConfigForm(null)).toEqual({ origins: "", openapiUrl: "", allowedPaths: "", maxRequestsPerStep: "50", rateLimitPerSecond: "10" });
    expect(parseApiConfig(apiConfigForm(null)).value).toEqual({ apiOrigins: [], openapiUrl: null, apiPolicy: { allowedPaths: [], maxRequestsPerStep: 50, rateLimitPerSecond: 10 } });
    const invalid = parseApiConfig({ origins: "https://api.example.test/v1", openapiUrl: "ftp://x", allowedPaths: "api/**", maxRequestsPerStep: "0", rateLimitPerSecond: "-1" });
    expect(Object.keys(invalid.errors).sort()).toEqual(["allowedPaths", "maxRequestsPerStep", "openapiUrl", "origins", "rateLimitPerSecond"]);
    expect(isHttpOrigin("https://api.example.test")).toBe(true);
    expect(isHttpOrigin("https://api.example.test/path")).toBe(false);
  });

  it("summarises API scripts per step and offers seq:path candidates for a flag", () => {
    const script = {
      id: "sc1",
      testCaseId: "tc",
      stepId: "s1",
      instructionKey: "k",
      environmentId: null,
      keyHash: "api:s1",
      version: 1,
      renderedCode: "",
      status: "active" as const,
      staleReason: null,
      verifiedCount: 0,
      recordedFromRunId: null,
      lastReplayedAt: null,
      createdAt: 0,
      kind: "api-requests" as const,
      requests: {
        schemaVersion: "jl-api-1" as const,
        stepId: "s1",
        instructionKey: null,
        recordedAt: "2026-10-13T00:00:00.000Z",
        auth: {},
        requests: [
          { seq: 1, method: "POST", origin: "https://api.example.test", pathTemplate: "/api/x", query: {}, headersTemplate: {}, bodyKind: null, numericLeaves: [], mutation: true, check: true, captures: [], expect: null },
          { seq: 2, method: "GET", origin: "https://api.example.test", pathTemplate: "/api/x/1", query: {}, headersTemplate: {}, bodyKind: null, numericLeaves: [], mutation: false, check: false, captures: [], expect: null }
        ],
        reviewFlags: []
      },
      reviewFlags: [{ seq: 2, location: "path[3]", value: "1", reason: "r", candidates: [{ fromSeq: 1, path: "id", sample: "1" }, { fromSeq: 1, fromStepId: "s0", path: "data.id", sample: "2" }] }]
    };
    const summaries = apiScriptSummaries([script, { ...script, id: "ui", kind: "ui-actions" as const, requests: null, reviewFlags: undefined }]);
    expect([...summaries.keys()]).toEqual(["s1"]);
    expect(summaries.get("s1")?.map((summary) => [summary.requests, summary.mutations, summary.flags])).toEqual([[2, 1, 1]]);
    expect(flagCandidateOptions(script.reviewFlags[0]!).map((option) => [option.label, option.fromSeq, option.fromStepId, option.path])).toEqual([
      ["1:id = 1", 1, undefined, "id"],
      ["1:data.id = 2", 1, "s0", "data.id"]
    ]);
  });
});
