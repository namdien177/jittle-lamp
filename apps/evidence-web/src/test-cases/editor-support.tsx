import React from "react";
import { Link } from "react-router";
import type { TestCaseDetail, TestEnvironment } from "@jittle-lamp/shared";
import { docFromTranscript, serializeEditorDoc, type EditorCredential, type EditorDoc, type EditorMacro } from "@jittle-lamp/ui";

import { useSimilarTestCases, useTestCredentials, useTestEnvironments, useTestMacros, useTestTags } from "./queries";
import { tagValue } from "./list-model";

// Data the step editor needs from the organisation: macros, credential profiles (names only),
// environment variables and tag suggestions.

export type EditorCatalog = {
  macros: EditorMacro[];
  macrosLoaded: boolean;
  credentials: EditorCredential[];
  environments: TestEnvironment[];
  tagSuggestions: string[];
  environmentFor: (doc: EditorDoc, fallbackId: string | null) => TestEnvironment | null;
};

export function useEditorCatalog(): EditorCatalog {
  const macrosQuery = useTestMacros();
  const credentialsQuery = useTestCredentials();
  const environmentsQuery = useTestEnvironments();
  const tagsQuery = useTestTags();

  return React.useMemo(() => {
    const environments = environmentsQuery.data ?? [];
    return {
      macros: (macrosQuery.data ?? []).map((macro) => ({ name: macro.name, params: macro.params, transcript: macro.transcript, version: macro.version })),
      macrosLoaded: macrosQuery.isSuccess,
      credentials: (credentialsQuery.data ?? [])
        .filter((credential) => credential.kind === "login")
        .map((credential) => ({ profile: credential.profile, fields: Object.keys(credential.fields), secretFields: credential.secretFieldNames })),
      environments,
      tagSuggestions: (tagsQuery.data ?? []).map((tag) => tagValue(tag.namespace, tag.name)),
      environmentFor: (doc, fallbackId) =>
        (doc.metadata.env ? environments.find((environment) => environment.name === doc.metadata.env) : undefined) ??
        environments.find((environment) => environment.id === fallbackId) ??
        null
    };
  }, [macrosQuery.data, macrosQuery.isSuccess, credentialsQuery.data, environmentsQuery.data, tagsQuery.data]);
}

export function editorDocFromDetail(detail: Pick<TestCaseDetail, "transcript" | "steps">): EditorDoc {
  return docFromTranscript(
    detail.transcript,
    detail.steps.map((step) => ({ stepId: step.stepId, instructionKey: step.instructionKey }))
  );
}

// The saved transcript as the editor would write it, for a formatting-insensitive dirty check.
export function normalizedTranscript(transcript: string): string {
  return serializeEditorDoc(docFromTranscript(transcript));
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// "3 similar cases" while typing a title (GET /test-cases/similar).
export function SimilarHint(props: { title: string; excludeId?: string | null }): React.JSX.Element | null {
  const debounced = useDebounced(props.title, 450);
  const query = useSimilarTestCases(debounced);
  const [open, setOpen] = React.useState(false);
  const items = (query.data?.items ?? []).filter((item) => item.id !== props.excludeId);
  if (items.length === 0) return null;
  const exact = items.some((item) => item.exact);
  return (
    <span className="relative">
      <button
        type="button"
        className="jl-tc-press rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-[12.5px] font-medium text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {exact ? "Exact duplicate exists" : `${items.length} similar case${items.length === 1 ? "" : "s"}`}
      </button>
      {open ? (
        <span className="jl-tc-enter absolute right-0 top-[calc(100%+4px)] z-50 flex w-[340px] flex-col gap-0.5 rounded-md border border-border-strong bg-popover p-1 shadow-pop" role="list">
          {items.slice(0, 6).map((item) => (
            <Link
              key={item.id}
              role="listitem"
              to={`/test-cases?case=${encodeURIComponent(item.id)}`}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-[13px] hover:bg-muted"
              onClick={() => setOpen(false)}
            >
              <span className="font-mono text-[11.5px] text-muted-foreground">{item.key}</span>
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{item.exact ? "exact" : `${Math.round(item.score * 100)}%`}</span>
            </Link>
          ))}
        </span>
      ) : null}
    </span>
  );
}
