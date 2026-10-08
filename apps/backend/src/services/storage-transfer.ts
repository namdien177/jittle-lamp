import { createHash } from "node:crypto";
import type { StorageTransfer } from "@jittle-lamp/shared";
import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lt,
	lte,
	or,
	sql,
} from "drizzle-orm";
import {
	evidenceArtifacts,
	evidences,
	organizationStorageTransfers,
} from "../db/schema";
import { withBusyRetry } from "./db-busy";
import { recordOrganizationActivity } from "./organization-activity";
import {
	ACTIVE_TRANSFER_STATUSES,
	nullableEquals,
	OrganizationStorageError,
	type OrganizationStorageService,
} from "./organization-storage";
import type { StorageRegistry } from "./storage-registry";
import type { BackendDb } from "./user-provisioning";

// Transfers every uploaded artifact of an organisation from one storage to another: copy, verify
// the sha256 the artifact was uploaded with, repoint the row, then delete the source object once
// no other row (another organisation's copy of the evidence) still references it. Artifacts that
// fail are counted and stay where they are; starting a new transfer retries them.

export const STORAGE_TRANSFER_LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 5;

type TransferRow = typeof organizationStorageTransfers.$inferSelect;

class TransferStopped extends Error {}

class TransferLeaseLost extends Error {}

const normalizeChecksum = (value: string) =>
	value.toLowerCase().replace(/^sha256:/, "");

export const publicStorageTransfer = (row: TransferRow): StorageTransfer => ({
	id: row.id,
	sourceStorageId: row.sourceStorageId,
	targetStorageId: row.targetStorageId,
	status: row.status,
	artifactsTotal: row.artifactsTotal,
	artifactsDone: row.artifactsDone,
	artifactsFailed: row.artifactsFailed,
	bytesTotal: row.bytesTotal,
	bytesDone: row.bytesDone,
	lastError: row.lastError,
	createdAt: row.createdAt,
	startedAt: row.startedAt,
	completedAt: row.completedAt,
});

export const createStorageTransfers = (input: {
	db: BackendDb;
	registry: StorageRegistry;
	storage: OrganizationStorageService;
	now?: () => number;
}) => {
	const { db, registry } = input;
	const now = input.now ?? Date.now;

	const pendingArtifacts = (orgId: string, sourceStorageId: string | null) =>
		and(
			eq(evidences.orgId, orgId),
			eq(evidenceArtifacts.uploadStatus, "uploaded"),
			nullableEquals(evidenceArtifacts.storageId, sourceStorageId),
		);

	const countPending = async (
		orgId: string,
		sourceStorageId: string | null,
	) => {
		const [row] = await db
			.select({
				artifacts: sql<number>`count(${evidenceArtifacts.id})`,
				bytes: sql<number>`coalesce(sum(${evidenceArtifacts.bytes}), 0)`,
			})
			.from(evidenceArtifacts)
			.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
			.where(pendingArtifacts(orgId, sourceStorageId));
		return {
			artifacts: Number(row?.artifacts ?? 0),
			bytes: Number(row?.bytes ?? 0),
		};
	};

	const getTransfer = async (orgId: string, transferId: string) => {
		const row = await db.query.organizationStorageTransfers.findFirst({
			where: and(
				eq(organizationStorageTransfers.id, transferId),
				eq(organizationStorageTransfers.orgId, orgId),
			),
		});
		if (!row) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_NOT_FOUND",
				"Transfer not found",
				404,
			);
		}
		return row;
	};

	const start = async (args: {
		orgId: string;
		actorUserId: string;
		sourceStorageId: string | null;
		targetStorageId: string;
		ipAddress?: string | null;
	}): Promise<StorageTransfer> => {
		if (args.sourceStorageId === args.targetStorageId) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_SAME_STORAGE",
				"Source and target must be different storages",
				400,
			);
		}
		const target = await input.storage.getActiveStorageRow(
			args.orgId,
			args.targetStorageId,
		);
		if (args.sourceStorageId) {
			await input.storage.getActiveStorageRow(args.orgId, args.sourceStorageId);
		}
		if (await input.storage.activeTransferFor(args.orgId)) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_ACTIVE",
				"Another transfer is still running for this organization",
				409,
			);
		}
		const pending = await countPending(args.orgId, args.sourceStorageId);
		if (pending.artifacts === 0) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_NOTHING_TO_MOVE",
				"There is nothing to transfer from this storage",
				409,
			);
		}
		const timestamp = now();
		const [row] = await db
			.insert(organizationStorageTransfers)
			.values({
				orgId: args.orgId,
				sourceStorageId: args.sourceStorageId,
				targetStorageId: target.id,
				status: "queued",
				artifactsTotal: pending.artifacts,
				bytesTotal: pending.bytes,
				createdBy: args.actorUserId,
				createdAt: timestamp,
				updatedAt: timestamp,
			})
			.returning();
		if (!row) throw new Error("Failed to create transfer");
		await recordOrganizationActivity(db, {
			organizationId: args.orgId,
			actorUserId: args.actorUserId,
			action: "organization.storage.transfer_started",
			entity: { type: "organization_storage_transfer", id: row.id },
			message: `Started transferring ${pending.artifacts} artifacts to ${target.name}`,
			metadata: {
				sourceStorageId: args.sourceStorageId,
				targetStorageId: target.id,
				bytes: pending.bytes,
			},
			ipAddress: args.ipAddress ?? null,
		});
		return publicStorageTransfer(row);
	};

	const control = async (args: {
		orgId: string;
		transferId: string;
		actorUserId: string;
		action: "pause" | "resume" | "cancel";
		ipAddress?: string | null;
	}): Promise<StorageTransfer> => {
		const row = await getTransfer(args.orgId, args.transferId);
		const timestamp = now();
		const transitions: Record<
			typeof args.action,
			{ from: TransferRow["status"][]; to: TransferRow["status"] }
		> = {
			pause: { from: ["queued", "running"], to: "pause_requested" },
			resume: { from: ["paused", "pause_requested"], to: "queued" },
			cancel: {
				from: ["queued", "running", "pause_requested", "paused"],
				to: "cancelled",
			},
		};
		const transition = transitions[args.action];
		if (!transition.from.includes(row.status)) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_INVALID_STATE",
				`Cannot ${args.action} a ${row.status.replace("_", " ")} transfer`,
				409,
			);
		}
		// A queued transfer has no worker yet: pause it directly.
		const nextStatus =
			args.action === "pause" && row.status === "queued"
				? "paused"
				: transition.to;
		const [updated] = await db
			.update(organizationStorageTransfers)
			.set({
				status: nextStatus,
				...(nextStatus === "cancelled" ? { completedAt: timestamp } : {}),
				...(args.action === "resume"
					? { nextAttemptAt: null, attempts: 0 }
					: {}),
				updatedAt: timestamp,
			})
			.where(
				and(
					eq(organizationStorageTransfers.id, row.id),
					eq(organizationStorageTransfers.status, row.status),
				),
			)
			.returning();
		if (!updated) {
			throw new OrganizationStorageError(
				"STORAGE_TRANSFER_INVALID_STATE",
				"The transfer changed meanwhile; reload and try again",
				409,
			);
		}
		await recordOrganizationActivity(db, {
			organizationId: args.orgId,
			actorUserId: args.actorUserId,
			action: `organization.storage.transfer_${args.action === "resume" ? "resumed" : args.action === "pause" ? "paused" : "cancelled"}`,
			entity: { type: "organization_storage_transfer", id: row.id },
			message: `${args.action === "resume" ? "Resumed" : args.action === "pause" ? "Paused" : "Cancelled"} a storage transfer`,
			ipAddress: args.ipAddress ?? null,
		});
		return publicStorageTransfer(updated);
	};

	// Moves one artifact. Returns false when it was skipped (changed meanwhile).
	const moveArtifact = async (
		run: TransferRow,
		artifact: {
			id: string;
			s3Key: string;
			mimeType: string;
			checksum: string;
		},
	): Promise<boolean> => {
		const source = await registry.forArtifact({
			storageId: run.sourceStorageId,
		});
		const target = await registry.forArtifact({
			storageId: run.targetStorageId,
		});
		const body = await source.getObject({ key: artifact.s3Key });
		const digest = createHash("sha256").update(body).digest();
		if (digest.toString("hex") !== normalizeChecksum(artifact.checksum)) {
			throw new Error(
				`checksum mismatch for artifact ${artifact.id}; the source object does not match what was uploaded`,
			);
		}
		await target.putObject({
			key: artifact.s3Key,
			body,
			contentType: artifact.mimeType,
			checksumSha256: digest.toString("base64"),
		});
		const repointed = await withBusyRetry(() =>
			db
				.update(evidenceArtifacts)
				.set({ storageId: run.targetStorageId, updatedAt: now() })
				.where(
					and(
						eq(evidenceArtifacts.id, artifact.id),
						nullableEquals(evidenceArtifacts.storageId, run.sourceStorageId),
					),
				)
				.returning({ id: evidenceArtifacts.id }),
		);
		if (repointed.length === 0) return false;
		const stillReferenced = await db.query.evidenceArtifacts.findFirst({
			where: and(
				eq(evidenceArtifacts.s3Key, artifact.s3Key),
				nullableEquals(evidenceArtifacts.storageId, run.sourceStorageId),
			),
			columns: { id: true },
		});
		if (!stillReferenced) {
			// The copy is verified and the row repointed; a failed delete only leaves an orphan.
			await source.deleteObject({ key: artifact.s3Key }).catch(() => undefined);
		}
		return true;
	};

	const process = async (
		run: TransferRow,
		checkpoint: () => Promise<void>,
	): Promise<void> => {
		// Fail fast with a clear error when either storage is unusable.
		await registry.forArtifact({ storageId: run.sourceStorageId });
		await registry.forArtifact({ storageId: run.targetStorageId });
		let cursor = run.cursor;
		for (;;) {
			await checkpoint();
			const batch = await db
				.select({
					id: evidenceArtifacts.id,
					s3Key: evidenceArtifacts.s3Key,
					mimeType: evidenceArtifacts.mimeType,
					checksum: evidenceArtifacts.checksum,
					bytes: evidenceArtifacts.bytes,
				})
				.from(evidenceArtifacts)
				.innerJoin(evidences, eq(evidences.id, evidenceArtifacts.evidenceId))
				.where(
					and(
						pendingArtifacts(run.orgId, run.sourceStorageId),
						cursor ? gt(evidenceArtifacts.id, cursor) : undefined,
					),
				)
				.orderBy(asc(evidenceArtifacts.id))
				.limit(BATCH_SIZE);
			if (batch.length === 0) return;
			for (const artifact of batch) {
				let done = 0;
				let failed = 0;
				let bytes = 0;
				let lastError: string | null = null;
				try {
					if (await moveArtifact(run, artifact)) {
						done = 1;
						bytes = artifact.bytes;
					}
				} catch (error) {
					failed = 1;
					lastError = error instanceof Error ? error.message : String(error);
				}
				cursor = artifact.id;
				const nextCursor = cursor;
				await withBusyRetry(() =>
					db
						.update(organizationStorageTransfers)
						.set({
							cursor: nextCursor,
							artifactsDone: sql`${organizationStorageTransfers.artifactsDone} + ${done}`,
							artifactsFailed: sql`${organizationStorageTransfers.artifactsFailed} + ${failed}`,
							bytesDone: sql`${organizationStorageTransfers.bytesDone} + ${bytes}`,
							...(lastError ? { lastError } : {}),
							updatedAt: now(),
						})
						.where(eq(organizationStorageTransfers.id, run.id)),
				);
			}
		}
	};

	return {
		start,
		control,
		get: async (orgId: string, transferId: string) =>
			publicStorageTransfer(await getTransfer(orgId, transferId)),
		list: async (orgId: string) =>
			(
				await db.query.organizationStorageTransfers.findMany({
					where: eq(organizationStorageTransfers.orgId, orgId),
					orderBy: desc(organizationStorageTransfers.createdAt),
					limit: 20,
				})
			).map(publicStorageTransfer),
		process,
	};
};

export type StorageTransfers = ReturnType<typeof createStorageTransfers>;

// Leased worker, same shape as services/migration-worker.ts: one transfer at a time per worker,
// a 30s lease extended every 10s, retryable failures back off and give up after 5 attempts.
export const createStorageTransferWorker = (input: {
	db: BackendDb;
	transfers: Pick<StorageTransfers, "process">;
	workerId?: string;
	now?: () => number;
	pollMs?: number;
	onError?: (error: unknown, transferId: string) => void;
}) => {
	const { db } = input;
	const workerId = input.workerId ?? crypto.randomUUID();
	const now = input.now ?? Date.now;

	const leaseFree = (currentTime: number) =>
		or(
			isNull(organizationStorageTransfers.workerLeaseExpiresAt),
			lt(organizationStorageTransfers.workerLeaseExpiresAt, currentTime),
		);

	const claimable = (currentTime: number) =>
		and(
			inArray(organizationStorageTransfers.status, [
				"queued",
				"running",
				"pause_requested",
			]),
			or(
				isNull(organizationStorageTransfers.nextAttemptAt),
				lte(organizationStorageTransfers.nextAttemptAt, currentTime),
			),
			leaseFree(currentTime),
		);

	const claim = async (): Promise<TransferRow | null> => {
		// Transfers are rare: an idle poll is one indexed read, without a write transaction.
		const pending = await db.query.organizationStorageTransfers.findFirst({
			where: claimable(now()),
			columns: { id: true },
		});
		if (!pending) return null;
		return db.transaction(async (tx) => {
			const currentTime = now();
			const candidate = await tx.query.organizationStorageTransfers.findFirst({
				where: claimable(currentTime),
				orderBy: asc(organizationStorageTransfers.createdAt),
			});
			if (!candidate) return null;
			const [run] = await tx
				.update(organizationStorageTransfers)
				.set({
					status:
						candidate.status === "pause_requested"
							? "pause_requested"
							: "running",
					workerLeaseOwner: workerId,
					workerLeaseExpiresAt: currentTime + STORAGE_TRANSFER_LEASE_MS,
					startedAt: candidate.startedAt ?? currentTime,
					attempts: candidate.attempts + 1,
					updatedAt: currentTime,
				})
				.where(
					and(
						eq(organizationStorageTransfers.id, candidate.id),
						leaseFree(currentTime),
					),
				)
				.returning();
			return run ?? null;
		});
	};

	const releaseLease = {
		workerLeaseOwner: null,
		workerLeaseExpiresAt: null,
	};

	const checkpoint = async (transferId: string) => {
		const currentTime = now();
		const row = await db.query.organizationStorageTransfers.findFirst({
			where: eq(organizationStorageTransfers.id, transferId),
			columns: { status: true, workerLeaseOwner: true },
		});
		if (!row || row.workerLeaseOwner !== workerId)
			throw new TransferLeaseLost();
		if (row.status === "pause_requested") {
			await db
				.update(organizationStorageTransfers)
				.set({ status: "paused", ...releaseLease, updatedAt: currentTime })
				.where(eq(organizationStorageTransfers.id, transferId));
			throw new TransferStopped();
		}
		if (row.status === "cancelled") {
			await db
				.update(organizationStorageTransfers)
				.set({ ...releaseLease, updatedAt: currentTime })
				.where(eq(organizationStorageTransfers.id, transferId));
			throw new TransferStopped();
		}
		await db
			.update(organizationStorageTransfers)
			.set({
				workerLeaseExpiresAt: currentTime + STORAGE_TRANSFER_LEASE_MS,
				updatedAt: currentTime,
			})
			.where(
				and(
					eq(organizationStorageTransfers.id, transferId),
					eq(organizationStorageTransfers.workerLeaseOwner, workerId),
				),
			);
	};

	const runOnce = async (): Promise<boolean> => {
		const run = await claim();
		if (!run) return false;
		const heartbeat = setInterval(() => {
			const currentTime = now();
			void db
				.update(organizationStorageTransfers)
				.set({
					workerLeaseExpiresAt: currentTime + STORAGE_TRANSFER_LEASE_MS,
					updatedAt: currentTime,
				})
				.where(
					and(
						eq(organizationStorageTransfers.id, run.id),
						eq(organizationStorageTransfers.workerLeaseOwner, workerId),
					),
				);
		}, HEARTBEAT_MS);
		heartbeat.unref();
		const ownedAndActive = and(
			eq(organizationStorageTransfers.id, run.id),
			eq(organizationStorageTransfers.workerLeaseOwner, workerId),
			inArray(organizationStorageTransfers.status, [
				...ACTIVE_TRANSFER_STATUSES,
			]),
		);
		try {
			await input.transfers.process(run, () => checkpoint(run.id));
			await db
				.update(organizationStorageTransfers)
				.set({
					status: "completed",
					...releaseLease,
					nextAttemptAt: null,
					completedAt: now(),
					updatedAt: now(),
				})
				.where(ownedAndActive);
		} catch (error) {
			if (
				error instanceof TransferStopped ||
				error instanceof TransferLeaseLost
			) {
				return true;
			}
			input.onError?.(error, run.id);
			const shouldRetry = run.attempts < MAX_ATTEMPTS;
			await db
				.update(organizationStorageTransfers)
				.set({
					status: shouldRetry ? "queued" : "failed",
					lastError: error instanceof Error ? error.message : String(error),
					nextAttemptAt: shouldRetry
						? now() +
							Math.min(60_000, 1_000 * 2 ** Math.max(0, run.attempts - 1))
						: null,
					...(shouldRetry ? {} : { completedAt: now() }),
					...releaseLease,
					updatedAt: now(),
				})
				.where(ownedAndActive);
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
							worked ? 0 : (input.pollMs ?? 2_000),
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
