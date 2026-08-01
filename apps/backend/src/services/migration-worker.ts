import { and, eq, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";

import { organizationMigrationRuns } from "../db/schema";
import type { BackendDb } from "./user-provisioning";

export const MIGRATION_LEASE_MS = 30_000;
export const MIGRATION_HEARTBEAT_MS = 10_000;

export class MigrationWorkerError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly retryable = false,
	) {
		super(message);
		this.name = "MigrationWorkerError";
	}
}

class MigrationPaused extends Error {}

export type ClaimedMigrationRun = typeof organizationMigrationRuns.$inferSelect;

export type MigrationRunHandler = (
	run: ClaimedMigrationRun,
	controls: {
		checkpoint(stage?: ClaimedMigrationRun["stage"]): Promise<void>;
	},
) => Promise<"succeeded" | "waiting_peer">;

export type MigrationWorker = {
	runOnce(): Promise<boolean>;
	start(): () => void;
};

const retryDelayMs = (attempt: number): number =>
	Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));

export const createMigrationWorker = (input: {
	db: BackendDb;
	handler: MigrationRunHandler;
	workerId?: string;
	now?: () => number;
	pollMs?: number;
}): MigrationWorker => {
	const workerId = input.workerId ?? crypto.randomUUID();
	const now = input.now ?? Date.now;

	const claim = async (): Promise<ClaimedMigrationRun | null> => {
		const claimed = await input.db.transaction(async (tx) => {
			const currentTime = now();
			const candidate = await tx.query.organizationMigrationRuns.findFirst({
				where: and(
					or(
						inArray(organizationMigrationRuns.status, [
							"queued",
							"running",
							"pause_requested",
						]),
						and(
							eq(organizationMigrationRuns.status, "waiting_peer"),
							ne(organizationMigrationRuns.stage, "manifest"),
						),
					),
					or(
						isNull(organizationMigrationRuns.nextAttemptAt),
						lte(organizationMigrationRuns.nextAttemptAt, currentTime),
					),
					or(
						isNull(organizationMigrationRuns.workerLeaseExpiresAt),
						lt(organizationMigrationRuns.workerLeaseExpiresAt, currentTime),
					),
				),
				orderBy: (runs, { asc }) => [asc(runs.createdAt)],
			});
			if (!candidate) return null;

			const [run] = await tx
				.update(organizationMigrationRuns)
				.set({
					status:
						candidate.status === "pause_requested"
							? "pause_requested"
							: "running",
					workerLeaseOwner: workerId,
					workerLeaseExpiresAt: currentTime + MIGRATION_LEASE_MS,
					workerHeartbeatAt: currentTime,
					startedAt: candidate.startedAt ?? currentTime,
					attempts: candidate.attempts + 1,
					updatedAt: currentTime,
				})
				.where(
					and(
						eq(organizationMigrationRuns.id, candidate.id),
						or(
							isNull(organizationMigrationRuns.workerLeaseExpiresAt),
							lt(organizationMigrationRuns.workerLeaseExpiresAt, currentTime),
						),
					),
				)
				.returning();
			return run ?? null;
		});
		return claimed;
	};

	const checkpoint = async (
		runId: string,
		stage?: ClaimedMigrationRun["stage"],
	): Promise<void> => {
		const currentTime = now();
		const run = await input.db.query.organizationMigrationRuns.findFirst({
			where: eq(organizationMigrationRuns.id, runId),
			columns: { status: true, workerLeaseOwner: true },
		});
		if (!run || run.workerLeaseOwner !== workerId) {
			throw new MigrationWorkerError(
				"LEASE_LOST",
				"Migration worker lease was lost",
				true,
			);
		}
		if (run.status === "pause_requested") {
			await input.db
				.update(organizationMigrationRuns)
				.set({
					status: "paused",
					workerLeaseOwner: null,
					workerLeaseExpiresAt: null,
					workerHeartbeatAt: null,
					updatedAt: currentTime,
				})
				.where(eq(organizationMigrationRuns.id, runId));
			throw new MigrationPaused();
		}
		await input.db
			.update(organizationMigrationRuns)
			.set({
				...(stage ? { stage } : {}),
				workerHeartbeatAt: currentTime,
				workerLeaseExpiresAt: currentTime + MIGRATION_LEASE_MS,
				updatedAt: currentTime,
			})
			.where(
				and(
					eq(organizationMigrationRuns.id, runId),
					eq(organizationMigrationRuns.workerLeaseOwner, workerId),
				),
			);
	};

	const runOnce = async (): Promise<boolean> => {
		const run = await claim();
		if (!run) return false;
		const heartbeat = setInterval(() => {
			const currentTime = now();
			void input.db
				.update(organizationMigrationRuns)
				.set({
					workerHeartbeatAt: currentTime,
					workerLeaseExpiresAt: currentTime + MIGRATION_LEASE_MS,
					updatedAt: currentTime,
				})
				.where(
					and(
						eq(organizationMigrationRuns.id, run.id),
						eq(organizationMigrationRuns.workerLeaseOwner, workerId),
					),
				);
		}, MIGRATION_HEARTBEAT_MS);
		heartbeat.unref();
		try {
			const outcome = await input.handler(run, {
				checkpoint: (stage) => checkpoint(run.id, stage),
			});
			const completedAt = outcome === "succeeded" ? now() : null;
			await input.db
				.update(organizationMigrationRuns)
				.set({
					status: outcome,
					nextAttemptAt: outcome === "waiting_peer" ? now() + 1_000 : null,
					workerLeaseOwner: null,
					workerLeaseExpiresAt: null,
					workerHeartbeatAt: null,
					completedAt,
					updatedAt: now(),
				})
				.where(
					and(
						eq(organizationMigrationRuns.id, run.id),
						eq(organizationMigrationRuns.workerLeaseOwner, workerId),
					),
				);
		} catch (error) {
			if (error instanceof MigrationPaused) return true;
			const workerError =
				error instanceof MigrationWorkerError
					? error
					: new MigrationWorkerError(
							"MIGRATION_RUN_FAILED",
							error instanceof Error ? error.message : "Migration run failed",
							false,
						);
			const shouldRetry = workerError.retryable && run.attempts < 5;
			await input.db
				.update(organizationMigrationRuns)
				.set({
					status: shouldRetry ? "queued" : "failed",
					errorCode: workerError.code,
					errorMessage: workerError.message,
					nextAttemptAt: shouldRetry
						? now() + retryDelayMs(run.attempts)
						: null,
					workerLeaseOwner: null,
					workerLeaseExpiresAt: null,
					workerHeartbeatAt: null,
					updatedAt: now(),
				})
				.where(eq(organizationMigrationRuns.id, run.id));
		} finally {
			clearInterval(heartbeat);
		}
		return true;
	};

	return {
		runOnce,
		start: () => {
			let stopped = false;
			const loop = async () => {
				while (!stopped) {
					const worked = await runOnce().catch(() => false);
					await new Promise<void>((resolve) => {
						const timer = setTimeout(
							resolve,
							worked ? 0 : (input.pollMs ?? 1_000),
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
