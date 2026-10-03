import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { evidenceArtifacts } from "./evidence-artifacts";
import { evidences } from "./evidences";
import { organizations } from "./organizations";
import { testCases, testSuites } from "./test-cases";
import { testEnvironments } from "./test-config";
import { users } from "./users";

// Runs (test sessions), their steps, batches, subscribers, runner pools and workers, and the
// model price table (design.md §3.1, §5.4, §10).

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

export const runnerPools = sqliteTable(
	"runner_pools",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		kind: text("kind", { enum: ["cloud", "self-hosted"] }).notNull(),
		maxConcurrentRuns: integer("max_concurrent_runs").notNull().default(1),
		// sha256 of the registration token; the token is shown once.
		registrationTokenHash: text("registration_token_hash"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
	},
	(table) => [
		uniqueIndex("runner_pools_org_name_unique").on(table.orgId, table.name),
		uniqueIndex("runner_pools_registration_token_unique").on(
			table.registrationTokenHash,
		),
		check(
			"runner_pools_kind_check",
			sql`${table.kind} in ('cloud', 'self-hosted')`,
		),
	],
);

export const runnerWorkers = sqliteTable(
	"runner_workers",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		poolId: text("pool_id")
			.notNull()
			.references(() => runnerPools.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		hostname: text("hostname").notNull(),
		version: text("version").notNull(),
		capabilitiesJson: text("capabilities_json").notNull().default("{}"),
		workerTokenHash: text("worker_token_hash").notNull(),
		lastHeartbeatAt: integer("last_heartbeat_at"),
		currentRunId: text("current_run_id"),
		load: integer("load").notNull().default(0),
		offlineNotifiedAt: integer("offline_notified_at"),
		revokedAt: integer("revoked_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("runner_workers_token_unique").on(table.workerTokenHash),
		index("runner_workers_pool_heartbeat_idx").on(
			table.poolId,
			table.lastHeartbeatAt,
		),
	],
);

export const testRunBatches = sqliteTable(
	"test_run_batches",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["dataset", "suite", "ci"] }).notNull(),
		testCaseId: text("test_case_id").references(() => testCases.id, {
			onDelete: "set null",
		}),
		suiteId: text("suite_id").references(() => testSuites.id, {
			onDelete: "set null",
		}),
		trigger: text("trigger").notNull(),
		triggerRef: text("trigger_ref"),
		status: text("status", {
			enum: ["queued", "running", "completed", "failed", "cancelled"],
		})
			.notNull()
			.default("queued"),
		total: integer("total").notNull().default(0),
		passed: integer("passed").notNull().default(0),
		failed: integer("failed").notNull().default(0),
		blocked: integer("blocked").notNull().default(0),
		pending: integer("pending").notNull().default(0),
		// Requested runs in order; members that attached to an existing run are listed too.
		runIdsJson: text("run_ids_json").notNull().default("[]"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		finishedAt: integer("finished_at"),
	},
	(table) => [
		index("test_run_batches_org_created_idx").on(table.orgId, table.createdAt),
	],
);

export const testRuns = sqliteTable(
	"test_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		testCaseId: text("test_case_id")
			.notNull()
			.references(() => testCases.id, { onDelete: "cascade" }),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		requestedByTokenId: text("requested_by_token_id"),
		transcriptVersion: integer("transcript_version").notNull(),
		environmentId: text("environment_id").references(
			() => testEnvironments.id,
			{ onDelete: "set null" },
		),
		// Webhook runs against a review app or deployment: the environment's config with this
		// baseUrl (design.md §10c). Part of the dedupe key when set.
		baseUrlOverride: text("base_url_override"),
		paramsJson: text("params_json").notNull().default("{}"),
		paramsHash: text("params_hash").notNull(),
		cacheMode: text("cache_mode", {
			enum: ["read-write", "read-only", "off", "strict"],
		})
			.notNull()
			.default("read-write"),
		dedupeKey: text("dedupe_key").notNull(),
		// Set on runs created by a non-forced request: at most one such run per dedupe key is
		// open at a time (unique index below). Forced runs and retries leave it 0.
		dedupeExclusive: integer("dedupe_exclusive", { mode: "boolean" })
			.notNull()
			.default(false),
		trigger: text("trigger", {
			enum: ["manual", "cli", "mcp", "ci", "webhook"],
		})
			.notNull()
			.default("manual"),
		priority: integer("priority").notNull().default(30),
		runnerAffinity: text("runner_affinity").notNull().default("cloud"),
		// Pool reference as configured on the environment and the resolved pool row.
		runnerPool: text("runner_pool").notNull().default("cloud"),
		runnerPoolId: text("runner_pool_id").references(() => runnerPools.id, {
			onDelete: "set null",
		}),
		runner: text("runner"),
		runnerInfoJson: text("runner_info_json"),
		workerId: text("worker_id").references(() => runnerWorkers.id, {
			onDelete: "set null",
		}),
		status: text("status", {
			enum: [
				"queued",
				"claimed",
				"running",
				"paused",
				"completed",
				"failed",
				"cancelled",
			],
		})
			.notNull()
			.default("queued"),
		outcome: text("outcome", { enum: ["passed", "failed", "blocked"] }),
		blockedReason: text("blocked_reason"),
		flaky: integer("flaky", { mode: "boolean" }).notNull().default(false),
		// Retry chain (design.md §14 "Retries"): attempt 1 is the original request.
		retryAttempt: integer("retry_attempt").notNull().default(1),
		retryOfRunId: text("retry_of_run_id"),
		batchId: text("batch_id").references(() => testRunBatches.id, {
			onDelete: "set null",
		}),
		queuedAt: integer("queued_at").notNull(),
		claimedAt: integer("claimed_at"),
		startedAt: integer("started_at"),
		finishedAt: integer("finished_at"),
		evidenceId: text("evidence_id").references(() => evidences.id, {
			onDelete: "set null",
		}),
		error: text("error"),
		currentStepId: text("current_step_id"),
		cancelRequestedAt: integer("cancel_requested_at"),
		cancelledBy: text("cancelled_by").references(() => users.id, {
			onDelete: "set null",
		}),
		// Metrics.
		modelId: text("model_id"),
		judgeModelId: text("judge_model_id"),
		provider: text("provider"),
		modelCalls: integer("model_calls").notNull().default(0),
		inputTokens: integer("input_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		reasoningTokens: integer("reasoning_tokens").notNull().default(0),
		costUsd: real("cost_usd"),
		priceTableVersion: text("price_table_version"),
		durationMs: integer("duration_ms"),
		stepsTotal: integer("steps_total").notNull().default(0),
		stepsReplayed: integer("steps_replayed").notNull().default(0),
		stepsAgent: integer("steps_agent").notNull().default(0),
		stepsHandoff: integer("steps_handoff").notNull().default(0),
		// Lease.
		workerLeaseOwner: text("worker_lease_owner"),
		workerLeaseExpiresAt: integer("worker_lease_expires_at"),
		workerHeartbeatAt: integer("worker_heartbeat_at"),
		attempts: integer("attempts").notNull().default(0),
		// Per-run token (sha256); valid while the lease holds.
		runTokenHash: text("run_token_hash"),
		runTokenExpiresAt: integer("run_token_expires_at"),
		// Live view (phase 2).
		liveAvailable: integer("live_available", { mode: "boolean" })
			.notNull()
			.default(false),
		liveTakeoverBy: text("live_takeover_by").references(() => users.id, {
			onDelete: "set null",
		}),
		livePaused: integer("live_paused", { mode: "boolean" })
			.notNull()
			.default(false),
		liveFrameKey: text("live_frame_key"),
		liveFrameAt: integer("live_frame_at"),
		takeoverRequestedAt: integer("takeover_requested_at"),
		...timestamps,
	},
	(table) => [
		index("test_runs_queue_idx").on(
			table.runnerPoolId,
			table.status,
			table.priority,
			table.queuedAt,
		),
		index("test_runs_org_status_idx").on(table.orgId, table.status),
		index("test_runs_org_dedupe_idx").on(
			table.orgId,
			table.dedupeKey,
			table.status,
		),
		uniqueIndex("test_runs_org_dedupe_open_unique")
			.on(table.orgId, table.dedupeKey)
			.where(
				sql`${table.dedupeExclusive} = 1 and ${table.status} in ('queued', 'claimed', 'running', 'paused')`,
			),
		index("test_runs_case_queued_idx").on(table.testCaseId, table.queuedAt),
		index("test_runs_batch_idx").on(table.batchId),
		index("test_runs_evidence_idx").on(table.evidenceId),
		index("test_runs_org_finished_idx").on(table.orgId, table.finishedAt),
		uniqueIndex("test_runs_run_token_unique").on(table.runTokenHash),
		check(
			"test_runs_status_check",
			sql`${table.status} in ('queued', 'claimed', 'running', 'paused', 'completed', 'failed', 'cancelled')`,
		),
	],
);

export const testRunSteps = sqliteTable(
	"test_run_steps",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		runId: text("run_id")
			.notNull()
			.references(() => testRuns.id, { onDelete: "cascade" }),
		stepId: text("step_id").notNull(),
		parentStepId: text("parent_step_id"),
		ordinal: integer("ordinal").notNull(),
		type: text("type").notNull(),
		label: text("label").notNull().default(""),
		checkpointId: text("checkpoint_id"),
		status: text("status", {
			enum: ["pending", "running", "passed", "failed", "blocked", "skipped"],
		})
			.notNull()
			.default("pending"),
		mode: text("mode"),
		cacheReason: text("cache_reason"),
		startedAt: integer("started_at"),
		finishedAt: integer("finished_at"),
		durationMs: integer("duration_ms"),
		videoOffsetMs: integer("video_offset_ms"),
		observed: text("observed"),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		screenshotArtifactId: text("screenshot_artifact_id").references(
			() => evidenceArtifacts.id,
			{ onDelete: "set null" },
		),
		// Progress screenshot stored before the evidence exists.
		screenshotKey: text("screenshot_key"),
		screenshotMimeType: text("screenshot_mime_type"),
		scriptVersion: integer("script_version"),
		modelId: text("model_id"),
		modelCalls: integer("model_calls").notNull().default(0),
		actions: integer("actions").notNull().default(0),
		inputTokens: integer("input_tokens").notNull().default(0),
		cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		reasoningTokens: integer("reasoning_tokens").notNull().default(0),
		costUsd: real("cost_usd"),
		visionInput: integer("vision_input", { mode: "boolean" })
			.notNull()
			.default(false),
		...timestamps,
	},
	(table) => [
		uniqueIndex("test_run_steps_run_step_unique").on(table.runId, table.stepId),
	],
);

export const testRunSubscribers = sqliteTable(
	"test_run_subscribers",
	{
		runId: text("run_id")
			.notNull()
			.references(() => testRuns.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		trigger: text("trigger").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({ columns: [table.runId, table.userId] }),
		index("test_run_subscribers_user_idx").on(table.userId),
	],
);

export const testModelPrices = sqliteTable(
	"test_model_prices",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		// null = global default.
		orgId: text("org_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		modelId: text("model_id").notNull(),
		inputUsdPerMtok: real("input_usd_per_mtok").notNull(),
		cachedInputUsdPerMtok: real("cached_input_usd_per_mtok").notNull(),
		outputUsdPerMtok: real("output_usd_per_mtok").notNull(),
		version: text("version").notNull(),
		effectiveFrom: integer("effective_from").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("test_model_prices_scope_model_from_unique").on(
			sql`coalesce(${table.orgId}, '')`,
			table.modelId,
			table.effectiveFrom,
		),
		index("test_model_prices_model_idx").on(table.modelId),
	],
);
