import React from "react";
import { Link } from "react-router";
import type { CreateTestRunResponse, TestCaseSummary, TestEnvironment } from "@jittle-lamp/shared";

import { Button } from "../components/ui/button";
import { Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { CopyCommand } from "./bits";
import { cliRunCommand } from "./list-model";
import { useCreateTestRun } from "./queries";
import { formatQueuePill } from "./run-model";

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
  testCase: Pick<TestCaseSummary, "id" | "key" | "title" | "environmentId">;
  hasDataset: boolean;
  environments: readonly TestEnvironment[];
  onClose: () => void;
}): React.JSX.Element {
  const createRun = useCreateTestRun();
  const [environmentId, setEnvironmentId] = React.useState(props.testCase.environmentId ?? props.environments[0]?.id ?? "");
  const [cacheMode, setCacheMode] = React.useState<CacheMode>("read-write");
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
        trigger: "manual"
      },
      {
        onSuccess: setResult,
        onError: (failure) => setError(failure instanceof Error ? failure.message : "Run request failed.")
      }
    );
  };

  const environment = props.environments.find((candidate) => candidate.id === environmentId) ?? null;
  const command = cliRunCommand({ caseId: props.testCase.id, environmentId: environment?.id ?? null });

  return (
    <Dialog
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
        <div className="space-y-3 text-[13.5px]" role="status">
          {result.attached ? (
            <p>
              <strong>Attached</strong> to a run {result.status === "completed" ? "that finished moments ago" : `already ${result.status}`}
              {result.requestedBy.length > 0 ? ` (requested by ${result.requestedBy.map((person) => person.name ?? person.userId).join(", ")})` : ""}. You will be notified when it
              finishes. Tick “Run again even if…” to force a fresh run.
            </p>
          ) : (
            <p>
              <strong>Queued.</strong>{" "}
              {formatQueuePill({ status: result.status, queuePosition: result.queuePosition, queueDepth: result.queueDepth ?? null, estimatedStartAt: null }) ?? result.status}
              {result.runIds.length > 1 ? ` · ${result.runIds.length} runs in a dataset batch` : ""}
            </p>
          )}
          <Field label="Same run from a terminal">
            <CopyCommand command={command} />
          </Field>
        </div>
      ) : (
        <div className="jl-tc-scope space-y-4">
          <Field label="Environment">
            <Select
              ariaLabel="Environment"
              value={environmentId}
              onValueChange={setEnvironmentId}
              options={props.environments.map((candidate) => ({ value: candidate.id, label: `${candidate.name} · ${candidate.runnerPool}` }))}
            />
          </Field>
          <Field label="Cache">
            <Select ariaLabel="Cache mode" value={cacheMode} onValueChange={(value) => setCacheMode(value as CacheMode)} options={(Object.keys(cacheModeLabels) as CacheMode[]).map((value) => ({ value, label: cacheModeLabels[value] }))} />
          </Field>
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" className="accent-[var(--primary)]" checked={force} onChange={(event) => setForce(event.currentTarget.checked)} />
            Run again even if the same run is queued or just finished
          </label>
          {props.hasDataset ? (
            <label className="flex items-center gap-2 text-[13.5px]">
              <input type="checkbox" className="accent-[var(--primary)]" checked={dataset} onChange={(event) => setDataset(event.currentTarget.checked)} />
              Run every dataset row as a batch
            </label>
          ) : null}
          {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
          <Field label="CLI">
            <CopyCommand command={command} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
