import React from "react";
import { AlertCircle, ArrowDownToLine, ArrowRight, Check, CheckCircle2, Circle, LoaderCircle, RefreshCw } from "lucide-react";
import type { RunnerPool } from "@jittle-lamp/shared";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/cn";
import { runnerUpdatePending } from "../../test-config/config-ui";

const steps = [
  { phase: "draining", label: "Finish jobs" },
  { phase: "downloading", label: "Download" },
  { phase: "verifying", label: "Verify" },
  { phase: "restarting", label: "Restart" },
  { phase: "reconnecting", label: "Reconnect" }
] as const;

const titles = {
  draining: "Waiting for active jobs to finish",
  downloading: "Downloading the new runner",
  verifying: "Checking the runner image",
  restarting: "Restarting cloud runners",
  reconnecting: "Waiting for runners to reconnect",
  completed: "Cloud runners are up to date",
  failed: "Runner update needs attention"
};
const descriptions = {
  draining: "New jobs stay in the queue. Running tests and explorations finish first.",
  downloading: "The update continues once the image is ready on your runner host.",
  verifying: "Confirming the image matches the requested release before replacing runners.",
  restarting: "Starting the new version. Runner credentials and work volumes are preserved.",
  reconnecting: "Confirming every replacement runner has connected with the new version.",
  completed: "The new version is connected and ready to accept jobs.",
  failed: "Check the runner host before continuing."
};
const failures = {
  DOWNLOAD_FAILED: "The image could not be downloaded. Check registry access on the runner host; the updater will retry.",
  VERIFY_FAILED: "The image could not be verified. Existing runners were kept. Check the release image before retrying.",
  RESTART_FAILED: "Some runners may have been replaced. Check the deployment on the host before retrying.",
  RECONNECT_FAILED: "The new runners have not reconnected yet. Check their startup logs and server connection."
};

function bytes(value: number): string {
  return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GB` : `${Math.round(value / 1024 ** 2)} MB`;
}

export function RunnerUpdatePanel({ pool, canManage, busy, onUpdate }: {
  pool: RunnerPool; canManage: boolean; busy: boolean; onUpdate: (cancel: boolean) => void;
}): React.JSX.Element | null {
  const progress = pool.updateProgress;
  const pending = runnerUpdatePending(pool);
  const current = pool.workers.filter(worker => worker.status === "online");
  const skewed = current.filter(worker => worker.versionSkew);
  const managed = current.some(worker => worker.managedUpdates);
  const version = [...new Set(current.map(worker => worker.version))].join(", ") || "No runner online";
  if (!pool.serverVersion) return null;
  const phase = progress?.phase ?? "draining";
  const active = pending && phase !== "completed";
  const failed = active && phase === "failed";
  const complete = progress?.phase === "completed" && progress.targetVersion === pool.serverVersion && current.length > 0 && skewed.length === 0;
  const stale = active && !failed && progress && Date.now() - progress.reportedAt > 45_000;
  const canCancel = active && !["restarting", "reconnecting"].includes(phase);
  const stepIndex = failed && progress?.errorCode
    ? { DOWNLOAD_FAILED: 1, VERIFY_FAILED: 2, RESTART_FAILED: 3, RECONNECT_FAILED: 4 }[progress.errorCode]
    : steps.findIndex(step => step.phase === phase);
  const downloadPercent = phase === "downloading" && !stale ? progress?.downloadPercent ?? null : null;
  const Icon = failed || stale ? AlertCircle : complete ? CheckCircle2 : active ? LoaderCircle : current.length === 0 ? Circle : skewed.length ? ArrowDownToLine : CheckCircle2;

  return (
    <div className="border-b border-border px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", failed ? "bg-destructive/10 text-destructive" : active || complete || !skewed.length ? "bg-primary/10 text-primary" : "bg-warning/10 text-warning")}>
            <span className={cn("inline-flex", active && !failed && !stale && "animate-spin motion-reduce:animate-none")}><Icon aria-hidden className="size-4" /></span>
          </span>
          <div>
            <p className="text-sm font-medium">{active || complete ? titles[phase] : current.length === 0 ? "No runner online" : skewed.length ? "A runner update is available" : "Versions match"}</p>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>Runner <span className="font-mono text-foreground">{version}</span></span>
              <ArrowRight className="size-3" aria-hidden />
              <span>{active ? "Updating to" : "Server"} <span className="font-mono text-foreground">{active ? pool.targetVersion : pool.serverVersion}</span></span>
            </div>
          </div>
        </div>
        {canManage && pool.kind === "cloud" ? (
          <div className="flex items-center gap-2">
            {failed ? <Button size="sm" variant="outline" disabled={busy || !managed} onClick={() => onUpdate(false)}><RefreshCw aria-hidden />Retry update</Button> : null}
            {canCancel ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => onUpdate(true)}>Cancel update</Button> : null}
            {!active && !complete && skewed.length > 0 ? <Button size="sm" disabled={busy || !managed} onClick={() => onUpdate(false)}><ArrowDownToLine aria-hidden />{busy ? "Requesting…" : `Update to ${pool.serverVersion}`}</Button> : null}
          </div>
        ) : null}
      </div>
      {active ? (
        <div className={cn("runner-update-details mt-4 rounded-lg border p-4", failed ? "border-destructive/20 bg-destructive/5" : "border-border bg-muted/40")}>
          <div className="flex items-center justify-between gap-4 text-xs">
            <p role="status" aria-live="polite" className={cn("font-medium", stale && "text-warning", failed && "text-destructive")}>
              {stale ? "Waiting for the runner host to report progress" : failed && progress?.errorCode ? failures[progress.errorCode] : phase === "downloading" && downloadPercent === 100 ? "Image downloaded. Unpacking on the runner host…" : descriptions[phase]}
            </p>
            {downloadPercent !== null ? <span className="shrink-0 font-mono text-sm tabular-nums">{downloadPercent}%</span> : null}
          </div>
          {!failed ? (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border/70" role="progressbar" aria-label={phase === "downloading" ? "Image download" : titles[phase]} aria-valuemin={0} aria-valuemax={100} {...(downloadPercent === null ? {} : { "aria-valuenow": downloadPercent })}>
              <div className={cn("h-full w-full origin-left rounded-full", stale ? "bg-warning/60" : "bg-primary", downloadPercent === null && !stale ? "runner-update-indeterminate" : "transition-transform duration-200 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none")} style={downloadPercent !== null ? { transform: `scaleX(${downloadPercent / 100})` } : stale ? { transform: "scaleX(.25)" } : undefined} />
            </div>
          ) : null}
          {phase === "downloading" && progress?.downloadedBytes != null && progress.totalBytes != null && !stale ? <p className="mt-2 font-mono text-xs tabular-nums text-muted-foreground">{bytes(progress.downloadedBytes)} / {bytes(progress.totalBytes)}</p> : null}
          <ol aria-label="Update steps" className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
            {steps.map((step, index) => {
              const done = index < stepIndex;
              const selected = index === stepIndex;
              const StepIcon = done ? Check : selected && failed ? AlertCircle : selected && !stale ? LoaderCircle : Circle;
              return <li key={step.phase} aria-current={selected ? "step" : undefined} className={cn("flex items-center gap-1.5 text-xs", selected && failed ? "text-destructive" : done || selected ? "text-primary" : "text-muted-foreground")}>
                <span className={cn("inline-flex shrink-0", selected && !failed && !stale && "animate-spin motion-reduce:animate-none")}><StepIcon aria-hidden className="size-3.5" /></span>
                <span className={cn(selected && "font-medium")}>{step.label}</span>
              </li>;
            })}
          </ol>
          {stale ? <p className="mt-3 text-xs text-muted-foreground">Progress is temporarily unavailable. Check that the host updater is running and can reach the server.</p> : null}
        </div>
      ) : complete ? <p role="status" className="mt-2 pl-11 text-xs text-muted-foreground">{descriptions.completed}</p> : pool.kind === "cloud" && skewed.length > 0 && !managed ? <p className="mt-2 pl-11 text-xs text-muted-foreground">Enable managed updates on the runner host to update from Settings.</p> : null}
    </div>
  );
}
