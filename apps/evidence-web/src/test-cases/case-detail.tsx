import React from "react";
import { Copy, ExternalLink, Play, X } from "lucide-react";
import type { TestCaseDetail, TestEnvironment, TestTag } from "@jittle-lamp/shared";
import { linkLabel, safeExternalHref } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { CaseStatusBadge, OutcomeBadge, Stat, TagChip } from "./bits";
import { formatCost, formatDuration, formatPassRate } from "./list-model";
import { useTestCase } from "./queries";
import { formatTokens } from "./run-model";
import { ScriptsTab } from "./scripts-tab";
import { SessionsTab } from "./sessions-tab";
import { StepsTab } from "./steps-tab";
import { Hint } from "../components/ui/tooltip";

export type DetailTab = "steps" | "sessions" | "scripts";

export function CaseDetailPane(props: {
  caseId: string;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  environments: readonly TestEnvironment[];
  tagDefinitions: readonly TestTag[];
  onRun: (detail: TestCaseDetail) => void;
  onDuplicate: (ids: string[]) => void;
  onClose: () => void;
  onTagClick: (tag: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const query = useTestCase(props.caseId);
  const detail = query.data;
  const tagColors = new Map(props.tagDefinitions.map((tag) => [tag.namespace ? `${tag.namespace}:${tag.name}` : tag.name, tag.color]));

  if (query.isError) {
    return (
      <section className="flex flex-col gap-2 p-6" aria-label="Test case detail">
        <p className="text-[13.5px] text-destructive">{query.error instanceof Error ? query.error.message : "Unable to load the case."}</p>
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </section>
    );
  }
  if (!detail) {
    return (
      <section className="flex flex-col gap-3 p-6" aria-label="Test case detail" aria-busy="true">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-24 w-full" />
      </section>
    );
  }

  const environment = props.environments.find((candidate) => candidate.id === detail.environmentId) ?? null;
  const stats = detail.stats;
  const required = detail.requiredConfig;
  const unresolved = new Set(required.unresolved);

  return (
    <section className="jl-scroll flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" aria-label={`Test case ${detail.key}`}>
      <header className="flex flex-col gap-2 px-6 pb-4 pt-4">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px] text-muted-foreground">
          <span className="flex min-w-0 items-center gap-2 whitespace-nowrap">
            <span className="font-mono">{detail.key}</span>
            <CaseStatusBadge status={detail.status} />
            <span aria-hidden>·</span>
            <span>source: {detail.source}</span>
            <span aria-hidden>·</span>
            <span>v{detail.transcriptVersion}</span>
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" className="jl-tc-press" onClick={() => props.onDuplicate([detail.id])}>
              <Copy aria-hidden /> Duplicate
            </Button>
            <Button size="sm" className="jl-tc-press" onClick={() => props.onRun(detail)}>
              <Play aria-hidden /> Run
            </Button>
            <Hint label="Close">
              <Button variant="ghost" size="icon-sm" className="jl-tc-press" aria-label="Close detail" onClick={props.onClose}>
                <X aria-hidden />
              </Button>
            </Hint>
          </span>
        </div>
        <h2 className="text-lg font-semibold leading-snug">{detail.title || "Untitled case"}</h2>
        {detail.description ? <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-muted-foreground">{detail.description}</p> : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {detail.links.map((link) => {
            const href = safeExternalHref(link.url);
            return href ? (
              <Hint key={link.url} label={link.url}>
                <a href={href} target="_blank" rel="noreferrer" className="jl-tc-press inline-flex items-center gap-1 rounded border border-border px-1.5 text-[12px] leading-5 hover:bg-muted">
                  {link.label ?? linkLabel(link.url)} <ExternalLink className="size-3" aria-hidden />
                </a>
              </Hint>
            ) : (
              <Hint key={link.url} label={link.url}>
                <span className="inline-flex items-center rounded border border-border px-1.5 text-[12px] leading-5 text-muted-foreground">{link.label ?? link.url}</span>
              </Hint>
            );
          })}
          {detail.tags.map((tag) => (
            <TagChip key={tag} tag={tag} color={tagColors.get(tag) ?? null} onClick={() => props.onTagClick(tag)} />
          ))}
          <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 font-mono text-[12px] leading-5 text-muted-foreground">
            env: {environment?.name ?? "none"}
          </span>
        </div>
        {required.variables.length + required.credentials.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1 text-[12px]">
            <span className="text-muted-foreground">Needs</span>
            {[...[...new Set(required.credentials)].map((name) => ({ name, kind: "credential" })), ...[...new Set(required.variables)].map((name) => ({ name, kind: "variable" }))].map((entry) => (
              <Hint key={`${entry.kind}:${entry.name}`} label={unresolved.has(entry.name) ? `${entry.name} is not set in ${environment?.name ?? "the environment"}` : `${entry.kind} resolved`}>
                <span
                  className={cn(
                    "rounded border px-1.5 font-mono leading-5",
                    unresolved.has(entry.name) ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-border text-muted-foreground"
                  )}
                >
                  {entry.kind === "credential" ? "🔒 " : "{"}
                  {entry.name}
                  {entry.kind === "credential" ? "" : "}"}
                  {unresolved.has(entry.name) ? " · missing" : ""}
                </span>
              </Hint>
            ))}
          </div>
        ) : null}
        <div className="mt-1 grid grid-cols-3 gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/30 px-3 py-2.5 sm:grid-cols-6" aria-label="Ten-run averages">
          <Stat label="Last" value={<OutcomeBadge outcome={stats.lastOutcome} />} />
          <Stat label="Pass rate" value={formatPassRate(stats.passRate)} hint="Over the last ten finished runs" />
          <Stat label="Flaky" value={formatPassRate(stats.flakyRate)} />
          <Stat label="Avg time" value={formatDuration(stats.avgDurationMs)} />
          <Stat label="Avg cost" value={formatCost(stats.avgCostUsd)} />
          <Stat label="Avg tokens" value={stats.avgTokens === null ? "—" : formatTokens(Math.round(stats.avgTokens))} hint={stats.avgModelCalls === null ? undefined : `${stats.avgModelCalls.toFixed(1)} model calls per run`} />
        </div>
        <div className="text-[12px] text-muted-foreground">
          {stats.runs} run{stats.runs === 1 ? "" : "s"} · {stats.cachedSteps} cached step{stats.cachedSteps === 1 ? "" : "s"}
          {stats.staleSteps > 0 ? <span className="text-warning"> · {stats.staleSteps} stale</span> : null}
          {stats.derivedCases > 0 ? ` · ${stats.derivedCases} derived case${stats.derivedCases === 1 ? "" : "s"}` : ""}
        </div>
      </header>

      <div role="tablist" aria-label="Case sections" className="sticky top-0 z-10 flex gap-4 border-b border-border bg-background px-6">
        {(
          [
            ["steps", "Steps"],
            ["sessions", "Test sessions"],
            ["scripts", "Scripts"]
          ] as const
        ).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={props.tab === tab}
            className={cn(
              "-mb-px border-b-2 py-2.5 text-[13px] font-medium transition-colors",
              props.tab === tab ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
            onClick={() => props.onTabChange(tab)}
          >
            {label}
            {tab === "sessions" && stats.runs > 0 ? <span className="ml-1 font-normal tabular-nums text-muted-foreground">{stats.runs}</span> : null}
          </button>
        ))}
      </div>

      <div className="px-6 py-5" role="tabpanel">
        {props.tab === "steps" ? <StepsTab key={detail.id} detail={detail} onRun={() => props.onRun(detail)} {...(props.onDirtyChange ? { onDirtyChange: props.onDirtyChange } : {})} /> : null}
        {props.tab === "sessions" ? <SessionsTab detail={detail} /> : null}
        {props.tab === "scripts" ? <ScriptsTab detail={detail} /> : null}
      </div>
    </section>
  );
}
