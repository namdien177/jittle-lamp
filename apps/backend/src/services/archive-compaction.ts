import { createHash } from "node:crypto";
import {
	archiveCompactionVersion,
	compactSessionArchive,
	extensionArchiveSchemaVersion,
	runnerArchiveV4SchemaVersion,
	type SessionArchive,
	sessionArchiveSchema,
	toExtensionWireArchive,
} from "@jittle-lamp/shared";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Logger } from "pino";

import {
	evidenceArtifacts,
	evidences,
	organizationMigrationStates,
	organizationStorageTransfers,
} from "../db/schema";
import { withBusyRetry } from "./db-busy";
import { nullableEquals } from "./organization-storage";
import type { StorageRegistry } from "./storage-registry";
import { createTaskQueue } from "./task-queue";
import type { BackendDb } from "./user-provisioning";

// Archives recorded before the clean-up rules in shared/archive-compaction.ts (or by older
// clients) are compacted the first time someone opens the evidence: the next open downloads
// the smaller file. The object is rewritten under the same key, so copies sharing it benefit
// too; every row pointing at it gets the new size and checksum.

// Larger archives are left alone rather than held in memory twice.
const MAX_COMPACTION_BYTES = 64 * 1024 * 1024;

const TRANSFER_ACTIVE_STATUSES = [
	"queued",
	"running",
	"pause_requested",
	"paused",
] as const;

export type ArchiveCompactionResult =
	| { status: "compacted"; bytesBefore: number; bytesAfter: number }
	| { status: "skipped"; reason: string };

export type ArchiveCompactor = {
	// Queues the artifact unless it is already current or queued. Never throws.
	schedule(artifact: {
		id: string;
		kind: string;
		uploadStatus: string;
		compactionVersion: number | null;
	}): void;
	// Runs one compaction now; used by schedule() and tests.
	compact(artifactId: string): Promise<ArchiveCompactionResult>;
	// Resolves once every queued compaction finished (tests, shutdown).
	idle(): Promise<void>;
};

export const needsArchiveCompaction = (artifact: {
	kind: string;
	uploadStatus: string;
	compactionVersion: number | null;
}) =>
	artifact.kind === "network-log" &&
	artifact.uploadStatus === "uploaded" &&
	(artifact.compactionVersion ?? 0) < archiveCompactionVersion;

const sha256 = (body: Uint8Array) => createHash("sha256").update(body);

// Writes the archive back in the schema version it was stored with, so clients that only read
// that version keep working.
const serializeLikeOriginal = (
	archive: SessionArchive,
	originalVersion: unknown,
): string => {
	if (
		originalVersion === extensionArchiveSchemaVersion &&
		archive.recorder.kind === "browser-extension"
	) {
		return `${JSON.stringify(toExtensionWireArchive(archive))}\n`;
	}
	if (originalVersion === runnerArchiveV4SchemaVersion) {
		return `${JSON.stringify({ ...archive, schemaVersion: runnerArchiveV4SchemaVersion })}\n`;
	}
	return `${JSON.stringify(archive)}\n`;
};

export const createArchiveCompactor = (input: {
	db: BackendDb;
	storageRegistry: StorageRegistry;
	logger: Logger;
	now?: () => number;
}): ArchiveCompactor => {
	const { db, storageRegistry, logger } = input;
	const now = input.now ?? Date.now;
	// One at a time: each job holds a whole archive in memory and is not urgent.
	const queue = createTaskQueue(1);
	const queued = new Set<string>();
	const pending = new Set<Promise<unknown>>();

	type ArtifactRow = typeof evidenceArtifacts.$inferSelect;

	// Every row pointing at the same object with the same checksum: copies share objects. A row
	// re-uploaded meanwhile has another checksum and is left alone.
	const sameObjectRows = (artifact: ArtifactRow) =>
		and(
			eq(evidenceArtifacts.s3Key, artifact.s3Key),
			nullableEquals(evidenceArtifacts.storageId, artifact.storageId),
			eq(evidenceArtifacts.checksum, artifact.checksum),
		);

	const markCurrent = (artifact: ArtifactRow) =>
		withBusyRetry(() =>
			db
				.update(evidenceArtifacts)
				.set({ compactionVersion: archiveCompactionVersion })
				.where(sameObjectRows(artifact)),
		);

	// A migration or storage transfer copies objects and verifies their checksums; rewriting an
	// object underneath it would fail that check, so those organisations wait.
	const organizationIsMovingFiles = async (orgId: string) => {
		const [migration, transfer] = await Promise.all([
			db.query.organizationMigrationStates.findFirst({
				where: and(
					eq(organizationMigrationStates.organizationId, orgId),
					notInArray(organizationMigrationStates.accessState, [
						"writable",
						"diverged",
					]),
				),
				columns: { organizationId: true },
			}),
			db.query.organizationStorageTransfers.findFirst({
				where: and(
					eq(organizationStorageTransfers.orgId, orgId),
					inArray(organizationStorageTransfers.status, [
						...TRANSFER_ACTIVE_STATUSES,
					]),
				),
				columns: { id: true },
			}),
		]);
		return Boolean(migration || transfer);
	};

	const compact = async (
		artifactId: string,
	): Promise<ArchiveCompactionResult> => {
		const artifact = await db.query.evidenceArtifacts.findFirst({
			where: eq(evidenceArtifacts.id, artifactId),
		});
		if (!artifact || !needsArchiveCompaction(artifact)) {
			return { status: "skipped", reason: "already current" };
		}
		const evidence = await db.query.evidences.findFirst({
			where: eq(evidences.id, artifact.evidenceId),
			columns: { orgId: true },
		});
		if (!evidence) return { status: "skipped", reason: "evidence missing" };
		if (await organizationIsMovingFiles(evidence.orgId)) {
			return { status: "skipped", reason: "organisation is moving files" };
		}
		if (artifact.bytes > MAX_COMPACTION_BYTES) {
			await markCurrent(artifact);
			return { status: "skipped", reason: "archive too large" };
		}

		const storage = await storageRegistry.forArtifact(artifact);
		const original = await storage.getObject({ key: artifact.s3Key });
		let raw: unknown;
		let archive: SessionArchive;
		try {
			raw = JSON.parse(new TextDecoder().decode(original));
			archive = sessionArchiveSchema.parse(raw);
		} catch {
			// Not a session archive this version understands; do not try again on every open.
			await markCurrent(artifact);
			return { status: "skipped", reason: "not a session archive" };
		}

		const originalVersion =
			raw && typeof raw === "object"
				? (raw as { schemaVersion?: unknown }).schemaVersion
				: undefined;
		const body = new TextEncoder().encode(
			serializeLikeOriginal(compactSessionArchive(archive), originalVersion),
		);
		const digest = sha256(body).digest();

		// The rewrite only pays off when it is smaller; storage gzips it either way.
		if (body.byteLength < original.byteLength) {
			await storage.putObject({
				key: artifact.s3Key,
				body,
				contentType: artifact.mimeType,
				checksumSha256: digest.toString("base64"),
			});
		} else {
			// Same bytes, but rewriting still stores them compressed when they were not.
			await storage.putObject({
				key: artifact.s3Key,
				body: original,
				contentType: artifact.mimeType,
				checksumSha256: sha256(original).digest("base64"),
			});
			await markCurrent(artifact);
			return { status: "skipped", reason: "already compact" };
		}

		await withBusyRetry(() =>
			db
				.update(evidenceArtifacts)
				.set({
					bytes: body.byteLength,
					checksum: `sha256:${digest.toString("hex")}`,
					compactionVersion: archiveCompactionVersion,
					updatedAt: now(),
				})
				.where(sameObjectRows(artifact)),
		);
		return {
			status: "compacted",
			bytesBefore: original.byteLength,
			bytesAfter: body.byteLength,
		};
	};

	return {
		schedule: (artifact) => {
			if (!needsArchiveCompaction(artifact) || queued.has(artifact.id)) return;
			queued.add(artifact.id);
			const job = queue
				.run(() => compact(artifact.id))
				.then((result) => {
					logger.info(
						{ event: "archive.compaction", artifactId: artifact.id, ...result },
						"archive compaction finished",
					);
				})
				.catch((error: unknown) => {
					logger.warn(
						{
							event: "archive.compaction.failed",
							artifactId: artifact.id,
							error: error instanceof Error ? error.message : String(error),
						},
						"archive compaction failed",
					);
				})
				.finally(() => {
					queued.delete(artifact.id);
					pending.delete(job);
				});
			pending.add(job);
		},
		compact,
		idle: async () => {
			while (pending.size > 0) {
				await Promise.all([...pending]);
			}
		},
	};
};
