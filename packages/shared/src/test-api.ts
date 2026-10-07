import { z } from "zod/v4";

import { isFakeDataLocale } from "./fake-data";
import { claimedExplorationSchema, importItemExplorationSchema } from "./test-exploration";
import {
  linkedCaseSchema,
  lintFindingSchema,
  macroParamSchema,
  paramDeclarationSchema,
  transcriptDatasetSchema,
  transcriptStepSchema,
  transcriptStepTypeSchema
} from "./test-case";
import {
  blockedReasonSchema,
  cacheModeSchema,
  cacheReasonSchema,
  modelPriceSchema,
  modelUsageSchema,
  runReportSchema,
  runStepResultSchema,
  runnerInfoSchema,
  testRunOutcomeSchema,
  testRunStatusSchema,
  testRunStepModeSchema,
  testRunStepStatusSchema,
  testRunTriggerSchema
} from "./test-run";

// HTTP contract of the test-case platform (design.md §6, §9.3, §10, §10b, §10c). The backend,
// runner daemon, web and desktop apps and the MCP server all validate against these schemas.

const id = z.string().min(1);
const epochMs = z.number().int().nonnegative();

// ---------------------------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------------------------

export const testCaseStatusSchema = z.enum(["draft", "review", "active", "archived"]);
export const testCaseSourceSchema = z.enum(["manual", "import", "ai", "duplicate", "recording"]);

// Links are opened in a browser by the web and desktop apps: only http(s), never file:, data: or
// javascript: URLs.
export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), "Use an http or https URL.");

export const testCaseLinkSchema = z.object({ url: httpUrlSchema, label: z.string().nullable().default(null) });

export const testCaseStatsSchema = z.object({
  runs: z.number().int().nonnegative(),
  lastOutcome: testRunOutcomeSchema.nullable(),
  lastRunAt: epochMs.nullable(),
  // Over the last ten finished runs (design.md handover §6: "ten-run averages").
  passRate: z.number().min(0).max(1).nullable(),
  flakyRate: z.number().min(0).max(1).nullable(),
  avgDurationMs: z.number().nonnegative().nullable(),
  avgCostUsd: z.number().nonnegative().nullable(),
  avgModelCalls: z.number().nonnegative().nullable(),
  avgTokens: z.number().nonnegative().nullable(),
  cachedSteps: z.number().int().nonnegative(),
  staleSteps: z.number().int().nonnegative(),
  derivedCases: z.number().int().nonnegative()
});

export const testCaseSummarySchema = z.object({
  id,
  key: z.string().min(1),
  title: z.string(),
  status: testCaseStatusSchema,
  source: testCaseSourceSchema,
  tags: z.array(z.string().min(1)),
  environmentId: id.nullable(),
  transcriptVersion: z.number().int().positive(),
  stepCount: z.number().int().nonnegative(),
  lintErrors: z.number().int().nonnegative(),
  lintWarnings: z.number().int().nonnegative(),
  duplicatedFromId: id.nullable(),
  createdBy: id.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  stats: testCaseStatsSchema
});

export const testCaseDetailSchema = testCaseSummarySchema.extend({
  description: z.string().nullable(),
  links: z.array(testCaseLinkSchema),
  transcript: z.string(),
  steps: z.array(transcriptStepSchema),
  params: z.array(paramDeclarationSchema),
  dataset: transcriptDatasetSchema.nullable(),
  lint: z.array(lintFindingSchema),
  externalId: z.string().nullable(),
  sourceRef: z.string().nullable(),
  fingerprint: z.string().min(1),
  retries: z.number().int().nonnegative(),
  // Names the case needs from the chosen environment and which are unresolved (design.md §9.3).
  requiredConfig: z.object({
    variables: z.array(z.string()),
    credentials: z.array(z.string()),
    unresolved: z.array(z.string())
  })
});

export const testCaseListQuerySchema = z.object({
  q: z.string().optional(),
  status: z.array(testCaseStatusSchema).optional(),
  tags: z.array(z.string().min(1)).optional(),
  environmentId: id.optional(),
  source: z.array(testCaseSourceSchema).optional(),
  lastOutcome: z.array(testRunOutcomeSchema).optional(),
  staleCache: z.boolean().optional(),
  createdBy: id.optional(),
  noRunsSinceDays: z.number().int().positive().optional(),
  sort: z.enum(["updated", "created", "key", "title", "last-run"]).default("updated"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional()
});

export const testCaseListResponseSchema = z.object({
  items: z.array(testCaseSummarySchema),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  // Tag counts per namespace for the sidebar ("team" → { "qa-pcf": 12 }); free tags under "".
  tagCounts: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()))
});

export const createTestCaseRequestSchema = z.object({
  // A one-case transcript document; title and metadata lines come from it.
  transcript: z.string().min(1).max(200_000),
  status: z.enum(["draft", "review", "active"]).default("active"),
  environmentId: id.nullable().optional(),
  source: testCaseSourceSchema.default("manual"),
  sourceRef: z.string().max(500).nullable().optional()
});

export const updateTestCaseRequestSchema = z.object({
  transcript: z.string().min(1).max(200_000).optional(),
  status: testCaseStatusSchema.optional(),
  environmentId: id.nullable().optional(),
  changeNote: z.string().max(500).optional(),
  // Optimistic concurrency: reject when the stored version moved on.
  expectedVersion: z.number().int().positive().optional()
});

export const testCaseVersionSchema = z.object({
  version: z.number().int().positive(),
  transcript: z.string(),
  createdBy: id.nullable(),
  createdAt: epochMs,
  changeNote: z.string().nullable()
});

export const duplicateTestCaseRequestSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  tags: z.array(z.string().min(1)).optional(),
  replacements: z.array(z.object({ find: z.string().min(1), replace: z.string() })).default([]),
  copy: z
    .object({ links: z.boolean().default(true), tags: z.boolean().default(true), environment: z.boolean().default(true), datasets: z.boolean().default(true) })
    .default({ links: true, tags: true, environment: true, datasets: true }),
  mode: z.enum(["variant", "copy"]).default("copy"),
  inheritScripts: z.boolean().default(true)
});

export const duplicateTestCaseResponseSchema = z.object({
  testCase: testCaseDetailSchema,
  inheritedScripts: z.number().int().nonnegative()
});

export const bulkTestCaseRequestSchema = z.object({
  action: z.enum(["tag", "untag", "set-environment", "archive", "run", "export", "approve", "reject"]),
  ids: z.array(id).min(1).max(1000),
  tags: z.array(z.string().min(1)).optional(),
  environmentId: id.nullable().optional(),
  reason: z.string().max(500).optional()
});

export const bulkTestCaseResponseSchema = z.object({
  updated: z.number().int().nonnegative(),
  runs: z.array(z.object({ testCaseId: id, runId: id, attached: z.boolean() })).default([]),
  document: z.string().nullable().default(null),
  errors: z.array(z.object({ id, message: z.string() })).default([])
});

export const similarTestCaseSchema = z.object({
  id,
  key: z.string(),
  title: z.string(),
  score: z.number().min(0).max(1),
  exact: z.boolean()
});

export const similarTestCasesResponseSchema = z.object({ items: z.array(similarTestCaseSchema) });

// ---------------------------------------------------------------------------------------------
// Import, review queue
// ---------------------------------------------------------------------------------------------

// `instructions`: plain-language instructions, explored on a browser and written as transcripts.
export const importSourceKindSchema = z.enum(["transcript-doc", "gherkin", "csv", "xlsx", "jira", "ai-generation", "instructions"]);
export const importDecisionSchema = z.enum(["create", "update", "skip", "merge"]);

export const importMappingSchema = z.object({
  title: z.string().optional(),
  steps: z.string().optional(),
  expected: z.string().optional(),
  preconditions: z.string().optional(),
  id: z.string().optional(),
  tags: z.string().optional()
});

export const createImportRequestSchema = z.object({
  sourceKind: importSourceKindSchema,
  // transcript-doc / gherkin / csv text; xlsx as base64.
  content: z.string().max(10_000_000).optional(),
  fileName: z.string().max(300).optional(),
  mapping: importMappingSchema.optional(),
  jql: z.string().max(2000).optional(),
  jiraCredentialId: id.optional(),
  defaultTags: z.array(z.string().min(1)).default([]),
  environmentId: id.nullable().optional(),
  // Try each item on a browser in the environment and rewrite it from what the agent did
  // (always for `instructions`; csv and xlsx when asked). Needs an environment.
  explore: z.boolean().default(false),
  // Without it an explored import is refused (409 EXPLORE_NO_RUNNER) while no runner of the
  // environment's pool is online, rather than queueing silently.
  queueWithoutRunner: z.boolean().default(false)
});

export const importItemSchema = z.object({
  id,
  ordinal: z.number().int().nonnegative(),
  externalId: z.string().nullable(),
  title: z.string(),
  transcript: z.string(),
  lint: z.array(lintFindingSchema),
  similar: z.array(similarTestCaseSchema),
  decision: importDecisionSchema,
  resultTestCaseId: id.nullable(),
  error: z.string().nullable(),
  // Rows whose steps need the model ("normalising") stay pending until it returns.
  state: z.enum(["pending", "ready", "committed", "skipped", "error"]),
  // Set when the item is explored on a browser before review.
  exploration: importItemExplorationSchema.nullable().default(null)
});

export const importBatchSchema = z.object({
  id,
  sourceKind: importSourceKindSchema,
  status: z.enum(["parsing", "ready", "committing", "done", "error"]),
  counts: z.object({
    total: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative()
  }),
  createdBy: id.nullable(),
  createdAt: epochMs,
  items: z.array(importItemSchema)
});

export const patchImportRequestSchema = z.object({
  decisions: z.array(z.object({ itemId: id, decision: importDecisionSchema, transcript: z.string().optional() })).default([]),
  commit: z.boolean().default(false)
});

// ---------------------------------------------------------------------------------------------
// Step scripts (cache) and suites
// ---------------------------------------------------------------------------------------------

export const stepScriptSchema = z.object({
  id,
  testCaseId: id,
  stepId: z.string().min(1),
  instructionKey: z.string().min(1),
  environmentId: id.nullable(),
  keyHash: z.string().min(1),
  version: z.number().int().positive(),
  renderedCode: z.string(),
  status: z.enum(["active", "stale", "invalid"]),
  staleReason: z.string().nullable(),
  verifiedCount: z.number().int().nonnegative(),
  recordedFromRunId: id.nullable(),
  lastReplayedAt: epochMs.nullable(),
  createdAt: epochMs
});

// Runner ↔ backend cache.store (handover 1b.2): the e2e record travels as opaque JSON.
export const cacheEntryReadResponseSchema = z.object({
  status: z.enum(["hit", "miss"]),
  entry: z.unknown().optional()
});
export const cacheEntryWriteRequestSchema = z.object({
  entry: z.unknown(),
  stepIds: z.array(z.string().min(1)),
  instructionKey: z.string().min(1).nullable(),
  renderedCode: z.string()
});

export const testSuiteSchema = z.object({
  id,
  name: z.string().min(1),
  description: z.string().nullable(),
  filter: testCaseListQuerySchema.partial().nullable(),
  memberIds: z.array(id),
  createdAt: epochMs
});
export const upsertTestSuiteRequestSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  filter: testCaseListQuerySchema.partial().nullable().optional(),
  memberIds: z.array(id).optional()
});

// ---------------------------------------------------------------------------------------------
// Runs: request, queue, progress, finalisation
// ---------------------------------------------------------------------------------------------

export const createTestRunRequestSchema = z.object({
  environmentId: id.nullable().optional(),
  params: z.record(z.string(), z.string()).default({}),
  cacheMode: cacheModeSchema.default("read-write"),
  force: z.boolean().default(false),
  trigger: testRunTriggerSchema.default("manual"),
  priority: z.number().int().min(0).max(100).optional(),
  // Dataset: run every enabled row as a batch.
  dataset: z.boolean().default(false)
});

export const createTestRunResponseSchema = z.object({
  runId: id,
  attached: z.boolean(),
  status: testRunStatusSchema,
  // 0-based place in the pool's queue (0 = claimed next); null once the run left the queue.
  queuePosition: z.number().int().nonnegative().nullable(),
  // Runs queued in the same pool.
  queueDepth: z.number().int().nonnegative().nullable().optional(),
  requestedBy: z.array(z.object({ userId: id, name: z.string().nullable() })),
  batchId: id.nullable().default(null),
  runIds: z.array(id).default([])
});

export const testRunStepSchema = z.object({
  stepId: z.string().min(1),
  parentStepId: z.string().nullable(),
  ordinal: z.number().int().positive(),
  type: transcriptStepTypeSchema,
  label: z.string(),
  checkpointId: z.string().nullable(),
  status: testRunStepStatusSchema.or(z.literal("running")).or(z.literal("pending")),
  mode: testRunStepModeSchema.nullable(),
  cacheReason: cacheReasonSchema.nullable(),
  startedAt: epochMs.nullable(),
  finishedAt: epochMs.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  videoOffsetMs: z.number().nonnegative().nullable(),
  observed: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  screenshotUrl: z.string().nullable(),
  usage: modelUsageSchema
});

export const testRunMetricsSchema = z.object({
  modelId: z.string().nullable(),
  judgeModelId: z.string().nullable(),
  provider: z.string().nullable(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  priceTableVersion: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  stepsTotal: z.number().int().nonnegative(),
  stepsReplayed: z.number().int().nonnegative(),
  stepsAgent: z.number().int().nonnegative(),
  stepsHandoff: z.number().int().nonnegative()
});

export const testRunSummarySchema = z.object({
  id,
  testCaseId: id,
  testCaseKey: z.string(),
  testCaseTitle: z.string(),
  transcriptVersion: z.number().int().positive(),
  environmentId: id.nullable(),
  environmentName: z.string().nullable(),
  status: testRunStatusSchema,
  outcome: testRunOutcomeSchema.nullable(),
  blockedReason: blockedReasonSchema.nullable(),
  flaky: z.boolean(),
  trigger: testRunTriggerSchema,
  runnerPool: z.string(),
  createdBy: id.nullable(),
  createdByName: z.string().nullable(),
  queuedAt: epochMs,
  startedAt: epochMs.nullable(),
  finishedAt: epochMs.nullable(),
  evidenceId: id.nullable(),
  batchId: id.nullable(),
  // 0-based place in the pool's queue (0 = claimed next); null once the run left the queue.
  queuePosition: z.number().int().nonnegative().nullable(),
  // Runs queued in the run's pool, for the "queued · #2 of 3" pill (design.md §10.4).
  queueDepth: z.number().int().nonnegative().nullable().optional(),
  estimatedStartAt: epochMs.nullable(),
  subscribers: z.array(z.object({ userId: id, name: z.string().nullable() })),
  metrics: testRunMetricsSchema
});

export const testRunDetailSchema = testRunSummarySchema.extend({
  params: z.record(z.string(), z.string()),
  cacheMode: cacheModeSchema,
  runnerInfo: runnerInfoSchema.nullable(),
  error: z.string().nullable(),
  steps: z.array(testRunStepSchema),
  transcript: z.string(),
  currentStepId: z.string().nullable(),
  // Live view (phase 2): set while a runner streams frames and accepts take-over.
  live: z
    .object({
      available: z.boolean(),
      takeoverBy: id.nullable(),
      paused: z.boolean(),
      // API path of the latest JPEG (GET /test-runs/:id/live/frame); fetch it with the session.
            frameUrl: z.string().nullable(),
      frameAt: epochMs.nullable(),
      // After a secret was typed in the run, frames are replaced by a placeholder.
      framesHidden: z.boolean().default(false),
      // CSS pixels of the run's browser viewport; input coordinates use this space.
      viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).nullable().default(null)
    })
    .nullable()
});

export const testRunListResponseSchema = z.object({
  items: z.array(testRunSummarySchema),
  nextCursor: z.string().nullable()
});

// Runner → backend while a run executes (design.md §5.4 "Progress while a run executes").
export const testRunProgressRequestSchema = z.object({
  status: z.enum(["running", "paused"]).optional(),
  currentStepId: z.string().nullable().optional(),
  steps: z
    .array(
      runStepResultSchema.partial().extend({
        stepId: z.string().min(1),
        status: testRunStepStatusSchema.or(z.literal("running"))
      })
    )
    .default([]),
  // Reduced PNG/JPEG of the finished step, base64, at most ~200 KB.
  screenshot: z.object({ stepId: z.string().min(1), mimeType: z.enum(["image/png", "image/jpeg"]), base64: z.string().max(400_000) }).optional(),
  runnerInfo: runnerInfoSchema.optional()
});

// Runner → backend at the end of a run; evidence was uploaded first.
export const finalizeTestRunRequestSchema = z.object({
  report: runReportSchema,
  evidenceId: id.nullable()
});

export const testRunProgressResponseSchema = z.object({
  cancelRequested: z.boolean(),
  leaseExpiresAt: epochMs.nullable(),
  // Live view: a viewer asked to take over the browser.
  takeoverRequested: z.boolean().default(false)
});

// ---------------------------------------------------------------------------------------------
// Runner pools, workers, claim, per-run config (design.md §5.4, §9.3, §10.1)
// ---------------------------------------------------------------------------------------------

export const runnerPoolKindSchema = z.enum(["cloud", "self-hosted"]);

export const runnerUpdatePhaseSchema = z.enum(["draining", "downloading", "verifying", "restarting", "reconnecting", "completed", "failed"]);
export const runnerUpdateErrorSchema = z.enum(["DOWNLOAD_FAILED", "VERIFY_FAILED", "RESTART_FAILED", "RECONNECT_FAILED"]);
export const runnerUpdateProgressRequestSchema = z.object({
  updateId: epochMs,
  targetVersion: z.string().min(1).max(50),
  phase: runnerUpdatePhaseSchema,
  downloadPercent: z.number().min(0).max(100).nullable().default(null),
  downloadedBytes: z.number().int().nonnegative().nullable().default(null),
  totalBytes: z.number().int().positive().nullable().default(null),
  errorCode: runnerUpdateErrorSchema.nullable().default(null),
  replacementWorkerIds: z.array(id).min(1).max(50).optional()
});
export const runnerUpdateProgressSchema = runnerUpdateProgressRequestSchema.omit({ replacementWorkerIds: true }).extend({
  startedAt: epochMs,
  reportedAt: epochMs
});
export type RunnerUpdateProgress = z.infer<typeof runnerUpdateProgressSchema>;

export const runnerPoolSchema = z.object({
  id,
  name: z.string().min(1),
  kind: runnerPoolKindSchema,
  maxConcurrentRuns: z.number().int().min(1).max(50),
  serverVersion: z.string().optional(),
  targetVersion: z.string().nullable().optional(),
  updateProgress: runnerUpdateProgressSchema.nullable().optional(),
  workers: z.array(
    z.object({
      id,
      hostname: z.string(),
      version: z.string(),
      versionSkew: z.boolean().optional(),
      managedUpdates: z.boolean().optional(),
      drainingVersion: z.string().nullable().optional(),
      status: z.enum(["online", "offline"]),
      lastHeartbeatAt: epochMs.nullable(),
      currentRunId: id.nullable()
    })
  ),
  // Runs only.
  queued: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  // Import items waiting for or in an exploration on this pool (design.md §7 "General instructions").
  explorationsQueued: z.number().int().nonnegative().default(0),
  explorationsRunning: z.number().int().nonnegative().default(0),
  createdAt: epochMs
});

export const createRunnerPoolRequestSchema = z.object({
  name: z.string().min(1).max(100),
  maxConcurrentRuns: z.number().int().min(1).max(50).default(1)
});
export const createRunnerPoolResponseSchema = z.object({
  pool: runnerPoolSchema,
  // Shown once. `jl-e2e-runner start --token <registrationToken>`.
  registrationToken: z.string().min(1)
});

export const registerRunnerRequestSchema = z.object({
  hostname: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  capabilities: z.object({ browsers: z.array(z.string()).default(["chromium"]), headed: z.boolean().default(false), liveView: z.boolean().default(false), managedUpdates: z.boolean().optional() })
});
export const registerRunnerResponseSchema = z.object({
  workerId: id,
  poolId: id,
  // Worker credential for heartbeat and claim; the registration token is not used again.
  workerToken: z.string().min(1),
  heartbeatMs: z.number().int().positive(),
  leaseMs: z.number().int().positive()
});

export const runnerHeartbeatRequestSchema = z.object({
  runId: id.nullable().default(null),
  load: z.number().int().nonnegative().default(0),
  version: z.string().min(1).max(50).optional(),
  managedUpdates: z.boolean().optional(),
  drainingVersion: z.string().min(1).max(50).nullable().optional(),
  drainingUpdateId: epochMs.nullable().optional()
});

export const runnerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  serverVersion: z.string().optional(),
  targetVersion: z.string().nullable().optional(),
  updateId: epochMs.optional()
});

export const claimedRunSchema = z.object({
  runId: id,
  testCaseId: id,
  testCaseKey: z.string(),
  transcript: z.string(),
  transcriptVersion: z.number().int().positive(),
  steps: z.array(transcriptStepSchema),
  macros: z.array(z.object({ name: z.string(), version: z.number().int().positive(), params: z.array(macroParamSchema), transcript: z.string() })),
  // Cases the transcript runs inline with [Use: KEY], transitively.
  cases: z.array(linkedCaseSchema).default([]),
  environmentId: id.nullable(),
  params: z.record(z.string(), z.string()),
  cacheMode: cacheModeSchema,
  leaseExpiresAt: epochMs,
  attempt: z.number().int().positive(),
  // Per-run token for GET /test-runs/:id/config, progress, cache and evidence upload; valid for the lease.
  runToken: z.string().min(1)
});
// A worker gets a run or, when its pool has no run queued, an exploration (import).
export const claimRunResponseSchema = z.object({ run: claimedRunSchema.nullable(), exploration: claimedExplorationSchema.nullable().default(null) });

// The resolved environment and decrypted credentials for one run (§9.3). Matches the runner's
// OrgRunConfig; returned only to a run token, never to a browser.
export const testRunConfigSchema = z.object({
  environment: z.object({
    name: z.string().min(1),
    baseUrl: z.string(),
    variables: z.record(z.string(), z.string()),
    agentInstructions: z.string().nullable(),
    // Locale of generated values ({person.name}); null means en.
    dataLocale: z.string().nullable().default(null)
  }),
  credentials: z.array(
    z.object({
      profile: z.string().min(1),
      fields: z.record(z.string(), z.string()),
      loginField: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable().default(null),
      secretFields: z.record(z.string(), z.string())
    })
  ),
  model: z.object({ act: z.string().nullable(), judge: z.string().nullable(), apiKeys: z.record(z.string(), z.string()) }).nullable(),
  // Phase 2: organisation agent notes, prepended to environment agent instructions.
  agentNotes: z.string().nullable().default(null),
  prices: z.array(modelPriceSchema).default([]),
  priceTableVersion: z.string().nullable().default(null)
});

// ---------------------------------------------------------------------------------------------
// Organisation configuration (design.md §9.3, §14)
// ---------------------------------------------------------------------------------------------

export const testEnvironmentSchema = z.object({
  id,
  name: z.string().min(1),
  baseUrl: z.string(),
  variables: z.record(z.string(), z.string()),
  runnerPool: z.string().min(1),
  agentInstructions: z.string().max(16_384).nullable(),
  dataLocale: z.string().nullable().default(null),
  notes: z.string().nullable(),
  usedByCases: z.number().int().nonnegative(),
  createdAt: epochMs,
  updatedAt: epochMs
});
export const upsertTestEnvironmentRequestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  baseUrl: z.string().url(),
  variables: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
  runnerPool: z.string().min(1).default("cloud"),
  agentInstructions: z.string().max(16_384).nullable().optional(),
  dataLocale: z
    .string()
    .refine(isFakeDataLocale, "Unknown data locale")
    .nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional()
});

export const credentialKindSchema = z.enum(["login", "model_key", "jira", "github_app", "gitlab_token", "slack_webhook"]);

export const testCredentialSchema = z.object({
  id,
  profile: z.string().min(1),
  kind: credentialKindSchema,
  environmentId: id.nullable(),
  fields: z.record(z.string(), z.string()),
  // Names only; values never leave the server (§9.3).
  secretFieldNames: z.array(z.string()),
  loginField: z.string().nullable().default(null),
  keyVersion: z.number().int().positive(),
  lastUsedAt: epochMs.nullable(),
  loginMacroId: id.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs
});
export const upsertTestCredentialRequestSchema = z.object({
  profile: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/),
  kind: credentialKindSchema.default("login"),
  environmentId: id.nullable().optional(),
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string()).default({}),
  // Write-only. Omitted fields keep their stored value; null removes the field.
  secretFields: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.string().min(1).nullable()).default({}),
  loginField: z.string().regex(/^[a-z][a-z0-9_]*$/).nullable().optional(),
  loginMacroId: id.nullable().optional()
});

export const testMacroSchema = z.object({
  id,
  name: z.string().min(1),
  params: z.array(macroParamSchema),
  transcript: z.string(),
  version: z.number().int().positive(),
  status: z.enum(["draft", "active"]),
  createdBy: id.nullable(),
  createdAt: epochMs,
  updatedAt: epochMs
});
export const upsertTestMacroRequestSchema = z.object({
  name: z.string().min(1).max(80),
  params: z.array(macroParamSchema).default([]),
  transcript: z.string().min(1).max(50_000),
  status: z.enum(["draft", "active"]).optional()
});

export const testTagSchema = z.object({
  id,
  namespace: z.string(),
  name: z.string().min(1),
  color: z.string().min(1),
  description: z.string().nullable(),
  count: z.number().int().nonnegative()
});
export const upsertTestTagRequestSchema = z.object({
  namespace: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).or(z.literal("")),
  name: z.string().min(1).max(60),
  color: z.string().min(1).max(40),
  description: z.string().max(500).nullable().optional()
});

export const testRunSettingsSchema = z.object({
  maxConcurrentRuns: z.number().int().min(1).max(50),
  dedupeWindowSeconds: z.number().int().min(0).max(86_400),
  maxQueuedRuns: z.number().int().min(1).max(10_000),
  maxQueuedPerCase: z.number().int().min(1).max(100),
  tokenBucketSize: z.number().int().min(1).max(10_000),
  tokenBucketWindowSeconds: z.number().int().min(1).max(86_400),
  dailyBudgetUsd: z.number().nonnegative().nullable(),
  retention: z.object({
    failedDays: z.number().int().min(1).max(3650),
    passedDays: z.number().int().min(1).max(3650)
  })
});

// What a run still needs before the models can be instantiated: the act provider's key, the
// judge provider's key (when it differs from the act provider) or the OpenAI-compatible base URL.
export const modelSettingsMissingSchema = z.enum(["key", "judgeKey", "baseUrl"]);
export const modelSettingsSchema = z.object({
  actModel: z.string().min(1),
  judgeModel: z.string().min(1),
  // Provider of the act model; the key belongs to it.
  provider: z.string().min(1),
  judgeProvider: z.string().min(1).optional(),
  keyConfigured: z.boolean(),
  keyLast4: z.string().nullable(),
  // A second key for the judge model's provider, used only when it differs from the act provider.
  judgeKeyRequired: z.boolean().default(false),
  judgeKeyConfigured: z.boolean().default(false),
  judgeKeyLast4: z.string().nullable().default(null),
  // Endpoint for `openai-compatible/` models (OPENAI_COMPATIBLE_BASE_URL on the runner). Not a secret.
  baseUrl: z.string().nullable().default(null),
  missing: z.array(modelSettingsMissingSchema).default([])
});
const modelKeySchema = z.string().min(8).max(500);
export const updateModelSettingsRequestSchema = z.object({
  actModel: z.string().trim().min(1).max(200),
  judgeModel: z.string().trim().min(1).max(200),
  // Write-only key for the act model's provider. Omitted keeps the stored key; null removes it. A
  // stored key is dropped when the act provider changes, so it is never sent to another provider.
  apiKey: modelKeySchema.nullable().optional(),
  // Write-only key for the judge model's provider when it differs from the act provider. Same rules.
  judgeApiKey: modelKeySchema.nullable().optional(),
  // http(s) endpoint for `openai-compatible/` models, e.g. https://api.groq.com/openai/v1. Omitted
  // keeps the stored URL; null removes it. Required while either model is openai-compatible.
  baseUrl: z.string().trim().max(2000).pipe(httpUrlSchema).nullable().optional()
});

// GET/PUT /model-prices: the effective price per model id (USD per million tokens) and whether
// it is a global default or the organisation's own row. PUT takes the organisation's rows only and
// replaces the previous set; `source` is ignored there.
export const modelPriceSourceSchema = z.enum(["default", "organization"]);
export const modelPriceRowSchema = modelPriceSchema.extend({ source: modelPriceSourceSchema });

// Model spend per organisation and per user (ops: cost visible in the UI).
export const modelCostReportSchema = z.object({
  from: epochMs,
  to: epochMs,
  totalCostUsd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
  byUser: z.array(z.object({ userId: id.nullable(), name: z.string().nullable(), costUsd: z.number().nonnegative(), runs: z.number().int().nonnegative() })),
  byModel: z.array(z.object({ modelId: z.string(), costUsd: z.number().nonnegative(), tokens: z.number().int().nonnegative() })),
  byDay: z.array(z.object({ day: z.string(), costUsd: z.number().nonnegative() }))
});

// ---------------------------------------------------------------------------------------------
// Notifications (design.md §10b)
// ---------------------------------------------------------------------------------------------

export const notificationKindSchema = z.enum([
  "run.finished",
  "run.blocked",
  "batch.finished",
  "import.finished",
  "review.pending_count",
  "runner.offline"
]);

export const notificationSchema = z.object({
  id,
  kind: notificationKindSchema,
  subjectType: z.string(),
  subjectId: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: epochMs,
  readAt: epochMs.nullable()
});
export const notificationListResponseSchema = z.object({ items: z.array(notificationSchema), unread: z.number().int().nonnegative() });
// Marks notifications read: the listed ids, or everything with `all`.
export const markNotificationsReadRequestSchema = z.object({ ids: z.array(id).max(500).default([]), all: z.boolean().default(false) });
// Per-user opt-in by kind; run events about the user's own runs are always delivered.
export const notificationSubscriptionsSchema = z.object({
  subscribed: z.array(notificationKindSchema),
  unsubscribed: z.array(notificationKindSchema).default([])
});

export const notificationChannelSchema = z.object({
  id,
  kind: z.enum(["in_app", "slack", "email", "webhook"]),
  config: z.record(z.string(), z.string()),
  filter: z.object({ kinds: z.array(notificationKindSchema).default([]), tags: z.array(z.string()).default([]) }),
  enabled: z.boolean()
});
// Webhook channels: the URL is stored encrypted and shown masked; posts are signed with a
// per-channel secret (X-Jl-Signature-256) that is returned once, on create.
export const createNotificationChannelResponseSchema = notificationChannelSchema.extend({
  signingSecret: z.string().nullable().default(null)
});
export const upsertNotificationChannelRequestSchema = z.object({
  kind: z.enum(["slack", "webhook"]),
  // Slack: { credentialId } of a slack_webhook credential; webhook: { url }.
  config: z.record(z.string(), z.string()),
  filter: z.object({ kinds: z.array(notificationKindSchema).default([]), tags: z.array(z.string()).default([]) }).default({ kinds: [], tags: [] }),
  enabled: z.boolean().default(true)
});

// ---------------------------------------------------------------------------------------------
// CI webhooks (design.md §10c, phase 2) and agent notes (phase 2)
// ---------------------------------------------------------------------------------------------

export const webhookRuleSchema = z.object({
  when: z.object({
    events: z.array(z.enum(["push", "merge_request", "pipeline", "deployment"])).min(1),
    branches: z.array(z.string()).default([]),
    labels: z.array(z.string()).default([])
  }),
  run: z.object({ suiteId: id }),
  // fromPayload: the event's review-app or deployment URL becomes the base URL, so its host must be
  // allowed: globs in allowedHosts ("*.review.example.com"), or the base environment's own host
  // when the list is empty. The base environment's credentials go to that host.
  environment: z.union([
    z.object({ id }),
    z.object({
      fromPayload: z.enum(["review_app_url", "deployment_url"]),
      baseEnvironmentId: id,
      allowedHosts: z.array(z.string().regex(/^[a-z0-9*.-]{1,253}$/i)).max(20).default([])
    })
  ]),
  priority: z.number().int().min(0).max(100).default(10),
  report: z
    .object({ commitStatus: z.boolean().default(true), mrNote: z.boolean().default(false), callbackUrl: httpUrlSchema.nullable().default(null), credentialId: id.nullable().default(null) })
    .default({ commitStatus: true, mrNote: false, callbackUrl: null, credentialId: null })
});

export const webhookEndpointSchema = z.object({
  id,
  provider: z.enum(["gitlab", "github", "generic"]),
  rules: z.array(webhookRuleSchema),
  enabled: z.boolean(),
  url: z.string(),
  createdAt: epochMs
});
export const upsertWebhookEndpointRequestSchema = z.object({
  provider: z.enum(["gitlab", "github", "generic"]),
  rules: z.array(webhookRuleSchema).min(1),
  enabled: z.boolean().default(true)
});
export const createWebhookEndpointResponseSchema = z.object({
  endpoint: webhookEndpointSchema,
  // Shown once: the GitLab token or GitHub webhook secret.
  secret: z.string().min(16)
});

// Inbound deliveries of an endpoint, newest first (settings "Recent deliveries").
export const webhookDeliverySchema = z.object({
  id,
  eventType: z.string(),
  status: z.enum(["received", "matched", "ignored", "rejected", "error"]),
  signatureValid: z.boolean(),
  triggerRef: z.string().nullable(),
  batchId: id.nullable(),
    error: z.string().nullable(),
  // Outbound report of the batch this delivery started or joined: retrying with the last error,
  // or failed for good after five attempts (dead letter).
  report: z
    .object({
      stage: z.enum(["pending", "final"]),
      state: z.enum(["pending", "sent", "retrying", "failed"]),
      attempts: z.number().int().nonnegative(),
      error: z.string().nullable()
    })
    .nullable()
    .default(null),
  createdAt: epochMs
});

export const testRunBatchSchema = z.object({
  id,
  kind: z.enum(["dataset", "suite", "ci"]),
  testCaseId: id.nullable(),
  suiteId: id.nullable(),
  trigger: z.string(),
  triggerRef: z.string().nullable(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  counts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative()
  }),
  runIds: z.array(id),
  createdAt: epochMs,
  finishedAt: epochMs.nullable()
});

export const agentNotesSchema = z.object({
  notes: z.string().max(16_384),
  updatedBy: id.nullable(),
  updatedAt: epochMs.nullable()
});

export type TestCaseStatus = z.infer<typeof testCaseStatusSchema>;
export type TestCaseSummary = z.infer<typeof testCaseSummarySchema>;
export type TestCaseDetail = z.infer<typeof testCaseDetailSchema>;
export type TestCaseStats = z.infer<typeof testCaseStatsSchema>;
export type TestCaseListQuery = z.infer<typeof testCaseListQuerySchema>;
export type TestCaseListResponse = z.infer<typeof testCaseListResponseSchema>;
export type CreateTestCaseRequest = z.infer<typeof createTestCaseRequestSchema>;
export type UpdateTestCaseRequest = z.infer<typeof updateTestCaseRequestSchema>;
export type DuplicateTestCaseRequest = z.infer<typeof duplicateTestCaseRequestSchema>;
export type BulkTestCaseRequest = z.infer<typeof bulkTestCaseRequestSchema>;
export type SimilarTestCase = z.infer<typeof similarTestCaseSchema>;
export type ImportBatch = z.infer<typeof importBatchSchema>;
export type ImportItem = z.infer<typeof importItemSchema>;
export type CreateImportRequest = z.infer<typeof createImportRequestSchema>;
export type StepScript = z.infer<typeof stepScriptSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;
export type CreateTestRunRequest = z.infer<typeof createTestRunRequestSchema>;
export type CreateTestRunResponse = z.infer<typeof createTestRunResponseSchema>;
export type TestRunStep = z.infer<typeof testRunStepSchema>;
export type TestRunSummary = z.infer<typeof testRunSummarySchema>;
export type TestRunDetail = z.infer<typeof testRunDetailSchema>;
export type TestRunMetrics = z.infer<typeof testRunMetricsSchema>;
export type TestRunProgressRequest = z.infer<typeof testRunProgressRequestSchema>;
export type FinalizeTestRunRequest = z.infer<typeof finalizeTestRunRequestSchema>;
export type RunnerPool = z.infer<typeof runnerPoolSchema>;
export type ClaimedRun = z.infer<typeof claimedRunSchema>;
export type TestRunConfig = z.infer<typeof testRunConfigSchema>;
export type TestEnvironment = z.infer<typeof testEnvironmentSchema>;
export type TestCredential = z.infer<typeof testCredentialSchema>;
export type TestMacro = z.infer<typeof testMacroSchema>;
export type TestTag = z.infer<typeof testTagSchema>;
export type TestRunSettings = z.infer<typeof testRunSettingsSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export type ModelPriceRow = z.infer<typeof modelPriceRowSchema>;
export type ModelCostReport = z.infer<typeof modelCostReportSchema>;
export type NotificationKind = z.infer<typeof notificationKindSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type NotificationSubscriptions = z.infer<typeof notificationSubscriptionsSchema>;
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;
export type WebhookRule = z.infer<typeof webhookRuleSchema>;
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export type CreateWebhookEndpointResponse = z.infer<typeof createWebhookEndpointResponseSchema>;
export type UpsertWebhookEndpointRequest = z.infer<typeof upsertWebhookEndpointRequestSchema>;
export type UpsertNotificationChannelRequest = z.infer<typeof upsertNotificationChannelRequestSchema>;
export type CreateNotificationChannelResponse = z.infer<typeof createNotificationChannelResponseSchema>;
export type TestRunBatch = z.infer<typeof testRunBatchSchema>;
export type AgentNotes = z.infer<typeof agentNotesSchema>;
