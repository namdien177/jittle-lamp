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
import { deviceAuthClientSchema } from "./desktop-auth-flows";

export const deviceSessions = sqliteTable(
	"device_sessions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		clerkUserId: text("clerk_user_id").notNull(),
		client: text("client")
			.$type<z.infer<typeof deviceAuthClientSchema>>()
			.notNull(),
		flowId: text("flow_id"),
		scope: text("scope").notNull(),
		expiresAt: integer("expires_at").notNull(),
		revokedAt: integer("revoked_at"),
		lastSeenAt: integer("last_seen_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("device_sessions_clerk_user_id_idx").on(table.clerkUserId),
		index("device_sessions_client_idx").on(table.client),
		index("device_sessions_expires_at_idx").on(table.expiresAt),
		check(
			"device_sessions_client_check",
			sql`${table.client} in ('desktop', 'extension')`,
		),
	],
);

export const createDeviceSessionInputSchema = z.object({
	clerkUserId: z.string().min(1),
	client: deviceAuthClientSchema,
	flowId: z.string().min(1).nullable().optional(),
	scope: z.string().min(1),
	expiresAt: z.number().int(),
});
