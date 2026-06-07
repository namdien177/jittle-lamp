import { sql } from "drizzle-orm";
import {
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

export const defaultOrganizationRoles = [
	"admin",
	"moderator",
	"developer",
	"qa_engineer",
] as const;
export const organizationRoleSchema = z.string().trim().min(1);
export type OrganizationRole = z.infer<typeof organizationRoleSchema>;

export const organizationMembers = sqliteTable(
	"organization_members",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		teamId: text("team_id"),
		role: text("role").$type<OrganizationRole>().notNull().default("developer"),
		guestExpiresAt: integer("guest_expires_at"),
		invitationCodeId: text("invitation_code_id"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("organization_members_org_user_org_scope_unique")
			.on(table.organizationId, table.userId)
			.where(sql`${table.teamId} is null`),
		uniqueIndex("organization_members_org_user_team_unique")
			.on(table.organizationId, table.userId, table.teamId)
			.where(sql`${table.teamId} is not null`),
		index("organization_members_user_id_idx").on(table.userId),
		index("organization_members_team_id_idx").on(table.teamId),
	],
);

export const createOrganizationMembershipInputSchema = z.object({
	organizationId: z.string().uuid(),
	userId: z.string().uuid(),
	teamId: z.string().uuid().nullable().optional(),
	role: organizationRoleSchema,
	guestExpiresAt: z.number().int().nullable().optional(),
	invitationCodeId: z.string().uuid().nullable().optional(),
});
