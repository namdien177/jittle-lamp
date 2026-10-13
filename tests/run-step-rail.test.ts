import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunStepRail, adjacentPillId, railKeyCommand, railPillTitle, railPills, railScrollTarget, type RunStepRailStep } from "@jittle-lamp/ui";

// The horizontal step rail of the run view (roadmap 2026-10-13 §3.5): pills, selection, keys,
// overflow and macro folding. Rendering is static; the scroll maths is a pure function.

const step = (overrides: Partial<RunStepRailStep> & Pick<RunStepRailStep, "stepId" | "ordinal">): RunStepRailStep => ({
  parentStepId: null,
  type: "act",
  label: `step ${overrides.ordinal}`,
  status: "passed",
  mode: null,
  ...overrides
});

const steps: RunStepRailStep[] = [
  step({ stepId: "s1", ordinal: 1, type: "open" }),
  step({ stepId: "s2", ordinal: 2, type: "login", mode: "agent" }),
  step({ stepId: "s2.1", ordinal: 2, parentStepId: "s2" }),
  step({ stepId: "s2.2", ordinal: 2, parentStepId: "s2" }),
  step({ stepId: "s3", ordinal: 3, mode: "replayed" }),
  step({ stepId: "s4", ordinal: 4, type: "assert", status: "failed", label: "The confirmation page shows a reference number" }),
  step({ stepId: "s5", ordinal: 5, status: "skipped" })
];

describe("railPills", () => {
  test("folds expanded macro steps under their parent with a count", () => {
    const pills = railPills(steps);
    expect(pills.map((pill) => [pill.step.stepId, pill.childCount])).toEqual([
      ["s1", 0],
      ["s2", 2],
      ["s3", 0],
      ["s4", 0],
      ["s5", 0]
    ]);
    expect(railPillTitle(pills[1]!)).toBe("Step 2 · login · passed · agent · 2 macro steps\nstep 2");
    expect(railPillTitle(pills[3]!)).toBe("Step 4 · assert · failed\nThe confirmation page shows a reference number");
  });
});

describe("selection", () => {
  const pills = railPills(steps);

  test("prev and next walk the top-level pills and stop at the ends", () => {
    expect(adjacentPillId(pills, "s2", 1)).toBe("s3");
    expect(adjacentPillId(pills, "s2", -1)).toBe("s1");
    expect(adjacentPillId(pills, "s1", -1)).toBeNull();
    expect(adjacentPillId(pills, "s5", 1)).toBeNull();
    // From nothing: next starts at the first step, prev at the last.
    expect(adjacentPillId(pills, null, 1)).toBe("s1");
    expect(adjacentPillId(pills, null, -1)).toBe("s5");
    expect(adjacentPillId([], null, 1)).toBeNull();
  });

  test("n/j move forward, p/k back, other keys are not rail keys", () => {
    expect(railKeyCommand("n")).toBe("next");
    expect(railKeyCommand("j")).toBe("next");
    expect(railKeyCommand("p")).toBe("prev");
    expect(railKeyCommand("k")).toBe("prev");
    expect(railKeyCommand("Enter")).toBeNull();
    expect(railKeyCommand("N")).toBeNull();
  });
});

describe("overflow", () => {
  test("scrolls only when the selected pill is outside the visible track", () => {
    const track = { scrollLeft: 0, clientWidth: 400 };
    expect(railScrollTarget(track, { offsetLeft: 20, offsetWidth: 60 })).toBeNull();
    // Past the right edge: bring it in with 16px of padding after it.
    expect(railScrollTarget(track, { offsetLeft: 380, offsetWidth: 60 })).toBe(56);
    // Before the left edge of a scrolled track.
    expect(railScrollTarget({ scrollLeft: 300, clientWidth: 400 }, { offsetLeft: 290, offsetWidth: 60 })).toBe(274);
    // The first pill never scrolls below zero.
    expect(railScrollTarget({ scrollLeft: 300, clientWidth: 400 }, { offsetLeft: 8, offsetWidth: 60 })).toBe(0);
  });
});

describe("RunStepRail markup", () => {
  const render = (props: Partial<React.ComponentProps<typeof RunStepRail>> = {}) =>
    renderToStaticMarkup(React.createElement(RunStepRail, { steps, activeStepId: "s4", onSelect: () => undefined, ...props }));

  test("one pill per top-level step with its status, the failed one selected", () => {
    const html = render();
    expect((html.match(/class="jl-rail-pill"/g) ?? []).length).toBe(5);
    expect(html).not.toContain('data-step-id="s2.1"');
    expect(html).toContain('data-step-id="s4" data-status="failed" data-active="true"');
    expect(html).toContain('aria-current="step"');
    expect((html.match(/aria-current="step"/g) ?? []).length).toBe(1);
    // Macro count and the replayed bolt.
    expect(html).toContain('<span class="jl-rail-kids">+2</span>');
    expect(html).toContain('aria-label="replayed"');
    expect(html).toContain('title="Step 1 · open · passed');
  });

  test("a keyboard move marks the rail instant so the highlight does not animate", () => {
    expect(render({ instant: true })).toContain('data-instant="true"');
    expect(render()).toContain('data-instant="false"');
  });

  test("the host can wrap pills (tooltips) and add a trailing control", () => {
    const html = render({
      renderPill: (pill, element) => React.createElement("span", { "data-tip-for": pill.step.stepId }, element),
      trailing: React.createElement("button", { type: "button" }, "Details")
    });
    expect(html).toContain('data-tip-for="s3"');
    expect(html).not.toContain('title="Step 1');
    expect(html).toContain('<div class="jl-rail-trailing"><button type="button">Details</button></div>');
  });
});
