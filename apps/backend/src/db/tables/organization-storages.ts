import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
} from "drizzle-orm/sqlite-core";

import { createUuidV7 } from "../uuid";
import { organizations } from "./organizations";
import { users } from "./users";

export const organizationStorageStatuses = ["active", "deleted"] as const;
export type OrganizationStorageStatus =
	(typeof organizationStorageStatuses)[number];

// Bring-your-own S3-compatible buckets of an organisation. Rows are never hard-deleted while the
// organisation exists: a removed storage stays as a tombstone (status `deleted`, credentials
// wiped) so artifacts that pointed at it report "storage removed" instead of silently resolving
// to a different bucket. Adding the same bucket again creates a new id; old artifacts are never
// re-linked because the files in the bucket can no longer be vouched for.
export const organizationStorages = sqliteTable(
	"organization_storages",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		endpoint: text("endpoint"),
		region: text("region").notNull(),
		bucket: text("bucket").notNull(),
		keyPrefix: text("key_prefix"),
		forcePathStyle: integer("force_path_style", { mode: "boolean" })
			.notNull()
			.default(false),
		serverSideEncryption: integer("server_side_encryption", {
			mode: "boolean",
		})
			.notNull()
			.default(true),
		// Envelope-encrypted {accessKeyId, secretAccessKey} (services/test-config.ts, kind
		// `storage_credential`). Null once the storage is deleted.
		credentialsEnc: text("credentials_enc"),
		keyVersion: integer("key_version"),
		accessKeyLast4: text("access_key_last4"),
		status: text("status")
			.$type<OrganizationStorageStatus>()
			.notNull()
			.default("active"),
		lastVerifiedAt: integer("last_verified_at"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		deletedBy: text("deleted_by").references(() => users.id, {
			onDelete: "set null",
		}),
		deletedAt: integer("deleted_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("organization_storages_org_idx").on(table.orgId, table.status),
		check(
			"organization_storages_status_check",
			sql`${table.status} in ('active', 'deleted')`,
		),
	],
);

// Where new evidence of an organisation is written. No row (or a null defaultStorageId) means the
// JittleLamp default storage. `defaultStorageDisabled` forbids writes to the JittleLamp storage;
// it requires defaultStorageId to point at an active custom storage.
export const organizationStorageSettings = sqliteTable(
	"organization_storage_settings",
	{
		orgId: text("org_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		defaultStorageId: text("default_storage_id").references(
			() => organizationStorages.id,
			{ onDelete: "set null" },
		),
		defaultStorageDisabled: integer("default_storage_disabled", {
			mode: "boolean",
		})
			.notNull()
			.default(false),
		updatedBy: text("updated_by").references(() => users.id, {
			onDelete: "set null",
		}),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
);

export const storageTransferStatuses = [
	"queued",
	"running",
	"pause_requested",
	"paused",
	"completed",
	"failed",
	"cancelled",
] as const;
export type StorageTransferStatus = (typeof storageTransferStatuses)[number];

// Moves every uploaded artifact of an organisation from one storage to another (null source =
// JittleLamp default storage). Leased like organization_migration_runs.
export const organizationStorageTransfers = sqliteTable(
	"organization_storage_transfers",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		sourceStorageId: text("source_storage_id").references(
			() => organizationStorages.id,
			{ onDelete: "set null" },
		),
		targetStorageId: text("target_storage_id")
			.notNull()
			.references(() => organizationStorages.id, { onDelete: "cascade" }),
		status: text("status")
			.$type<StorageTransferStatus>()
			.notNull()
			.default("queued"),
		artifactsTotal: integer("artifacts_total").notNull().default(0),
		artifactsDone: integer("artifacts_done").notNull().default(0),
		artifactsFailed: integer("artifacts_failed").notNull().default(0),
		bytesTotal: integer("bytes_total").notNull().default(0),
		bytesDone: integer("bytes_done").notNull().default(0),
		// Last processed artifact id; artifacts are walked in id order.
		cursor: text("cursor"),
		lastError: text("last_error"),
		attempts: integer("attempts").notNull().default(0),
		workerLeaseOwner: text("worker_lease_owner"),
		workerLeaseExpiresAt: integer("worker_lease_expires_at"),
		nextAttemptAt: integer("next_attempt_at"),
		createdBy: text("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		startedAt: integer("started_at"),
		completedAt: integer("completed_at"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("organization_storage_transfers_org_idx").on(
			table.orgId,
			table.status,
		),
		index("organization_storage_transfers_claim_idx").on(
			table.status,
			table.nextAttemptAt,
			table.workerLeaseExpiresAt,
		),
		check(
			"organization_storage_transfers_status_check",
			sql`${table.status} in ('queued', 'running', 'pause_requested', 'paused', 'completed', 'failed', 'cancelled')`,
		),
	],
);

// Daily snapshot of stored bytes per organisation and storage, written by the hourly maintenance
// loop. `storageKey` is the storage id, or "default" for the JittleLamp storage (a primary key
// column cannot be null). Kept as history for usage charts and billing estimates.
export const organizationStorageDailyUsage = sqliteTable(
	"organization_storage_daily_usage",
	{
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		storageKey: text("storage_key").notNull(),
		// UTC day, YYYY-MM-DD.
		day: text("day").notNull(),
		bytes: integer("bytes").notNull().default(0),
		artifactCount: integer("artifact_count").notNull().default(0),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.storageKey, table.day] }),
		index("organization_storage_daily_usage_org_day_idx").on(
			table.orgId,
			table.day,
		),
	],
);

export const DEFAULT_STORAGE_KEY = "default";
