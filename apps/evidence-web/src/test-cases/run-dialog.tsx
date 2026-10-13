import React from "react";
import { Link } from "react-router";
import type { CreateTestRunResponse, ExecutionMode, TestCaseDetail, TestCaseSummary, TestEnvironment } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { SimpleDialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { SimpleSelect } from "../components/ui/select";
import { Hint } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { apiNotConfiguredHint, defaultExecutionMode, executionChoices, hasUseBlocks } from "./api-mode-model";
import { CopyCommand } from "./bits";
import { cliRunCommand } from "./list-model";
import { useCreateTestRun } from "./queries";
import { formatQueuePosition } from "./run-model";
import { describeRunRequestError } from "./run-errors";

type CacheMode = "read-write" | "read-only" | "off" | "strict";

const cacheModeLabels: Record<CacheMode, string> = {
  "read-write": "Replay cached steps, record new ones",
  "read-only": "Replay cached steps, record nothing",
  off: "Agent for every step",
  strict: "Replay only; block on stale cache"
};

// "Run" on a case: POST /test-cases/:id/runs, then say whether the request queued a new run or
// attached to one already queued or just finished (design.md §10.2), and show the CLI equivalent.
export function RunDialog(props: {
  // The case page passes its detail, so the steps decide the default execution mode.
  testCase: Pick<TestCaseSummary, "id" | "key" | "title" | "environmentId"> & Partial<Pick<TestCaseDetail, "steps">>;
  hasDataset: boolean;
  environments: readonly TestEnvironment[];
  onClose: () => void;
}): React.JSX.Element {
  const createRun = useCreateTestRun();
  const [environmentId, setEnvironmentId] = React.useState(props.testCase.environmentId ?? props.environments[0]?.id ?? "");
  const [cacheMode, setCacheMode] = React.useState<CacheMode>("read-write");
  const environment = props.environments.find((candidate) => candidate.id === environmentId) ?? null;
  const useBlocks = hasUseBlocks(props.testCase.steps);
  // Execution (roadmap §2.5): Full by default, Fast preconditions once the case has [Use]
  // blocks and the environment has API origins; the choice follows the environment until touched.
  const [executionMode, setExecutionMode] = React.useState<ExecutionMode>(() => defaultExecutionMode({ hasUseBlocks: useBlocks, environment }));
  const [executionTouched, setExecutionTouched] = React.useState(false);
  React.useEffect(() => {
    if (!executionTouched) setExecutionMode(defaultExecutionMode({ hasUseBlocks: useBlocks, environment }));
  }, [executionTouched, useBlocks, environment]);
  const choices = executionChoices(environment);
  const chosen = choices.find((choice) => choice.value === executionMode) ?? choices[0];
  const [force, setForce] = React.useState(false);
  const [dataset, setDataset] = React.useState(false);
  const [result, setResult] = React.useState<CreateTestRunResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = () => {
    setError(null);
    createRun.mutate(
      {
        testCaseId: props.testCase.id,
        ...(environmentId ? { environmentId } : {}),
        cacheMode,
        force,
        dataset,
        executionMode,
        trigger: "manual"
      },
      {
        onSuccess: setResult,
        onError: (failure) => setError(describeRunRequestError(failure).message)
      }
    );
  };

  const command = cliRunCommand({ caseId: props.testCase.id, environmentId: environment?.id ?? null });

  return (
    <SimpleDialog
      open
      onClose={props.onClose}
      size="md"
      title={`Run ${props.testCase.key}`}
      description={props.testCase.title}
      footer={
        result ? (
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              Close
            </Button>
            <Link to={`/test-runs/${encodeURIComponent(result.runId)}`} className="inline-flex">
              <Button size="sm" className="jl-tc-press">
                Open run
              </Button>
            </Link>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose} disabled={createRun.isPending}>
              Cancel
            </Button>
            <Button size="sm" className="jl-tc-press" onClick={submit} disabled={createRun.isPending}>
              {createRun.isPending ? "Requesting…" : "Run"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-base" role="status">
          {result.attached ? (
            <p>
              <strong>Attached</strong> to a run {result.status === "completed" ? "that finished moments ago" : `already ${result.status}`}
              {result.requestedBy.length > 0 ? ` (requested by ${result.requestedBy.map((person) => person.name ?? person.userId).join(", ")})` : ""}. You will be notified when it
              finishes. Tick “Run again even if…” to force a fresh run.
            </p>
          ) : (
            <p>
              <strong>Queued</strong>
              {formatQueuePosition({ queuePosition: result.queuePosition, queueDepth: result.queueDepth ?? null }) ? ` · ${formatQueuePosition({ queuePosition: result.queuePosition, queueDepth: result.queueDepth ?? null })} in the queue` : ""}
              {result.runIds.length > 1 ? ` · ${result.runIds.length} runs in a dataset batch` : ""}. Follow it on the run page.
            </p>
          )}
          <Field label="Same run from a terminal">
            <CopyCommand command={command} />
          </Field>
        </div>
      ) : (
        <div className="jl-tc-scope space-y-4">
          <Field label="Environment">
            <SimpleSelect
              ariaLabel="Environment"
              value={environmentId}
              onValueChange={setEnvironmentId}
              options={props.environments.map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${candidate.runnerPool}` }))}
            />
          </Field>
          <Field label="Execution" hint={chosen?.note ?? undefined}>
            <div role="radiogroup" aria-label="Execution" className="inline-flex w-fit rounded-md border border-border bg-muted/40 p-0.5 text-sm">
              {choices.map((choice) => {
                const button = (
                  <button
                    key={choice.value}
                    type="button"
                    role="radio"
                    aria-checked={executionMode === choice.value}
                    aria-disabled={choice.disabled || undefined}
                    disabled={choice.disabled}
                    className={cn(
                      "jl-tc-press rounded px-3 py-1 transition-colors",
                      executionMode === choice.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
                      choice.disabled ? "cursor-not-allowed opacity-50" : "hover:text-foreground"
                    )}
                    onClick={() => {
                      setExecutionTouched(true);
                      setExecutionMode(choice.value);
                    }}
                  >
                    {choice.label}
                  </button>
                );
                return choice.disabled ? (
                  <Hint key={choice.value} label={apiNotConfiguredHint}>
                    <span className="inline-flex">{button}</span>
                  </Hint>
                ) : (
                  button
                );
              })}
            </div>
          </Field>
          <Field label="Cache">
            <SimpleSelect ariaLabel="Cache mode" value={cacheMode} onValueChange={(value) => setCacheMode(value as CacheMode)} options={(Object.keys(cacheModeLabels) as CacheMode[]).map((value) => ({ value, label: cacheModeLabels[value] }))} />
          </Field>
          <label className="flex items-center gap-2 text-base">
            <input type="checkbox" className="accent-[var(--primary)]" checked={force} onChange={(event) => setForce(event.currentTarget.checked)} />
            Run again even if the same run is queued or just finished
          </label>
          {props.hasDataset ? (
            <label className="flex items-center gap-2 text-base">
              <input type="checkbox" className="accent-[var(--primary)]" checked={dataset} onChange={(event) => setDataset(event.currentTarget.checked)} />
              Run every dataset row as a batch
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Field label="CLI">
            <CopyCommand command={command} />
          </Field>
        </div>
      )}
    </SimpleDialog>
  );
}
