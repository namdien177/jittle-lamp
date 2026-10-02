import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";

import { runnerWorkers, testRuns } from "../db/schema";
import {
	ACTIVE_RUN_STATUSES,
	poolConcurrency,
	RUN_LEASE_MS,
	type RunnerPoolRow,
	type TestRunRow,
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

export const queuedWithoutPool = () =>
	and(eq(testRuns.status, "queued"), isNull(testRuns.runnerPoolId));
