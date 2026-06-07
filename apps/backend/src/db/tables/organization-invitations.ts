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

export const organizationInvitationStatusSchema = z.enum([
	"pending",
	"accepted",
	"revoked",
	"expired",
]);
export type OrganizationInvitationStatus = z.infer<
	typeof organizationInvitationStatusSchema
>;

export const organizationInvitationRoleSchema = z.enum([
	"admin",
	"moderator",
	"developer",
	"qa_engineer",
]);
export type OrganizationInvitationRole = z.infer<
	typeof organizationInvitationRoleSchema
>;

export const organizationInvitations = sqliteTable(
	"organization_invitations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		role: text("role")
			.$type<OrganizationInvitationRole>()
			.notNull()
			.default("developer"),
		tokenHash: text("token_hash").notNull(),
		status: text("status")
			.$type<OrganizationInvitationStatus>()
			.notNull()
			.default("pending"),
		expiresAt: integer("expires_at").notNull(),
		invitedBy: text("invited_by")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		acceptedBy: text("accepted_by").references(() => users.id, {
			onDelete: "set null",
		}),
		acceptedAt: integer("accepted_at"),
		revokedAt: integer("revoked_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("organization_invitations_token_hash_unique").on(
			table.tokenHash,
		),
		index("organization_invitations_org_idx").on(table.organizationId),
		index("organization_invitations_email_idx").on(table.email),
		index("organization_invitations_status_idx").on(table.status),
		check(
			"organization_invitations_status_check",
			sql`${table.status} in ('pending', 'accepted', 'revoked', 'expired')`,
		),
		check(
			"organization_invitations_role_check",
			sql`${table.role} in ('admin', 'moderator', 'developer', 'qa_engineer')`,
		),
	],
);

export const createOrganizationInvitationInputSchema = z.object({
	organizationId: z.string().uuid(),
	email: z.string().trim().email(),
	role: organizationInvitationRoleSchema.default("developer"),
	tokenHash: z.string().min(32),
	expiresAt: z.number().int(),
	invitedBy: z.string().uuid(),
});
