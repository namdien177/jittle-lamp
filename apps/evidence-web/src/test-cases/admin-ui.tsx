import React, { useState } from "react";
import { AlertCircle, AlertTriangle, Check, Copy, Info, Lock, Plus, Trash2 } from "lucide-react";
import type { LintFinding } from "@jittle-lamp/shared";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { cn } from "../lib/cn";
import { copyToClipboard } from "../utils";
import type { KeyValueRow } from "../test-config/config-ui";
import type { PreviewSegment } from "./duplicate/find-replace";
import { Hint } from "../components/ui/tooltip";

// Small building blocks shared by the import, review, duplicate and settings screens.

// Press feedback for pointer input (motion rules: scale 0.97, under 250 ms, custom ease-out).
export const pressable =
  "transition-[transform,background-color,border-color,color,box-shadow] duration-150 ease-[cubic-bezier(.23,1,.32,1)] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";

// Enter transition for popovers and inline panels.
export const popIn =
  "origin-top transition-[opacity,transform] duration-200 ease-[cubic-bezier(.23,1,.32,1)] data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0 data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 motion-reduce:transition-none";

export function AdminCard(props: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}): React.JSX.Element {
  return (
    <Card className={cn("min-w-0 overflow-hidden", props.className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold">{props.title}</h2>
          {props.description ? <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p> : null}
        </div>
        {props.actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div> : null}
      </div>
      <CardContent className={cn("p-4", props.bodyClassName)}>{props.children}</CardContent>
    </Card>
  );
}

export function ReadOnlyNotice(props: { permission: string }): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-1.5 text-sm text-muted-foreground" role="note">
      <Lock className="size-3.5 shrink-0" aria-hidden />
      Read-only. Editing needs the <code className="font-mono text-xs">{props.permission}</code> permission.
    </p>
  );
}

export { Kbd } from "../components/ui/kbd";

export function ErrorNote(props: { error: unknown; className?: string }): React.JSX.Element | null {
  if (!props.error) return null;
  const message = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <p role="alert" className={cn("flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive", props.className)}>
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

const severityIcon = { error: AlertCircle, warning: AlertTriangle, info: Info } as const;
const severityTone = { error: "text-destructive", warning: "text-warning", info: "text-muted-foreground" } as const;

export function LintBadge(props: { errors: number; warnings: number; pending?: boolean }): React.JSX.Element {
  if (props.pending) return <Badge variant="outline">normalising</Badge>;
  if (props.errors > 0) return <Badge variant="danger">{props.errors} error{props.errors === 1 ? "" : "s"}</Badge>;
  if (props.warnings > 0) return <Badge variant="warning">{props.warnings} warn</Badge>;
  return <Badge variant="success">ok</Badge>;
}

export function LintFindingList(props: { findings: readonly LintFinding[]; className?: string }): React.JSX.Element | null {
  if (props.findings.length === 0) return null;
  return (
    <ul className={cn("grid gap-1", props.className)}>
      {props.findings.map((finding, index) => {
        const Icon = severityIcon[finding.severity];
        return (
          <li key={`${finding.ruleId}-${index}`} className="flex items-start gap-2 text-sm">
            <Icon className={cn("mt-0.5 size-3.5 shrink-0", severityTone[finding.severity])} aria-label={finding.severity} />
            <span className="min-w-0">
              {finding.line ? <span className="mr-1 font-mono text-xs text-muted-foreground">L{finding.line}</span> : null}
              {finding.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const stepTagTone: Array<[RegExp, string]> = [
  [/^\[(Open)\b/i, "text-sky-500"],
  [/^\[(Assert|Wait)\b/i, "text-amber-500"],
  [/^\[(Login)\b/i, "text-violet-500"],
  [/^\[(Note|Screenshot)\b/i, "text-muted-foreground"],
  [/^\[/, "text-primary"]
];

function lineTone(line: string): string {
  if (line.startsWith("## ")) return "font-semibold text-foreground";
  if (line.startsWith("# ")) return "font-bold text-foreground";
  if (/^[A-Z][A-Za-z-]+:\s/.test(line)) return "text-muted-foreground";
  return "text-foreground";
}

function renderStepLine(line: string): React.ReactNode {
  const tag = /^\[[^\]]+\]/.exec(line)?.[0];
  if (!tag) return line;
  const tone = stepTagTone.find(([pattern]) => pattern.test(line))?.[1] ?? "text-primary";
  return (
    <>
      <span className={cn("font-semibold", tone)}>{tag}</span>
      {line.slice(tag.length)}
    </>
  );
}

// Transcript with line numbers; lint findings render under the line they point at.
export function TranscriptView(props: {
  transcript: string;
  findings?: readonly LintFinding[];
  label: string;
  className?: string;
}): React.JSX.Element {
  const lines = props.transcript.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const byLine = new Map<number, LintFinding[]>();
  const general: LintFinding[] = [];
  for (const finding of props.findings ?? []) {
    if (finding.line && finding.line <= lines.length) byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
    else general.push(finding);
  }
  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-background", props.className)}>
      <div role="region" aria-label={props.label} className="jl-scroll max-h-[28rem] overflow-auto py-2 font-mono text-sm leading-6">
        {lines.map((line, index) => {
          const lineNumber = index + 1;
          const findings = byLine.get(lineNumber) ?? [];
          const worst = findings.some((finding) => finding.severity === "error") ? "error" : findings.length > 0 ? "warning" : null;
          return (
            <div key={lineNumber}>
              <div className={cn("flex gap-3 px-3", worst === "error" && "bg-destructive/8", worst === "warning" && "bg-warning/8")}>
                <span className="w-6 shrink-0 select-none text-right text-muted-foreground/70" aria-hidden>
                  {lineNumber}
                </span>
                <span className={cn("min-w-0 whitespace-pre-wrap break-words", lineTone(line))}>{renderStepLine(line) || " "}</span>
              </div>
              {findings.length > 0 ? <LintFindingList findings={findings} className="mb-1 ml-12 mr-3 font-sans" /> : null}
            </div>
          );
        })}
      </div>
      {general.length > 0 ? <LintFindingList findings={general} className="border-t border-border px-3 py-2" /> : null}
    </div>
  );
}

// Transcript preview with find/replace results highlighted.
export function ReplacementPreview(props: { segments: readonly PreviewSegment[]; label: string }): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label={props.label}
      className="jl-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-3 py-2 font-mono text-sm leading-6"
    >
      {props.segments.map((segment, index) =>
        segment.replaced ? (
          <Hint key={index} label={`Was “${segment.original}”`}>
            <mark className="rounded-sm bg-primary/20 px-0.5 text-foreground">{segment.text}</mark>
          </Hint>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        )
      )}
    </div>
  );
}

export function CopyBlock(props: { label: string; value: string; secret?: boolean; multiline?: boolean }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void copyToClipboard(props.value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <div className="flex items-start gap-2 overflow-hidden rounded-md border border-border bg-muted py-1 pl-3 pr-1.5 font-mono text-sm">
        <code className={cn("min-w-0 flex-1 py-1.5 text-foreground", props.multiline ? "whitespace-pre-wrap break-all" : "truncate")}>{props.value}</code>
        <Hint label="Copy">
          <button
            type="button"
            onClick={onCopy}
            aria-label={`Copy ${props.label}`}
            className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2.5 py-1.5 font-sans text-sm font-medium text-foreground hover:bg-background", pressable)}
          >
            {copied ? <Check className="size-3.5 text-primary" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </button>
        </Hint>
      </div>
    </div>
  );
}

export function Toggle(props: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; description?: string }): React.JSX.Element {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-base", props.disabled && "cursor-not-allowed opacity-60")}>
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 accent-[var(--primary)]"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="font-medium text-foreground">{props.label}</span>
        {props.description ? <span className="block text-sm text-muted-foreground">{props.description}</span> : null}
      </span>
    </label>
  );
}

// Editable name/value table (environment variables, credential public fields).
export function KeyValueEditor(props: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
  addLabel: string;
}): React.JSX.Element {
  const update = (index: number, patch: Partial<KeyValueRow>) =>
    props.onChange(props.rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  return (
    <div className="grid gap-2">
      {props.rows.length > 0 ? (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.25rem] gap-2 text-xs font-medium text-muted-foreground">
          <span>{props.keyLabel}</span>
          <span>{props.valueLabel}</span>
          <span />
        </div>
      ) : null}
      {props.rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.25rem] gap-2">
          <Input
            aria-label={`${props.keyLabel} ${index + 1}`}
            value={row.key}
            placeholder={props.keyPlaceholder}
            disabled={props.disabled}
            className="font-mono text-sm"
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            aria-label={`${props.valueLabel} ${index + 1}`}
            value={row.value}
            placeholder={props.valuePlaceholder}
            disabled={props.disabled}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Hint label="Remove">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${props.keyLabel.toLowerCase()} ${row.key || index + 1}`}
              disabled={props.disabled}
              onClick={() => props.onChange(props.rows.filter((_row, rowIndex) => rowIndex !== index))}
            >
              <Trash2 aria-hidden />
            </Button>
          </Hint>
        </div>
      ))}
      {!props.disabled ? (
        <div>
          <Button variant="ghost" size="xs" onClick={() => props.onChange([...props.rows, { key: "", value: "" }])}>
            <Plus aria-hidden />
            {props.addLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function StatTile(props: { label: string; value: React.ReactNode; detail?: React.ReactNode; tone?: "default" | "success" | "warning" | "danger" }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{props.label}</p>
      <p
        className={cn(
          "mt-1 font-display text-2xl font-bold tabular-nums",
          props.tone === "success" && "text-primary",
          props.tone === "warning" && "text-warning",
          props.tone === "danger" && "text-destructive"
        )}
      >
        {props.value}
      </p>
      {props.detail ? <p className="text-sm text-muted-foreground">{props.detail}</p> : null}
    </div>
  );
}

export function downloadText(fileName: string, text: string, mimeType: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatDateTime(value: number | null, fallback = "Never"): string {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
