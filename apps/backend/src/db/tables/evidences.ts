import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

export const evidenceScopeTypeSchema = z.enum(["organization", "team"]);
export type EvidenceScopeType = z.infer<typeof evidenceScopeTypeSchema>;

export const evidences = sqliteTable(
	"evidences",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		title: text("title").notNull(),
		sourceType: text("source_type").notNull(),
		sourceUri: text("source_uri"),
		sourceExternalId: text("source_external_id"),
		sourceMetadata: text("source_metadata"),
		thumbnailBase64: text("thumbnail_base64"),
		thumbnailMimeType: text("thumbnail_mime_type"),
		teamId: text("team_id"),
		scopeType: text("scope_type")
			.$type<EvidenceScopeType>()
			.notNull()
			.default("organization"),
		scopeId: text("scope_id"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		deletedAt: integer("deleted_at"),
		deletedBy: text("deleted_by").references(() => users.id, {
			onDelete: "set null",
		}),
		deletePurgesAt: integer("delete_purges_at"),
	},
	(table) => [
		index("evidences_org_id_idx").on(table.orgId),
		index("evidences_created_by_idx").on(table.createdBy),
		index("evidences_org_created_at_idx").on(table.orgId, table.createdAt),
		index("evidences_org_deleted_at_idx").on(table.orgId, table.deletedAt),
		index("evidences_delete_purges_at_idx").on(table.deletePurgesAt),
		uniqueIndex("evidences_org_id_id_unique").on(table.orgId, table.id),
		index("evidences_source_lookup_idx").on(
			table.orgId,
			table.sourceType,
			table.sourceExternalId,
		),
		index("evidences_scope_lookup_idx").on(table.scopeType, table.scopeId),
		index("evidences_team_id_idx").on(table.teamId),
		index("evidences_updated_at_idx").on(table.updatedAt),
		check(
			"evidences_scope_type_check",
			sql`${table.scopeType} in ('organization', 'team')`,
		),
	],
);

export const createEvidenceInputSchema = z.object({
	orgId: z.string().uuid(),
	createdBy: z.string().uuid(),
	title: z.string().trim().min(1),
	sourceType: z.string().trim().min(1),
	sourceUri: z.string().url().optional(),
	sourceExternalId: z.string().trim().min(1).optional(),
	sourceMetadata: z.string().optional(),
	thumbnailBase64: z.string().max(20_000).optional(),
	thumbnailMimeType: z.string().trim().min(1).optional(),
	teamId: z.string().uuid().nullable().optional(),
	scopeType: evidenceScopeTypeSchema.default("organization"),
	scopeId: z.string().uuid().nullable().optional(),
});
