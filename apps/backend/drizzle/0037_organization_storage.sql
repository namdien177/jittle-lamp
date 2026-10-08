CREATE TABLE `organization_storage_daily_usage` (
	`org_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`day` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`artifact_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `storage_key`, `day`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_storage_daily_usage_org_day_idx` ON `organization_storage_daily_usage` (`org_id`,`day`);--> statement-breakpoint
CREATE TABLE `organization_storage_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`default_storage_id` text,
	`default_storage_disabled` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_storage_id`) REFERENCES `organization_storages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `organization_storage_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`source_storage_id` text,
	`target_storage_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`artifacts_total` integer DEFAULT 0 NOT NULL,
	`artifacts_done` integer DEFAULT 0 NOT NULL,
	`artifacts_failed` integer DEFAULT 0 NOT NULL,
	`bytes_total` integer DEFAULT 0 NOT NULL,
	`bytes_done` integer DEFAULT 0 NOT NULL,
	`cursor` text,
	`last_error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worker_lease_owner` text,
	`worker_lease_expires_at` integer,
	`next_attempt_at` integer,
	`created_by` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_storage_id`) REFERENCES `organization_storages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_storage_id`) REFERENCES `organization_storages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_storage_transfers_status_check" CHECK("organization_storage_transfers"."status" in ('queued', 'running', 'pause_requested', 'paused', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `organization_storage_transfers_org_idx` ON `organization_storage_transfers` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `organization_storage_transfers_claim_idx` ON `organization_storage_transfers` (`status`,`next_attempt_at`,`worker_lease_expires_at`);--> statement-breakpoint
CREATE TABLE `organization_storages` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`endpoint` text,
	`region` text NOT NULL,
	`bucket` text NOT NULL,
	`key_prefix` text,
	`force_path_style` integer DEFAULT false NOT NULL,
	`server_side_encryption` integer DEFAULT true NOT NULL,
	`credentials_enc` text,
	`key_version` integer,
	`access_key_last4` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_verified_at` integer,
	`created_by` text,
	`deleted_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_storages_status_check" CHECK("organization_storages"."status" in ('active', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `organization_storages_org_idx` ON `organization_storages` (`org_id`,`status`);--> statement-breakpoint
ALTER TABLE `evidence_artifacts` ADD `storage_id` text;--> statement-breakpoint
CREATE INDEX `evidence_artifacts_storage_key_idx` ON `evidence_artifacts` (`storage_id`,`s3_key`);--> statement-breakpoint
-- Backfill storage.manage into the stored admin and moderator roles of existing organisations.
UPDATE `organization_roles` SET `permissions_json` = (
  SELECT json_group_array(`value`) FROM (
    SELECT `value` FROM json_each(`organization_roles`.`permissions_json`)
    UNION
    SELECT `value` FROM json_each('["storage.manage"]')
  )
), `updated_at` = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE `key` IN ('admin', 'moderator');