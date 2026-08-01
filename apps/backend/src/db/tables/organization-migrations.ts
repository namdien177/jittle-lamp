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

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now()),
};

export const jittleLampInstances = sqliteTable(
	"jittle_lamp_instances",
	{
		singleton: integer("singleton").primaryKey().default(1),
		id: text("id")
			.notNull()
			.unique()
			.$defaultFn(() => crypto.randomUUID()),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		check("jittle_lamp_instances_singleton_check", sql`${table.singleton} = 1`),
	],
);

export const migrationReceiverCodes = sqliteTable(
	"migration_receiver_codes",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		createdByUserId: text("created_by_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		passphraseHash: text("passphrase_hash").notNull(),
		expiresAt: integer("expires_at").notNull(),
		failedAttempts: integer("failed_attempts").notNull().default(0),
		redeemedAt: integer("redeemed_at"),
		revokedAt: integer("revoked_at"),
		linkId: text("link_id"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("migration_receiver_codes_creator_idx").on(table.createdByUserId),
		index("migration_receiver_codes_expiry_idx").on(table.expiresAt),
	],
);

export const organizationMigrationLinks = sqliteTable(
	"organization_migration_links",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		direction: text("direction", { enum: ["inbound", "outbound"] }).notNull(),
		localOrganizationId: text("local_organization_id").references(
			() => organizations.id,
			{ onDelete: "restrict" },
		),
		remoteOrganizationId: text("remote_organization_id"),
		remoteInstanceId: text("remote_instance_id").notNull(),
		remoteApiOrigin: text("remote_api_origin").notNull(),
		remoteWebOrigin: text("remote_web_origin").notNull(),
		protocolVersion: text("protocol_version").notNull(),
		encryptedSessionToken: text("encrypted_session_token"),
		encryptedDataKey: text("encrypted_data_key"),
		sessionTokenHash: text("session_token_hash"),
		state: text("state", {
			enum: [
				"paired",
				"syncing",
				"synced",
				"finalizing",
				"completed",
				"diverged",
				"broken",
			],
		})
			.notNull()
			.default("paired"),
		lastSuccessfulManifestHash: text("last_successful_manifest_hash"),
		finalManifestHash: text("final_manifest_hash"),
		verificationReceipt: text("verification_receipt"),
		lastSuccessfulAt: integer("last_successful_at"),
		credentialsWipedAt: integer("credentials_wiped_at"),
		...timestamps,
	},
	(table) => [
		index("organization_migration_links_local_org_idx").on(
			table.localOrganizationId,
		),
		index("organization_migration_links_remote_instance_idx").on(
			table.remoteInstanceId,
		),
	],
);

export const organizationMigrationRuns = sqliteTable(
	"organization_migration_runs",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		linkId: text("link_id")
			.notNull()
			.references(() => organizationMigrationLinks.id, { onDelete: "cascade" }),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "restrict",
		}),
		sourceRunId: text("source_run_id").notNull(),
		kind: text("kind", { enum: ["full", "delta", "final"] }).notNull(),
		status: text("status", {
			enum: [
				"queued",
				"running",
				"waiting_peer",
				"pause_requested",
				"paused",
				"failed",
				"succeeded",
				"cancelled",
			],
		})
			.notNull()
			.default("queued"),
		stage: text("stage", {
			enum: [
				"preflight",
				"manifest",
				"identities",
				"records",
				"artifacts",
				"verify",
				"publish",
				"finalize",
			],
		})
			.notNull()
			.default("preflight"),
		override: integer("override", { mode: "boolean" }).notNull().default(false),
		identityCompleted: integer("identity_completed").notNull().default(0),
		identityTotal: integer("identity_total").notNull().default(0),
		recordCompleted: integer("record_completed").notNull().default(0),
		recordTotal: integer("record_total").notNull().default(0),
		artifactCompleted: integer("artifact_completed").notNull().default(0),
		artifactTotal: integer("artifact_total").notNull().default(0),
		bytesTransferred: integer("bytes_transferred").notNull().default(0),
		bytesTotal: integer("bytes_total").notNull().default(0),
		warningsJson: text("warnings_json").notNull().default("[]"),
		manifestHash: text("manifest_hash"),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		attempts: integer("attempts").notNull().default(0),
		workerLeaseOwner: text("worker_lease_owner"),
		workerLeaseExpiresAt: integer("worker_lease_expires_at"),
		workerHeartbeatAt: integer("worker_heartbeat_at"),
		nextAttemptAt: integer("next_attempt_at"),
		startedAt: integer("started_at"),
		completedAt: integer("completed_at"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("organization_migration_runs_source_run_idx").on(
			table.linkId,
			table.sourceRunId,
		),
		index("organization_migration_runs_claim_idx").on(
			table.status,
			table.nextAttemptAt,
			table.workerLeaseExpiresAt,
		),
		index("organization_migration_runs_org_idx").on(table.organizationId),
	],
);

export const organizationMigrationItems = sqliteTable(
	"organization_migration_items",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		runId: text("run_id")
			.notNull()
			.references(() => organizationMigrationRuns.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: ["manifest", "record", "artifact"] }).notNull(),
		page: integer("page"),
		ordinal: integer("ordinal").notNull(),
		entityType: text("entity_type"),
		sourceId: text("source_id").notNull(),
		contentHash: text("content_hash").notNull(),
		byteSize: integer("byte_size"),
		mimeType: text("mime_type"),
		stagedPayload: text("staged_payload"),
		stagedObjectKey: text("staged_object_key"),
		status: text("status", {
			enum: ["pending", "processing", "verified", "published", "failed"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("organization_migration_items_idempotency_idx").on(
			table.runId,
			table.kind,
			table.sourceId,
			table.contentHash,
		),
		index("organization_migration_items_work_idx").on(
			table.runId,
			table.status,
			table.ordinal,
		),
	],
);

export const migrationIdentityMappings = sqliteTable(
	"migration_identity_mappings",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => createUuidV7()),
		linkId: text("link_id")
			.notNull()
			.references(() => organizationMigrationLinks.id, { onDelete: "cascade" }),
		sourceLocalUserId: text("source_local_user_id").notNull(),
		sourceClerkUserId: text("source_clerk_user_id"),
		destinationLocalUserId: text("destination_local_user_id")
			.notNull()
			.references(() => users.id, { onDelete: "restrict" }),
		destinationClerkUserId: text("destination_clerk_user_id"),
		archivedPrincipal: integer("archived_principal", { mode: "boolean" })
			.notNull()
			.default(false),
		...timestamps,
	},
	(table) => [
		uniqueIndex("migration_identity_mappings_source_idx").on(
			table.linkId,
			table.sourceLocalUserId,
		),
	],
);

export const migrationEntityMappings = sqliteTable(
	"migration_entity_mappings",
	{
		linkId: text("link_id")
			.notNull()
			.references(() => organizationMigrationLinks.id, { onDelete: "cascade" }),
		entityType: text("entity_type").notNull(),
		sourceEntityId: text("source_entity_id").notNull(),
		destinationEntityId: text("destination_entity_id").notNull(),
		lastImportedHash: text("last_imported_hash").notNull(),
		lastSeenRunId: text("last_seen_run_id")
			.notNull()
			.references(() => organizationMigrationRuns.id, { onDelete: "restrict" }),
		...timestamps,
	},
	(table) => [
		primaryKey({
			columns: [table.linkId, table.entityType, table.sourceEntityId],
		}),
		index("migration_entity_mappings_destination_idx").on(
			table.linkId,
			table.entityType,
			table.destinationEntityId,
		),
	],
);

export const organizationMigrationStates = sqliteTable(
	"organization_migration_states",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		linkId: text("link_id")
			.notNull()
			.references(() => organizationMigrationLinks.id, { onDelete: "cascade" }),
		role: text("role", { enum: ["source", "target"] }).notNull(),
		accessState: text("access_state", {
			enum: [
				"importing",
				"synced_read_only",
				"finalizing_read_only",
				"completed_source_read_only",
				"ready_to_activate",
				"writable",
				"diverged",
			],
		}).notNull(),
		destinationWebOrigin: text("destination_web_origin"),
		verificationReceipt: text("verification_receipt"),
		...timestamps,
	},
	(table) => [index("organization_migration_states_link_idx").on(table.linkId)],
);
