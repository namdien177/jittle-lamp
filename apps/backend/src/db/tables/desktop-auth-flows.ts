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

export const desktopAuthFlowStatusSchema = z.enum([
	"pending",
	"approved",
	"denied",
	"expired",
]);
export type DesktopAuthFlowStatus = z.infer<typeof desktopAuthFlowStatusSchema>;

export const deviceAuthClientSchema = z.enum(["desktop", "extension"]);
export type DeviceAuthClient = z.infer<typeof deviceAuthClientSchema>;

export const desktopAuthFlows = sqliteTable(
	"desktop_auth_flows",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		deviceCodeHash: text("device_code_hash").notNull(),
		userCodeHash: text("user_code_hash").notNull(),
		status: text("status")
			.$type<DesktopAuthFlowStatus>()
			.notNull()
			.default("pending"),
		client: text("client")
			.$type<DeviceAuthClient>()
			.notNull()
			.default("desktop"),
		clerkUserId: text("clerk_user_id"),
		expiresAt: integer("expires_at").notNull(),
		approvedAt: integer("approved_at"),
		completedAt: integer("completed_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		uniqueIndex("desktop_auth_flows_device_code_hash_unique").on(
			table.deviceCodeHash,
		),
		uniqueIndex("desktop_auth_flows_user_code_hash_unique").on(
			table.userCodeHash,
		),
		index("desktop_auth_flows_status_idx").on(table.status),
		index("desktop_auth_flows_expires_at_idx").on(table.expiresAt),
		check(
			"desktop_auth_flows_status_check",
			sql`${table.status} in ('pending', 'approved', 'denied', 'expired')`,
		),
		check(
			"desktop_auth_flows_client_check",
			sql`${table.client} in ('desktop', 'extension')`,
		),
	],
);

export const createDesktopAuthFlowInputSchema = z.object({
	deviceCodeHash: z.string().min(32),
	userCodeHash: z.string().min(32),
	client: deviceAuthClientSchema.default("desktop"),
	expiresAt: z.number().int(),
});
