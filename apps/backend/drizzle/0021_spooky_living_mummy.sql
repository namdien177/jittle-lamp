CREATE TABLE `jittle_lamp_instances` (
	`singleton` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`id` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "jittle_lamp_instances_singleton_check" CHECK(`jittle_lamp_instances`.`singleton` = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jittle_lamp_instances_id_unique` ON `jittle_lamp_instances` (`id`);--> statement-breakpoint
CREATE TABLE `organization_migration_links` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`local_organization_id` text,
	`remote_organization_id` text,
	`remote_instance_id` text NOT NULL,
	`remote_api_origin` text NOT NULL,
	`remote_web_origin` text NOT NULL,
	`protocol_version` text NOT NULL,
	`encrypted_session_token` text,
	`encrypted_data_key` text,
	`session_token_hash` text,
	`state` text DEFAULT 'paired' NOT NULL,
	`last_successful_manifest_hash` text,
	`final_manifest_hash` text,
	`verification_receipt` text,
	`last_successful_at` integer,
	`credentials_wiped_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`local_organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `organization_migration_links_local_org_idx` ON `organization_migration_links` (`local_organization_id`);--> statement-breakpoint
CREATE INDEX `organization_migration_links_remote_instance_idx` ON `organization_migration_links` (`remote_instance_id`);--> statement-breakpoint
CREATE TABLE `migration_receiver_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by_user_id` text NOT NULL,
	`passphrase_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`redeemed_at` integer,
	`revoked_at` integer,
	`link_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `migration_receiver_codes_creator_idx` ON `migration_receiver_codes` (`created_by_user_id`);--> statement-breakpoint
CREATE INDEX `migration_receiver_codes_expiry_idx` ON `migration_receiver_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `organization_migration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`organization_id` text,
	`source_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'preflight' NOT NULL,
	`override` integer DEFAULT false NOT NULL,
	`identity_completed` integer DEFAULT 0 NOT NULL,
	`identity_total` integer DEFAULT 0 NOT NULL,
	`record_completed` integer DEFAULT 0 NOT NULL,
	`record_total` integer DEFAULT 0 NOT NULL,
	`artifact_completed` integer DEFAULT 0 NOT NULL,
	`artifact_total` integer DEFAULT 0 NOT NULL,
	`bytes_transferred` integer DEFAULT 0 NOT NULL,
	`bytes_total` integer DEFAULT 0 NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`manifest_hash` text,
	`error_code` text,
	`error_message` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worker_lease_owner` text,
	`worker_lease_expires_at` integer,
	`worker_heartbeat_at` integer,
	`next_attempt_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `organization_migration_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_migration_runs_source_run_idx` ON `organization_migration_runs` (`link_id`,`source_run_id`);--> statement-breakpoint
CREATE INDEX `organization_migration_runs_claim_idx` ON `organization_migration_runs` (`status`,`next_attempt_at`,`worker_lease_expires_at`);--> statement-breakpoint
CREATE INDEX `organization_migration_runs_org_idx` ON `organization_migration_runs` (`organization_id`);--> statement-breakpoint
CREATE TABLE `organization_migration_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`page` integer,
	`ordinal` integer NOT NULL,
	`entity_type` text,
	`source_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`byte_size` integer,
	`mime_type` text,
	`staged_payload` text,
	`staged_object_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `organization_migration_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_migration_items_idempotency_idx` ON `organization_migration_items` (`run_id`,`kind`,`source_id`,`content_hash`);--> statement-breakpoint
CREATE INDEX `organization_migration_items_work_idx` ON `organization_migration_items` (`run_id`,`status`,`ordinal`);--> statement-breakpoint
CREATE TABLE `migration_identity_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`source_local_user_id` text NOT NULL,
	`source_clerk_user_id` text,
	`destination_local_user_id` text NOT NULL,
	`destination_clerk_user_id` text,
	`archived_principal` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `organization_migration_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_local_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `migration_identity_mappings_source_idx` ON `migration_identity_mappings` (`link_id`,`source_local_user_id`);--> statement-breakpoint
CREATE TABLE `migration_entity_mappings` (
	`link_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`source_entity_id` text NOT NULL,
	`destination_entity_id` text NOT NULL,
	`last_imported_hash` text NOT NULL,
	`last_seen_run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`link_id`, `entity_type`, `source_entity_id`),
	FOREIGN KEY (`link_id`) REFERENCES `organization_migration_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_seen_run_id`) REFERENCES `organization_migration_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `migration_entity_mappings_destination_idx` ON `migration_entity_mappings` (`link_id`,`entity_type`,`destination_entity_id`);--> statement-breakpoint
CREATE TABLE `organization_migration_states` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`role` text NOT NULL,
	`access_state` text NOT NULL,
	`destination_web_origin` text,
	`verification_receipt` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `organization_migration_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `organization_migration_states_link_idx` ON `organization_migration_states` (`link_id`);
--> statement-breakpoint
CREATE TRIGGER `migration_lock_organizations_update` BEFORE UPDATE ON `organizations`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_organizations_delete` BEFORE DELETE ON `organizations`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_members_insert` BEFORE INSERT ON `organization_members`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_members_update` BEFORE UPDATE ON `organization_members`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` IN (OLD.`organization_id`,NEW.`organization_id`) AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_members_delete` BEFORE DELETE ON `organization_members`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_roles_insert` BEFORE INSERT ON `organization_roles`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_roles_update` BEFORE UPDATE ON `organization_roles`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_roles_delete` BEFORE DELETE ON `organization_roles`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_evidences_insert` BEFORE INSERT ON `evidences`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_evidences_update` BEFORE UPDATE ON `evidences`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` IN (OLD.`org_id`,NEW.`org_id`) AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_evidences_delete` BEFORE DELETE ON `evidences`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_artifacts_insert` BEFORE INSERT ON `evidence_artifacts`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = NEW.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_artifacts_update` BEFORE UPDATE ON `evidence_artifacts`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` IN (OLD.`evidence_id`,NEW.`evidence_id`) AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_artifacts_delete` BEFORE DELETE ON `evidence_artifacts`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = OLD.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_comments_insert` BEFORE INSERT ON `evidence_comments`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = NEW.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_comments_update` BEFORE UPDATE ON `evidence_comments`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = OLD.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_comments_delete` BEFORE DELETE ON `evidence_comments`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = OLD.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_tags_insert` BEFORE INSERT ON `organization_evidence_tags`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_tags_update` BEFORE UPDATE ON `organization_evidence_tags`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_tags_delete` BEFORE DELETE ON `organization_evidence_tags`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_tag_assignments_insert` BEFORE INSERT ON `evidence_tag_assignments`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = NEW.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_tag_assignments_delete` BEFORE DELETE ON `evidence_tag_assignments`
WHEN EXISTS (SELECT 1 FROM `evidences` e JOIN `organization_migration_states` s ON s.`organization_id` = e.`org_id` WHERE e.`id` = OLD.`evidence_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_share_links_insert` BEFORE INSERT ON `share_links`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_share_links_update` BEFORE UPDATE ON `share_links`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_share_links_delete` BEFORE DELETE ON `share_links`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_recordings_insert` BEFORE INSERT ON `desktop_recording_sessions`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_recordings_update` BEFORE UPDATE ON `desktop_recording_sessions`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_recordings_delete` BEFORE DELETE ON `desktop_recording_sessions`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_automation_tokens_insert` BEFORE INSERT ON `automation_api_tokens`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_automation_tokens_update` BEFORE UPDATE ON `automation_api_tokens`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_automation_tokens_delete` BEFORE DELETE ON `automation_api_tokens`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`org_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitations_insert` BEFORE INSERT ON `organization_invitations`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitations_update` BEFORE UPDATE ON `organization_invitations`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitations_delete` BEFORE DELETE ON `organization_invitations`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitation_codes_insert` BEFORE INSERT ON `organization_invitation_codes`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitation_codes_update` BEFORE UPDATE ON `organization_invitation_codes`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_invitation_codes_delete` BEFORE DELETE ON `organization_invitation_codes`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_join_requests_insert` BEFORE INSERT ON `organization_join_requests`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = NEW.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_join_requests_update` BEFORE UPDATE ON `organization_join_requests`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;--> statement-breakpoint
CREATE TRIGGER `migration_lock_join_requests_delete` BEFORE DELETE ON `organization_join_requests`
WHEN EXISTS (SELECT 1 FROM `organization_migration_states` s WHERE s.`organization_id` = OLD.`organization_id` AND s.`access_state` IN ('importing','synced_read_only','finalizing_read_only','completed_source_read_only','ready_to_activate'))
BEGIN SELECT RAISE(ABORT, 'ORG_MIGRATION_READ_ONLY'); END;
