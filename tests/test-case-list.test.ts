import { describe, expect, test } from "bun:test";

import { testCaseListQuerySchema } from "@jittle-lamp/shared";

import { computeVirtualWindow, scrollTopForIndex } from "../packages/ui/src/virtual-window";
import { parseEnvelope } from "../apps/evidence-web/src/test-cases/api";
import {
  activeFilterCount,
  buildTagGroups,
  cliRunCommand,
  defaultColumns,
  defaultSort,
  emptyFilters,
  emptySelection,
  filtersToQuery,
  listKeyCommand,
  listQuerySearchParams,
  listSelectionReducer,
  loadSavedViews,
  parseSavedViews,
  savedViewsStorageKey,
  serializeSavedViews,
  storeSavedViews,
  upsertSavedView,
  viewMatches,
  type ListSelection,
  type SavedView
} from "../apps/evidence-web/src/test-cases/list-model";
import { z } from "zod/v4";

describe("windowing for thousands of rows", () => {
  test("renders a bounded slice and keeps total height exact at start, middle and end", () => {
    for (const count of [0, 1, 37, 5_000, 50_000]) {
      for (const scrollTop of [0, 440, 120_000, 99_999_999]) {
        const win = computeVirtualWindow({ count, rowHeight: 44, scrollTop, viewportHeight: 700, overscan: 6 });
        expect(win.start).toBeGreaterThanOrEqual(0);
        expect(win.end).toBeLessThanOrEqual(count);
        expect(win.end - win.start).toBeLessThanOrEqual(Math.ceil(700 / 44) + 1 + 12);
        expect(win.before + (win.end - win.start) * 44 + win.after).toBe(count * 44);
        if (count > 0) expect(win.end).toBeGreaterThan(win.start);
      }
    }
  });

  test("the rows under the viewport are always inside the window", () => {
    const win = computeVirtualWindow({ count: 5_000, rowHeight: 44, scrollTop: 44 * 2_500 + 10, viewportHeight: 440 });
    expect(win.start).toBeLessThanOrEqual(2_500);
    expect(win.end).toBeGreaterThanOrEqual(2_511);
  });

  test("keyboard moves scroll the cursor row into view, and not otherwise", () => {
    expect(scrollTopForIndex({ index: 5, rowHeight: 44, scrollTop: 0, viewportHeight: 440 })).toBeNull();
    expect(scrollTopForIndex({ index: 10, rowHeight: 44, scrollTop: 0, viewportHeight: 440 })).toBe(44);
    expect(scrollTopForIndex({ index: 2, rowHeight: 44, scrollTop: 300, viewportHeight: 440 })).toBe(88);
  });
});

describe("filters and the list query", () => {
  test("empty filters ask for the default sort and nothing else", () => {
    const query = filtersToQuery(emptyFilters(), defaultSort());
    expect(query).toEqual({ sort: "updated", order: "desc", limit: 200 });
    expect(activeFilterCount(emptyFilters())).toBe(0);
  });

  test("every filter maps to the contract query and validates against it", () => {
    const filters = {
      ...emptyFilters(),
      q: "  logout ",
      status: ["active" as const, "review" as const],
      tags: ["team:qa-pcf", "regression"],
      environmentId: "env_1",
      source: ["import" as const],
      lastOutcome: ["failed" as const],
      staleCache: true,
      noRunsSinceDays: 30
    };
    const query = filtersToQuery(filters, { sort: "last-run", order: "asc" }, { limit: 100, cursor: "c2" });
    expect(testCaseListQuerySchema.parse(query)).toMatchObject({ q: "logout", staleCache: true, noRunsSinceDays: 30, cursor: "c2" });
    expect(activeFilterCount(filters)).toBe(10);
    expect(listQuerySearchParams(query).toString()).toBe(
      "sort=last-run&order=asc&limit=100&q=logout&status=active%2Creview&tags=team%3Aqa-pcf%2Cregression&environmentId=env_1&source=import&lastOutcome=failed&staleCache=true&noRunsSinceDays=30&cursor=c2"
    );
  });
});

describe("saved views persist per organisation", () => {
  const view: SavedView = {
    id: "view_1",
    name: "PCF login, failing",
    filters: { ...emptyFilters(), tags: ["team:qa-pcf", "feature:login"], lastOutcome: ["failed"] },
    sort: { sort: "last-run", order: "desc" },
    columns: ["key", "title", "lastOutcome", "costAvg"]
  };

  test("round-trips through JSON and drops corrupt entries only", () => {
    expect(parseSavedViews(serializeSavedViews([view]))).toEqual([view]);
    const corrupt = JSON.stringify({ version: 1, views: [view, { id: "x", name: "", columns: [] }, 42] });
    expect(parseSavedViews(corrupt)).toEqual([view]);
    expect(parseSavedViews("not json")).toEqual([]);
    expect(parseSavedViews(JSON.stringify({ version: 2, views: [view] }))).toEqual([]);
    expect(parseSavedViews(null)).toEqual([]);
  });

  test("storage keys are per org and upsert replaces by id", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    storeSavedViews(storage, "org_a", [view]);
    expect(store.has(savedViewsStorageKey("org_a"))).toBe(true);
    expect(loadSavedViews(storage, "org_a")).toEqual([view]);
    expect(loadSavedViews(storage, "org_b")).toEqual([]);
    const renamed = { ...view, name: "Renamed" };
    expect(upsertSavedView([view], renamed)).toEqual([renamed]);
    expect(upsertSavedView([view], { ...view, id: "view_2" })).toHaveLength(2);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); } };
    expect(loadSavedViews(throwing, "org_a")).toEqual([]);
    expect(() => storeSavedViews(throwing, "org_a", [view])).not.toThrow();
  });

  test("a view is active when filter, sort and columns all match", () => {
    expect(viewMatches(view, view.filters, view.sort, view.columns)).toBe(true);
    expect(viewMatches(view, view.filters, view.sort, defaultColumns)).toBe(false);
    expect(viewMatches(view, { ...view.filters, staleCache: true }, view.sort, view.columns)).toBe(false);
  });
});

describe("tag sidebar", () => {
  test("namespaces group with counts, org-defined tags without cases still appear, free tags last", () => {
    const groups = buildTagGroups(
      { team: { "qa-pcf": 12, core: 3 }, "": { regression: 7 }, feature: { login: 4 } },
      [
        { id: "t1", namespace: "team", name: "qa-pcf", color: "#22c55e", description: null, count: 12 },
        { id: "t2", namespace: "prio", name: "p1", color: "#ef4444", description: null, count: 0 }
      ]
    );
    expect(groups.map((group) => `${group.label}:${group.total}`)).toEqual(["feature:4", "prio:0", "team:15", "Other tags:7"]);
    expect(groups.find((group) => group.namespace === "team")?.tags.map((tag) => [tag.tag, tag.count, tag.color])).toEqual([
      ["team:qa-pcf", 12, "#22c55e"],
      ["team:core", 3, null]
    ]);
    expect(groups.at(-1)?.tags[0]?.tag).toBe("regression");
  });
});

describe("list keyboard map and selection", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const at = (cursor: number, selected: string[] = [], anchor: number | null = null): ListSelection => ({ cursor, selected: new Set(selected), anchor });

  test("keys map to commands; typing in inputs is left alone", () => {
    const key = (k: string, extra: Partial<Parameters<typeof listKeyCommand>[0]> = {}) => listKeyCommand({ key: k, inEditable: false, ...extra });
    expect([key("j"), key("k"), key("Enter"), key("/"), key("x"), key("X", { shiftKey: true }), key("c"), key("d"), key("r"), key("Escape")]).toEqual([
      "next",
      "prev",
      "open",
      "focus-search",
      "toggle-select",
      "range-select",
      "quick-create",
      "duplicate",
      "run",
      "escape"
    ]);
    expect(key("j", { inEditable: true })).toBeNull();
    expect(key("Escape", { inEditable: true })).toBe("escape");
    expect(key("c", { metaKey: true })).toBeNull();
    expect(key("a", { metaKey: true })).toBe("select-all");
  });

  test("j/k clamp to the list; x toggles the cursor row; shift+x selects the range from the anchor", () => {
    expect(listSelectionReducer(at(0), { type: "move", delta: -1, count: 5 }).cursor).toBe(0);
    expect(listSelectionReducer(at(4), { type: "move", delta: 1, count: 5 }).cursor).toBe(4);
    let state = listSelectionReducer(at(1), { type: "toggle", ids });
    expect([...state.selected]).toEqual(["b"]);
    state = listSelectionReducer({ ...state, cursor: 3 }, { type: "range", ids });
    expect([...state.selected].sort()).toEqual(["b", "c", "d"]);
    state = listSelectionReducer(state, { type: "toggle", ids });
    expect([...state.selected].sort()).toEqual(["b", "c"]);
    expect(listSelectionReducer(state, { type: "clear" }).selected.size).toBe(0);
    expect(listSelectionReducer(state, { type: "retain", ids: ["c"] }).selected).toEqual(new Set(["c"]));
    expect(listSelectionReducer(emptySelection(), { type: "select-all", ids }).selected.size).toBe(5);
  });

  test("shift+x from a deselected anchor clears the range", () => {
    let state = listSelectionReducer(at(2, ["a", "b", "c", "d"]), { type: "toggle", ids });
    expect(state.selected.has("c")).toBe(false);
    state = listSelectionReducer({ ...state, cursor: 0 }, { type: "range", ids });
    expect([...state.selected]).toEqual(["d"]);
  });

  test("the CLI command names the case and environment ids", () => {
    expect(cliRunCommand({ caseId: "tc_1", environmentId: "env_9" })).toBe("jl-e2e run --case tc_1 --env env_9 --wait");
    expect(cliRunCommand({ caseId: "tc_1", environmentId: null })).toBe("jl-e2e run --case tc_1 --wait");
  });
});

describe("API envelopes", () => {
  test("accepts the bare payload or a known envelope, and names the first schema error", () => {
    const schema = z.array(z.object({ id: z.string() }));
    expect(parseEnvelope(schema, [{ id: "a" }], ["items"], "x")).toEqual([{ id: "a" }]);
    expect(parseEnvelope(schema, { items: [{ id: "a" }] }, ["items"], "x")).toEqual([{ id: "a" }]);
    expect(() => parseEnvelope(schema, { items: [{ id: 1 }] }, ["items"], "list")).toThrow(/Unexpected list response/);
  });
});
