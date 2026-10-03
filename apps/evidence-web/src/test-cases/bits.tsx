import React from "react";
import type { TestCaseStatus, TestRunSummary } from "@jittle-lamp/shared";
import { splitTag } from "@jittle-lamp/ui";

import { cn } from "../lib/cn";
import { Badge } from "../components/ui/badge";
import { runLabel, runTone } from "./run-model";
import { Hint, TruncatedText } from "../components/ui/tooltip";

// Small presentational pieces shared by the test case pages.

export { Kbd } from "../components/ui/kbd";

const statusVariant: Record<TestCaseStatus, "brand" | "warning" | "muted" | "outline"> = {
  active: "outline",
  draft: "muted",
  review: "warning",
  archived: "muted"
};

export function CaseStatusBadge(props: { status: TestCaseStatus; className?: string }): React.JSX.Element {
  return (
    <Badge variant={statusVariant[props.status]} className={cn("px-1.5 py-0 text-xs", props.className)}>
      {props.status}
    </Badge>
  );
}

export function OutcomeBadge(props: { outcome: "passed" | "failed" | "blocked" | null; stale?: boolean; className?: string }): React.JSX.Element {
  if (props.outcome === null) return <span className={cn("text-xs text-muted-foreground", props.className)}>no runs</span>;
  const variant = props.outcome === "passed" ? "success" : props.outcome === "failed" ? "danger" : "warning";
  return (
    <Badge variant={variant} className={cn("px-1.5 py-0 text-xs", props.className)}>
      {props.outcome}
    </Badge>
  );
}

export function RunStatusBadge(props: { run: Pick<TestRunSummary, "status" | "outcome">; className?: string }): React.JSX.Element {
  const tone = runTone(props.run);
  const variant = tone === "success" ? "success" : tone === "danger" ? "danger" : tone === "warning" ? "warning" : tone === "brand" ? "brand" : "muted";
  return (
    <Badge variant={variant} className={cn("px-1.5 py-0 text-xs", props.className)}>
      {props.run.status === "running" ? <span className="jl-tc-pulse size-1.5 rounded-full bg-current" aria-hidden /> : null}
      {runLabel(props.run)}
    </Badge>
  );
}

export function TagChip(props: { tag: string; color?: string | null; onClick?: () => void; active?: boolean }): React.JSX.Element {
  const { namespace, name } = splitTag(props.tag);
  const content = (
    <>
      {props.color ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: props.color }} aria-hidden /> : null}
      <span className="truncate">
        {namespace ? <span className="text-muted-foreground">{namespace}:</span> : null}
        {name}
      </span>
    </>
  );
  const className = cn(
    "inline-flex max-w-full items-center gap-1 rounded border px-1.5 text-xs leading-[18px] whitespace-nowrap",
    props.active ? "border-primary/50 bg-primary/12 text-foreground" : "border-border bg-secondary/70 text-foreground/85"
  );
  if (props.onClick) {
    return (
      <button type="button" className={cn(className, "jl-tc-press cursor-pointer")} onClick={props.onClick} aria-pressed={props.active ?? false} aria-label={`Filter by tag ${props.tag}`}>
        {content}
      </button>
    );
  }
  return <span className={className}>{content}</span>;
}

export function Stat(props: { label: string; value: React.ReactNode; hint?: string | undefined }): React.JSX.Element {
  return (
    <Hint label={props.hint} disabled={!props.hint}>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{props.label}</div>
        <div className="truncate font-mono text-base tabular-nums text-foreground">{props.value}</div>
      </div>
    </Hint>
  );
}

export function CopyCommand(props: { command: string; onCopied?: () => void }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5">
      <TruncatedText render={<code />} className="flex-1 font-mono text-sm">
        {props.command}
      </TruncatedText>
      <button
        type="button"
        className="jl-tc-press shrink-0 rounded px-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
        aria-label="Copy CLI command"
        onClick={() => {
          void navigator.clipboard?.writeText(props.command).then(() => {
            setCopied(true);
            props.onCopied?.();
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
