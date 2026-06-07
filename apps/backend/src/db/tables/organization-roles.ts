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

export const organizationRoleKeySchema = z.enum([
	"admin",
	"moderator",
	"developer",
	"qa_engineer",
]);
export type OrganizationRoleKey = z.infer<typeof organizationRoleKeySchema>;

export const organizationPermissionValueSchema = z.enum([
	"evidence.view",
	"evidence.download",
	"evidence.comment",
	"evidence.create",
	"evidence.update.own",
	"evidence.delete.own",
	"evidence.move.own",
	"evidence.update.any",
	"evidence.delete.any",
	"evidence.move.any",
	"invitations.create",
	"invitations.disable",
	"join_requests.manage",
	"roles.manage",
	"members.assign_role",
	"members.kick",
	"activity.view",
]);
export type OrganizationPermission = z.infer<
	typeof organizationPermissionValueSchema
>;

export const organizationRoles = sqliteTable(
	"organization_roles",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		key: text("key").$type<OrganizationRoleKey>().notNull(),
		name: text("name").notNull(),
		permissionsJson: text("permissions_json").notNull(),
		isSystem: integer("is_system", { mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("organization_roles_org_key_unique").on(
			table.organizationId,
			table.key,
		),
		index("organization_roles_org_idx").on(table.organizationId),
		check(
			"organization_roles_key_check",
			sql`${table.key} in ('admin', 'moderator', 'developer', 'qa_engineer')`,
		),
	],
);

export const createOrganizationRoleInputSchema = z.object({
	organizationId: z.string().uuid(),
	key: organizationRoleKeySchema,
	name: z.string().trim().min(1).max(80),
	permissionsJson: z.string().min(2),
	isSystem: z.boolean().default(true),
});
