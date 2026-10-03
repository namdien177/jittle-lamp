import React from "react";
import { AlertCircle, Bookmark, ChevronRight, ClipboardCheck, Clock, Layers, Plus, RefreshCcw, Trash2, type LucideIcon } from "lucide-react";

import { cn } from "../lib/cn";
import { emptyFilters, toggleValue, viewMatches, type ListColumnId, type ListFilters, type ListSort, type SavedView, type TagGroup } from "./list-model";
import { Hint } from "../components/ui/tooltip";

type QuickView = { id: string; label: string; icon: LucideIcon; filters: Partial<ListFilters> };

const quickViews: QuickView[] = [
  { id: "all", label: "All cases", icon: Layers, filters: {} },
  { id: "review", label: "Review queue", icon: ClipboardCheck, filters: { status: ["review"] } },
  { id: "failed", label: "Failed last run", icon: AlertCircle, filters: { lastOutcome: ["failed"] } },
  { id: "stale", label: "Stale cache", icon: RefreshCcw, filters: { staleCache: true } },
  { id: "idle", label: "No runs in 30 days", icon: Clock, filters: { noRunsSinceDays: 30 } }
];

export function CaseSidebar(props: {
  filters: ListFilters;
  sort: ListSort;
  columns: readonly ListColumnId[];
  onApply: (input: { filters: ListFilters; sort?: ListSort; columns?: ListColumnId[] }) => void;
  tagGroups: readonly TagGroup[];
  savedViews: readonly SavedView[];
  onSaveView: (name: string) => void;
  onDeleteView: (id: string) => void;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set());
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState("");

  const isQuickActive = (view: QuickView) =>
    JSON.stringify({ ...emptyFilters(), q: props.filters.q, ...view.filters }) === JSON.stringify(props.filters);

  return (
    <aside className="jl-scroll flex min-h-0 flex-col gap-6 overflow-y-auto border-r border-border bg-sidebar/60 px-3 py-4" aria-label="Test case views and tags">
      <nav aria-label="Views" className="flex flex-col gap-0.5">
        <SidebarHeading>Views</SidebarHeading>
        {quickViews.map((view) => (
          <SidebarButton
            key={view.id}
            active={isQuickActive(view)}
            onClick={() => props.onApply({ filters: { ...emptyFilters(), q: props.filters.q, ...view.filters } })}
          >
            <view.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate">{view.label}</span>
          </SidebarButton>
        ))}
      </nav>

      <nav aria-label="Saved views" className="flex flex-col gap-0.5">
        <SidebarHeading>Saved views</SidebarHeading>
        {props.savedViews.length === 0 && !naming ? <p className="px-2.5 text-xs text-muted-foreground">Save the current filter, sort and columns as a view.</p> : null}
        {props.savedViews.map((view) => (
          <div key={view.id} className="group flex items-center">
            <SidebarButton active={viewMatches(view, props.filters, props.sort, props.columns)} onClick={() => props.onApply({ filters: view.filters, sort: view.sort, columns: view.columns })}>
              <Bookmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{view.name}</span>
            </SidebarButton>
            <Hint label="Delete view">
              <button
                type="button"
                className="jl-tc-press grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                aria-label={`Delete saved view ${view.name}`}
                onClick={() => props.onDeleteView(view.id)}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </button>
            </Hint>
          </div>
        ))}
        {naming ? (
          <form
            className="flex items-center gap-1 px-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length === 0) return;
              props.onSaveView(name.trim());
              setName("");
              setNaming(false);
            }}
          >
            <input
              autoFocus
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNaming(false);
              }}
              onBlur={() => {
                if (name.trim().length === 0) setNaming(false);
              }}
              placeholder="View name"
              aria-label="Saved view name"
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </form>
        ) : (
          <button type="button" className="jl-tc-press flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setNaming(true)}>
            <Plus className="size-4" aria-hidden /> Save current view
          </button>
        )}
      </nav>

      <nav aria-label="Tags" className="flex flex-col gap-0.5">
        <SidebarHeading>Tags</SidebarHeading>
        {props.tagGroups.length === 0 ? <p className="px-2.5 text-xs text-muted-foreground">Tags like team:qa-pcf or feature:login group cases here.</p> : null}
        {props.tagGroups.map((group) => {
          const open = !collapsed.has(group.namespace);
          return (
            <div key={group.namespace || "free"} className="flex flex-col">
              <button
                type="button"
                className="jl-tc-press flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium text-foreground/90 hover:bg-accent"
                aria-expanded={open}
                onClick={() => setCollapsed((current) => new Set(toggleValue([...current], group.namespace)))}
              >
                <ChevronRight className={cn("size-4 text-muted-foreground transition-transform duration-150", open && "rotate-90")} aria-hidden />
                <span className="truncate">{group.label}</span>
                <span className="ml-auto font-normal tabular-nums text-muted-foreground">{group.total}</span>
              </button>
              {open
                ? group.tags.map((tag) => {
                    const active = props.filters.tags.includes(tag.tag);
                    return (
                      <SidebarButton key={tag.tag} active={active} inset onClick={() => props.onApply({ filters: { ...props.filters, tags: toggleValue(props.filters.tags, tag.tag) } })}>
                        {tag.color ? <span className="size-2 shrink-0 rounded-full" style={{ background: tag.color }} aria-hidden /> : null}
                        <span className="truncate">{tag.name}</span>
                        <span className="ml-auto tabular-nums text-muted-foreground">{tag.count}</span>
                      </SidebarButton>
                    );
                  })
                : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function SidebarHeading(props: { children: React.ReactNode }): React.JSX.Element {
  return <p className="px-2.5 pb-1.5 text-xs font-medium text-muted-foreground">{props.children}</p>;
}

function SidebarButton(props: { active: boolean; inset?: boolean; onClick: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={props.active}
      onClick={props.onClick}
      className={cn(
        "jl-tc-press flex h-8 min-w-0 shrink-0 grow items-center gap-2 rounded-md px-2.5 text-left text-sm",
        props.inset && "pl-8",
        props.active ? "bg-accent font-medium text-foreground" : "text-foreground/80 hover:bg-accent hover:text-foreground"
      )}
    >
      {props.children}
    </button>
  );
}
