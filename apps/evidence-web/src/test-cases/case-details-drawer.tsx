import React from "react";
import { ChevronRight, X } from "lucide-react";
import type { TestCaseDetail } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { Hint } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { OutcomeBadge, Stat } from "./bits";
import type { CaseEditor } from "./case-editor";
import { CaseDetailsForm } from "./case-details-form";
import { formatCost, formatDuration, formatPassRate, formatRelative } from "./list-model";
import { formatTokens } from "./run-model";
import { ApiScriptsSection } from "./api-scripts";
import { useStepScripts } from "./queries";
import { ScriptsTab } from "./scripts-tab";
import { SessionsTab } from "./sessions-tab";

// Right-side "Details" drawer of the case page (roadmap §3.4): what left the header. Opened from
// the ⋯ menu, closed by default; slides over the right pane with `transform` (§3.7).

export type DrawerSection = "details" | "needs" | "stats" | "runs" | "versions" | "scripts";

const sections: ReadonlyArray<{ id: DrawerSection; label: string }> = [
  { id: "details", label: "Details" },
  { id: "needs", label: "Needs" },
  { id: "stats", label: "Stats" },
  { id: "runs", label: "Runs" },
  { id: "versions", label: "Versions" },
  { id: "scripts", label: "Scripts" }
];

export function CaseDetailsDrawer(props: {
  open: boolean;
  onClose: () => void;
  detail: TestCaseDetail;
  editor: CaseEditor;
  environmentName: string | null;
  section: DrawerSection;
  onSectionChange: (section: DrawerSection) => void;
}): React.JSX.Element {
  const { detail, editor } = props;
  const [expanded, setExpanded] = React.useState<ReadonlySet<DrawerSection>>(() => new Set<DrawerSection>(["details", props.section]));
  React.useEffect(() => {
    setExpanded((current) => (current.has(props.section) ? current : new Set([...current, props.section])));
  }, [props.section]);
  const toggle = (section: DrawerSection) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  return (
    <aside
      className="jl-tc-drawer absolute inset-y-0 right-0 z-20 flex w-[min(100%,400px)] flex-col border-l border-border bg-background shadow-pop"
      data-open={props.open ? "true" : "false"}
      aria-hidden={!props.open}
      inert={!props.open}
      aria-label="Case details"
      onFocusCapture={editor.engage}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-sm font-medium">Details</span>
        {editor.dirty && !editor.locked ? (
          <span className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" className="jl-tc-press" onClick={editor.discard} disabled={editor.saving}>
              Discard
            </Button>
            <Button size="xs" className="jl-tc-press" onClick={() => editor.save()} disabled={editor.saving}>
              {editor.saving ? "Saving…" : "Save"}
            </Button>
          </span>
        ) : null}
        <Hint label="Close">
          <Button variant="ghost" size="icon-sm" className={cn("jl-tc-press", !editor.dirty && "ml-auto")} aria-label="Close details" onClick={props.onClose}>
            <X aria-hidden />
          </Button>
        </Hint>
      </header>
      <div className="jl-scroll min-h-0 flex-1 overflow-y-auto">
        {sections.map((section) => {
          const open = expanded.has(section.id);
          return (
            <section key={section.id} className="border-b border-border" aria-label={section.label}>
              <button
                type="button"
                className="jl-tc-press jl-tc-hover flex h-9 w-full items-center gap-2 px-3 text-left text-sm font-medium text-foreground"
                aria-expanded={open}
                onClick={() => {
                  toggle(section.id);
                  props.onSectionChange(section.id);
                }}
              >
                <ChevronRight className={cn("size-4 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                {section.label}
                {section.id === "versions" ? <span className="ml-auto font-mono text-xs font-normal text-muted-foreground">v{detail.transcriptVersion}</span> : null}
                {section.id === "stats" ? (
                  <span className="ml-auto font-normal text-muted-foreground">
                    <OutcomeBadge outcome={detail.stats.lastOutcome} />
                  </span>
                ) : null}
              </button>
              {open ? <div className="px-3 pb-4 pt-1">{renderSection(section.id, props)}</div> : null}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

function renderSection(section: DrawerSection, props: { detail: TestCaseDetail; editor: CaseEditor; environmentName: string | null }): React.ReactNode {
  const { detail, editor } = props;
  switch (section) {
    case "details":
      return (
        <CaseDetailsForm
          layout="stacked"
          fields={["description", "tags", "environment", "links", "params", "dataset"]}
          doc={editor.doc}
          onChange={editor.setDoc}
          readOnly={editor.locked}
          environments={editor.catalog.environments}
          tagSuggestions={editor.catalog.tagSuggestions}
          environmentFallback={props.environmentName}
        />
      );
    case "needs":
      return <Needs detail={detail} environmentName={props.environmentName} />;
    case "stats":
      return <Stats detail={detail} />;
    case "runs":
      return <SessionsTab detail={detail} />;
    case "versions":
      return editor.versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ol className="flex flex-col gap-1 text-sm">
          {editor.versions.slice(0, 20).map((version) => (
            <li key={version.version} className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">v{version.version}</span>
              <span className="text-xs text-muted-foreground">{formatRelative(version.createdAt)}</span>
              {version.changeNote ? <span className="min-w-0 truncate">{version.changeNote}</span> : null}
            </li>
          ))}
        </ol>
      );
    case "scripts":
      return <ScriptsSection detail={detail} />;
  }
}

// UI scripts as before, with the case's API scripts (roadmap §3.4) listed above them.
function ScriptsSection(props: { detail: TestCaseDetail }): React.JSX.Element {
  const scripts = useStepScripts(props.detail.id);
  return (
    <div className="flex flex-col gap-3">
      <ApiScriptsSection detail={props.detail} scripts={scripts.data ?? []} />
      <ScriptsTab detail={props.detail} />
    </div>
  );
}

function Needs(props: { detail: TestCaseDetail; environmentName: string | null }): React.JSX.Element {
  const required = props.detail.requiredConfig;
  const unresolved = new Set(required.unresolved);
  const entries = [
    ...[...new Set(required.credentials)].map((name) => ({ name, kind: "credential" as const })),
    ...[...new Set(required.variables)].map((name) => ({ name, kind: "variable" as const }))
  ];
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">Nothing from the environment.</p>;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      {entries.map((entry) => (
        <Hint key={`${entry.kind}:${entry.name}`} label={unresolved.has(entry.name) ? `${entry.name} is not set in ${props.environmentName ?? "the environment"}` : `${entry.kind} resolved`}>
          <span className={cn("rounded border px-1.5 font-mono leading-5", unresolved.has(entry.name) ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-border text-muted-foreground")}>
            {entry.kind === "credential" ? "🔒 " : "{"}
            {entry.name}
            {entry.kind === "credential" ? "" : "}"}
            {unresolved.has(entry.name) ? " · missing" : ""}
          </span>
        </Hint>
      ))}
    </div>
  );
}

function Stats(props: { detail: TestCaseDetail }): React.JSX.Element {
  const stats = props.detail.stats;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-x-4 gap-y-2" aria-label="Ten-run averages">
        <Stat label="Pass rate" value={formatPassRate(stats.passRate)} hint="Over the last ten finished runs" />
        <Stat label="Flaky" value={formatPassRate(stats.flakyRate)} />
        <Stat label="Avg time" value={formatDuration(stats.avgDurationMs)} />
        <Stat label="Avg cost" value={formatCost(stats.avgCostUsd)} />
        <Stat label="Avg tokens" value={stats.avgTokens === null ? "—" : formatTokens(Math.round(stats.avgTokens))} hint={stats.avgModelCalls === null ? undefined : `${stats.avgModelCalls.toFixed(1)} model calls per run`} />
        <Stat label="Runs" value={stats.runs} />
      </div>
      <p className="text-xs text-muted-foreground">
        {stats.cachedSteps} cached step{stats.cachedSteps === 1 ? "" : "s"}
        {stats.staleSteps > 0 ? <span className="text-warning"> · {stats.staleSteps} stale</span> : null}
        {stats.derivedCases > 0 ? ` · ${stats.derivedCases} derived case${stats.derivedCases === 1 ? "" : "s"}` : ""}
        {` · source: ${props.detail.source}`}
      </p>
    </div>
  );
}
