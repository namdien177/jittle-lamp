import React from "react";
import { ArrowDownUp, Columns3, Filter, Plus, Search, X } from "lucide-react";
import type { TestCaseSummary, TestEnvironment, TestTag } from "@jittle-lamp/shared";
import { useVirtualWindow } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/misc";
import { CaseStatusBadge, Kbd, OutcomeBadge, TagChip } from "./bits";
import {
  activeFilterCount,
  formatCost,
  formatPassRate,
  formatRelative,
  listColumnIds,
  listColumnLabels,
  toggleValue,
  type ListColumnId,
  type ListFilters,
  type ListSort
} from "./list-model";

export const listRowHeight = 44;

const columnWidth: Record<ListColumnId, string> = {
  key: "84px",
  title: "minmax(180px,1fr)",
  tags: "minmax(150px,250px)",
  status: "76px",
  lastOutcome: "104px",
  passRate: "76px",
  costAvg: "76px",
  environment: "minmax(90px,120px)",
  steps: "48px",
  updated: "76px",
  lastRun: "76px"
};

export function gridTemplate(columns: readonly ListColumnId[]): string {
  return ["28px", ...columns.map((column) => columnWidth[column])].join(" ");
}

export type BulkAction = "run" | "tag" | "untag" | "set-environment" | "duplicate" | "export" | "approve" | "archive";

export function CaseListPane(props: {
  items: readonly TestCaseSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  onNeedMore: () => void;
  filters: ListFilters;
  onFiltersChange: (filters: ListFilters) => void;
  searchDraft: string;
  onSearchDraftChange: (value: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  sort: ListSort;
  onSortChange: (sort: ListSort) => void;
  columns: ListColumnId[];
  onColumnsChange: (columns: ListColumnId[]) => void;
  environments: readonly TestEnvironment[];
  tagDefinitions: readonly TestTag[];
  cursor: number;
  openId: string | null;
  selected: ReadonlySet<string>;
  onRowClick: (index: number, event: React.MouseEvent) => void;
  onToggleRow: (index: number, shift: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulk: (action: BulkAction) => void;
  bulkBusy: boolean;
  onQuickCreate: () => void;
  scrollToCursorToken: number;
  headerAccessory?: React.ReactNode;
}): React.JSX.Element {
  const { items, total, filters, columns } = props;
  const count = Math.max(items.length, props.hasMore ? Math.min(total, items.length + 40) : items.length);
  const { scrollRef, window: win, scrollToIndex } = useVirtualWindow({ count, rowHeight: listRowHeight, overscan: 8 });
  const envNames = React.useMemo(() => new Map(props.environments.map((environment) => [environment.id, environment.name])), [props.environments]);
  const tagColors = React.useMemo(() => new Map(props.tagDefinitions.map((tag) => [tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name, tag.color])), [props.tagDefinitions]);
  const template = gridTemplate(columns);
  const filterCount = activeFilterCount({ ...filters, q: "" });

  // Keyboard moves scroll the cursor row into view without animation.
  React.useEffect(() => {
    if (props.scrollToCursorToken > 0) scrollToIndex(props.cursor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollToCursorToken]);

  React.useEffect(() => {
    if (props.hasMore && win.end >= items.length - 20) props.onNeedMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win.end, items.length, props.hasMore]);

  const setFilters = (patch: Partial<ListFilters>) => props.onFiltersChange({ ...filters, ...patch });
  const selectedCount = props.selected.size;

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border" aria-label="Test case list">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <h1 className="mr-auto text-[18px] font-semibold tracking-[-0.01em]">
          Test cases <span className="ml-1 text-[13px] font-normal text-muted-foreground tabular-nums">{total.toLocaleString()}</span>
        </h1>
        {props.headerAccessory}
        <Button size="xs" onClick={props.onQuickCreate} className="jl-tc-press" aria-keyshortcuts="c">
          <Plus aria-hidden /> New case <Kbd>c</Kbd>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <label className="relative flex min-w-[220px] flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden />
          <input
            ref={props.searchRef}
            type="search"
            value={props.searchDraft}
            onChange={(event) => props.onSearchDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") event.currentTarget.blur();
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            placeholder="Search key, title, transcript, tags…"
            aria-label="Search test cases"
            aria-keyshortcuts="/"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-8 text-[13.5px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring/70 focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <span className="pointer-events-none absolute right-2">
            <Kbd>/</Kbd>
          </span>
        </label>

        <DropdownMenu
          align="start"
          trigger={
            <Button size="xs" variant={filterCount > 0 ? "secondary" : "ghost"} className="jl-tc-press" aria-label={`Filters${filterCount > 0 ? `, ${filterCount} active` : ""}`}>
              <Filter aria-hidden /> Filters{filterCount > 0 ? ` · ${filterCount}` : ""}
            </Button>
          }
        >
          <DropdownMenuLabel>Status</DropdownMenuLabel>
          {(["draft", "review", "active", "archived"] as const).map((status) => (
            <CheckItem key={status} checked={filters.status.includes(status)} onClick={() => setFilters({ status: toggleValue(filters.status, status) })}>
              {status}
            </CheckItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Last outcome</DropdownMenuLabel>
          {(["passed", "failed", "blocked"] as const).map((outcome) => (
            <CheckItem key={outcome} checked={filters.lastOutcome.includes(outcome)} onClick={() => setFilters({ lastOutcome: toggleValue(filters.lastOutcome, outcome) })}>
              {outcome}
            </CheckItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Source</DropdownMenuLabel>
          {(["manual", "import", "ai", "duplicate", "recording"] as const).map((source) => (
            <CheckItem key={source} checked={filters.source.includes(source)} onClick={() => setFilters({ source: toggleValue(filters.source, source) })}>
              {source}
            </CheckItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Environment</DropdownMenuLabel>
          <CheckItem checked={filters.environmentId === null} onClick={() => setFilters({ environmentId: null })}>
            Any environment
          </CheckItem>
          {props.environments.map((environment) => (
            <CheckItem key={environment.id} checked={filters.environmentId === environment.id} onClick={() => setFilters({ environmentId: environment.id })}>
              {environment.name}
            </CheckItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Cache and activity</DropdownMenuLabel>
          <CheckItem checked={filters.staleCache} onClick={() => setFilters({ staleCache: !filters.staleCache })}>
            Stale cache
          </CheckItem>
          {[7, 30, 90].map((days) => (
            <CheckItem key={days} checked={filters.noRunsSinceDays === days} onClick={() => setFilters({ noRunsSinceDays: filters.noRunsSinceDays === days ? null : days })}>
              No runs in {days} days
            </CheckItem>
          ))}
        </DropdownMenu>

        <DropdownMenu
          align="end"
          trigger={
            <Button size="xs" variant="ghost" className="jl-tc-press" aria-label="Sort">
              <ArrowDownUp aria-hidden /> {sortLabel(props.sort)}
            </Button>
          }
        >
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          {(["updated", "created", "key", "title", "last-run"] as const).map((sort) => (
            <CheckItem key={sort} checked={props.sort.sort === sort} onClick={() => props.onSortChange({ ...props.sort, sort })}>
              {sortNames[sort]}
            </CheckItem>
          ))}
          <DropdownMenuSeparator />
          <CheckItem checked={props.sort.order === "desc"} onClick={() => props.onSortChange({ ...props.sort, order: "desc" })}>
            Descending
          </CheckItem>
          <CheckItem checked={props.sort.order === "asc"} onClick={() => props.onSortChange({ ...props.sort, order: "asc" })}>
            Ascending
          </CheckItem>
        </DropdownMenu>

        <DropdownMenu
          align="end"
          trigger={
            <Button size="xs" variant="ghost" className="jl-tc-press" aria-label="Columns">
              <Columns3 aria-hidden />
            </Button>
          }
        >
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          {listColumnIds
            .filter((column) => column !== "title")
            .map((column) => (
              <CheckItem
                key={column}
                checked={columns.includes(column)}
                onClick={() => {
                  const next = columns.includes(column) ? columns.filter((candidate) => candidate !== column) : listColumnIds.filter((candidate) => candidate === column || columns.includes(candidate));
                  props.onColumnsChange(next);
                }}
              >
                {listColumnLabels[column]}
              </CheckItem>
            ))}
        </DropdownMenu>
      </div>

      {filterCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-1.5 text-[12px]">
          {filters.status.map((status) => (
            <FilterChip key={`s-${status}`} label={`status: ${status}`} onRemove={() => setFilters({ status: filters.status.filter((value) => value !== status) })} />
          ))}
          {filters.lastOutcome.map((outcome) => (
            <FilterChip key={`o-${outcome}`} label={`last: ${outcome}`} onRemove={() => setFilters({ lastOutcome: filters.lastOutcome.filter((value) => value !== outcome) })} />
          ))}
          {filters.source.map((source) => (
            <FilterChip key={`src-${source}`} label={`source: ${source}`} onRemove={() => setFilters({ source: filters.source.filter((value) => value !== source) })} />
          ))}
          {filters.tags.map((tag) => (
            <FilterChip key={`t-${tag}`} label={tag} onRemove={() => setFilters({ tags: filters.tags.filter((value) => value !== tag) })} />
          ))}
          {filters.environmentId ? <FilterChip label={`env: ${envNames.get(filters.environmentId) ?? filters.environmentId}`} onRemove={() => setFilters({ environmentId: null })} /> : null}
          {filters.staleCache ? <FilterChip label="stale cache" onRemove={() => setFilters({ staleCache: false })} /> : null}
          {filters.noRunsSinceDays !== null ? <FilterChip label={`no runs in ${filters.noRunsSinceDays}d`} onRemove={() => setFilters({ noRunsSinceDays: null })} /> : null}
          <button type="button" className="jl-tc-press ml-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => props.onFiltersChange({ ...filters, status: [], tags: [], environmentId: null, source: [], lastOutcome: [], staleCache: false, noRunsSinceDays: null })}>
            Clear filters
          </button>
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div className="jl-tc-enter flex flex-wrap items-center gap-1.5 border-b border-primary/30 bg-primary/8 px-4 py-1.5" role="toolbar" aria-label="Bulk actions">
          <span className="mr-1 text-[13px] font-semibold tabular-nums">{selectedCount} selected</span>
          {(
            [
              ["run", "Run"],
              ["duplicate", "Duplicate…"],
              ["tag", "Tag…"],
              ["untag", "Untag…"],
              ["set-environment", "Set env…"],
              ["export", "Export .md"],
              ["approve", "Approve"],
              ["archive", "Archive"]
            ] as const
          ).map(([action, label]) => (
            <Button key={action} size="xs" variant={action === "archive" ? "ghost" : "secondary"} className="jl-tc-press h-7 px-2.5 text-[12.5px]" disabled={props.bulkBusy} onClick={() => props.onBulk(action)}>
              {label}
            </Button>
          ))}
          <button type="button" className="jl-tc-press ml-auto rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Clear selection" onClick={props.onClearSelection}>
            <X className="size-4" aria-hidden />
          </button>
        </div>
      ) : null}

      <div
        role="row"
        className="grid items-center gap-2 border-b border-border px-4 py-1.5 text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground"
        style={{ gridTemplateColumns: template }}
      >
        <span role="columnheader">
          <input
            type="checkbox"
            aria-label="Select all loaded cases"
            className="size-3.5 accent-[var(--primary)]"
            checked={items.length > 0 && items.every((item) => props.selected.has(item.id))}
            onChange={(event) => (event.currentTarget.checked ? props.onSelectAll() : props.onClearSelection())}
          />
        </span>
        {columns.map((column) => (
          <span key={column} role="columnheader" className={cn("truncate", numericColumns.has(column) && "text-right")}>
            {listColumnLabels[column]}
          </span>
        ))}
      </div>

      <div ref={scrollRef} className="jl-scroll relative min-h-0 flex-1 overflow-y-auto" role="grid" aria-rowcount={total} aria-label="Test cases" tabIndex={-1}>
        {props.error ? (
          <p className="p-6 text-[13.5px] text-destructive">{props.error}</p>
        ) : !props.loading && items.length === 0 ? (
          <div className="p-8 text-center text-[13.5px] text-muted-foreground">
            {activeFilterCount(filters) > 0 ? "No case matches these filters." : "No test cases yet. Press c to write the first one."}
          </div>
        ) : (
          <div style={{ height: win.totalHeight, position: "relative" }}>
            <div style={{ transform: `translateY(${win.before}px)` }}>
              {Array.from({ length: win.end - win.start }, (_, offset) => {
                const index = win.start + offset;
                const item = items[index];
                if (!item) {
                  return (
                    <div key={`skeleton-${index}`} className="flex items-center gap-3 px-4" style={{ height: listRowHeight }} aria-hidden>
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-3 flex-1" />
                    </div>
                  );
                }
                return (
                  <CaseRow
                    key={item.id}
                    item={item}
                    index={index}
                    columns={columns}
                    template={template}
                    cursor={props.cursor === index}
                    open={props.openId === item.id}
                    checked={props.selected.has(item.id)}
                    environmentName={item.environmentId ? envNames.get(item.environmentId) ?? null : null}
                    tagColors={tagColors}
                    onClick={(event) => props.onRowClick(index, event)}
                    onToggle={(shift) => props.onToggleRow(index, shift)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-1.5 text-[11.5px] text-muted-foreground">
        <span>
          <Kbd>j</Kbd> <Kbd>k</Kbd> move
        </span>
        <span>
          <Kbd>x</Kbd> select · <Kbd>shift+x</Kbd> range
        </span>
        <span>
          <Kbd>enter</Kbd> open
        </span>
        <span>
          <Kbd>d</Kbd> duplicate
        </span>
        <span>
          <Kbd>r</Kbd> run
        </span>
        <span className="ml-auto tabular-nums">
          {items.length.toLocaleString()} of {total.toLocaleString()} loaded
        </span>
      </footer>
    </section>
  );
}

const numericColumns = new Set<ListColumnId>(["passRate", "costAvg", "steps"]);

const sortNames = { updated: "Updated", created: "Created", key: "Key", title: "Title", "last-run": "Last run" } as const;
function sortLabel(sort: ListSort): string {
  return `${sortNames[sort.sort]} ${sort.order === "desc" ? "↓" : "↑"}`;
}

function CheckItem(props: { checked: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <DropdownMenuItem onClick={props.onClick} closeOnClick={false}>
      <span className={cn("grid size-3.5 place-items-center rounded-sm border text-[10px] leading-none", props.checked ? "border-primary bg-primary text-primary-foreground" : "border-border-strong")} aria-hidden>
        {props.checked ? "✓" : ""}
      </span>
      <span className="sr-only">{props.checked ? "Selected: " : ""}</span>
      {props.children}
    </DropdownMenuItem>
  );
}

function FilterChip(props: { label: string; onRemove: () => void }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border bg-secondary px-1.5 leading-5">
      {props.label}
      <button type="button" className="jl-tc-press rounded text-muted-foreground hover:text-foreground" aria-label={`Remove filter ${props.label}`} onClick={props.onRemove}>
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}

const CaseRow = React.memo(function CaseRow(props: {
  item: TestCaseSummary;
  index: number;
  columns: readonly ListColumnId[];
  template: string;
  cursor: boolean;
  open: boolean;
  checked: boolean;
  environmentName: string | null;
  tagColors: ReadonlyMap<string, string>;
  onClick: (event: React.MouseEvent) => void;
  onToggle: (shift: boolean) => void;
}): React.JSX.Element {
  const { item } = props;
  const stale = item.stats.staleSteps > 0;
  const cell = (column: ListColumnId): React.ReactNode => {
    switch (column) {
      case "key":
        return <span className="font-mono text-[12px] text-muted-foreground">{item.key}</span>;
      case "title":
        return (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[13.5px] text-foreground">{item.title || "Untitled case"}</span>
            {item.status !== "active" ? <CaseStatusBadge status={item.status} /> : null}
            {item.lintErrors > 0 ? (
              <span className="shrink-0 text-[11px] text-destructive" title={`${item.lintErrors} lint error(s)`}>
                ● {item.lintErrors}
              </span>
            ) : null}
            {item.stats.derivedCases > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground">{item.stats.derivedCases} variants</span> : null}
          </span>
        );
      case "tags":
        return (
          <span className="flex min-w-0 gap-1 overflow-hidden">
            {item.tags.slice(0, 3).map((tag) => (
              <TagChip key={tag} tag={tag} color={props.tagColors.get(tag) ?? null} />
            ))}
            {item.tags.length > 3 ? <span className="text-[11px] text-muted-foreground">+{item.tags.length - 3}</span> : null}
          </span>
        );
      case "status":
        return <CaseStatusBadge status={item.status} />;
      case "lastOutcome":
        return stale && item.stats.lastOutcome !== "failed" ? (
          <span className="flex items-center gap-1">
            <OutcomeBadge outcome={item.stats.lastOutcome} />
            <span className="text-[10.5px] text-warning" title={`${item.stats.staleSteps} stale cached step(s)`}>
              stale
            </span>
          </span>
        ) : (
          <OutcomeBadge outcome={item.stats.lastOutcome} />
        );
      case "passRate":
        return <span className="block text-right font-mono text-[12.5px] tabular-nums">{formatPassRate(item.stats.passRate)}</span>;
      case "costAvg":
        return <span className="block text-right font-mono text-[12.5px] tabular-nums">{formatCost(item.stats.avgCostUsd)}</span>;
      case "environment":
        return <span className="truncate text-[12.5px] text-muted-foreground">{props.environmentName ?? "—"}</span>;
      case "steps":
        return <span className="block text-right font-mono text-[12.5px] tabular-nums">{item.stepCount}</span>;
      case "updated":
        return <span className="text-[12px] text-muted-foreground">{formatRelative(item.updatedAt)}</span>;
      case "lastRun":
        return <span className="text-[12px] text-muted-foreground">{formatRelative(item.stats.lastRunAt)}</span>;
    }
  };
  return (
    <div
      role="row"
      aria-rowindex={props.index + 1}
      aria-selected={props.checked}
      data-cursor={props.cursor ? "true" : "false"}
      className={cn(
        "jl-tc-row grid cursor-pointer items-center gap-2 border-b border-border/60 px-4",
        props.open ? "bg-primary/10" : props.checked ? "bg-primary/6" : "hover:bg-muted/60",
        props.cursor && "shadow-[inset_2px_0_0_var(--primary)]"
      )}
      style={{ gridTemplateColumns: props.template, height: listRowHeight }}
      onClick={props.onClick}
    >
      <span role="gridcell" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--primary)]"
          aria-label={`Select ${item.key}`}
          checked={props.checked}
          onChange={(event) => props.onToggle((event.nativeEvent as MouseEvent).shiftKey === true)}
        />
      </span>
      {props.columns.map((column) => (
        <span key={column} role="gridcell" className="min-w-0">
          {cell(column)}
        </span>
      ))}
    </div>
  );
});
