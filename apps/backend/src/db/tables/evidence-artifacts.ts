import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { evidences } from "./evidences";

export const evidenceArtifactKindSchema = z.enum([
	"recording",
	"transcript",
	"screenshot",
	"network-log",
	"attachment",
]);
export type EvidenceArtifactKind = z.infer<typeof evidenceArtifactKindSchema>;

export const evidenceArtifactUploadStatusSchema = z.enum([
	"pending",
	"uploading",
	"uploaded",
	"failed",
]);
export type EvidenceArtifactUploadStatus = z.infer<
	typeof evidenceArtifactUploadStatusSchema
>;

export const evidenceArtifacts = sqliteTable(
	"evidence_artifacts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		evidenceId: text("evidence_id")
			.notNull()
			.references(() => evidences.id, { onDelete: "cascade" }),
		kind: text("kind").$type<EvidenceArtifactKind>().notNull(),
		s3Key: text("s3_key").notNull(),
		// organization_storages.id holding the object; null = JittleLamp default storage. Set when
		// the row is created so the blob upload goes to the same storage even if the organisation
		// changes its write target meanwhile. No FK: storages are tombstoned, never removed.
		storageId: text("storage_id"),
		mimeType: text("mime_type").notNull(),
		bytes: integer("bytes").notNull(),
		checksum: text("checksum").notNull(),
		uploadStatus: text("upload_status")
			.$type<EvidenceArtifactUploadStatus>()
			.notNull()
			.default("pending"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("evidence_artifacts_evidence_id_idx").on(table.evidenceId),
		index("evidence_artifacts_kind_idx").on(table.kind),
		index("evidence_artifacts_storage_key_idx").on(
			table.storageId,
			table.s3Key,
		),
		index("evidence_artifacts_upload_status_idx").on(table.uploadStatus),
		index("evidence_artifacts_evidence_kind_idx").on(
			table.evidenceId,
			table.kind,
		),
		check(
			"evidence_artifacts_kind_check",
			sql`${table.kind}
            in ('recording', 'transcript', 'screenshot', 'network-log', 'attachment')`,
		),
		check(
			"evidence_artifacts_upload_status_check",
			sql`${table.uploadStatus}
            in ('pending', 'uploading', 'uploaded', 'failed')`,
		),
	],
);

export const createEvidenceArtifactInputSchema = z.object({
	evidenceId: z.string().uuid(),
	kind: evidenceArtifactKindSchema,
	s3Key: z.string().trim().min(1),
	mimeType: z.string().trim().min(1),
	bytes: z.number().int().nonnegative(),
	checksum: z.string().trim().min(1),
	uploadStatus: evidenceArtifactUploadStatusSchema.optional(),
});
