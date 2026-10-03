import { z } from "zod/v4";
import {
  testCaseSourceSchema,
  testCaseStatusSchema,
  testRunOutcomeSchema,
  type TestCaseListQuery,
  type TestCaseListResponse,
  type TestTag
} from "@jittle-lamp/shared";

// Pure model of the test case library (design.md §7 "Organising thousands"): filters, saved views,
// query serialisation, tag sidebar grouping and the list keyboard map.

// ---------------------------------------------------------------------------------------------
// Filters, sort, columns
// ---------------------------------------------------------------------------------------------

export const listColumnIds = ["key", "title", "tags", "status", "lastOutcome", "passRate", "costAvg", "environment", "steps", "updated", "lastRun"] as const;
export type ListColumnId = (typeof listColumnIds)[number];
export const defaultColumns: ListColumnId[] = ["key", "title", "tags", "lastOutcome", "passRate", "costAvg"];

export const listColumnLabels: Record<ListColumnId, string> = {
  key: "Key",
  title: "Title",
  tags: "Tags",
  status: "Status",
  lastOutcome: "Last outcome",
  passRate: "Pass rate",
  costAvg: "Cost avg",
  environment: "Environment",
  steps: "Steps",
  updated: "Updated",
  lastRun: "Last run"
};

export const listFiltersSchema = z.object({
  q: z.string().default(""),
  status: z.array(testCaseStatusSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  environmentId: z.string().min(1).nullable().default(null),
  source: z.array(testCaseSourceSchema).default([]),
  lastOutcome: z.array(testRunOutcomeSchema).default([]),
  staleCache: z.boolean().default(false),
  noRunsSinceDays: z.number().int().positive().nullable().default(null)
});
export type ListFilters = z.infer<typeof listFiltersSchema>;

export const listSortSchema = z.object({
  sort: z.enum(["updated", "created", "key", "title", "last-run"]).default("updated"),
  order: z.enum(["asc", "desc"]).default("desc")
});
export type ListSort = z.infer<typeof listSortSchema>;

export const emptyFilters = (): ListFilters => listFiltersSchema.parse({});
export const defaultSort = (): ListSort => listSortSchema.parse({});

export function activeFilterCount(filters: ListFilters): number {
  return (
    (filters.q.trim().length > 0 ? 1 : 0) +
    filters.status.length +
    filters.tags.length +
    (filters.environmentId ? 1 : 0) +
    filters.source.length +
    filters.lastOutcome.length +
    (filters.staleCache ? 1 : 0) +
    (filters.noRunsSinceDays !== null ? 1 : 0)
  );
}

export function filtersToQuery(filters: ListFilters, sort: ListSort, page: { limit?: number; cursor?: string | null } = {}): Partial<TestCaseListQuery> {
  const query: Partial<TestCaseListQuery> = { sort: sort.sort, order: sort.order, limit: page.limit ?? 200 };
  const q = filters.q.trim();
  if (q.length > 0) query.q = q;
  if (filters.status.length > 0) query.status = filters.status;
  if (filters.tags.length > 0) query.tags = filters.tags;
  if (filters.environmentId) query.environmentId = filters.environmentId;
  if (filters.source.length > 0) query.source = filters.source;
  if (filters.lastOutcome.length > 0) query.lastOutcome = filters.lastOutcome;
  if (filters.staleCache) query.staleCache = true;
  if (filters.noRunsSinceDays !== null) query.noRunsSinceDays = filters.noRunsSinceDays;
  if (page.cursor) query.cursor = page.cursor;
  return query;
}

// GET query string: arrays are comma-joined (`status=draft,active`), booleans `true`.
export function listQuerySearchParams(query: Partial<TestCaseListQuery>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(","));
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

export function toggleValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

// ---------------------------------------------------------------------------------------------
// Saved views (filter + sort + columns), persisted per organisation in localStorage
// ---------------------------------------------------------------------------------------------

export const savedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  filters: listFiltersSchema,
  sort: listSortSchema,
  columns: z.array(z.enum(listColumnIds)).min(1)
});
export type SavedView = z.infer<typeof savedViewSchema>;

const savedViewsFileSchema = z.object({ version: z.literal(1), views: z.array(z.unknown()) });

export function savedViewsStorageKey(orgId: string): string {
  return `jl-test-case-views:${orgId}`;
}

export function serializeSavedViews(views: readonly SavedView[]): string {
  return JSON.stringify({ version: 1, views });
}

// Tolerant: a corrupt entry is dropped, not the whole list.
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  const file = savedViewsFileSchema.safeParse(payload);
  if (!file.success) return [];
  return file.data.views.flatMap((view) => {
    const parsed = savedViewSchema.safeParse(view);
    return parsed.success ? [parsed.data] : [];
  });
}

export function upsertSavedView(views: readonly SavedView[], view: SavedView): SavedView[] {
  const index = views.findIndex((candidate) => candidate.id === view.id);
  if (index === -1) return [...views, view];
  return views.map((candidate, i) => (i === index ? view : candidate));
}

export function viewMatches(view: SavedView, filters: ListFilters, sort: ListSort, columns: readonly ListColumnId[]): boolean {
  return JSON.stringify([view.filters, view.sort, view.columns]) === JSON.stringify([listFiltersSchema.parse(filters), sort, columns]);
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function loadSavedViews(storage: StorageLike | null, orgId: string): SavedView[] {
  if (!storage) return [];
  try {
    return parseSavedViews(storage.getItem(savedViewsStorageKey(orgId)));
  } catch {
    return [];
  }
}

export function storeSavedViews(storage: StorageLike | null, orgId: string, views: readonly SavedView[]): void {
  if (!storage) return;
  try {
    storage.setItem(savedViewsStorageKey(orgId), serializeSavedViews(views));
  } catch {
    // Quota or privacy mode: views stay in memory for this session.
  }
}

// ---------------------------------------------------------------------------------------------
// Tag sidebar: namespaces with counts
// ---------------------------------------------------------------------------------------------

export type TagGroup = {
  namespace: string;
  label: string;
  total: number;
  tags: { tag: string; name: string; count: number; color: string | null }[];
};

export function tagValue(namespace: string, name: string): string {
  return namespace.length > 0 ? `${namespace}:${name}` : name;
}

export function buildTagGroups(tagCounts: TestCaseListResponse["tagCounts"], definitions: readonly TestTag[] = []): TagGroup[] {
  const colors = new Map(definitions.map((tag) => [tagValue(tag.namespace, tag.name), tag.color]));
  const groups: TagGroup[] = Object.entries(tagCounts).map(([namespace, counts]) => {
    const tags = Object.entries(counts)
      .map(([name, count]) => ({ tag: tagValue(namespace, name), name, count, color: colors.get(tagValue(namespace, name)) ?? null }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { namespace, label: namespace.length > 0 ? namespace : "Other tags", total: tags.reduce((sum, tag) => sum + tag.count, 0), tags };
  });
  // Organisation-managed namespaces without cases still show up so the tree is stable.
  for (const definition of definitions) {
    let group = groups.find((candidate) => candidate.namespace === definition.namespace);
    if (!group) {
      group = { namespace: definition.namespace, label: definition.namespace.length > 0 ? definition.namespace : "Other tags", total: 0, tags: [] };
      groups.push(group);
    }
    if (!group.tags.some((tag) => tag.name === definition.name)) {
      group.tags.push({ tag: tagValue(definition.namespace, definition.name), name: definition.name, count: 0, color: definition.color });
    }
  }
  return groups.sort((a, b) => (a.namespace === "" ? 1 : b.namespace === "" ? -1 : a.namespace.localeCompare(b.namespace)));
}

// ---------------------------------------------------------------------------------------------
// Selection and keyboard map (j/k, enter, /, x, shift+x, c, d, r)
// ---------------------------------------------------------------------------------------------

export type ListSelection = {
  // Index of the keyboard cursor row.
  cursor: number;
  selected: ReadonlySet<string>;
  // Index of the last x-toggled row, the anchor for shift+x ranges.
  anchor: number | null;
};

export type ListAction =
  | { type: "move"; delta: number; count: number }
  | { type: "set-cursor"; index: number }
  | { type: "toggle"; ids: readonly string[] }
  | { type: "range"; ids: readonly string[] }
  | { type: "select-all"; ids: readonly string[] }
  | { type: "clear" }
  | { type: "retain"; ids: readonly string[] };

export const emptySelection = (): ListSelection => ({ cursor: 0, selected: new Set(), anchor: null });

// `ids` is the visible id list in order, so ranges follow what the user sees.
export function listSelectionReducer(state: ListSelection, action: ListAction): ListSelection {
  switch (action.type) {
    case "move": {
      if (action.count === 0) return { ...state, cursor: 0 };
      return { ...state, cursor: Math.min(action.count - 1, Math.max(0, state.cursor + action.delta)) };
    }
    case "set-cursor":
      return { ...state, cursor: Math.max(0, action.index) };
    case "toggle": {
      const id = action.ids[state.cursor];
      if (id === undefined) return state;
      const selected = new Set(state.selected);
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      return { ...state, selected, anchor: state.cursor };
    }
    case "range": {
      const anchor = state.anchor ?? state.cursor;
      const [from, to] = anchor <= state.cursor ? [anchor, state.cursor] : [state.cursor, anchor];
      const selected = new Set(state.selected);
      // The range takes the anchor row's state: selecting extends, deselecting clears.
      const anchorId = action.ids[anchor];
      const select = anchorId === undefined ? true : state.selected.has(anchorId) || state.anchor === null;
      for (let index = from; index <= to; index += 1) {
        const id = action.ids[index];
        if (id === undefined) continue;
        if (select) selected.add(id);
        else selected.delete(id);
      }
      return { ...state, selected, anchor: state.cursor };
    }
    case "select-all":
      return { ...state, selected: new Set(action.ids) };
    case "clear":
      return { ...state, selected: new Set(), anchor: null };
    case "retain": {
      const keep = new Set(action.ids);
      const selected = new Set([...state.selected].filter((id) => keep.has(id)));
      return selected.size === state.selected.size ? state : { ...state, selected };
    }
  }
}

// A key another handler already consumed (an editor picker's Escape) or an IME composition step
// never reaches the list map.
export function listKeyEventIgnored(event: { defaultPrevented: boolean; isComposing?: boolean; keyCode?: number }): boolean {
  return event.defaultPrevented || event.isComposing === true || event.keyCode === 229;
}

// Unsaved editor changes live in the Steps tab of the open case; leaving the case or the tab
// unmounts the editor, so those moves ask first.
export function leavingDetailNeedsConfirm(input: {
  dirty: boolean;
  current: { caseId: string | null; tab: string };
  next: { caseId: string | null; tab: string };
}): boolean {
  if (!input.dirty || input.current.caseId === null) return false;
  if (input.next.caseId !== input.current.caseId) return true;
  return input.current.tab === "steps" && input.next.tab !== "steps";
}

export type ListCommand = "next" | "prev" | "open" | "focus-search" | "toggle-select" | "range-select" | "quick-create" | "duplicate" | "run" | "escape" | "select-all";

export function listKeyCommand(event: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  // The event comes from an input, textarea, select or contenteditable.
  inEditable: boolean;
  // The event comes from a button, link or menu item: Enter, Space and arrows belong to it.
  inInteractive?: boolean;
}): ListCommand | null {
  if (event.metaKey || event.ctrlKey || event.altKey) {
    if ((event.metaKey || event.ctrlKey) && !event.inEditable && (event.key === "a" || event.key === "A")) return "select-all";
    return null;
  }
  if (event.inEditable) return event.key === "Escape" ? "escape" : null;
  if (event.inInteractive && (event.key === "Enter" || event.key === " " || event.key === "ArrowUp" || event.key === "ArrowDown")) return null;
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "next";
    case "k":
    case "ArrowUp":
      return "prev";
    case "Enter":
    case "o":
      return "open";
    case "/":
      return "focus-search";
    case "x":
      return "toggle-select";
    case "X":
      return event.shiftKey ? "range-select" : "toggle-select";
    case "c":
      return "quick-create";
    case "d":
      return "duplicate";
    case "r":
      return "run";
    case "Escape":
      return "escape";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers for the table
// ---------------------------------------------------------------------------------------------

export function formatPassRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

export function formatCost(cost: number | null): string {
  if (cost === null) return "—";
  if (cost === 0) return "$0";
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatRelative(epochMs: number | null, now = Date.now()): string {
  if (epochMs === null) return "never";
  const delta = Math.max(0, now - epochMs);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epochMs).toISOString().slice(0, 10);
}

// `jl-e2e run --case <id> --env <id> --wait` (packages/e2e-runner/src/cli.ts).
export function cliRunCommand(input: { caseId: string; environmentId: string | null }): string {
  return `jl-e2e run --case ${input.caseId}${input.environmentId ? ` --env ${input.environmentId}` : ""} --wait`;
}
