import { and, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";

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

export const DEFAULT_FAILED_RUN_RETENTION_DAYS = 180;
export const DEFAULT_PASSED_RUN_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention for test run evidence (design.md §14): passed runs keep their evidence 30 days,
 * failed, blocked and cancelled runs 180 days, per-organisation overrides in test_run_settings,
 * and the latest run of every case always keeps its evidence. Expired evidence moves to the bin;
 * purgeExpiredDeletedEvidences removes it after the bin retention like any other evidence.
 */
export const applyTestRunRetention = async (
	db: BackendDb,
	now = Date.now(),
): Promise<number> => {
	const candidates = await db.all<{ evidence_id: string; org_id: string }>(sql`
		select ranked.evidence_id as evidence_id, ranked.org_id as org_id
		from (
			select r.evidence_id, r.org_id, r.outcome, r.finished_at,
				row_number() over (partition by r.test_case_id order by r.finished_at desc) as rn
			from test_runs r
			join evidences e on e.id = r.evidence_id
			where r.evidence_id is not null
				and r.finished_at is not null
				and e.deleted_at is null
				and e.source_type = 'test-run'
		) ranked
		left join test_run_settings settings on settings.org_id = ranked.org_id
		where ranked.rn > 1
			and ranked.finished_at < ${now} - (
				case when ranked.outcome = 'passed'
					then coalesce(settings.retention_passed_days, ${DEFAULT_PASSED_RUN_RETENTION_DAYS})
					else coalesce(settings.retention_failed_days, ${DEFAULT_FAILED_RUN_RETENTION_DAYS})
				end
			) * ${DAY_MS}
	`);
	const paused = await retentionPausedOrganizationIds(db);
	const evidenceIds = [
		...new Set(
			candidates
				.filter((candidate) => !paused.has(candidate.org_id))
				.map((candidate) => candidate.evidence_id),
		),
	];
	if (evidenceIds.length === 0) return 0;
	await db
		.update(evidences)
		.set({
			deletedAt: now,
			deletedBy: null,
			deletePurgesAt: now + EVIDENCE_BIN_RETENTION_MS,
			updatedAt: now,
		})
		.where(
			and(inArray(evidences.id, evidenceIds), isNull(evidences.deletedAt)),
		);
	return evidenceIds.length;
};
