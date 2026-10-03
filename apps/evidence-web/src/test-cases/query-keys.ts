// One query-key factory for every test-case, test-run and test-config query in the web app (the
// case workspace, the editor pickers, import, review, settings, the bell). Every key starts with the
// active organisation, so switching organisation never shows another organisation's data, and the
// two query modules share keys, so a mutation in one refreshes what the other shows.

export const testKeyRoot = "test-platform" as const;

type Org = string | null;

const org = (orgId: Org) => [testKeyRoot, orgId ?? "none"] as const;
const cases = (orgId: Org) => [...org(orgId), "cases"] as const;
const runs = (orgId: Org) => [...org(orgId), "runs"] as const;
const config = (orgId: Org) => [...org(orgId), "config"] as const;

export const testKeys = {
  // Everything of every organisation: invalidated when the active organisation changes.
  all: () => [testKeyRoot] as const,
  org,

  // Cases: invalidate `cases(orgId)` after any create, update, approve, reject, duplicate, import
  // commit or bulk action; it covers the list, details, versions, scripts, runs per case, similar
  // matches and the review queue.
  cases,
  caseLists: (orgId: Org) => [...cases(orgId), "list"] as const,
  caseList: (orgId: Org, filters: unknown, sort: unknown) => [...cases(orgId), "list", filters, sort] as const,
  // Keys and titles for the editor's [Use: KEY] picker.
  linkableCases: (orgId: Org) => [...cases(orgId), "linkable"] as const,
  caseDetail: (orgId: Org, caseId: string) => [...cases(orgId), "detail", caseId] as const,
  caseVersions: (orgId: Org, caseId: string) => [...cases(orgId), "versions", caseId] as const,
  caseScripts: (orgId: Org, caseId: string) => [...cases(orgId), "scripts", caseId] as const,
  caseRuns: (orgId: Org, caseId: string) => [...cases(orgId), "runs", caseId] as const,
  similar: (orgId: Org, query: string, excludeId: string | null) => [...cases(orgId), "similar", query, excludeId] as const,
  reviewQueue: (orgId: Org) => [...cases(orgId), "review-queue"] as const,
  importBatch: (orgId: Org, batchId: string) => [...cases(orgId), "import", batchId] as const,

  runs,
  run: (orgId: Org, runId: string) => [...runs(orgId), "detail", runId] as const,
  elementNames: (orgId: Org, evidenceId: string) => [...runs(orgId), "element-names", evidenceId] as const,
  modelCosts: (orgId: Org, from: number, to: number) => [...runs(orgId), "model-costs", from, to] as const,

  config,
  environments: (orgId: Org) => [...config(orgId), "environments"] as const,
  credentials: (orgId: Org) => [...config(orgId), "credentials"] as const,
  macros: (orgId: Org) => [...config(orgId), "macros"] as const,
  tags: (orgId: Org) => [...config(orgId), "tags"] as const,
  runSettings: (orgId: Org) => [...config(orgId), "run-settings"] as const,
  modelSettings: (orgId: Org) => [...config(orgId), "model-settings"] as const,
  modelPrices: (orgId: Org) => [...config(orgId), "model-prices"] as const,
  runnerPools: (orgId: Org) => [...config(orgId), "runner-pools"] as const,
  notificationSubscriptions: (orgId: Org) => [...config(orgId), "notification-subscriptions"] as const,
  notificationChannels: (orgId: Org) => [...config(orgId), "notification-channels"] as const,
  webhooks: (orgId: Org) => [...config(orgId), "webhooks"] as const,
  webhookDeliveries: (orgId: Org, endpointId: string) => [...config(orgId), "webhook-deliveries", endpointId] as const,
  agentNotes: (orgId: Org) => [...config(orgId), "agent-notes"] as const,
  suites: (orgId: Org) => [...cases(orgId), "suites"] as const,

  notifications: (orgId: Org) => [...org(orgId), "notifications"] as const
};

// TanStack prefix matching, for tests and for deciding what a mutation refreshes.
export function keyStartsWith(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  return prefix.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));
}
