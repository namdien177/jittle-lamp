import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import { runnerPools, runnerWorkers, testRuns } from "../db/schema";
import {
	dispatchPendingNotifications,
	emitNotification,
	emitRunOutcome,
} from "./notifications";
import {
	ACTIVE_RUN_STATUSES,
	poolConcurrency,
	RUN_HEARTBEAT_MS,
	RUN_LEASE_MS,
	RUN_MAX_ATTEMPTS,
	type RunnerPoolRow,
	refreshBatch,
	type TestRunRow,
	WORKER_LIVE_MS,
} from "./test-runs";
import { createOpaqueToken, hashToken, RUN_TOKEN_PREFIX } from "./test-tokens";
import type { BackendDb } from "./user-provisioning";

// Runner claims (design.md §10.1): one atomic statement picks the first queued run of the pool
// by priority then queued_at, only while the pool runs fewer than its max_concurrent_runs, and
// takes a 30 s lease. Same lease pattern as migration-worker.ts.

const isBusyError = (error: unknown): boolean => {
	let current: unknown = error;
	for (let depth = 0; depth < 5 && current; depth += 1) {
		const text = String(
			(current as { code?: unknown }).code ?? (current as Error).message ?? "",
		);
		if (/SQLITE_BUSY|database is locked/i.test(text)) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
};

// Concurrent writers on separate connections can see SQLITE_BUSY; the statement is atomic, so
// retrying it is safe.
export const withBusyRetry = async <T>(
	operation: () => Promise<T>,
	attempts = 20,
): Promise<T> => {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (!isBusyError(error) || attempt >= attempts) throw error;
			await new Promise((resolve) =>
				setTimeout(resolve, 5 + Math.random() * 20 * attempt),
			);
		}
	}
};

export const claimNextRun = async (
	db: BackendDb,
	input: {
		pool: RunnerPoolRow;
		workerId: string;
		now?: number;
	},
): Promise<{ run: TestRunRow; runToken: string } | null> => {
	const now = input.now ?? Date.now();
	const concurrency = await poolConcurrency(db, input.pool);
	const runToken = createOpaqueToken(RUN_TOKEN_PREFIX);
	const leaseExpiresAt = now + RUN_LEASE_MS;
	const claimed = await withBusyRetry(() =>
		db.all<{ id: string }>(sql`
			update test_runs set
				status = 'claimed',
				worker_id = ${input.workerId},
				worker_lease_owner = ${input.workerId},
				worker_lease_expires_at = ${leaseExpiresAt},
				worker_heartbeat_at = ${now},
				claimed_at = ${now},
				run_token_hash = ${hashToken(runToken)},
				run_token_expires_at = ${leaseExpiresAt},
				blocked_reason = null,
				updated_at = ${now}
			where id = (
				select candidate.id from test_runs candidate
				where candidate.runner_pool_id = ${input.pool.id}
					and candidate.status = 'queued'
					and candidate.cancel_requested_at is null
					and (
						select count(*) from test_runs active
						where active.runner_pool_id = ${input.pool.id}
							and active.status in ('claimed', 'running', 'paused')
					) < ${concurrency}
				order by candidate.priority desc, candidate.queued_at asc, candidate.id asc
				limit 1
			)
			and status = 'queued'
			returning id`),
	);
	const id = claimed[0]?.id;
	if (!id) return null;
	await db
		.update(runnerWorkers)
		.set({ currentRunId: id, updatedAt: now })
		.where(eq(runnerWorkers.id, input.workerId));
	const run = await db.query.testRuns.findFirst({ where: eq(testRuns.id, id) });
	return run ? { run, runToken } : null;
};

// Releases the worker slot once the run finished or the lease moved on.
export const releaseWorkerRun = async (
	db: BackendDb,
	runId: string,
	now = Date.now(),
) => {
	await db
		.update(runnerWorkers)
		.set({ currentRunId: null, updatedAt: now })
		.where(eq(runnerWorkers.currentRunId, runId));
};

export const expiredLeaseCondition = (now: number) =>
	and(
		inArray(testRuns.status, [...ACTIVE_RUN_STATUSES]),
		lt(testRuns.workerLeaseExpiresAt, now),
	);

export const noLiveWorkerForPool = (now: number, liveMs: number) =>
	sql`not exists (select 1 from ${runnerWorkers} w where w.pool_id = ${testRuns.runnerPoolId} and w.revoked_at is null and w.last_heartbeat_at > ${now - liveMs})`;

export type QueueSweepResult = {
	requeued: string[];
	lost: TestRunRow[];
	cancelled: string[];
	offlineWorkers: Array<typeof runnerWorkers.$inferSelect>;
};

// Lease maintenance (design.md §10.1): an expired lease returns the run to the queue with
// attempts + 1; the third loss fails it as blocked RUNNER_LOST. A run whose cancel was requested
// is cancelled instead. Queued runs of pools without a live worker carry NO_RUNNER.
export const sweepRunQueue = async (
	db: BackendDb,
	now = Date.now(),
): Promise<QueueSweepResult> => {
	const result: QueueSweepResult = {
		requeued: [],
		lost: [],
		cancelled: [],
		offlineWorkers: [],
	};
	const expired = await db.query.testRuns.findMany({
		where: expiredLeaseCondition(now),
	});
	for (const run of expired) {
		const attempts = run.attempts + 1;
		const guard = and(
			eq(testRuns.id, run.id),
			eq(testRuns.status, run.status),
			eq(testRuns.workerLeaseExpiresAt, run.workerLeaseExpiresAt ?? 0),
		);
		const clearLease = {
			workerId: null,
			workerLeaseOwner: null,
			workerLeaseExpiresAt: null,
			workerHeartbeatAt: null,
			runTokenHash: null,
			runTokenExpiresAt: null,
			currentStepId: null,
			attempts,
			updatedAt: now,
		};
		if (run.cancelRequestedAt !== null) {
			const updated = await withBusyRetry(() =>
				db
					.update(testRuns)
					.set({ ...clearLease, status: "cancelled", finishedAt: now })
					.where(guard)
					.returning({ id: testRuns.id }),
			);
			if (updated.length > 0) result.cancelled.push(run.id);
		} else if (attempts >= RUN_MAX_ATTEMPTS) {
			const [updated] = await withBusyRetry(() =>
				db
					.update(testRuns)
					.set({
						...clearLease,
						status: "failed",
						outcome: "blocked",
						blockedReason: "RUNNER_LOST",
						error: `The runner stopped heartbeating ${attempts} times`,
						finishedAt: now,
					})
					.where(guard)
					.returning(),
			);
			if (updated) result.lost.push(updated);
		} else {
			const updated = await withBusyRetry(() =>
				db
					.update(testRuns)
					.set({ ...clearLease, status: "queued", claimedAt: null })
					.where(guard)
					.returning({ id: testRuns.id }),
			);
			if (updated.length > 0) result.requeued.push(run.id);
		}
		await releaseWorkerRun(db, run.id, now);
	}

	await withBusyRetry(() =>
		db
			.update(testRuns)
			.set({ blockedReason: "NO_RUNNER", updatedAt: now })
			.where(
				and(
					eq(testRuns.status, "queued"),
					isNull(testRuns.blockedReason),
					or(
						isNull(testRuns.runnerPoolId),
						noLiveWorkerForPool(now, WORKER_LIVE_MS),
					),
				),
			),
	);
	await withBusyRetry(() =>
		db
			.update(testRuns)
			.set({ blockedReason: null, updatedAt: now })
			.where(
				and(
					eq(testRuns.status, "queued"),
					eq(testRuns.blockedReason, "NO_RUNNER"),
					sql`${testRuns.runnerPoolId} is not null`,
					sql`not (${noLiveWorkerForPool(now, WORKER_LIVE_MS)})`,
				),
			),
	);

	// Workers that stopped heartbeating are reported once until they come back.
	result.offlineWorkers = await withBusyRetry(() =>
		db
			.update(runnerWorkers)
			.set({ offlineNotifiedAt: now, updatedAt: now })
			.where(
				and(
					isNull(runnerWorkers.revokedAt),
					isNull(runnerWorkers.offlineNotifiedAt),
					lt(runnerWorkers.lastHeartbeatAt, now - RUNNER_OFFLINE_MS),
				),
			)
			.returning(),
	);

	// Producers: lost and lease-cancelled runs, offline runners (design.md §10b).
	const finishedIds = [
		...result.lost.map((run) => run.id),
		...result.cancelled,
	];
	if (finishedIds.length > 0) {
		const finished = await db.query.testRuns.findMany({
			where: inArray(testRuns.id, finishedIds),
		});
		for (const run of finished) {
			await emitRunOutcome(db, run);
			if (run.batchId) await refreshBatch(db, run.batchId, now);
		}
	}
	for (const worker of result.offlineWorkers) {
		const pool = await db.query.runnerPools.findFirst({
			where: eq(runnerPools.id, worker.poolId),
			columns: { name: true, createdBy: true },
		});
		await emitNotification(db, {
			orgId: worker.orgId,
			kind: "runner.offline",
			subjectType: "runner_worker",
			subjectId: worker.id,
			recipients: [pool?.createdBy],
			payload: {
				poolId: worker.poolId,
				poolName: pool?.name ?? null,
				hostname: worker.hostname,
				lastHeartbeatAt: worker.lastHeartbeatAt,
			},
		});
	}
	await dispatchPendingNotifications(db, now).catch(() => 0);
	return result;
};

// Revoking a worker (design.md §10.1) ends its leases at once: the run tokens stop working and
// the runs it held go through the lost-lease path (requeued with attempts + 1, RUNNER_LOST on
// the last attempt) instead of waiting for a lease the revoked worker could keep extending.
export const revokeRunnerWorker = async (
	db: BackendDb,
	input: { poolId: string; workerId: string; now?: number },
): Promise<{ revoked: boolean; sweep: QueueSweepResult | null }> => {
	const now = input.now ?? Date.now();
	const revoked = await withBusyRetry(() =>
		db
			.update(runnerWorkers)
			.set({ revokedAt: now, currentRunId: null, updatedAt: now })
			.where(
				and(
					eq(runnerWorkers.id, input.workerId),
					eq(runnerWorkers.poolId, input.poolId),
				),
			)
			.returning({ id: runnerWorkers.id }),
	);
	if (revoked.length === 0) return { revoked: false, sweep: null };
	const held = await withBusyRetry(() =>
		db
			.update(testRuns)
			.set({
				runTokenHash: null,
				runTokenExpiresAt: null,
				workerLeaseExpiresAt: now - 1,
				updatedAt: now,
			})
			.where(
				and(
					eq(testRuns.workerLeaseOwner, input.workerId),
					inArray(testRuns.status, [...ACTIVE_RUN_STATUSES]),
				),
			)
			.returning({ id: testRuns.id }),
	);
	return {
		revoked: true,
		sweep: held.length > 0 ? await sweepRunQueue(db, now) : null,
	};
};

// A worker is reported offline after two missed lease windows.
export const RUNNER_OFFLINE_MS = 2 * RUN_LEASE_MS;

export type TestRunQueueWorker = {
	runOnce(): Promise<QueueSweepResult>;
	start(): () => void;
};

// Background loop next to the migration worker: sweeps leases every heartbeat interval.
export const createTestRunQueueWorker = (input: {
	db: BackendDb;
	onSweep?: (result: QueueSweepResult) => Promise<void>;
	intervalMs?: number;
	now?: () => number;
}): TestRunQueueWorker => {
	const now = input.now ?? Date.now;
	const runOnce = async () => {
		const result = await sweepRunQueue(input.db, now());
		await input.onSweep?.(result);
		return result;
	};
	return {
		runOnce,
		start: () => {
			let stopped = false;
			const loop = async () => {
				while (!stopped) {
					await runOnce().catch(() => undefined);
					await new Promise<void>((resolve) => {
						const timer = setTimeout(
							resolve,
							input.intervalMs ?? RUN_HEARTBEAT_MS,
						);
						timer.unref();
					});
				}
			};
			void loop();
			return () => {
				stopped = true;
			};
		},
	};
};
