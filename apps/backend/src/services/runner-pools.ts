import type {
	RunnerPool,
	registerRunnerRequestSchema,
	runnerHeartbeatRequestSchema,
} from "@jittle-lamp/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod/v4";

import {
	runnerPools,
	runnerWorkers,
	testExplorations,
	testRuns,
} from "../db/schema";
import { conflict, HttpError, notFound } from "../http/test-http";
import {
	ACTIVE_RUN_STATUSES,
	CLOUD_POOL_NAME,
	ensureCloudPool,
	extendRunLease,
	RUN_HEARTBEAT_MS,
	RUN_LEASE_MS,
	type RunnerPoolRow,
	WORKER_LIVE_MS,
} from "./test-runs";
import {
	createOpaqueToken,
	hashToken,
	RUNNER_REGISTRATION_TOKEN_PREFIX,
	RUNNER_WORKER_TOKEN_PREFIX,
} from "./test-tokens";
import type { BackendDb } from "./user-provisioning";

// Runner pools and workers (design.md §5.4): a pool hands out a registration token once; a
// runner exchanges it for a worker token, then heartbeats and claims with that.

export type RunnerWorkerRow = typeof runnerWorkers.$inferSelect;

export const toRunnerPool = async (
	db: BackendDb,
	pool: RunnerPoolRow,
	now = Date.now(),
): Promise<RunnerPool> => {
	const workers = await db.query.runnerWorkers.findMany({
		where: and(
			eq(runnerWorkers.poolId, pool.id),
			isNull(runnerWorkers.revokedAt),
		),
		orderBy: asc(runnerWorkers.createdAt),
	});
	const counts = await db
		.select({ status: testRuns.status, runs: sql<number>`count(*)` })
		.from(testRuns)
		.where(
			and(
				eq(testRuns.runnerPoolId, pool.id),
				inArray(testRuns.status, ["queued", ...ACTIVE_RUN_STATUSES]),
			),
		)
		.groupBy(testRuns.status);
	const queued = counts
		.filter((row) => row.status === "queued")
		.reduce((total, row) => total + Number(row.runs), 0);
	const running = counts
		.filter((row) => row.status !== "queued")
		.reduce((total, row) => total + Number(row.runs), 0);
	return {
		id: pool.id,
		name: pool.name,
		kind: pool.kind,
		maxConcurrentRuns: pool.maxConcurrentRuns,
		workers: workers.map((worker) => ({
			id: worker.id,
			hostname: worker.hostname,
			version: worker.version,
			status:
				(worker.lastHeartbeatAt ?? 0) > now - WORKER_LIVE_MS
					? "online"
					: "offline",
			lastHeartbeatAt: worker.lastHeartbeatAt,
			currentRunId: worker.currentRunId,
		})),
		queued,
		running,
		createdAt: pool.createdAt,
	};
};

export const listRunnerPools = async (
	db: BackendDb,
	orgId: string,
): Promise<RunnerPool[]> => {
	await ensureCloudPool(db, orgId);
	const pools = await db.query.runnerPools.findMany({
		where: and(eq(runnerPools.orgId, orgId), isNull(runnerPools.deletedAt)),
		orderBy: asc(runnerPools.createdAt),
	});
	const out: RunnerPool[] = [];
	for (const pool of pools) out.push(await toRunnerPool(db, pool));
	return out;
};

export const getRunnerPoolRow = async (
	db: BackendDb,
	orgId: string,
	id: string,
): Promise<RunnerPoolRow> => {
	const pool = await db.query.runnerPools.findFirst({
		where: and(
			eq(runnerPools.orgId, orgId),
			eq(runnerPools.id, id),
			isNull(runnerPools.deletedAt),
		),
	});
	if (!pool) throw notFound("RUNNER_POOL_NOT_FOUND", "Runner pool not found");
	return pool;
};

// Queued runs and explorations whose environment named this pool before it existed now resolve
// to it.
const adoptPendingRuns = async (db: BackendDb, pool: RunnerPoolRow) => {
	await db
		.update(testRuns)
		.set({ runnerPoolId: pool.id, updatedAt: Date.now() })
		.where(
			and(
				eq(testRuns.orgId, pool.orgId),
				eq(testRuns.status, "queued"),
				isNull(testRuns.runnerPoolId),
				inArray(testRuns.runnerPool, [
					pool.name,
					pool.id,
					`self-hosted:${pool.name}`,
					`self-hosted:${pool.id}`,
				]),
			),
		);
	await db
		.update(testExplorations)
		.set({ runnerPoolId: pool.id, updatedAt: Date.now() })
		.where(
			and(
				eq(testExplorations.orgId, pool.orgId),
				eq(testExplorations.status, "queued"),
				isNull(testExplorations.runnerPoolId),
				inArray(testExplorations.runnerPool, [
					pool.name,
					pool.id,
					`self-hosted:${pool.name}`,
					`self-hosted:${pool.id}`,
				]),
			),
		);
};

export const createRunnerPool = async (
	db: BackendDb,
	input: {
		orgId: string;
		userId: string;
		name: string;
		maxConcurrentRuns: number;
	},
): Promise<{ pool: RunnerPoolRow; registrationToken: string }> => {
	if (input.name === CLOUD_POOL_NAME) {
		throw conflict(
			"RUNNER_POOL_RESERVED",
			"The cloud pool exists for every organisation; use its registration-token route",
		);
	}
	const registrationToken = createOpaqueToken(RUNNER_REGISTRATION_TOKEN_PREFIX);
	try {
		const [pool] = await db
			.insert(runnerPools)
			.values({
				orgId: input.orgId,
				name: input.name,
				kind: "self-hosted",
				maxConcurrentRuns: input.maxConcurrentRuns,
				registrationTokenHash: hashToken(registrationToken),
				createdBy: input.userId,
			})
			.returning();
		if (!pool) throw new Error("Failed to create runner pool");
		await adoptPendingRuns(db, pool);
		return { pool, registrationToken };
	} catch (error) {
		if (
			/UNIQUE constraint failed/i.test(
				String((error as { cause?: unknown }).cause ?? error),
			)
		) {
			throw conflict(
				"RUNNER_POOL_EXISTS",
				`A runner pool named ${input.name} already exists`,
			);
		}
		throw error;
	}
};

export const rotateRegistrationToken = async (
	db: BackendDb,
	pool: RunnerPoolRow,
): Promise<string> => {
	const registrationToken = createOpaqueToken(RUNNER_REGISTRATION_TOKEN_PREFIX);
	await db
		.update(runnerPools)
		.set({
			registrationTokenHash: hashToken(registrationToken),
			updatedAt: Date.now(),
		})
		.where(eq(runnerPools.id, pool.id));
	return registrationToken;
};

export const registerWorker = async (
	db: BackendDb,
	input: {
		registrationToken: string | null;
		request: z.output<typeof registerRunnerRequestSchema>;
	},
) => {
	if (!input.registrationToken?.startsWith(RUNNER_REGISTRATION_TOKEN_PREFIX)) {
		throw new HttpError(
			401,
			"RUNNER_REGISTRATION_TOKEN_REQUIRED",
			"Runner registration token required",
		);
	}
	const pool = await db.query.runnerPools.findFirst({
		where: and(
			eq(runnerPools.registrationTokenHash, hashToken(input.registrationToken)),
			isNull(runnerPools.deletedAt),
		),
	});
	if (!pool) {
		throw new HttpError(
			401,
			"RUNNER_REGISTRATION_TOKEN_INVALID",
			"Invalid runner registration token",
		);
	}
	const workerToken = createOpaqueToken(RUNNER_WORKER_TOKEN_PREFIX);
	const now = Date.now();
	const [worker] = await db
		.insert(runnerWorkers)
		.values({
			poolId: pool.id,
			orgId: pool.orgId,
			hostname: input.request.hostname,
			version: input.request.version,
			capabilitiesJson: JSON.stringify(input.request.capabilities),
			workerTokenHash: hashToken(workerToken),
			lastHeartbeatAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!worker) throw new Error("Failed to register runner");
	await clearNoRunner(db, pool.id, now);
	return {
		workerId: worker.id,
		poolId: pool.id,
		workerToken,
		heartbeatMs: RUN_HEARTBEAT_MS,
		leaseMs: RUN_LEASE_MS,
	};
};

export const verifyWorkerToken = async (
	db: BackendDb,
	token: string | null,
): Promise<{ worker: RunnerWorkerRow; pool: RunnerPoolRow }> => {
	if (!token?.startsWith(RUNNER_WORKER_TOKEN_PREFIX)) {
		throw new HttpError(
			401,
			"RUNNER_TOKEN_REQUIRED",
			"Runner worker token required",
		);
	}
	const worker = await db.query.runnerWorkers.findFirst({
		where: and(
			eq(runnerWorkers.workerTokenHash, hashToken(token)),
			isNull(runnerWorkers.revokedAt),
		),
	});
	const pool = worker
		? await db.query.runnerPools.findFirst({
				where: and(
					eq(runnerPools.id, worker.poolId),
					isNull(runnerPools.deletedAt),
				),
			})
		: null;
	if (!worker || !pool) {
		throw new HttpError(
			401,
			"RUNNER_TOKEN_INVALID",
			"Invalid or revoked runner worker token",
		);
	}
	return { worker, pool };
};

// A live worker lifts NO_RUNNER from the pool's queued runs.
export const clearNoRunner = async (
	db: BackendDb,
	poolId: string,
	now = Date.now(),
) => {
	await db
		.update(testRuns)
		.set({ blockedReason: null, updatedAt: now })
		.where(
			and(
				eq(testRuns.runnerPoolId, poolId),
				eq(testRuns.status, "queued"),
				eq(testRuns.blockedReason, "NO_RUNNER"),
			),
		);
};

// A claim proves the worker is alive but names no run, so it never extends a lease: leases move
// only with a heartbeat or progress call for that run.
export const touchWorker = async (
	db: BackendDb,
	worker: RunnerWorkerRow,
	now = Date.now(),
): Promise<void> => {
	await db
		.update(runnerWorkers)
		.set({ lastHeartbeatAt: now, offlineNotifiedAt: null, updatedAt: now })
		.where(eq(runnerWorkers.id, worker.id));
	await clearNoRunner(db, worker.poolId, now);
};

export const recordHeartbeat = async (
	db: BackendDb,
	input: {
		worker: RunnerWorkerRow;
		request: z.output<typeof runnerHeartbeatRequestSchema>;
		now?: number;
	},
): Promise<void> => {
	const now = input.now ?? Date.now();
	await db
		.update(runnerWorkers)
		.set({
			lastHeartbeatAt: now,
			load: input.request.load,
			currentRunId: input.request.runId,
			offlineNotifiedAt: null,
			updatedAt: now,
		})
		.where(eq(runnerWorkers.id, input.worker.id));
	await clearNoRunner(db, input.worker.poolId, now);
	if (input.request.runId) {
		const run = await db.query.testRuns.findFirst({
			where: and(
				eq(testRuns.id, input.request.runId),
				eq(testRuns.workerLeaseOwner, input.worker.id),
			),
			columns: { id: true },
		});
		if (run) await extendRunLease(db, run.id, now);
	}
};
