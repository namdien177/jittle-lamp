import React from "react";
import type { ApiReviewFlag, StepScript, TestCaseDetail } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { SimpleSelect } from "../components/ui/select";
import { useToast } from "../toast";
import { apiScriptSummaries, flagCandidateOptions, type ApiScriptSummary } from "./api-mode-model";
import { useFixApiScript } from "./queries";

// API scripts of a case (roadmap 2026-10-13 §3.4): one line per step with the request count,
// mutations and review flags; a flagged value shows its request and lets the reviewer bind it to
// a field of an earlier response, saved through PATCH /test-cases/:id/scripts/:scriptId.

export function ApiScriptsSection(props: { detail: TestCaseDetail; scripts: readonly StepScript[] }): React.JSX.Element | null {
  const byStep = apiScriptSummaries(props.scripts);
  if (byStep.size === 0) return null;
  const steps = props.detail.steps.filter((step) => byStep.has(step.stepId));
  return (
    <section className="flex flex-col gap-2" aria-label="API scripts">
      <p className="text-xs font-medium text-muted-foreground">API</p>
      {steps.map((step) => (
        <div key={step.stepId} className="rounded-md border border-border bg-card/50">
          <header className="flex items-center gap-2 px-3 py-2">
            <span className="font-mono text-xs text-muted-foreground">{step.ordinal}</span>
            <span className="min-w-0 flex-1 truncate text-sm">{step.text || step.args.map((arg) => arg.value).join(", ")}</span>
          </header>
          {(byStep.get(step.stepId) ?? []).map((summary) => (
            <ApiScriptRow key={summary.script.id} testCaseId={props.detail.id} summary={summary} />
          ))}
        </div>
      ))}
    </section>
  );
}

function ApiScriptRow(props: { testCaseId: string; summary: ApiScriptSummary }): React.JSX.Element {
  const { summary } = props;
  const script = summary.script;
  const flags = script.reviewFlags ?? [];
  return (
    <div className="flex flex-col gap-2 border-t border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <Badge variant={script.status === "active" ? "success" : "warning"} className="px-1.5 py-0 text-xs">
          {script.status}
        </Badge>
        <span className="font-mono">v{script.version}</span>
        <span className="tabular-nums">
          {summary.requests} request{summary.requests === 1 ? "" : "s"} · {summary.mutations} mutation{summary.mutations === 1 ? "" : "s"}
        </span>
        {summary.flags > 0 ? (
          <Badge variant="warning" className="px-1.5 py-0 text-xs">
            {summary.flags} to review
          </Badge>
        ) : null}
        {script.staleReason ? <span className="text-warning">{script.staleReason}</span> : null}
      </div>
      {flags.length > 0 && script.requests ? (
        <ol className="flex flex-col gap-2">
          {flags.map((flag) => (
            <li key={`${flag.seq}:${flag.location}`}>
              <FlagEditor testCaseId={props.testCaseId} script={script} flag={flag} />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function FlagEditor(props: { testCaseId: string; script: StepScript; flag: ApiReviewFlag }): React.JSX.Element {
  const { flag, script } = props;
  const toast = useToast();
  const fix = useFixApiScript();
  const options = flagCandidateOptions(flag);
  const [choice, setChoice] = React.useState<string>(options[0]?.value ?? "");
  const request = script.requests?.requests.find((candidate) => candidate.seq === flag.seq);
  const selected = options.find((option) => option.value === choice) ?? null;

  const save = () => {
    if (!selected) return;
    fix.mutate(
      {
        testCaseId: props.testCaseId,
        scriptId: script.id,
        fixes: [{ seq: flag.seq, location: flag.location, fromSeq: selected.fromSeq, ...(selected.fromStepId ? { fromStepId: selected.fromStepId } : {}), path: selected.path }]
      },
      {
        onSuccess: () => toast.success("Source saved", `${flag.location} now reads ${selected.fromSeq}:${selected.path}.`),
        onError: (error) => toast.error("Could not save the source", error instanceof Error ? error.message : undefined)
      }
    );
  };

  return (
    <div className="flex flex-col gap-1.5 rounded border border-warning/40 bg-warning/5 px-2 py-1.5">
      <p className="font-mono text-foreground/85">
        {request ? `${request.method} ${request.pathTemplate}` : `request ${flag.seq}`}
        <span className="text-muted-foreground"> · {flag.location} = </span>
        <span className="break-all">{flag.value}</span>
      </p>
      <p className="text-muted-foreground">{flag.reason}</p>
      {options.length === 0 ? (
        <p className="text-muted-foreground">No earlier response in this step to read it from.</p>
      ) : (
        <div className="flex items-center gap-2">
          <SimpleSelect ariaLabel={`Source for ${flag.location}`} size="sm" className="min-w-0 flex-1" value={choice} onValueChange={setChoice} options={options.map(({ value, label }) => ({ value, label }))} />
          <Button size="xs" className="jl-tc-press" onClick={save} disabled={fix.isPending || !selected}>
            {fix.isPending ? "Saving…" : "Use"}
          </Button>
        </div>
      )}
    </div>
  );
}
