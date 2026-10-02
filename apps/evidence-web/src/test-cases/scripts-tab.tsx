import React from "react";
import { Link } from "react-router";
import type { StepScript, TestCaseDetail } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { useToast } from "../toast";
import { formatRelative } from "./list-model";
import { useClearStepScripts, useStepScripts, useTestEnvironments } from "./queries";

// Scripts tab: the cached action record of each step rendered as Playwright, with its version and a
// per-step clear that forces the agent on the next run (design.md §5.2, §7).
export function ScriptsTab(props: { detail: TestCaseDetail }): React.JSX.Element {
  const { detail } = props;
  const toast = useToast();
  const scriptsQuery = useStepScripts(detail.id);
  const environmentsQuery = useTestEnvironments();
  const clear = useClearStepScripts();
  const envNames = new Map((environmentsQuery.data ?? []).map((environment) => [environment.id, environment.name]));
  const scripts = scriptsQuery.data ?? [];
  const byStep = new Map<string, StepScript[]>();
  for (const script of scripts) byStep.set(script.stepId, [...(byStep.get(script.stepId) ?? []), script]);

  const clearScripts = (stepId?: string) =>
    clear.mutate(
      { testCaseId: detail.id, ...(stepId ? { stepId } : {}) },
      {
        onSuccess: () => toast.success(stepId ? "Cached script cleared" : "All cached scripts cleared", "The next run records them again with the agent."),
        onError: (error) => toast.error("Clear failed", error instanceof Error ? error.message : undefined)
      }
    );

  if (scriptsQuery.isPending) return <p className="py-6 text-[13.5px] text-muted-foreground">Loading scripts…</p>;
  if (scriptsQuery.isError) return <p className="py-6 text-[13.5px] text-destructive">{scriptsQuery.error instanceof Error ? scriptsQuery.error.message : "Unable to load scripts."}</p>;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
        <span>
          {scripts.filter((script) => script.status === "active").length} of {detail.steps.length} steps cached
        </span>
        {scripts.length > 0 ? (
          <Button size="xs" variant="ghost" className="jl-tc-press" onClick={() => clearScripts()} disabled={clear.isPending}>
            Clear all
          </Button>
        ) : null}
      </div>
      {detail.steps.map((step) => {
        const entries = byStep.get(step.stepId) ?? [];
        return (
          <section key={step.stepId} className="rounded-md border border-border bg-card/50" aria-label={`Step ${step.ordinal} script`}>
            <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
              <span className="font-mono text-[12px] text-muted-foreground">{step.ordinal}</span>
              <span className="rounded border border-border bg-secondary px-1.5 text-[11px] font-semibold leading-[18px]">{step.tag ?? "Act"}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{step.text || step.args.map((arg) => arg.value).join(", ")}</span>
              {entries.length === 0 ? <span className="text-[12px] text-muted-foreground">{step.type === "note" || step.type === "screenshot" || step.type === "open" ? "not cached (deterministic)" : "no script yet"}</span> : null}
            </header>
            {entries.map((script) => (
              <div key={script.id} className="flex flex-col gap-1.5 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                  <Badge variant={script.status === "active" ? "success" : "warning"} className="px-1.5 py-0 text-[11px]">
                    {script.status}
                  </Badge>
                  <span className="font-mono">v{script.version}</span>
                  <span>{script.environmentId ? envNames.get(script.environmentId) ?? script.environmentId : "any environment"}</span>
                  <span>replayed {script.verifiedCount}× · last {formatRelative(script.lastReplayedAt)}</span>
                  {script.recordedFromRunId ? (
                    <Link to={`/test-runs/${encodeURIComponent(script.recordedFromRunId)}`} className="underline-offset-2 hover:underline">
                      recorded in run
                    </Link>
                  ) : null}
                  {script.staleReason ? <span className="text-warning">{script.staleReason}</span> : null}
                  <Button size="xs" variant="ghost" className="jl-tc-press ml-auto h-6 px-2 text-[12px]" onClick={() => clearScripts(step.stepId)} disabled={clear.isPending} aria-label={`Clear cached script of step ${step.ordinal}`}>
                    Clear
                  </Button>
                </div>
                <pre className="jl-scroll max-h-56 overflow-auto rounded border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed">
                  <code>{script.renderedCode || "// no rendered code"}</code>
                </pre>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
