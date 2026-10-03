import type { NotificationKind, WebhookDelivery, WebhookEndpoint, WebhookRule } from "@jittle-lamp/shared";

// Pure helpers for Settings → Webhooks, Notifications and Agent notes (phase 2 units 2.1, 2.2,
// 2.4). Rule drafts are the form state; they convert to and from the contract's WebhookRule.

export type WebhookEventKind = WebhookRule["when"]["events"][number];
export type EnvironmentMode = "fixed" | "review_app_url" | "deployment_url";

export const webhookEventLabels: Record<WebhookEventKind, string> = {
  push: "Push",
  merge_request: "Merge request / pull request",
  pipeline: "Pipeline succeeded",
  deployment: "Deployment succeeded"
};

export type RuleDraft = {
  events: WebhookEventKind[];
  branches: string;
  labels: string;
  suiteId: string;
  environmentMode: EnvironmentMode;
  environmentId: string;
  priority: string;
  commitStatus: boolean;
  mrNote: boolean;
  callbackUrl: string;
  credentialId: string;
};

export const emptyRuleDraft = (): RuleDraft => ({
  events: ["merge_request"],
  branches: "",
  labels: "",
  suiteId: "",
  environmentMode: "fixed",
  environmentId: "",
  priority: "10",
  commitStatus: true,
  mrNote: false,
  callbackUrl: "",
  credentialId: ""
});

// "main, release/*" → ["main", "release/*"]: trimmed, unique, empty entries dropped.
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((part) => part.trim()).filter((part) => part.length > 0))];
}

export function ruleToDraft(rule: WebhookRule): RuleDraft {
  const fromPayload = "fromPayload" in rule.environment ? rule.environment.fromPayload : null;
  return {
    events: [...rule.when.events],
    branches: rule.when.branches.join(", "),
    labels: rule.when.labels.join(", "),
    suiteId: rule.run.suiteId,
    environmentMode: fromPayload ?? "fixed",
    environmentId: "id" in rule.environment ? rule.environment.id : rule.environment.baseEnvironmentId,
    priority: String(rule.priority),
    commitStatus: rule.report.commitStatus,
    mrNote: rule.report.mrNote,
    callbackUrl: rule.report.callbackUrl ?? "",
    credentialId: rule.report.credentialId ?? ""
  };
}

export type DraftResult = { ok: true; rule: WebhookRule } | { ok: false; error: string };

export function draftToRule(draft: RuleDraft): DraftResult {
  if (draft.events.length === 0) return { ok: false, error: "Pick at least one event." };
  if (!draft.suiteId) return { ok: false, error: "Pick the suite to run." };
  if (!draft.environmentId) return { ok: false, error: draft.environmentMode === "fixed" ? "Pick an environment." : "Pick the base environment." };
  const priority = Number(draft.priority);
  if (!Number.isInteger(priority) || priority < 0 || priority > 100) return { ok: false, error: "Priority is a whole number from 0 to 100." };
  const callbackUrl = draft.callbackUrl.trim();
  if (callbackUrl && !/^https?:\/\/[^\s]+$/i.test(callbackUrl)) return { ok: false, error: "The callback URL must start with http:// or https://." };
  if ((draft.commitStatus || draft.mrNote) && !draft.credentialId) {
    return { ok: false, error: "Commit status and MR notes need a GitHub or GitLab credential." };
  }
  return {
    ok: true,
    rule: {
      when: { events: [...draft.events], branches: splitList(draft.branches), labels: splitList(draft.labels) },
      run: { suiteId: draft.suiteId },
      environment:
        draft.environmentMode === "fixed"
          ? { id: draft.environmentId }
          : { fromPayload: draft.environmentMode, baseEnvironmentId: draft.environmentId },
      priority,
      report: {
        commitStatus: draft.commitStatus,
        mrNote: draft.mrNote,
        callbackUrl: callbackUrl || null,
        credentialId: draft.credentialId || null
      }
    }
  };
}

export function describeRule(rule: WebhookRule, names: { suites: Record<string, string>; environments: Record<string, string> }): { when: string; run: string; report: string } {
  const events = rule.when.events.map((event) => webhookEventLabels[event].toLowerCase()).join(" or ");
  const branches = rule.when.branches.length > 0 ? ` on ${rule.when.branches.join(", ")}` : "";
  const labels = rule.when.labels.length > 0 ? ` labelled ${rule.when.labels.join(" or ")}` : "";
  const suite = names.suites[rule.run.suiteId] ?? "a deleted suite";
  const environment =
    "id" in rule.environment
      ? (names.environments[rule.environment.id] ?? "a deleted environment")
      : `${rule.environment.fromPayload === "review_app_url" ? "the review app URL" : "the deployment URL"} with ${names.environments[rule.environment.baseEnvironmentId] ?? "a deleted environment"}'s config`;
  const reports = [
    rule.report.commitStatus ? "commit status" : null,
    rule.report.mrNote ? "MR note" : null,
    rule.report.callbackUrl ? "callback" : null
  ].filter((value): value is string => value !== null);
  return {
    when: `${events}${branches}${labels}`,
    run: `${suite} on ${environment} · priority ${rule.priority}`,
    report: reports.length > 0 ? reports.join(" · ") : "no reporting"
  };
}

export const credentialKindForProvider = (provider: WebhookEndpoint["provider"]): "github_app" | "gitlab_token" | null =>
  provider === "github" ? "github_app" : provider === "gitlab" ? "gitlab_token" : null;

// Where to paste the URL and the secret on the provider's side.
export function providerSetup(provider: WebhookEndpoint["provider"]): string[] {
  switch (provider) {
    case "gitlab":
      return [
        "GitLab → Settings → Webhooks → Add new webhook.",
        "URL: the endpoint URL. Secret token: the secret below.",
        "Triggers: Push, Merge request, Pipeline and Deployment events as your rules need."
      ];
    case "github":
      return [
        "GitHub → Settings → Webhooks → Add webhook.",
        "Payload URL: the endpoint URL. Content type: application/json. Secret: the secret below.",
        "Events: Pushes, Pull requests, Workflow runs and Deployment statuses as your rules need."
      ];
    case "generic":
      return [
        "POST JSON { event, sha, branch, labels, mrId, reviewAppUrl, deploymentUrl } to the endpoint URL.",
        "Sign the raw body: X-Hub-Signature-256: sha256=<HMAC-SHA256 of the body with the secret, hex>."
      ];
  }
}

export function deliveryTone(status: WebhookDelivery["status"]): "success" | "warning" | "danger" | "muted" {
  if (status === "matched") return "success";
  if (status === "rejected" || status === "error") return "danger";
  if (status === "ignored") return "muted";
  return "warning";
}

export const shortSha = (sha: string | null) => (sha ? sha.slice(0, 8) : "—");

// ---------------------------------------------------------------------------------------------
// Notification channels
// ---------------------------------------------------------------------------------------------

export const notificationKindLabels: Record<NotificationKind, string> = {
  "run.finished": "Run finished",
  "run.blocked": "Run blocked",
  "batch.finished": "Batch finished",
  "import.finished": "Import finished",
  "review.pending_count": "Review queue",
  "runner.offline": "Runner offline"
};

export function channelFilterSummary(filter: { kinds: readonly NotificationKind[]; tags: readonly string[] }): string {
  const kinds = filter.kinds.length > 0 ? filter.kinds.map((kind) => notificationKindLabels[kind]).join(", ") : "All events";
  return filter.tags.length > 0 ? `${kinds} · cases tagged ${filter.tags.join(" or ")}` : kinds;
}

// ---------------------------------------------------------------------------------------------
// Agent notes
// ---------------------------------------------------------------------------------------------

export const AGENT_NOTES_MAX_BYTES = 16_384;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function notesBudget(text: string): { bytes: number; remaining: number; over: boolean; label: string } {
  const bytes = utf8Bytes(text);
  return {
    bytes,
    remaining: AGENT_NOTES_MAX_BYTES - bytes,
    over: bytes > AGENT_NOTES_MAX_BYTES,
    label: `${bytes.toLocaleString("en-US")} / ${AGENT_NOTES_MAX_BYTES.toLocaleString("en-US")} bytes`
  };
}
