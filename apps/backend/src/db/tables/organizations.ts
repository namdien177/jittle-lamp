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
import { users } from "./users";

export const organizations = sqliteTable(
	"organizations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		name: text("name").notNull(),
		isPersonal: integer("is_personal", { mode: "boolean" })
			.notNull()
			.default(true),
		personalOwnerUserId: text("personal_owner_user_id").references(
			() => users.id,
			{
				onDelete: "cascade",
			},
		),
		requireInvitationApproval: integer("require_invitation_approval", {
			mode: "boolean",
		})
			.notNull()
			.default(false),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("organizations_personal_owner_user_id_idx").on(
			table.personalOwnerUserId,
		),
		uniqueIndex("organizations_one_personal_org_per_user")
			.on(table.personalOwnerUserId)
			.where(sql`${table.personalOwnerUserId} is not null`),
		check(
			"organizations_personal_org_owner_required",
			sql`(${table.isPersonal} = 0 and ${table.personalOwnerUserId} is null) or (${table.isPersonal} = 1 and ${table.personalOwnerUserId} is not null)`,
		),
	],
);

export const createOrganizationInputSchema = z.object({
	name: z.string().trim().min(1),
	isPersonal: z.boolean(),
	personalOwnerUserId: z.string().uuid().nullable(),
	requireInvitationApproval: z.boolean().optional(),
});
