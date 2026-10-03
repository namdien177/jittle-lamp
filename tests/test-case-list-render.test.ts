import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CaseListPane, caseRowId } from "../apps/evidence-web/src/test-cases/case-list";
import { defaultColumns, defaultSort, emptyFilters } from "../apps/evidence-web/src/test-cases/list-model";
import { fixtureTestCaseSummary } from "./fixtures/test-api-fixtures";

// Static render of the list pane: grid semantics and keyboard-driven motion (review findings 7, 8).
function render(overrides: { instant?: boolean; selected?: string[]; cursor?: number } = {}): string {
  const items = [fixtureTestCaseSummary({ id: "tc_a", key: "TC-0001" }), fixtureTestCaseSummary({ id: "tc_b", key: "TC-0002" })];
  return renderToStaticMarkup(
    React.createElement(CaseListPane, {
      items,
      total: 2,
      loading: false,
      error: null,
      hasMore: false,
      onNeedMore: () => undefined,
      filters: emptyFilters(),
      onFiltersChange: () => undefined,
      searchDraft: "",
      onSearchDraftChange: () => undefined,
      searchRef: { current: null },
      sort: defaultSort(),
      onSortChange: () => undefined,
      columns: defaultColumns,
      onColumnsChange: () => undefined,
      environments: [],
      tagDefinitions: [],
      cursor: overrides.cursor ?? 1,
      openId: null,
      selected: new Set(overrides.selected ?? ["tc_a"]),
      onRowClick: () => undefined,
      onToggleRow: () => undefined,
      onSelectAll: () => undefined,
      onClearSelection: () => undefined,
      onBulk: () => undefined,
      bulkBusy: false,
      onQuickCreate: () => undefined,
      scrollToCursorToken: 0,
      ...(overrides.instant !== undefined ? { instant: overrides.instant } : {})
    })
  );
}

describe("case list grid", () => {
  test("the header row sits inside the grid and the cursor row is the active descendant", () => {
    const html = render();
    const grid = html.indexOf('role="grid"');
    expect(grid).toBeGreaterThan(-1);
    expect(html.indexOf('role="columnheader"')).toBeGreaterThan(grid);
    expect(html).toContain(`aria-activedescendant="${caseRowId("tc_b")}"`);
    expect(html).toContain(`id="${caseRowId("tc_b")}"`);
    expect((html.match(/role="grid"/g) ?? []).length).toBe(1);
  });

  test("a keyboard-driven selection shows the bulk bar without the enter animation", () => {
    expect(render({ instant: false })).toContain("jl-tc-enter");
    const instant = render({ instant: true });
    expect(instant).not.toContain("jl-tc-enter");
    expect(instant).toContain('data-instant="true"');
  });
});
