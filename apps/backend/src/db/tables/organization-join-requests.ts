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
import { organizationInvitationCodes } from "./organization-invitation-codes";
import { organizations } from "./organizations";
import { users } from "./users";

export const organizationJoinRequestStatusSchema = z.enum([
	"pending",
	"approved",
	"rejected",
]);
export type OrganizationJoinRequestStatus = z.infer<
	typeof organizationJoinRequestStatusSchema
>;

export const organizationJoinRequests = sqliteTable(
	"organization_join_requests",
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
		invitationCodeId: text("invitation_code_id").references(
			() => organizationInvitationCodes.id,
			{ onDelete: "set null" },
		),
		requestedRole: text("requested_role").notNull().default("developer"),
		status: text("status")
			.$type<OrganizationJoinRequestStatus>()
			.notNull()
			.default("pending"),
		reviewedBy: text("reviewed_by").references(() => users.id, {
			onDelete: "set null",
		}),
		reviewedAt: integer("reviewed_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("organization_join_requests_pending_user_unique")
			.on(table.organizationId, table.userId)
			.where(sql`${table.status} = 'pending'`),
		index("organization_join_requests_org_status_idx").on(
			table.organizationId,
			table.status,
		),
		check(
			"organization_join_requests_status_check",
			sql`${table.status} in ('pending', 'approved', 'rejected')`,
		),
		check(
			"organization_join_requests_role_check",
			sql`${table.requestedRole} in ('admin', 'moderator', 'developer', 'qa_engineer')`,
		),
	],
);

export const createOrganizationJoinRequestInputSchema = z.object({
	organizationId: z.string().uuid(),
	userId: z.string().uuid(),
	invitationCodeId: z.string().uuid().nullable().optional(),
	requestedRole: z
		.enum(["admin", "moderator", "developer", "qa_engineer"])
		.default("developer"),
});
