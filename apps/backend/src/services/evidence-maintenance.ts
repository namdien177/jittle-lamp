import { and, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import {
	evidenceArtifacts,
	evidences,
	organizationMigrationStates,
} from "../db/schema";
import type { ArtifactStorage } from "./artifact-storage";
import type { BackendDb } from "./user-provisioning";

/**
 * How long a freshly created evidence may have zero successfully uploaded
 * artifacts before it is treated as an abandoned upload draft. Far longer than
 * the per-blob upload session TTL so slow or resumed uploads are never reaped.
 */
export const ABANDONED_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
export const EVIDENCE_BIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_PAUSED_STATES = [
	"importing",
	"synced_read_only",
	"finalizing_read_only",
	"completed_source_read_only",
	"ready_to_activate",
] as const;

const retentionPausedOrganizationIds = async (db: BackendDb) =>
	new Set(
		(
			await db.query.organizationMigrationStates.findMany({
				where: inArray(organizationMigrationStates.accessState, [
					...RETENTION_PAUSED_STATES,
				]),
				columns: { organizationId: true },
			})
		).map((state) => state.organizationId),
	);

const deleteUnreferencedArtifactKeys = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	keys: string[],
): Promise<void> => {
	const uniqueKeys = Array.from(new Set(keys));
	if (uniqueKeys.length === 0) return;

	const referenced = await db.query.evidenceArtifacts.findMany({
		where: inArray(evidenceArtifacts.s3Key, uniqueKeys),
		columns: { s3Key: true },
	});
	const referencedKeys = new Set(referenced.map((artifact) => artifact.s3Key));
	const unreferencedKeys = uniqueKeys.filter((key) => !referencedKeys.has(key));
	if (unreferencedKeys.length === 0) return;

	await Promise.allSettled(
		unreferencedKeys.map((key) => artifactStorage.deleteObject({ key })),
	);
};

/**
 * Removes evidence rows (and their cascaded artifacts / desktop sessions /
 * share links) that were created via an upload start but never had any artifact
 * reach the "uploaded" state within the grace window. This keeps the catalog
 * free of orphaned draft uploads that would otherwise accumulate forever.
 */
export const cleanupAbandonedEvidenceUploads = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	now = Date.now(),
	graceMs = ABANDONED_UPLOAD_GRACE_MS,
): Promise<number> => {
	const cutoff = now - graceMs;

	const staleEvidences = await db.query.evidences.findMany({
		where: and(lt(evidences.createdAt, cutoff), isNull(evidences.deletedAt)),
		columns: { id: true, orgId: true },
	});
	const paused = await retentionPausedOrganizationIds(db);
	const eligibleEvidences = staleEvidences.filter(
		(evidence) => !paused.has(evidence.orgId),
	);
	if (eligibleEvidences.length === 0) {
		return 0;
	}

	const staleEvidenceIds = eligibleEvidences.map((evidence) => evidence.id);
	const artifacts = await db.query.evidenceArtifacts.findMany({
		where: inArray(evidenceArtifacts.evidenceId, staleEvidenceIds),
		columns: { evidenceId: true, s3Key: true, uploadStatus: true },
	});

	const hasUploadedByEvidence = new Map<string, boolean>();
	const keysByEvidence = new Map<string, string[]>();
	for (const artifact of artifacts) {
		if (artifact.uploadStatus === "uploaded") {
			hasUploadedByEvidence.set(artifact.evidenceId, true);
		}
		const keys = keysByEvidence.get(artifact.evidenceId) ?? [];
		keys.push(artifact.s3Key);
		keysByEvidence.set(artifact.evidenceId, keys);
	}

	const abandonedEvidenceIds = staleEvidenceIds.filter(
		(evidenceId) => !hasUploadedByEvidence.get(evidenceId),
	);
	if (abandonedEvidenceIds.length === 0) {
		return 0;
	}

	await db.delete(evidences).where(inArray(evidences.id, abandonedEvidenceIds));

	const orphanedKeys = abandonedEvidenceIds.flatMap(
		(evidenceId) => keysByEvidence.get(evidenceId) ?? [],
	);
	await deleteUnreferencedArtifactKeys(db, artifactStorage, orphanedKeys);

	return abandonedEvidenceIds.length;
};

export const purgeExpiredDeletedEvidences = async (
	db: BackendDb,
	artifactStorage: ArtifactStorage,
	now = Date.now(),
): Promise<number> => {
	const expired = await db.query.evidences.findMany({
		where: and(
			isNotNull(evidences.deletedAt),
			lt(evidences.deletePurgesAt, now),
		),
		columns: { id: true, orgId: true },
	});
	const paused = await retentionPausedOrganizationIds(db);
	const eligible = expired.filter((evidence) => !paused.has(evidence.orgId));
	if (eligible.length === 0) {
		return 0;
	}

	const evidenceIds = eligible.map((evidence) => evidence.id);
	const artifacts = await db.query.evidenceArtifacts.findMany({
		where: inArray(evidenceArtifacts.evidenceId, evidenceIds),
		columns: { s3Key: true },
	});

	await db.delete(evidences).where(inArray(evidences.id, evidenceIds));

	await deleteUnreferencedArtifactKeys(
		db,
		artifactStorage,
		artifacts.map((artifact) => artifact.s3Key),
	);

	return evidenceIds.length;
};
