import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

// Notification bus (design.md §10b) and CI webhooks (design.md §10c, phase 2 schema now).
// Producers write events; channels deliver them. Adding a channel adapter touches no producer.

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

export const notificationEvents = sqliteTable(
	"notification_events",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		subjectType: text("subject_type").notNull(),
		subjectId: text("subject_id").notNull(),
		actorId: text("actor_id").references(() => users.id, {
			onDelete: "set null",
		}),
		// Users the producer names directly (requester, subscribers, uploader).
		recipientsJson: text("recipients_json").notNull().default("[]"),
		payloadJson: text("payload_json").notNull().default("{}"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		dispatchedAt: integer("dispatched_at"),
	},
	(table) => [
		index("notification_events_org_created_idx").on(
			table.orgId,
			table.createdAt,
		),
		index("notification_events_dispatch_idx").on(table.dispatchedAt),
	],
);

export const notificationChannels = sqliteTable(
	"notification_channels",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", {
			enum: ["in_app", "slack", "email", "webhook"],
		}).notNull(),
		configJson: text("config_json").notNull().default("{}"),
		filterJson: text("filter_json").notNull().default('{"kinds":[],"tags":[]}'),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(table) => [
		index("notification_channels_org_idx").on(table.orgId),
		check(
			"notification_channels_kind_check",
			sql`${table.kind} in ('in_app', 'slack', 'email', 'webhook')`,
		),
	],
);

export const notificationDeliveries = sqliteTable(
	"notification_deliveries",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		eventId: text("event_id")
			.notNull()
			.references(() => notificationEvents.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		channelId: text("channel_id").references(() => notificationChannels.id, {
			onDelete: "cascade",
		}),
		channelKind: text("channel_kind").notNull(),
		recipientUserId: text("recipient_user_id").references(() => users.id, {
			onDelete: "cascade",
		}),
		status: text("status", {
			enum: ["pending", "delivered", "failed", "skipped"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		nextAttemptAt: integer("next_attempt_at"),
		deliveredAt: integer("delivered_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("notification_deliveries_unique").on(
			table.eventId,
			table.channelKind,
			sql`coalesce(${table.channelId}, '')`,
			sql`coalesce(${table.recipientUserId}, '')`,
		),
		index("notification_deliveries_recipient_idx").on(
			table.recipientUserId,
			table.orgId,
			table.createdAt,
		),
		index("notification_deliveries_pending_idx").on(
			table.status,
			table.nextAttemptAt,
		),
	],
);

export const notificationReads = sqliteTable(
	"notification_reads",
	{
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		eventId: text("event_id")
			.notNull()
			.references(() => notificationEvents.id, { onDelete: "cascade" }),
		readAt: integer("read_at").notNull(),
	},
	(table) => [primaryKey({ columns: [table.userId, table.eventId] })],
);

// Per-user opt-in by kind ("review queue", "imports", "runner offline"); a user always receives
// events that name them as requester or subscriber.
export const notificationSubscriptions = sqliteTable(
	"notification_subscriptions",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.userId, table.kind] }),
		index("notification_subscriptions_org_kind_idx").on(
			table.orgId,
			table.kind,
		),
	],
);

export const webhookEndpoints = sqliteTable(
	"webhook_endpoints",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		provider: text("provider", {
			enum: ["gitlab", "github", "generic"],
		}).notNull(),
		// Encrypted with the organisation data key, like credential secrets.
		secretEnc: text("secret_enc").notNull(),
		keyVersion: integer("key_version").notNull().default(1),
		rulesJson: text("rules_json").notNull().default("[]"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
		deletedAt: integer("deleted_at"),
	},
	(table) => [index("webhook_endpoints_org_idx").on(table.orgId)],
);

export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		endpointId: text("endpoint_id")
			.notNull()
			.references(() => webhookEndpoints.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		signatureValid: integer("signature_valid", { mode: "boolean" }).notNull(),
		payloadSha256: text("payload_sha256").notNull(),
		triggerRef: text("trigger_ref"),
		batchId: text("batch_id"),
		status: text("status", {
			enum: ["received", "matched", "ignored", "rejected", "error"],
		}).notNull(),
		error: text("error"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("webhook_deliveries_endpoint_created_idx").on(
			table.endpointId,
			table.createdAt,
		),
		index("webhook_deliveries_trigger_ref_idx").on(
			table.orgId,
			table.triggerRef,
		),
	],
);
