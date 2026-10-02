import { Buffer } from "node:buffer";
import {
	type ClaimedRun,
	type CreateTestRunRequest,
	type CreateTestRunResponse,
	type MacroParam,
	macroParamSchema,
	runnerInfoSchema,
	type TestRunBatch,
	type TestRunDetail,
	type TestRunProgressRequest,
	type TestRunSettings,
	type TestRunStep,
	type TestRunSummary,
	transcriptStepSchema,
} from "@jittle-lamp/shared";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { z } from "zod/v4";

import {
	evidenceArtifacts,
	runnerPools,
	runnerWorkers,
	testCases,
	testCaseVersions,
	testEnvironments,
	testMacros,
	testRateBuckets,
	testRunBatches,
	testRunSettings,
	testRunSteps,
	testRunSubscribers,
	testRuns,
} from "../db/schema";
import { HttpError, notFound } from "../http/test-http";
import type { ArtifactStorage } from "./artifact-storage";
import { emitNotification, emitRunOutcome } from "./notifications";
import { caseSteps, parseJsonColumn, type TestCaseRow } from "./test-cases";
import type { LiveHub } from "./test-live";
import {
	createOpaqueToken,
	hashToken,
	RUN_TOKEN_PREFIX,
	sha256Text,
} from "./test-tokens";
import type { BackendDb } from "./user-provisioning";

// The run queue (design.md §10, ADR 0002 decision 12): one queue per organisation, claimed by
// runners per pool with a lease; dedupe, queue caps and a token bucket per user or token.

export const RUN_LEASE_MS = 30_000;
export const RUN_HEARTBEAT_MS = 10_000;
export const RUN_MAX_ATTEMPTS = 3;
// A worker is live while it heartbeated within three intervals.
export const WORKER_LIVE_MS = 3 * RUN_HEARTBEAT_MS;
export const ACTIVE_RUN_STATUSES = ["claimed", "running", "paused"] as const;
export const OPEN_RUN_STATUSES = ["queued", ...ACTIVE_RUN_STATUSES] as const;

export type TestRunRow = typeof testRuns.$inferSelect;
export type RunnerPoolRow = typeof runnerPools.$inferSelect;

export const defaultRunSettings: TestRunSettings = {
	maxConcurrentRuns: 1,
	dedupeWindowSeconds: 120,
	maxQueuedRuns: 20,
	maxQueuedPerCase: 3,
	tokenBucketSize: 30,
	tokenBucketWindowSeconds: 600,
	dailyBudgetUsd: null,
	retention: { failedDays: 180, passedDays: 30 },
};

export const getRunSettings = async (
	db: BackendDb,
	orgId: string,
): Promise<TestRunSettings> => {
	const row = await db.query.testRunSettings.findFirst({
		where: eq(testRunSettings.orgId, orgId),
	});
	if (!row) return defaultRunSettings;
	return {
		maxConcurrentRuns: row.maxConcurrentRuns,
		dedupeWindowSeconds: row.dedupeWindowSeconds,
		maxQueuedRuns: row.maxQueuedRuns,
		maxQueuedPerCase: row.maxQueuedPerCase,
		tokenBucketSize: row.tokenBucketSize,
		tokenBucketWindowSeconds: row.tokenBucketWindowSeconds,
		dailyBudgetUsd: row.dailyBudgetUsd,
		retention: {
			failedDays: row.retentionFailedDays,
			passedDays: row.retentionPassedDays,
		},
	};
};

// ---------------------------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------------------------

export const CLOUD_POOL_NAME = "cloud";

// The per-organisation cloud pool exists implicitly and is created on first use.
export const ensureCloudPool = async (
	db: BackendDb,
	orgId: string,
): Promise<RunnerPoolRow> => {
	const find = () =>
		db.query.runnerPools.findFirst({
			where: and(
				eq(runnerPools.orgId, orgId),
				eq(runnerPools.name, CLOUD_POOL_NAME),
			),
		});
	const existing = await find();
	if (existing) return existing;
	await db
		.insert(runnerPools)
		.values({ orgId, name: CLOUD_POOL_NAME, kind: "cloud" })
		.onConflictDoNothing();
	const created = await find();
	if (!created) throw new Error("Failed to create cloud runner pool");
	return created;
};

// Environment pool references: `cloud`, `self-hosted:<name or id>`, or a bare name or id.
export const resolvePoolReference = async (
	db: BackendDb,
	orgId: string,
	reference: string,
): Promise<RunnerPoolRow | null> => {
	const ref = reference.trim();
	if (ref === "" || ref === CLOUD_POOL_NAME) return ensureCloudPool(db, orgId);
	const target = ref.startsWith("self-hosted:")
		? ref.slice("self-hosted:".length)
		: ref;
	return (
		(await db.query.runnerPools.findFirst({
			where: and(
				eq(runnerPools.orgId, orgId),
				isNull(runnerPools.deletedAt),
				or(eq(runnerPools.id, target), eq(runnerPools.name, target)),
			),
		})) ?? null
	);
};

export const poolHasLiveWorker = async (
	db: BackendDb,
	poolId: string,
	now = Date.now(),
): Promise<boolean> => {
	const worker = await db.query.runnerWorkers.findFirst({
		where: and(
			eq(runnerWorkers.poolId, poolId),
			isNull(runnerWorkers.revokedAt),
			gt(runnerWorkers.lastHeartbeatAt, now - WORKER_LIVE_MS),
		),
		columns: { id: true },
	});
	return Boolean(worker);
};

export const poolConcurrency = async (
	db: BackendDb,
	pool: Pick<RunnerPoolRow, "orgId" | "kind" | "maxConcurrentRuns">,
): Promise<number> =>
	pool.kind === "cloud"
		? (await getRunSettings(db, pool.orgId)).maxConcurrentRuns
		: pool.maxConcurrentRuns;

// ---------------------------------------------------------------------------------------------
// Throttle: token bucket per user or token (design.md §10.3)
// ---------------------------------------------------------------------------------------------

export const consumeRunRequestToken = async (
	db: BackendDb,
	input: {
		orgId: string;
		bucketKey: string;
		settings: TestRunSettings;
		now?: number;
	},
): Promise<{ ok: true } | { ok: false; retryAfter: number }> => {
	const now = input.now ?? Date.now();
	const size = input.settings.tokenBucketSize;
	const refillPerMs = size / (input.settings.tokenBucketWindowSeconds * 1000);
	const row = await db.query.testRateBuckets.findFirst({
		where: and(
			eq(testRateBuckets.orgId, input.orgId),
			eq(testRateBuckets.bucketKey, input.bucketKey),
		),
	});
	const available = row
		? Math.min(
				size,
				row.tokens + Math.max(0, now - row.updatedAt) * refillPerMs,
			)
		: size;
	if (available < 1) {
		return {
			ok: false,
			retryAfter: Math.max(1, Math.ceil((1 - available) / refillPerMs / 1000)),
		};
	}
	await db
		.insert(testRateBuckets)
		.values({
			orgId: input.orgId,
			bucketKey: input.bucketKey,
			tokens: available - 1,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: [testRateBuckets.orgId, testRateBuckets.bucketKey],
			set: { tokens: available - 1, updatedAt: now },
		});
	return { ok: true };
};

// ---------------------------------------------------------------------------------------------
// Create, dedupe
// ---------------------------------------------------------------------------------------------

export type RunRequester = {
	userId: string;
	tokenId: string | null;
	kind: "session" | "ai" | "automation";
};

const sortedRecord = (value: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);

export const computeParamsHash = (params: Record<string, string>) =>
	`sha256:${sha256Text(JSON.stringify(sortedRecord(params)))}`;

export const computeDedupeKey = (input: {
	testCaseId: string;
	transcriptVersion: number;
	environmentId: string | null;
	paramsHash: string;
	cacheMode: string;
}) =>
	`sha256:${sha256Text(
		JSON.stringify([
			input.testCaseId,
			input.transcriptVersion,
			input.environmentId ?? "",
			input.paramsHash,
			input.cacheMode,
		]),
	)}`;

const defaultPriority = (trigger: CreateTestRunRequest["trigger"]) =>
	trigger === "manual" ? 30 : trigger === "mcp" ? 20 : 10;

const runnableStatuses = new Set<TestCaseRow["status"]>(["active", "draft"]);

type PlannedRun = {
	row: TestCaseRow;
	environmentId: string | null;
	params: Record<string, string>;
	request: CreateTestRunRequest;
};

type PlannedResult = { runId: string; attached: boolean };

const subscribe = async (
	db: BackendDb,
	runId: string,
	userId: string,
	trigger: string,
) => {
	await db
		.insert(testRunSubscribers)
		.values({ runId, userId, trigger })
		.onConflictDoNothing();
};

const findAttachableRun = async (
	db: BackendDb,
	input: {
		orgId: string;
		dedupeKey: string;
		force: boolean;
		windowSeconds: number;
		now: number;
	},
): Promise<TestRunRow | null> => {
	if (input.force) return null;
	const open = await db.query.testRuns.findFirst({
		where: and(
			eq(testRuns.orgId, input.orgId),
			eq(testRuns.dedupeKey, input.dedupeKey),
			inArray(testRuns.status, [...OPEN_RUN_STATUSES]),
		),
		orderBy: asc(testRuns.queuedAt),
	});
	if (open) return open;
	if (input.windowSeconds <= 0) return null;
	return (
		(await db.query.testRuns.findFirst({
			where: and(
				eq(testRuns.orgId, input.orgId),
				eq(testRuns.dedupeKey, input.dedupeKey),
				eq(testRuns.status, "completed"),
				gte(testRuns.finishedAt, input.now - input.windowSeconds * 1000),
			),
			orderBy: desc(testRuns.finishedAt),
		})) ?? null
	);
};

const queuedCount = async (
	db: BackendDb,
	where: ReturnType<typeof and>,
): Promise<number> => {
	const [row] = await db
		.select({ value: sql<number>`count(*)` })
		.from(testRuns)
		.where(where);
	return Number(row?.value ?? 0);
};

const resolveRunEnvironment = async (
	db: BackendDb,
	orgId: string,
	environmentId: string | null,
) => {
	if (!environmentId) return null;
	const environment = await db.query.testEnvironments.findFirst({
		where: and(
			eq(testEnvironments.id, environmentId),
			eq(testEnvironments.orgId, orgId),
			isNull(testEnvironments.deletedAt),
		),
	});
	if (!environment) {
		throw notFound(
			"TEST_ENVIRONMENT_NOT_FOUND",
			"Test environment not found in this organisation",
		);
	}
	return environment;
};

const insertRun = async (
	db: BackendDb,
	input: {
		orgId: string;
		requester: RunRequester;
		plan: PlannedRun;
		dedupeKey: string;
		paramsHash: string;
		batchId: string | null;
		now: number;
		retryOf?: TestRunRow;
	},
): Promise<TestRunRow> => {
	const { plan } = input;
	const environment = await resolveRunEnvironment(
		db,
		input.orgId,
		plan.environmentId,
	);
	const poolReference = environment?.runnerPool ?? CLOUD_POOL_NAME;
	const pool = await resolvePoolReference(db, input.orgId, poolReference);
	const live = pool ? await poolHasLiveWorker(db, pool.id, input.now) : false;
	const [run] = await db
		.insert(testRuns)
		.values({
			orgId: input.orgId,
			testCaseId: plan.row.id,
			createdBy: input.requester.userId,
			requestedByTokenId: input.requester.tokenId,
			transcriptVersion: plan.row.transcriptVersion,
			environmentId: plan.environmentId,
			paramsJson: JSON.stringify(plan.params),
			paramsHash: input.paramsHash,
			cacheMode: plan.request.cacheMode,
			dedupeKey: input.dedupeKey,
			trigger: plan.request.trigger,
			priority: plan.request.priority ?? defaultPriority(plan.request.trigger),
			runnerAffinity:
				pool?.kind === "self-hosted" ? `pool:${pool.id}` : "cloud",
			runnerPool:
				pool?.kind === "self-hosted"
					? `self-hosted:${pool.name}`
					: poolReference || CLOUD_POOL_NAME,
			runnerPoolId: pool?.id ?? null,
			status: "queued",
			blockedReason: live ? null : "NO_RUNNER",
			batchId: input.batchId,
			retryAttempt: input.retryOf ? input.retryOf.retryAttempt + 1 : 1,
			retryOfRunId: input.retryOf?.id ?? null,
			queuedAt: input.now,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.returning();
	if (!run) throw new Error("Failed to create test run");
	await subscribe(db, run.id, input.requester.userId, plan.request.trigger);
	return run;
};

const planRunsForCase = (
	row: TestCaseRow,
	request: CreateTestRunRequest,
): PlannedRun[] => {
	if (!runnableStatuses.has(row.status)) {
		throw new HttpError(
			409,
			"TEST_CASE_NOT_RUNNABLE",
			row.status === "review"
				? `${row.key} is waiting for review; approve it before running`
				: `${row.key} is ${row.status} and cannot run`,
		);
	}
	const environmentId =
		request.environmentId !== undefined
			? request.environmentId
			: row.environmentId;
	if (request.dataset) {
		const dataset = parseJsonColumn(
			row.datasetJson,
			z.object({ rows: z.array(z.record(z.string(), z.string())) }).nullable(),
			null,
		);
		if (dataset && dataset.rows.length > 0) {
			return dataset.rows.map((datasetRow) => ({
				row,
				environmentId,
				params: { ...datasetRow, ...request.params },
				request,
			}));
		}
	}
	return [{ row, environmentId, params: request.params, request }];
};

// Creates or attaches runs. One token-bucket token per request; queue caps only count runs
// that are actually created.
export const requestRuns = async (
	db: BackendDb,
	input: {
		orgId: string;
		requester: RunRequester;
		cases: ReadonlyArray<{ row: TestCaseRow; request: CreateTestRunRequest }>;
		batch?: {
			kind: "dataset" | "suite" | "ci";
			suiteId?: string | null;
			testCaseId?: string | null;
		};
		now?: number;
	},
): Promise<{
	results: PlannedResult[];
	batchId: string | null;
}> => {
	const now = input.now ?? Date.now();
	const settings = await getRunSettings(db, input.orgId);
	const bucket = await consumeRunRequestToken(db, {
		orgId: input.orgId,
		bucketKey:
			input.requester.tokenId !== null
				? `token:${input.requester.tokenId}`
				: `user:${input.requester.userId}`,
		settings,
		now,
	});
	if (!bucket.ok) {
		throw new HttpError(
			429,
			"RATE_LIMITED",
			`Too many run requests; retry in ${bucket.retryAfter} s`,
			{ retryAfter: bucket.retryAfter },
			{ "retry-after": String(bucket.retryAfter) },
		);
	}

	const plans = input.cases.flatMap(({ row, request }) =>
		planRunsForCase(row, request),
	);
	const resolved: Array<{
		plan: PlannedRun;
		dedupeKey: string;
		paramsHash: string;
		attachTo: TestRunRow | null;
	}> = [];
	const seenKeys = new Map<string, number>();
	for (const plan of plans) {
		const paramsHash = computeParamsHash(plan.params);
		const dedupeKey = computeDedupeKey({
			testCaseId: plan.row.id,
			transcriptVersion: plan.row.transcriptVersion,
			environmentId: plan.environmentId,
			paramsHash,
			cacheMode: plan.request.cacheMode,
		});
		const attachTo = await findAttachableRun(db, {
			orgId: input.orgId,
			dedupeKey,
			force: plan.request.force,
			windowSeconds: settings.dedupeWindowSeconds,
			now,
		});
		if (!attachTo && !plan.request.force && seenKeys.has(dedupeKey)) {
			// Two identical rows in one request (a dataset with duplicate rows) share a run.
			resolved.push({ plan, dedupeKey, paramsHash, attachTo: null });
			continue;
		}
		seenKeys.set(dedupeKey, resolved.length);
		resolved.push({ plan, dedupeKey, paramsHash, attachTo });
	}

	const toCreate = resolved.filter((entry) => !entry.attachTo);
	if (toCreate.length > 0) {
		const depth = await queuedCount(
			db,
			and(eq(testRuns.orgId, input.orgId), eq(testRuns.status, "queued")),
		);
		if (depth + toCreate.length > settings.maxQueuedRuns) {
			throw new HttpError(
				429,
				"QUEUE_FULL",
				`The organisation queue is full (${depth} of ${settings.maxQueuedRuns} queued)`,
				{ depth, maxQueuedRuns: settings.maxQueuedRuns },
			);
		}
		const perCase = new Map<string, Set<string>>();
		for (const entry of toCreate) {
			const keys = perCase.get(entry.plan.row.id) ?? new Set<string>();
			keys.add(entry.dedupeKey);
			perCase.set(entry.plan.row.id, keys);
		}
		for (const [caseId, keys] of perCase) {
			const queued = await queuedCount(
				db,
				and(eq(testRuns.testCaseId, caseId), eq(testRuns.status, "queued")),
			);
			if (queued + keys.size > settings.maxQueuedPerCase) {
				throw new HttpError(
					429,
					"QUEUE_FULL",
					`This test case already has ${queued} queued run(s) (limit ${settings.maxQueuedPerCase})`,
					{ depth: queued, maxQueuedPerCase: settings.maxQueuedPerCase },
				);
			}
		}
	}

	let batchId: string | null = null;
	const isBatch = Boolean(input.batch) || plans.length > 1;
	if (isBatch) {
		const kind = input.batch?.kind ?? "dataset";
		const [batch] = await db
			.insert(testRunBatches)
			.values({
				orgId: input.orgId,
				kind,
				testCaseId:
					input.batch?.testCaseId ??
					(kind === "dataset" ? (plans[0]?.row.id ?? null) : null),
				suiteId: input.batch?.suiteId ?? null,
				trigger: plans[0]?.request.trigger ?? "manual",
				status: "queued",
				total: plans.length,
				pending: plans.length,
				createdBy: input.requester.userId,
				createdAt: now,
				updatedAt: now,
			})
			.returning({ id: testRunBatches.id });
		batchId = batch?.id ?? null;
	}

	const results: PlannedResult[] = [];
	const createdByKey = new Map<string, string>();
	for (const entry of resolved) {
		if (entry.attachTo) {
			await subscribe(
				db,
				entry.attachTo.id,
				input.requester.userId,
				entry.plan.request.trigger,
			);
			results.push({ runId: entry.attachTo.id, attached: true });
			continue;
		}
		const sharedRunId = entry.plan.request.force
			? undefined
			: createdByKey.get(entry.dedupeKey);
		if (sharedRunId) {
			results.push({ runId: sharedRunId, attached: true });
			continue;
		}
		const run = await insertRun(db, {
			orgId: input.orgId,
			requester: input.requester,
			plan: entry.plan,
			dedupeKey: entry.dedupeKey,
			paramsHash: entry.paramsHash,
			batchId,
			now,
		});
		createdByKey.set(entry.dedupeKey, run.id);
		results.push({ runId: run.id, attached: false });
	}
	if (batchId) {
		await db
			.update(testRunBatches)
			.set({
				runIdsJson: JSON.stringify(results.map((result) => result.runId)),
			})
			.where(eq(testRunBatches.id, batchId));
		await refreshBatch(db, batchId);
	}
	return { results, batchId };
};

// A failed run with retries left is queued again as the next attempt (design.md §14 Retries).
export const queueRetryRun = async (
	db: BackendDb,
	run: TestRunRow,
	now = Date.now(),
): Promise<TestRunRow> => {
	const row = await db.query.testCases.findFirst({
		where: eq(testCases.id, run.testCaseId),
	});
	if (!row) throw new Error("Test case of the run disappeared");
	const [retry] = await db
		.insert(testRuns)
		.values({
			orgId: run.orgId,
			testCaseId: run.testCaseId,
			createdBy: run.createdBy,
			requestedByTokenId: run.requestedByTokenId,
			transcriptVersion: run.transcriptVersion,
			environmentId: run.environmentId,
			paramsJson: run.paramsJson,
			paramsHash: run.paramsHash,
			cacheMode: run.cacheMode,
			dedupeKey: run.dedupeKey,
			trigger: run.trigger,
			priority: run.priority,
			runnerAffinity: run.runnerAffinity,
			runnerPool: run.runnerPool,
			runnerPoolId: run.runnerPoolId,
			status: "queued",
			batchId: run.batchId,
			retryAttempt: run.retryAttempt + 1,
			retryOfRunId: run.id,
			queuedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!retry) throw new Error("Failed to queue retry run");
	const subscribers = await db.query.testRunSubscribers.findMany({
		where: eq(testRunSubscribers.runId, run.id),
	});
	for (const subscriber of subscribers) {
		await subscribe(db, retry.id, subscriber.userId, subscriber.trigger);
	}
	return retry;
};

// ---------------------------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------------------------

// Follows retry chains so a batch counts the last attempt of each member.
const finalAttempts = async (
	db: BackendDb,
	runIds: readonly string[],
): Promise<Map<string, TestRunRow>> => {
	const result = new Map<string, TestRunRow>();
	if (runIds.length === 0) return result;
	const rows = await db.query.testRuns.findMany({
		where: inArray(testRuns.id, [...runIds]),
	});
	for (const row of rows) result.set(row.id, row);
	let frontier = rows.map((row) => row.id);
	const latestByOrigin = new Map(runIds.map((id) => [id, id]));
	for (let depth = 0; depth < 10 && frontier.length > 0; depth += 1) {
		const retries = await db.query.testRuns.findMany({
			where: inArray(testRuns.retryOfRunId, frontier),
		});
		for (const retry of retries) {
			for (const [origin, latest] of latestByOrigin) {
				if (latest === retry.retryOfRunId) latestByOrigin.set(origin, retry.id);
			}
			result.set(retry.id, retry);
		}
		frontier = retries.map((retry) => retry.id);
	}
	const out = new Map<string, TestRunRow>();
	for (const [origin, latest] of latestByOrigin) {
		const row = result.get(latest);
		if (row) out.set(origin, row);
	}
	return out;
};

export const refreshBatch = async (
	db: BackendDb,
	batchId: string,
	now = Date.now(),
): Promise<{ finished: boolean; changed: boolean }> => {
	const batch = await db.query.testRunBatches.findFirst({
		where: eq(testRunBatches.id, batchId),
	});
	if (!batch) return { finished: false, changed: false };
	const runIds = parseJsonColumn(batch.runIdsJson, z.array(z.string()), []);
	const latest = await finalAttempts(db, [...new Set(runIds)]);
	const runs = runIds.flatMap((id) => {
		const row = latest.get(id);
		return row ? [row] : [];
	});
	const passed = runs.filter((run) => run.outcome === "passed").length;
	const failed = runs.filter((run) => run.outcome === "failed").length;
	const blocked = runs.filter((run) => run.outcome === "blocked").length;
	const cancelled = runs.filter(
		(run) => run.status === "cancelled" && run.outcome === null,
	).length;
	const pending = runs.length - passed - failed - blocked - cancelled;
	const status: typeof batch.status =
		pending > 0
			? runs.some((run) => run.status !== "queued")
				? "running"
				: "queued"
			: cancelled === runs.length && runs.length > 0
				? "cancelled"
				: failed + blocked > 0
					? "failed"
					: "completed";
	const finished = pending === 0;
	const changed = batch.status !== status || batch.pending !== pending;
	await db
		.update(testRunBatches)
		.set({
			total: runs.length,
			passed,
			failed,
			blocked,
			pending,
			status,
			finishedAt: finished ? (batch.finishedAt ?? now) : null,
			updatedAt: now,
		})
		.where(eq(testRunBatches.id, batchId));
	const justFinished = finished && batch.finishedAt === null;
	if (justFinished) {
		const subscribers = runs.length
			? await db.query.testRunSubscribers.findMany({
					where: inArray(
						testRunSubscribers.runId,
						runs.map((run) => run.id),
					),
					columns: { userId: true },
				})
			: [];
		await emitNotification(db, {
			orgId: batch.orgId,
			kind: "batch.finished",
			subjectType: "test_run_batch",
			subjectId: batch.id,
			recipients: [batch.createdBy, ...subscribers.map((row) => row.userId)],
			payload: {
				kind: batch.kind,
				suiteId: batch.suiteId,
				status,
				total: runs.length,
				passed,
				failed,
				blocked,
			},
		});
	}
	return { finished: justFinished, changed };
};

export const toBatch = async (
	db: BackendDb,
	batchId: string,
	orgId: string,
): Promise<TestRunBatch> => {
	await refreshBatch(db, batchId);
	const batch = await db.query.testRunBatches.findFirst({
		where: and(eq(testRunBatches.id, batchId), eq(testRunBatches.orgId, orgId)),
	});
	if (!batch) throw notFound("TEST_RUN_BATCH_NOT_FOUND", "Run batch not found");
	const runIds = parseJsonColumn(batch.runIdsJson, z.array(z.string()), []);
	const latest = await finalAttempts(db, [...new Set(runIds)]);
	return {
		id: batch.id,
		kind: batch.kind,
		testCaseId: batch.testCaseId,
		suiteId: batch.suiteId,
		trigger: batch.trigger,
		triggerRef: batch.triggerRef,
		status: batch.status,
		counts: {
			total: batch.total,
			passed: batch.passed,
			failed: batch.failed,
			blocked: batch.blocked,
			pending: batch.pending,
		},
		runIds: runIds.map((id) => latest.get(id)?.id ?? id),
		createdAt: batch.createdAt,
		finishedAt: batch.finishedAt,
	};
};

// ---------------------------------------------------------------------------------------------
// Summaries and details
// ---------------------------------------------------------------------------------------------

const median = (values: number[]): number | null => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? (sorted[middle] ?? null)
		: ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const DEFAULT_RUN_ESTIMATE_MS = 60_000;

const medianDurationByCase = async (
	db: BackendDb,
	caseIds: readonly string[],
): Promise<Map<string, number>> => {
	const out = new Map<string, number>();
	if (caseIds.length === 0) return out;
	const rows = await db.all<{ test_case_id: string; duration_ms: number }>(
		sql`select test_case_id, duration_ms from (
			select ${testRuns.testCaseId} as test_case_id, ${testRuns.durationMs} as duration_ms,
				row_number() over (partition by ${testRuns.testCaseId} order by ${testRuns.finishedAt} desc) as rn
			from ${testRuns}
			where ${inArray(testRuns.testCaseId, [...caseIds])} and ${testRuns.status} = 'completed' and ${testRuns.durationMs} is not null
		) where rn <= 10`,
	);
	const grouped = new Map<string, number[]>();
	for (const row of rows) {
		const list = grouped.get(row.test_case_id) ?? [];
		list.push(Number(row.duration_ms));
		grouped.set(row.test_case_id, list);
	}
	for (const [caseId, values] of grouped) {
		const value = median(values);
		if (value !== null) out.set(caseId, value);
	}
	return out;
};

// Queue position (0 = next), depth of the pool's queue, and estimated start: median duration of the last ten completed
// runs of each case ahead, spread over the pool's concurrency (design.md §10.1).
export const queuePlacement = async (
	db: BackendDb,
	run: TestRunRow,
	now = Date.now(),
): Promise<{
	position: number | null;
	depth: number | null;
	estimatedStartAt: number | null;
}> => {
	if (run.status !== "queued")
		return { position: null, depth: null, estimatedStartAt: null };
	const poolCondition = run.runnerPoolId
		? eq(testRuns.runnerPoolId, run.runnerPoolId)
		: and(
				eq(testRuns.orgId, run.orgId),
				isNull(testRuns.runnerPoolId),
				eq(testRuns.runnerPool, run.runnerPool),
			);
	const ahead = await db.query.testRuns.findMany({
		where: and(
			poolCondition,
			eq(testRuns.status, "queued"),
			or(
				gt(testRuns.priority, run.priority),
				and(
					eq(testRuns.priority, run.priority),
					or(
						lt(testRuns.queuedAt, run.queuedAt),
						and(eq(testRuns.queuedAt, run.queuedAt), lt(testRuns.id, run.id)),
					),
				),
			),
		),
		columns: { id: true, testCaseId: true },
		limit: 500,
	});
	const running = await db.query.testRuns.findMany({
		where: and(
			poolCondition,
			inArray(testRuns.status, [...ACTIVE_RUN_STATUSES]),
		),
		columns: { testCaseId: true, startedAt: true, claimedAt: true },
	});
	const medians = await medianDurationByCase(db, [
		...new Set([
			...ahead.map((entry) => entry.testCaseId),
			...running.map((entry) => entry.testCaseId),
		]),
	]);
	const estimate = (caseId: string) =>
		medians.get(caseId) ?? DEFAULT_RUN_ESTIMATE_MS;
	const pool = run.runnerPoolId
		? await db.query.runnerPools.findFirst({
				where: eq(runnerPools.id, run.runnerPoolId),
			})
		: null;
	const concurrency = pool ? await poolConcurrency(db, pool) : 1;
	const remainingRunning = running.reduce((total, entry) => {
		const started = entry.startedAt ?? entry.claimedAt ?? now;
		return total + Math.max(0, estimate(entry.testCaseId) - (now - started));
	}, 0);
	const queuedWork = ahead.reduce(
		(total, entry) => total + estimate(entry.testCaseId),
		0,
	);
	const freeSlots = Math.max(0, concurrency - running.length);
	const waitMs =
		ahead.length < freeSlots
			? 0
			: (remainingRunning + queuedWork) / Math.max(1, concurrency);
	const [depth] = await db
		.select({ value: sql<number>`count(*)` })
		.from(testRuns)
		.where(and(poolCondition, eq(testRuns.status, "queued")));
	return {
		position: ahead.length,
		depth: Number(depth?.value ?? 0),
		estimatedStartAt: Math.round(now + waitMs),
	};
};

const blockedReasonSchema = z
	.enum([
		"MISSING_VARIABLE",
		"MISSING_CREDENTIAL",
		"MODEL_UNAVAILABLE",
		"MODEL_KEY_MISSING",
		"APP_UNREACHABLE",
		"AUTH_CREDENTIAL_UNAVAILABLE",
		"STEP_BUDGET_EXHAUSTED",
		"REPLAY_STALE",
		"NO_RUNNER",
		"RUNNER_LOST",
		"BUDGET_EXCEEDED",
		"MACRO_ERROR",
		"TRANSCRIPT_INVALID",
		"ENGINE_ERROR",
		"CANCELLED",
		"INCONCLUSIVE",
	])
	.nullable()
	.catch(null);

export const toRunSummary = async (
	db: BackendDb,
	run: TestRunRow,
	context: {
		testCase?: Pick<TestCaseRow, "key" | "title"> | undefined;
		now?: number;
	} = {},
): Promise<TestRunSummary> => {
	const testCase =
		context.testCase ??
		(await db.query.testCases.findFirst({
			where: eq(testCases.id, run.testCaseId),
			columns: { key: true, title: true },
		}));
	const environment = run.environmentId
		? await db.query.testEnvironments.findFirst({
				where: eq(testEnvironments.id, run.environmentId),
				columns: { name: true },
			})
		: null;
	const subscribers = await db.query.testRunSubscribers.findMany({
		where: eq(testRunSubscribers.runId, run.id),
		orderBy: asc(testRunSubscribers.createdAt),
	});
	const placement = await queuePlacement(db, run, context.now);
	return {
		id: run.id,
		testCaseId: run.testCaseId,
		testCaseKey: testCase?.key ?? "",
		testCaseTitle: testCase?.title ?? "",
		transcriptVersion: run.transcriptVersion,
		environmentId: run.environmentId,
		environmentName: environment?.name ?? null,
		status: run.status,
		outcome: run.outcome,
		blockedReason: blockedReasonSchema.parse(run.blockedReason),
		flaky: run.flaky,
		trigger: run.trigger,
		runnerPool: run.runnerPool,
		createdBy: run.createdBy,
		createdByName: null,
		queuedAt: run.queuedAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		evidenceId: run.evidenceId,
		batchId: run.batchId,
		queuePosition: placement.position,
		queueDepth: placement.depth,
		estimatedStartAt: placement.estimatedStartAt,
		subscribers: subscribers.map((subscriber) => ({
			userId: subscriber.userId,
			name: null,
		})),
		metrics: {
			modelId: run.modelId,
			judgeModelId: run.judgeModelId,
			provider: run.provider,
			modelCalls: run.modelCalls,
			inputTokens: run.inputTokens,
			cachedInputTokens: run.cachedInputTokens,
			outputTokens: run.outputTokens,
			reasoningTokens: run.reasoningTokens,
			costUsd: run.costUsd,
			priceTableVersion: run.priceTableVersion,
			durationMs: run.durationMs,
			stepsTotal: run.stepsTotal,
			stepsReplayed: run.stepsReplayed,
			stepsAgent: run.stepsAgent,
			stepsHandoff: run.stepsHandoff,
		},
	};
};

export const runTranscriptVersion = async (
	db: BackendDb,
	run: Pick<TestRunRow, "testCaseId" | "transcriptVersion">,
) =>
	db.query.testCaseVersions.findFirst({
		where: and(
			eq(testCaseVersions.testCaseId, run.testCaseId),
			eq(testCaseVersions.version, run.transcriptVersion),
		),
	});

const stepStatusSchema = z.enum([
	"passed",
	"failed",
	"blocked",
	"skipped",
	"running",
	"pending",
]);
const stepModeSchema = z
	.enum(["agent", "replayed", "handoff", "deterministic"])
	.nullable()
	.catch(null);
const cacheReasonSchema = z
	.enum([
		"hit",
		"no-entry",
		"wrong-context",
		"target-not-found",
		"target-ambiguous",
		"end-mismatch",
		"action-failed",
		"cache-off",
		"not-cacheable",
	])
	.nullable()
	.catch(null);
const stepTypeSchema = z
	.enum([
		"open",
		"act",
		"assert",
		"login",
		"wait",
		"screenshot",
		"extract",
		"note",
		"macro",
	])
	.catch("act");

const readUrl = async (
	artifactStorage: ArtifactStorage,
	key: string,
	mimeType: string,
): Promise<string | null> => {
	try {
		return (
			await artifactStorage.createReadUrl({
				key,
				responseContentType: mimeType,
			})
		).url;
	} catch {
		return null;
	}
};

export const toRunDetail = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	run: TestRunRow,
	now = Date.now(),
	liveHub?: LiveHub,
): Promise<TestRunDetail> => {
	const summary = await toRunSummary(db, run, { now });
	const version = await runTranscriptVersion(db, run);
	const planned = parseJsonColumn(
		version?.stepsJson,
		z.array(transcriptStepSchema),
		[],
	);
	const rows = await db.query.testRunSteps.findMany({
		where: eq(testRunSteps.runId, run.id),
		orderBy: asc(testRunSteps.ordinal),
	});
	const artifactIds = rows.flatMap((row) =>
		row.screenshotArtifactId ? [row.screenshotArtifactId] : [],
	);
	const artifacts = artifactIds.length
		? await db.query.evidenceArtifacts.findMany({
				where: inArray(evidenceArtifacts.id, artifactIds),
				columns: { id: true, s3Key: true, mimeType: true },
			})
		: [];
	const artifactById = new Map(
		artifacts.map((artifact) => [artifact.id, artifact]),
	);
	const steps: TestRunStep[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		seen.add(row.stepId);
		const artifact = row.screenshotArtifactId
			? artifactById.get(row.screenshotArtifactId)
			: undefined;
		steps.push({
			stepId: row.stepId,
			parentStepId: row.parentStepId,
			ordinal: Math.max(1, row.ordinal),
			type: stepTypeSchema.parse(row.type),
			label: row.label,
			checkpointId: row.checkpointId,
			status: stepStatusSchema.catch("pending").parse(row.status),
			mode: stepModeSchema.parse(row.mode),
			cacheReason: cacheReasonSchema.parse(row.cacheReason),
			startedAt: row.startedAt,
			finishedAt: row.finishedAt,
			durationMs: row.durationMs,
			videoOffsetMs: row.videoOffsetMs,
			observed: row.observed,
			error:
				row.errorCode !== null
					? { code: row.errorCode, message: row.errorMessage ?? "" }
					: null,
			screenshotUrl: artifact
				? await readUrl(artifactStorage, artifact.s3Key, artifact.mimeType)
				: row.screenshotKey
					? await readUrl(
							artifactStorage,
							row.screenshotKey,
							row.screenshotMimeType ?? "image/png",
						)
					: null,
			usage: {
				modelId: row.modelId,
				modelCalls: row.modelCalls,
				inputTokens: row.inputTokens,
				cachedInputTokens: row.cachedInputTokens,
				outputTokens: row.outputTokens,
				reasoningTokens: row.reasoningTokens,
				costUsd: row.costUsd,
			},
		});
	}
	for (const step of planned) {
		if (seen.has(step.stepId) || step.disabled) continue;
		steps.push({
			stepId: step.stepId,
			parentStepId: null,
			ordinal: step.ordinal,
			type: step.type,
			label: step.text,
			checkpointId: step.checkpointId,
			status: "pending",
			mode: null,
			cacheReason: null,
			startedAt: null,
			finishedAt: null,
			durationMs: null,
			videoOffsetMs: null,
			observed: null,
			error: null,
			screenshotUrl: null,
			usage: {
				modelId: null,
				modelCalls: 0,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				costUsd: null,
			},
		});
	}
	steps.sort((a, b) => a.ordinal - b.ordinal);
	const runnerInfo = parseJsonColumn(
		run.runnerInfoJson,
		runnerInfoSchema.nullable(),
		null,
	);
	return {
		...summary,
		params: parseJsonColumn(
			run.paramsJson,
			z.record(z.string(), z.string()),
			{},
		),
		cacheMode: run.cacheMode,
		runnerInfo,
		error: run.error,
		steps,
		transcript: version?.transcript ?? "",
		currentStepId: run.currentStepId,
		live: await liveDetail(run, liveHub),
	};
};

// Live view while the run executes and its runner polls the live control (design.md §5.4).
const liveDetail = async (
	run: TestRunRow,
	liveHub: LiveHub | undefined,
): Promise<TestRunDetail["live"]> => {
	if (
		!run.liveAvailable ||
		!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)
	) {
		return null;
	}
	const snapshot = liveHub?.snapshot(run.id);
	const runnerViewport = parseJsonColumn(
		run.runnerInfoJson,
		runnerInfoSchema.nullable(),
		null,
	)?.viewport;
	const frameAt = snapshot?.frameAt ?? null;
	return {
		available: true,
		takeoverBy: run.liveTakeoverBy,
		paused: run.status === "paused" || run.livePaused,
		frameUrl:
			frameAt !== null
				? `/test-runs/${encodeURIComponent(run.id)}/live/frame?at=${frameAt}`
				: null,
		frameAt,
		viewport: snapshot?.viewport ?? runnerViewport ?? null,
	};
};

export const getRunRow = async (
	db: BackendDb,
	orgId: string,
	runId: string,
): Promise<TestRunRow> => {
	const run = await db.query.testRuns.findFirst({
		where: and(eq(testRuns.id, runId), eq(testRuns.orgId, orgId)),
	});
	if (!run) throw notFound("TEST_RUN_NOT_FOUND", "Test run not found");
	return run;
};

export const toCreateRunResponse = async (
	db: BackendDb,
	results: PlannedResult[],
	batchId: string | null,
): Promise<CreateTestRunResponse> => {
	const first = results[0];
	if (!first) throw new Error("No run was requested");
	const run = await db.query.testRuns.findFirst({
		where: eq(testRuns.id, first.runId),
	});
	if (!run) throw new Error("Requested run disappeared");
	const subscribers = await db.query.testRunSubscribers.findMany({
		where: eq(testRunSubscribers.runId, run.id),
		orderBy: asc(testRunSubscribers.createdAt),
	});
	const placement = await queuePlacement(db, run);
	return {
		runId: run.id,
		attached: first.attached,
		status: run.status,
		queuePosition: placement.position,
		queueDepth: placement.depth,
		requestedBy: subscribers.map((subscriber) => ({
			userId: subscriber.userId,
			name: null,
		})),
		batchId,
		runIds: results.map((result) => result.runId),
	};
};

// ---------------------------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------------------------

export const cancelRun = async (
	db: BackendDb,
	input: {
		run: TestRunRow;
		userId: string;
		canCancel: boolean;
		now?: number;
	},
): Promise<{
	cancelled: boolean;
	cancelRequested: boolean;
	unsubscribed: boolean;
}> => {
	const now = input.now ?? Date.now();
	const { run } = input;
	if (!input.canCancel) {
		const removed = await db
			.delete(testRunSubscribers)
			.where(
				and(
					eq(testRunSubscribers.runId, run.id),
					eq(testRunSubscribers.userId, input.userId),
				),
			)
			.returning({ userId: testRunSubscribers.userId });
		if (removed.length === 0) {
			throw new HttpError(
				403,
				"TEST_PERMISSION_DENIED",
				"Only the requester or someone with test_run.cancel_any can cancel this run",
				{ permission: "test_run.cancel_any" },
			);
		}
		return { cancelled: false, cancelRequested: false, unsubscribed: true };
	}
	if (run.status === "queued") {
		const updated = await db
			.update(testRuns)
			.set({
				status: "cancelled",
				blockedReason: null,
				cancelRequestedAt: now,
				cancelledBy: input.userId,
				finishedAt: now,
				updatedAt: now,
			})
			.where(and(eq(testRuns.id, run.id), eq(testRuns.status, "queued")))
			.returning({ id: testRuns.id });
		if (updated.length > 0) {
			await emitRunOutcome(db, {
				...run,
				status: "cancelled",
				cancelledBy: input.userId,
			});
			if (run.batchId) await refreshBatch(db, run.batchId, now);
			return { cancelled: true, cancelRequested: true, unsubscribed: false };
		}
	}
	if (
		(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status) ||
		run.status === "queued"
	) {
		// The runner sees the request in its next progress response and stops.
		await db
			.update(testRuns)
			.set({
				cancelRequestedAt: now,
				cancelledBy: input.userId,
				updatedAt: now,
			})
			.where(eq(testRuns.id, run.id));
		return { cancelled: false, cancelRequested: true, unsubscribed: false };
	}
	throw new HttpError(
		409,
		"TEST_RUN_FINISHED",
		`The run already finished with status ${run.status}`,
	);
};

// ---------------------------------------------------------------------------------------------
// Run token (runner side)
// ---------------------------------------------------------------------------------------------

export const issueRunToken = async (
	db: BackendDb,
	runId: string,
	expiresAt: number,
): Promise<string> => {
	const token = createOpaqueToken(RUN_TOKEN_PREFIX);
	await db
		.update(testRuns)
		.set({ runTokenHash: hashToken(token), runTokenExpiresAt: expiresAt })
		.where(eq(testRuns.id, runId));
	return token;
};

export const verifyRunToken = async (
	db: BackendDb,
	input: { runId: string; token: string | null; now?: number },
): Promise<TestRunRow> => {
	const now = input.now ?? Date.now();
	if (!input.token?.startsWith(RUN_TOKEN_PREFIX)) {
		throw new HttpError(401, "RUN_TOKEN_REQUIRED", "Run token required");
	}
	const run = await db.query.testRuns.findFirst({
		where: and(
			eq(testRuns.id, input.runId),
			eq(testRuns.runTokenHash, hashToken(input.token)),
		),
	});
	if (!run || (run.runTokenExpiresAt ?? 0) <= now) {
		throw new HttpError(
			401,
			"RUN_TOKEN_INVALID",
			"Invalid or expired run token",
		);
	}
	return run;
};

const extendLease = (now: number) => ({
	workerHeartbeatAt: now,
	workerLeaseExpiresAt: now + RUN_LEASE_MS,
	runTokenExpiresAt: now + RUN_LEASE_MS,
	updatedAt: now,
});

export const extendRunLease = async (
	db: BackendDb,
	runId: string,
	now = Date.now(),
): Promise<number> => {
	await db
		.update(testRuns)
		.set(extendLease(now))
		.where(
			and(
				eq(testRuns.id, runId),
				inArray(testRuns.status, [...ACTIVE_RUN_STATUSES]),
			),
		);
	return now + RUN_LEASE_MS;
};

const isoToMs = (value: string | null | undefined): number | null => {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
};

type StepPatch = TestRunProgressRequest["steps"][number];

export const upsertRunSteps = async (
	db: BackendDb,
	runId: string,
	steps: ReadonlyArray<
		StepPatch & { screenshotKey?: string; screenshotMimeType?: string }
	>,
	now = Date.now(),
): Promise<void> => {
	for (const step of steps) {
		const usage = step.usage;
		const values = {
			...(step.parentStepId !== undefined
				? { parentStepId: step.parentStepId }
				: {}),
			...(step.ordinal !== undefined ? { ordinal: step.ordinal } : {}),
			...(step.type !== undefined ? { type: step.type } : {}),
			...(step.label !== undefined ? { label: step.label } : {}),
			...(step.checkpointId !== undefined
				? { checkpointId: step.checkpointId }
				: {}),
			status: step.status,
			...(step.mode !== undefined ? { mode: step.mode } : {}),
			...(step.cacheReason !== undefined
				? { cacheReason: step.cacheReason }
				: {}),
			...(step.startedAt !== undefined
				? { startedAt: isoToMs(step.startedAt) }
				: {}),
			...(step.finishedAt !== undefined
				? { finishedAt: isoToMs(step.finishedAt) }
				: {}),
			...(step.durationMs !== undefined
				? {
						durationMs:
							step.durationMs === null ? null : Math.round(step.durationMs),
					}
				: {}),
			...(step.videoOffsetMs !== undefined
				? {
						videoOffsetMs:
							step.videoOffsetMs === null
								? null
								: Math.round(step.videoOffsetMs),
					}
				: {}),
			...(step.observed !== undefined ? { observed: step.observed } : {}),
			...(step.error !== undefined
				? {
						errorCode: step.error?.code ?? null,
						errorMessage: step.error?.message ?? null,
					}
				: {}),
			...(step.actions !== undefined ? { actions: step.actions } : {}),
			...(step.visionInput !== undefined
				? { visionInput: step.visionInput }
				: {}),
			...(usage
				? {
						modelId: usage.modelId,
						modelCalls: usage.modelCalls,
						inputTokens: usage.inputTokens,
						cachedInputTokens: usage.cachedInputTokens,
						outputTokens: usage.outputTokens,
						reasoningTokens: usage.reasoningTokens,
						costUsd: usage.costUsd,
					}
				: {}),
			...(step.screenshotKey
				? {
						screenshotKey: step.screenshotKey,
						screenshotMimeType: step.screenshotMimeType ?? "image/png",
					}
				: {}),
			updatedAt: now,
		};
		await db
			.insert(testRunSteps)
			.values({
				runId,
				stepId: step.stepId,
				ordinal: step.ordinal ?? 1,
				type: step.type ?? "act",
				label: step.label ?? "",
				...values,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: [testRunSteps.runId, testRunSteps.stepId],
				set: values,
			});
	}
};

export const recordProgress = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	run: TestRunRow,
	request: TestRunProgressRequest,
	now = Date.now(),
): Promise<{
	cancelRequested: boolean;
	leaseExpiresAt: number | null;
	takeoverRequested: boolean;
}> => {
	if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
		return {
			cancelRequested: run.status === "cancelled",
			leaseExpiresAt: null,
			takeoverRequested: false,
		};
	}
	let screenshotKey: string | undefined;
	let screenshotMimeType: string | undefined;
	if (request.screenshot) {
		const bytes = new Uint8Array(
			Buffer.from(request.screenshot.base64, "base64"),
		);
		const extension =
			request.screenshot.mimeType === "image/png" ? "png" : "jpg";
		screenshotKey = `test-runs/${run.orgId}/${run.id}/progress/${request.screenshot.stepId.replace(/[^\w-]/g, "_")}.${extension}`;
		screenshotMimeType = request.screenshot.mimeType;
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		await artifactStorage.putObject({
			key: screenshotKey,
			body: bytes,
			contentType: request.screenshot.mimeType,
			checksumSha256: Buffer.from(digest).toString("base64"),
		});
	}
	const steps = request.steps.map((step) =>
		screenshotKey && step.stepId === request.screenshot?.stepId
			? { ...step, screenshotKey, screenshotMimeType: screenshotMimeType ?? "" }
			: step,
	);
	if (
		screenshotKey &&
		request.screenshot &&
		!steps.some((step) => step.stepId === request.screenshot?.stepId)
	) {
		const existing = await db.query.testRunSteps.findFirst({
			where: and(
				eq(testRunSteps.runId, run.id),
				eq(testRunSteps.stepId, request.screenshot.stepId),
			),
		});
		await upsertRunSteps(
			db,
			run.id,
			[
				{
					stepId: request.screenshot.stepId,
					status: (existing?.status === "pending"
						? "running"
						: (existing?.status ?? "running")) as StepPatch["status"],
					screenshotKey,
					screenshotMimeType: screenshotMimeType ?? "image/png",
				},
			],
			now,
		);
	}
	await upsertRunSteps(db, run.id, steps, now);
	const status =
		request.status ?? (run.status === "claimed" ? "running" : run.status);
	await db
		.update(testRuns)
		.set({
			status,
			...(status === "running" && run.startedAt === null
				? { startedAt: now }
				: {}),
			...(request.currentStepId !== undefined
				? { currentStepId: request.currentStepId }
				: {}),
			...(request.runnerInfo
				? {
						runnerInfoJson: JSON.stringify(request.runnerInfo),
						runner: request.runnerInfo.host,
					}
				: {}),
			blockedReason: null,
			// The runner reports "paused" while a person holds the take-over.
			livePaused: status === "paused",
			...extendLease(now),
		})
		.where(eq(testRuns.id, run.id));
	return {
		cancelRequested: run.cancelRequestedAt !== null,
		leaseExpiresAt: now + RUN_LEASE_MS,
		takeoverRequested: run.takeoverRequestedAt !== null,
	};
};

// ---------------------------------------------------------------------------------------------
// Claim payload
// ---------------------------------------------------------------------------------------------

export const loadRunMacros = async (
	db: BackendDb,
	orgId: string,
): Promise<ClaimedRun["macros"]> => {
	const macros = await db.query.testMacros.findMany({
		where: and(
			eq(testMacros.orgId, orgId),
			isNull(testMacros.deletedAt),
			eq(testMacros.status, "active"),
		),
	});
	return macros.map((macro) => ({
		name: macro.name,
		version: macro.version,
		params: parseJsonColumn(
			macro.paramsJson,
			z.array(macroParamSchema),
			[] as MacroParam[],
		),
		transcript: macro.transcript,
	}));
};

export const buildClaimedRun = async (
	db: BackendDb,
	run: TestRunRow,
	runToken: string,
): Promise<ClaimedRun> => {
	const testCase = await db.query.testCases.findFirst({
		where: eq(testCases.id, run.testCaseId),
	});
	if (!testCase) throw new Error("Claimed run has no test case");
	const version = await runTranscriptVersion(db, run);
	const steps = version
		? parseJsonColumn(version.stepsJson, z.array(transcriptStepSchema), [])
		: caseSteps(testCase);
	return {
		runId: run.id,
		testCaseId: run.testCaseId,
		testCaseKey: testCase.key,
		transcript: version?.transcript ?? testCase.transcript,
		transcriptVersion: run.transcriptVersion,
		steps,
		macros: await loadRunMacros(db, run.orgId),
		environmentId: run.environmentId,
		params: parseJsonColumn(
			run.paramsJson,
			z.record(z.string(), z.string()),
			{},
		),
		cacheMode: run.cacheMode,
		leaseExpiresAt: run.workerLeaseExpiresAt ?? Date.now() + RUN_LEASE_MS,
		attempt: run.attempts + 1,
		runToken,
	};
};
