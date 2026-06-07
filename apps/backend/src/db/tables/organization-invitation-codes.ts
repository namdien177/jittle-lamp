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

export const organizationInvitationCodeRoleSchema = z.enum([
	"admin",
	"moderator",
	"developer",
	"qa_engineer",
]);
export type OrganizationInvitationCodeRole = z.infer<
	typeof organizationInvitationCodeRoleSchema
>;

export const organizationInvitationCodes = sqliteTable(
	"organization_invitation_codes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		role: text("role")
			.$type<OrganizationInvitationCodeRole>()
			.notNull()
			.default("developer"),
		codeHash: text("code_hash").notNull(),
		passwordHash: text("password_hash"),
		emailDomain: text("email_domain"),
		expiresAt: integer("expires_at"),
		guestExpiresAfterDays: integer("guest_expires_after_days"),
		lockedAt: integer("locked_at"),
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
		uniqueIndex("organization_invitation_codes_code_hash_unique").on(
			table.codeHash,
		),
		index("organization_invitation_codes_org_idx").on(table.organizationId),
		index("organization_invitation_codes_locked_idx").on(table.lockedAt),
		check(
			"organization_invitation_codes_role_check",
			sql`${table.role} in ('admin', 'moderator', 'developer', 'qa_engineer')`,
		),
		check(
			"organization_invitation_codes_guest_days_check",
			sql`${table.guestExpiresAfterDays} is null or ${table.guestExpiresAfterDays} > 0`,
		),
	],
);

export const createOrganizationInvitationCodeInputSchema = z.object({
	organizationId: z.string().uuid(),
	label: z.string().trim().min(1).max(80),
	role: organizationInvitationCodeRoleSchema.default("developer"),
	codeHash: z.string().min(32),
	passwordHash: z.string().min(32).nullable().optional(),
	emailDomain: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
		.nullable()
		.optional(),
	expiresAt: z.number().int().nullable().optional(),
	guestExpiresAfterDays: z.number().int().min(1).max(365).nullable().optional(),
	createdBy: z.string().uuid(),
});
