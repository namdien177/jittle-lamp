import type { ApiPolicy, ApiRequestItem, ExecutionMode, StepScript, TestEnvironment, TestRunStep } from "@jittle-lamp/shared";

// Pure helpers behind the API-mode UI (roadmap 2026-10-13 §2.5, §3.4, §3.5): the Execution
// choice of the run dialog, the API fields of an environment, and what an API step shows on
// the run page. Free of React for the tests.

export type ExecutionChoice = { value: ExecutionMode; label: string; note: string | null; disabled: boolean };

export const apiNotConfiguredHint = "Configure API origins for this environment";

// "Full | Fast preconditions | API only": the non-Full options need the environment's API
// origins (decision 2); the default is Fast preconditions once a case has [Use] blocks there.
export function executionChoices(environment: Pick<TestEnvironment, "apiOrigins"> | null): ExecutionChoice[] {
  const configured = (environment?.apiOrigins.length ?? 0) > 0;
  return [
    { value: "full", label: "Full", note: null, disabled: false },
    { value: "hybrid", label: "Fast preconditions", note: null, disabled: !configured },
    { value: "api", label: "API only", note: "does not test the UI", disabled: !configured }
  ];
}

export function defaultExecutionMode(input: { hasUseBlocks: boolean; environment: Pick<TestEnvironment, "apiOrigins"> | null }): ExecutionMode {
  if (!input.hasUseBlocks) return "full";
  return (input.environment?.apiOrigins.length ?? 0) > 0 ? "hybrid" : "full";
}

export function hasUseBlocks(steps: ReadonlyArray<{ type: string; disabled?: boolean }> | undefined): boolean {
  return (steps ?? []).some((step) => step.type === "use" && step.disabled !== true);
}

// --- Environment API configuration ---------------------------------------------------------

export type ApiConfigForm = { origins: string; openapiUrl: string; allowedPaths: string; maxRequestsPerStep: string; rateLimitPerSecond: string };

export function apiConfigForm(environment: Pick<TestEnvironment, "apiOrigins" | "openapiUrl" | "apiPolicy"> | null): ApiConfigForm {
  return {
    origins: (environment?.apiOrigins ?? []).join("\n"),
    openapiUrl: environment?.openapiUrl ?? "",
    allowedPaths: (environment?.apiPolicy.allowedPaths ?? []).join("\n"),
    maxRequestsPerStep: String(environment?.apiPolicy.maxRequestsPerStep ?? 50),
    rateLimitPerSecond: String(environment?.apiPolicy.rateLimitPerSecond ?? 10)
  };
}

export type ApiConfigResult = {
  value: { apiOrigins: string[]; openapiUrl: string | null; apiPolicy: ApiPolicy };
  errors: Partial<Record<keyof ApiConfigForm, string>>;
};

const lines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);

export function isHttpOrigin(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.pathname === "/" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

export function parseApiConfig(form: ApiConfigForm): ApiConfigResult {
  const errors: ApiConfigResult["errors"] = {};
  const apiOrigins = lines(form.origins).map((line) => line.replace(/\/+$/, ""));
  const badOrigin = apiOrigins.find((origin) => !isHttpOrigin(`${origin}/`));
  if (badOrigin) errors.origins = `${badOrigin} is not an origin (scheme and host only).`;
  if (apiOrigins.length > 20) errors.origins = "At most 20 origins.";
  const openapiUrl = form.openapiUrl.trim();
  if (openapiUrl.length > 0 && !/^https?:\/\/\S+$/i.test(openapiUrl)) errors.openapiUrl = "Enter an http(s) URL.";
  const allowedPaths = lines(form.allowedPaths);
  const badPath = allowedPaths.find((path) => !path.startsWith("/"));
  if (badPath) errors.allowedPaths = `${badPath} must start with /.`;
  const maxRequestsPerStep = Number(form.maxRequestsPerStep.trim());
  if (!Number.isInteger(maxRequestsPerStep) || maxRequestsPerStep < 1 || maxRequestsPerStep > 1000) errors.maxRequestsPerStep = "1 to 1000.";
  const rateLimitPerSecond = Number(form.rateLimitPerSecond.trim());
  if (!Number.isFinite(rateLimitPerSecond) || rateLimitPerSecond <= 0 || rateLimitPerSecond > 1000) errors.rateLimitPerSecond = "Above 0, at most 1000 per second.";
  return {
    value: {
      apiOrigins,
      openapiUrl: openapiUrl.length > 0 ? openapiUrl : null,
      apiPolicy: {
        allowedPaths,
        maxRequestsPerStep: Number.isInteger(maxRequestsPerStep) ? maxRequestsPerStep : 50,
        rateLimitPerSecond: Number.isFinite(rateLimitPerSecond) ? rateLimitPerSecond : 10
      }
    },
    errors
  };
}

// --- Run page --------------------------------------------------------------------------------

export function isApiStep(step: Pick<TestRunStep, "mode">): boolean {
  return step.mode === "api-replayed" || step.mode === "api-handoff";
}

// The replayed requests of an API step, oldest first; empty when the backend has none.
export function apiRequestItemsOf(step: Pick<TestRunStep, "requests">): ApiRequestItem[] {
  return [...(step.requests?.items ?? [])].sort((a, b) => a.seq - b.seq);
}

export function formatRequestStatus(item: Pick<ApiRequestItem, "status" | "error">): string {
  if (item.status === null) return item.error ? "failed" : "—";
  return String(item.status);
}

// --- Scripts drawer --------------------------------------------------------------------------

export type ApiScriptSummary = { script: StepScript; requests: number; mutations: number; flags: number };

export function apiScriptSummaries(scripts: readonly StepScript[]): Map<string, ApiScriptSummary[]> {
  const byStep = new Map<string, ApiScriptSummary[]>();
  for (const script of scripts) {
    if (script.kind !== "api-requests" || !script.requests) continue;
    const summary: ApiScriptSummary = {
      script,
      requests: script.requests.requests.length,
      mutations: script.requests.requests.filter((request) => request.mutation).length,
      flags: script.reviewFlags?.length ?? 0
    };
    byStep.set(script.stepId, [...(byStep.get(script.stepId) ?? []), summary]);
  }
  return byStep;
}

export type FlagCandidateOption = { value: string; label: string; fromSeq: number; fromStepId: string | undefined; path: string };

// `seq:path` options a reviewer picks a source field from; the value round-trips to a fix.
export function flagCandidateOptions(flag: { candidates: ReadonlyArray<{ fromSeq: number; fromStepId?: string | undefined; path: string; sample: string }> }): FlagCandidateOption[] {
  return flag.candidates.map((candidate) => ({
    value: `${candidate.fromStepId ?? ""}|${candidate.fromSeq}|${candidate.path}`,
    label: `${candidate.fromSeq}:${candidate.path} = ${candidate.sample}`,
    fromSeq: candidate.fromSeq,
    fromStepId: candidate.fromStepId,
    path: candidate.path
  }));
}
