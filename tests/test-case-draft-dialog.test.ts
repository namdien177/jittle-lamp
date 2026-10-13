import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTranscriptDocument, type LintFinding } from "@jittle-lamp/shared";

import {
  defaultEnvironmentId,
  describeDraftError,
  draftRows,
  filterStartFromCases,
  lastEnvironmentKey,
  lintSummary,
  loadLastEnvironment,
  manualTranscript,
  placeholderTitle,
  storeLastEnvironment,
  withTitle
} from "../apps/evidence-web/src/test-cases/draft-model";
import { Dialog } from "../apps/evidence-web/src/components/ui/dialog";
import { QuickCreateView, type QuickCreateViewProps } from "../apps/evidence-web/src/test-cases/quick-create";
import { fixtureTranscript } from "./fixtures/test-api-fixtures";

// "What do you want to test?" (roadmap §3.2): the pure model and the dialog body in each state.

const description = "Login as HQ admin\nOpen the registration list and approve the first pending application\nThe status should change to Approved";

describe("draft model", () => {
  test("the placeholder title is the first line; Write steps myself keeps every line as a Note", () => {
    expect(placeholderTitle(description)).toBe("Login as HQ admin");
    expect(placeholderTitle("  \n# Approve  \n")).toBe("Approve");
    expect(placeholderTitle("")).toBe("Untitled test");
    const transcript = manualTranscript(description);
    expect(transcript).toBe(
      "# Login as HQ admin\n\n[Note] Login as HQ admin\n[Note] Open the registration list and approve the first pending application\n[Note] The status should change to Approved\n"
    );
    const parsed = parseTranscriptDocument(transcript).cases[0];
    expect(parsed?.title).toBe("Login as HQ admin");
    expect(parsed?.steps.map((step) => step.type)).toEqual(["note", "note", "note"]);
    expect(manualTranscript("   ")).toBe("# Untitled test\n");
  });

  test("the last environment is remembered per organisation and falls back to the first", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    const environments = [{ id: "env_a" }, { id: "env_b" }];
    expect(defaultEnvironmentId(environments, null)).toBe("env_a");
    storeLastEnvironment(storage, "org_1", "env_b");
    expect(store.get(lastEnvironmentKey("org_1"))).toBe("env_b");
    expect(defaultEnvironmentId(environments, loadLastEnvironment(storage, "org_1"))).toBe("env_b");
    expect(defaultEnvironmentId(environments, loadLastEnvironment(storage, "org_2"))).toBe("env_a");
    // A removed environment no longer wins.
    expect(defaultEnvironmentId([{ id: "env_a" }], "env_b")).toBe("env_a");
    expect(defaultEnvironmentId([], "env_b")).toBe("");
    storeLastEnvironment(null, "org_1", "env_a");
    expect(loadLastEnvironment(null, "org_1")).toBeNull();
  });

  test("the start-from picker matches keys before titles and stays short", () => {
    const cases = [
      { key: "TC-0001", title: "Login as admin" },
      { key: "TC-0012", title: "Submit registration" },
      { key: "TC-0120", title: "Approve application" }
    ];
    expect(filterStartFromCases(cases, "12").map((item) => item.key)).toEqual(["TC-0012", "TC-0120"]);
    expect(filterStartFromCases(cases, "appl").map((item) => item.key)).toEqual(["TC-0120"]);
    expect(filterStartFromCases(cases, "", 2).map((item) => item.key)).toEqual(["TC-0001", "TC-0012"]);
    expect(filterStartFromCases(cases, "nothing")).toEqual([]);
  });

  test("draft rows carry checkpoint headers and the step type; the title line is replaceable", () => {
    const rows = draftRows(fixtureTranscript);
    expect(rows.map((row) => (row.kind === "checkpoint" ? `## ${row.title}` : `${row.type}:${row.text}`))).toEqual([
      "open:/login",
      "login:PCF_HQ_ADMIN",
      "assert:dashboard shows the main navigation",
      'act:open the account menu and choose "Log out"',
      "## Logout returns to the login page",
      "assert:the login form shows an empty Email field",
      "screenshot:login form after logout"
    ]);
    const renamed = withTitle(fixtureTranscript, "New\ntitle ");
    expect(renamed.split("\n")[0]).toBe("# New title");
    expect(parseTranscriptDocument(renamed).cases[0]?.steps).toHaveLength(6);
    expect(withTitle("[Act] no heading", "T")).toBe("# T\n\n[Act] no heading");
    expect(withTitle(fixtureTranscript, "  ").split("\n")[0]).toBe("# Untitled test");
  });

  test("lint and errors read as one line each", () => {
    const finding = (severity: LintFinding["severity"]): LintFinding => ({ ruleId: "r", severity, message: "m", stepId: null, line: null, fix: null });
    expect(lintSummary([])).toBeNull();
    expect(lintSummary([finding("warning")])).toBe("1 warning");
    expect(lintSummary([finding("error"), finding("error"), finding("warning")])).toBe("2 errors · 1 warning");
    expect(describeDraftError({ code: "DRAFT_UNPARSEABLE", message: "x" })).toContain("write them yourself");
    expect(describeDraftError({ code: "MODEL_PROVIDER_UNSUPPORTED", message: "x" })).toContain("Testing settings");
    expect(describeDraftError({ status: 403, message: "Forbidden" })).toContain("write the steps yourself");
    expect(describeDraftError(new Error("boom"))).toBe("boom");
    expect(describeDraftError(null)).toBe("The draft failed.");
  });
});

function render(overrides: Partial<QuickCreateViewProps> = {}): string {
  const noop = () => undefined;
  // DialogTitle needs the Dialog root's context; the root renders no markup of its own.
  return renderToStaticMarkup(
    React.createElement(
      Dialog,
      { open: true },
      React.createElement(QuickCreateView, {
      text: "",
      onTextChange: noop,
      environments: [
        { id: "env_a", name: "pcf-uat" },
        { id: "env_b", name: "ilham-uat" }
      ],
      environmentId: "env_a",
      onEnvironmentChange: noop,
      startFromCases: [{ key: "TC-0012", title: "Submit registration" }],
      startFrom: null,
      onStartFromChange: noop,
      phase: "compose",
      draft: null,
      onDraftTitleChange: noop,
      error: null,
      onWriteMyself: noop,
      onDraft: noop,
      onBackToText: noop,
      onSaveAndRun: noop,
      onClose: noop,
      ...overrides
      })
    )
  );
}

describe("quick create view", () => {
  test("compose: one textarea, both buttons, disabled until something is typed", () => {
    const empty = render();
    expect(empty).toContain("What do you want to test?");
    expect(empty).toContain('aria-label="Describe the test"');
    expect(empty.match(/Write steps myself/g)?.length).toBe(1);
    expect(empty.match(/Run it with AI/g)?.length).toBe(1);
    expect(empty).toContain('aria-label="Start from an existing case"');
    // Both buttons are disabled: nothing typed yet.
    expect((empty.match(/<button[^>]*disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const typed = render({ text: description });
    const buttons = typed.match(/<button[^>]*>/g) ?? [];
    const primary = buttons.find((button) => button.includes('aria-keyshortcuts="Meta+Enter"'));
    expect(primary).toBeDefined();
    expect(primary).not.toContain('disabled=""');
  });

  test("drafting: the primary button spins with Drafting… and everything is disabled", () => {
    const html = render({ text: description, phase: "drafting" });
    expect(html).toContain("Drafting…");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('data-slot="spinner"');
    expect(html).toContain("jl-tc-spin");
    expect(html).not.toContain("Run it with AI");
    const textarea = html.match(/<textarea[^>]*>/)?.[0] ?? "";
    expect(textarea).toContain("disabled");
  });

  test("error: the message sits under the textarea as an alert", () => {
    const html = render({ text: description, error: "The model could not write these steps." });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The model could not write these steps.");
    expect(html).toContain('aria-invalid="true"');
  });

  test("drafted: the step list with type rails, an editable title, one lint line and Save and run", () => {
    const html = render({
      text: description,
      phase: "drafted",
      draft: {
        title: "HQ admin logout returns a clean login form",
        transcript: fixtureTranscript,
        lint: [{ ruleId: "assert-specific", severity: "warning", message: "Name the element.", stepId: null, line: 7, fix: null }],
        similar: [{ id: "c1", key: "TC-0007", title: "Logout", score: 0.6, exact: false }]
      }
    });
    expect(html).toContain("Review the draft");
    expect(html).toContain('value="HQ admin logout returns a clean login form"');
    expect(html).toContain("jl-tc-stagger");
    expect((html.match(/class="jl-tc-rail/g) ?? []).length).toBe(6);
    expect(html).toContain('data-type="assert"');
    expect(html).toContain("Logout returns to the login page");
    expect(html).toContain("6 steps");
    expect(html).toContain("1 warning");
    expect(html).toContain("1 similar: TC-0007");
    expect(html).toContain("Save and run");
    expect(html).not.toContain("Write steps myself");
  });

  test("saving and queueing keep the footer busy", () => {
    const draft = { title: "t", transcript: fixtureTranscript, lint: [], similar: [] };
    expect(render({ text: description, phase: "saving", draft })).toContain("Saving…");
    expect(render({ text: description, phase: "queueing", draft })).toContain("Queueing…");
    expect(render({ text: description, phase: "saving" })).toContain("Saving…");
  });
});
