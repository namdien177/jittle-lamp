import { inArray, lt } from "drizzle-orm";

import { evidenceArtifacts, evidences } from "../db/schema";
import type { ArtifactStorage } from "./artifact-storage";
import type { BackendDb } from "./user-provisioning";

/**
 * How long a freshly created evidence may have zero successfully uploaded
 * artifacts before it is treated as an abandoned upload draft. Far longer than
 * the per-blob upload session TTL so slow or resumed uploads are never reaped.
 */
export const ABANDONED_UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;

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
		where: lt(evidences.createdAt, cutoff),
		columns: { id: true },
	});
	if (staleEvidences.length === 0) {
		return 0;
	}

	const staleEvidenceIds = staleEvidences.map((evidence) => evidence.id);
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
	if (orphanedKeys.length > 0) {
		await Promise.allSettled(
			orphanedKeys.map((key) => artifactStorage.deleteObject({ key })),
		);
	}

	return abandonedEvidenceIds.length;
};
