import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { evidences } from "./evidences";
import { organizations } from "./organizations";
import { users } from "./users";

export const PERMANENT_EXPIRY = 0;

export const shareLinkScopeTypeSchema = z.enum([
	"organization",
	"team",
	"public",
]);
export type ShareLinkScopeType = z.infer<typeof shareLinkScopeTypeSchema>;

export const shareLinks = sqliteTable(
	"share_links",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		slug: text("slug")
			.notNull()
			.$defaultFn(() => createUuidV7()),
		tokenHash: text("token_hash").notNull(),
		evidenceId: text("evidence_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		scopeType: text("scope_type")
			.$type<ShareLinkScopeType>()
			.notNull()
			.default("organization"),
		scopeId: text("scope_id"),
		teamId: text("team_id"),
		expiresAt: integer("expires_at").notNull(),
		revokedAt: integer("revoked_at"),
		createdBy: text("created_by")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("share_links_slug_unique").on(table.slug),
		uniqueIndex("share_links_token_hash_unique").on(table.tokenHash),
		index("share_links_org_id_idx").on(table.orgId),
		index("share_links_evidence_id_idx").on(table.evidenceId),
		index("share_links_lookup_idx").on(table.orgId, table.evidenceId),
		index("share_links_scope_lookup_idx").on(table.scopeType, table.scopeId),
		index("share_links_team_id_idx").on(table.teamId),
		index("share_links_expires_at_idx").on(table.expiresAt),
		check(
			"share_links_scope_type_check",
			sql`${table.scopeType} in ('organization', 'team', 'public')`,
		),
		foreignKey({
			columns: [table.orgId, table.evidenceId],
			foreignColumns: [evidences.orgId, evidences.id],
		}).onDelete("cascade"),
	],
);

export const createShareLinkInputSchema = z.object({
	slug: z.string().uuid().optional(),
	tokenHash: z.string().trim().min(32),
	evidenceId: z.string().uuid(),
	orgId: z.string().uuid(),
	scopeType: shareLinkScopeTypeSchema.default("organization"),
	scopeId: z.string().uuid().nullable().optional(),
	teamId: z.string().uuid().nullable().optional(),
	expiresAt: z.number().int(),
	revokedAt: z.number().int().nullable().optional(),
	createdBy: z.string().uuid(),
});
