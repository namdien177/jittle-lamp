import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseTranscriptDocument } from "@jittle-lamp/shared";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";

import {
  caseHref,
  caseMenuItems,
  defaultView,
  editingFromSearch,
  exportFileName,
  hasFlowSteps,
  latestRun,
  runHref,
  runPickerLabel,
  shownRun,
  viewSegments
} from "../apps/evidence-web/src/test-cases/case-page-model";
import { TestCasePageView, type TestCasePageViewProps } from "../apps/evidence-web/src/test-cases/case-page-view";
import { buildFlowGraph } from "../apps/evidence-web/src/test-cases/flow-model";
import { FlowNodeView, FlowView, flowNodeType, type FlowNodeType } from "../apps/evidence-web/src/test-cases/flow-view";
import { fixtureRunDetail, fixtureRunSummary, fixtureTestCaseDetail } from "./fixtures/test-api-fixtures";

// The case page (roadmap §3.4): the pure model and the static layout in its three states.

describe("case page model", () => {
  test("the left pane opens on Flow for any case with steps; editing and empty cases open on Steps", () => {
    const useSteps = parseTranscriptDocument("# A\n\n[Use: TC-0001]\n[Act] continue").cases[0]?.steps ?? [];
    expect(hasFlowSteps(useSteps)).toBe(true);
    expect(hasFlowSteps([{ type: "query", disabled: false }])).toBe(true);
    expect(hasFlowSteps([{ type: "api", disabled: true }])).toBe(false);
    expect(hasFlowSteps(fixtureTestCaseDetail().steps)).toBe(false);
    expect(defaultView({ editing: false, steps: 3, flowAvailable: true })).toBe("flow");
    expect(defaultView({ editing: true, steps: 3, flowAvailable: true })).toBe("steps");
    expect(defaultView({ editing: false, steps: 0, flowAvailable: true })).toBe("steps");
    expect(defaultView({ editing: false, steps: 3, flowAvailable: false })).toBe("steps");
    expect(viewSegments.map((segment) => segment.id)).toEqual(["flow", "steps", "text"]);
  });

  test("the right pane shows the picked run while it is listed, else the newest", () => {
    const runs = [fixtureRunSummary({ id: "r_old", queuedAt: 10 }), fixtureRunSummary({ id: "r_new", queuedAt: 30 }), fixtureRunSummary({ id: "r_mid", queuedAt: 20 })];
    expect(latestRun(runs)?.id).toBe("r_new");
    expect(latestRun([])).toBeNull();
    expect(shownRun(runs, null)?.id).toBe("r_new");
    expect(shownRun(runs, "r_mid")?.id).toBe("r_mid");
    expect(shownRun(runs, "r_gone")?.id).toBe("r_new");
    expect(runPickerLabel(fixtureRunSummary({ status: "completed", outcome: "failed", queuedAt: 5, transcriptVersion: 3 }), () => "2h ago")).toBe("failed · 2h ago · v3");
    expect(runPickerLabel(fixtureRunSummary({ status: "running", outcome: null, queuedAt: 5, transcriptVersion: 1 }), () => "just now")).toBe("running · just now · v1");
  });

  test("routes, the edit flag and the menu", () => {
    expect(caseHref("tc 1")).toBe("/test-cases/tc%201");
    expect(runHref("run/1")).toBe("/test-runs/run%2F1");
    expect(editingFromSearch("?edit=1")).toBe(true);
    expect(editingFromSearch("?edit=0")).toBe(false);
    expect(editingFromSearch("")).toBe(false);
    expect(exportFileName("TC-0412")).toBe("tc-0412.transcript.md");
    expect(caseMenuItems.map((item) => item.id)).toEqual(["rename", "tags", "links", "duplicate", "versions", "export", "clear-scripts", "archive"]);
  });
});

function render(overrides: Partial<TestCasePageViewProps> = {}): string {
  const noop = () => undefined;
  return renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(TestCasePageView, {
        detail: fixtureTestCaseDetail(),
        environmentName: "pcf-uat",
        runs: [],
        runsLoaded: true,
        view: null,
        onViewChange: noop,
        selectedRunId: null,
        onSelectRun: noop,
        onShowAllRuns: noop,
        editing: false,
        onEditingChange: noop,
        renaming: false,
        onRenamingChange: noop,
        onRename: noop,
        drawerOpen: false,
        onRun: noop,
        onMenu: noop,
        renderSteps: (input) => React.createElement("div", { "data-steps": input.editing ? "editable" : "read-only", "data-view": input.view }, "STEPS"),
        renderStepsToolbar: (input) => React.createElement("button", { type: "button", "data-toolbar": input.editing ? "save" : "edit" }, input.editing ? "Save" : "Edit steps"),
        renderRun: (runId) => React.createElement("div", { "data-run-view": runId }, "RUN VIEW"),
        renderDrawer: () => React.createElement("aside", { "data-drawer": "" }),
        ...overrides
      })
    )
  );
}

describe("case page view", () => {
  test("never run: one Run button with the environment name, the editor in edit mode", () => {
    const html = render({ editing: true });
    expect(html).toContain("TC-0412");
    expect(html).toContain("Never run");
    expect(html).toContain("pcf-uat");
    expect(html).not.toContain("RUN VIEW");
    expect(html).not.toContain('aria-label="Choose a run"');
    expect(html).toContain('data-steps="editable"');
    expect(html).toContain('data-view="steps"');
    expect(html).toContain('data-toolbar="save"');
    expect(html).toContain('data-editing="true"');
    // Header Run plus the empty state's Run.
    expect((html.match(/>\s*Run\s*<\/button>|Run<\/button>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("with runs: Steps | Text on the left without the Flow slot, the newest run behind its picker, a link to its page, steps read-only", () => {
    const runs = [fixtureRunSummary({ id: "r_old", queuedAt: 10 }), fixtureRunSummary({ id: "r_new", queuedAt: 30 })];
    const html = render({ runs });
    expect(html).toContain('role="tablist" aria-label="Case view"');
    expect(html).not.toContain(">Flow<");
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>Steps</);
    expect(html).toContain(">Text<");
    expect(html).toContain('data-toolbar="edit"');
    expect(html).toContain('aria-label="Choose a run"');
    expect(html).toContain('data-run-view="r_new"');
    expect(html).toContain(`href="${runHref("r_new")}"`);
    expect(html).toContain('data-steps="read-only"');
  });

  test("the Text view and a picked run", () => {
    const runs = [fixtureRunSummary({ id: "r_1", queuedAt: 10 }), fixtureRunSummary({ id: "r_2", queuedAt: 20 })];
    expect(render({ runs, editing: true })).toContain('data-steps="editable"');
    const text = render({ runs, view: "text", selectedRunId: "r_1" });
    expect(text).toContain('data-view="text"');
    expect(text).toContain('data-run-view="r_1"');
    expect(text).toContain(`href="${runHref("r_1")}"`);
  });

  test("the Flow slot adds the first segment and opens by default; editing opens Steps", () => {
    const detail = fixtureTestCaseDetail({ steps: parseTranscriptDocument("# A\n\n[Use: TC-0001]\n[Act] continue").cases[0]?.steps ?? [] });
    const flow = () => React.createElement("div", { "data-flow": "" }, "FLOW");
    const html = render({ detail, runs: [fixtureRunSummary({ id: "r_1" })], renderFlow: flow });
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>Flow</);
    expect(html).toContain('data-flow=""');
    expect(html).not.toContain("STEPS");
    expect(html).toContain('data-run-view="r_1"');
    const editing = render({ detail, runs: [fixtureRunSummary({ id: "r_1" })], renderFlow: flow, editing: true });
    expect(editing).toContain('data-steps="editable"');
    expect(editing).not.toContain('data-flow=""');
  });

  test("the Flow view mounts an xyflow canvas and renders a node per checkpoint, a use node with its link, output pills and the run outcome", () => {
    const transcript = "# A\n\n[Open] /login\n[Use: TC-0012 as registration]\n[Act] open {registration.applicationId}\n\n## Checkpoint: Find\n[Extract: applicationId] the id\n[Assert] visible\n\n## Checkpoint: Open\n[Open] /apps/{applicationId}\n";
    const parsed = parseTranscriptDocument(transcript).cases[0];
    const steps = parsed?.steps ?? [];
    const detail = fixtureTestCaseDetail({ transcript, steps });
    const latestRun = fixtureRunDetail({ status: "completed", outcome: "passed", steps: [] });
    const linkedCases = [{ key: "TC-0012", id: "case_12", title: "Parent registers a child" }];
    const selected = steps[3]?.stepId ?? null;
    // The canvas: xyflow mounts its nodes from the DOM, so a static render shows the frame only.
    const canvas = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(FlowView, { detail, latestRun, selectedStepId: selected, onSelectStep: () => undefined, environmentName: "pcf-uat", linkedCases }))
    );
    expect(canvas).toContain('class="react-flow');
    expect(canvas).toContain('aria-label="Flow"');
    expect(canvas).toContain("react-flow__controls-zoomin");
    expect(canvas).not.toContain("react-flow__controls-fitview");
    expect(canvas).not.toContain("react-flow__minimap");
    expect(flowNodeType("output")).toBe("pill");
    expect(flowNodeType("checkpoint")).toBe("checkpoint");
    // The nodes, rendered through the same component xyflow mounts.
    const graph = buildFlowGraph({ steps, checkpoints: parsed?.checkpoints ?? [], run: latestRun, environmentName: "pcf-uat", linkedCases });
    const html = graph.nodes
      .map((node) =>
        renderToStaticMarkup(
          React.createElement(
            MemoryRouter,
            null,
            React.createElement(ReactFlowProvider, null, React.createElement(FlowNodeView, { id: node.id, type: flowNodeType(node.data.kind), data: { node, selected: node.stepIds.includes(selected ?? "") && node.data.kind !== "output" } } as unknown as NodeProps<FlowNodeType>))
          )
        )
      )
      .join("\n");
    expect(html).toContain('data-kind="start"');
    expect(html).toContain("pcf-uat");
    expect(html).toContain('data-kind="use"');
    expect(html).toContain("Parent registers a child");
    expect(html).toContain(`href="${caseHref("case_12")}"`);
    expect(html).toContain("as registration");
    expect(html).toContain('data-kind="output"');
    expect(html).toContain("registration.applicationId");
    expect((html.match(/data-kind="checkpoint"/g) ?? []).length).toBe(2);
    expect(html).toContain("Find");
    expect(html).toContain("0/0 replayed");
    expect(html).toContain('data-kind="end"');
    expect(html).toContain("Passed");
    // Only the node holding the selected step is highlighted.
    expect((html.match(/data-selected="true"/g) ?? []).length).toBe(1);
    expect(html).toMatch(/data-kind="checkpoint" data-selected="true"/);
  });

  test("the Flow view with no steps shows the Steps pane's empty words", () => {
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(FlowView, { detail: fixtureTestCaseDetail({ transcript: "# A\n", steps: [] }), latestRun: null, selectedStepId: null, onSelectStep: () => undefined })));
    expect(html).toContain("No steps");
    expect(html).not.toContain("react-flow");
  });

  test("renaming swaps the title for an input", () => {
    expect(render({ renaming: true })).toContain('aria-label="Title"');
    expect(render()).toContain("HQ admin logout returns a clean login form");
  });
});
