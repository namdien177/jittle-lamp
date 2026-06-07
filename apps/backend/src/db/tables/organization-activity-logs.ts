import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod/v4";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

export const organizationActivityLogs = sqliteTable(
	"organization_activity_logs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: text("action").notNull(),
		entityType: text("entity_type").notNull(),
		entityId: text("entity_id"),
		message: text("message").notNull(),
		metadataJson: text("metadata_json").notNull().default("{}"),
		ipAddress: text("ip_address"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("organization_activity_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("organization_activity_logs_org_action_idx").on(
			table.organizationId,
			table.action,
		),
		index("organization_activity_logs_org_actor_idx").on(
			table.organizationId,
			table.actorUserId,
		),
	],
);

export const createOrganizationActivityLogInputSchema = z.object({
	organizationId: z.string().uuid(),
	actorUserId: z.string().uuid().nullable().optional(),
	action: z.string().trim().min(1).max(120),
	entityType: z.string().trim().min(1).max(80),
	entityId: z.string().trim().min(1).nullable().optional(),
	message: z.string().trim().min(1).max(500),
	metadataJson: z.string().min(2).default("{}"),
	ipAddress: z.string().trim().min(1).nullable().optional(),
});
