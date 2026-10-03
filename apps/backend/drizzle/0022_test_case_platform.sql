CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`filter_json` text DEFAULT '{"kinds":[],"tags":[]}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notification_channels_kind_check" CHECK("notification_channels"."kind" in ('in_app', 'slack', 'email', 'webhook'))
);
--> statement-breakpoint
CREATE INDEX `notification_channels_org_idx` ON `notification_channels` (`org_id`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`org_id` text NOT NULL,
	`channel_id` text,
	`channel_kind` text NOT NULL,
	`recipient_user_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_unique` ON `notification_deliveries` (`event_id`,`channel_kind`,coalesce("channel_id", ''),coalesce("recipient_user_id", ''));--> statement-breakpoint
CREATE INDEX `notification_deliveries_recipient_idx` ON `notification_deliveries` (`recipient_user_id`,`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_pending_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`actor_id` text,
	`recipients_json` text DEFAULT '[]' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`dispatched_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `notification_events_org_created_idx` ON `notification_events` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_events_dispatch_idx` ON `notification_events` (`dispatched_at`);--> statement-breakpoint
CREATE TABLE `notification_reads` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`read_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `user_id`, `kind`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_subscriptions_org_kind_idx` ON `notification_subscriptions` (`org_id`,`kind`);--> statement-breakpoint
CREATE TABLE `organization_agent_notes` (
	`org_id` text PRIMARY KEY NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `organization_data_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`provider` text NOT NULL,
	`master_key_id` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`retired_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_data_keys_org_version_unique` ON `organization_data_keys` (`org_id`,`key_version`);--> statement-breakpoint
CREATE INDEX `organization_data_keys_org_status_idx` ON `organization_data_keys` (`org_id`,`status`);--> statement-breakpoint
CREATE TABLE `organization_model_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`act_model` text NOT NULL,
	`judge_model` text NOT NULL,
	`provider` text NOT NULL,
	`key_credential_id` text,
	`key_last4` text,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_credential_id`) REFERENCES `test_credentials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `organization_test_counters` (
	`org_id` text PRIMARY KEY NOT NULL,
	`next_case_number` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organization_test_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`namespace` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_test_tags_org_ns_name_unique` ON `organization_test_tags` (`org_id`,`namespace`,`name`);--> statement-breakpoint
CREATE INDEX `organization_test_tags_org_idx` ON `organization_test_tags` (`org_id`);--> statement-breakpoint
CREATE TABLE `runner_pools` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`max_concurrent_runs` integer DEFAULT 1 NOT NULL,
	`registration_token_hash` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "runner_pools_kind_check" CHECK("runner_pools"."kind" in ('cloud', 'self-hosted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_pools_org_name_unique` ON `runner_pools` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `runner_pools_registration_token_unique` ON `runner_pools` (`registration_token_hash`);--> statement-breakpoint
CREATE TABLE `runner_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`org_id` text NOT NULL,
	`hostname` text NOT NULL,
	`version` text NOT NULL,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`worker_token_hash` text NOT NULL,
	`last_heartbeat_at` integer,
	`current_run_id` text,
	`load` integer DEFAULT 0 NOT NULL,
	`offline_notified_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`pool_id`) REFERENCES `runner_pools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_workers_token_unique` ON `runner_workers` (`worker_token_hash`);--> statement-breakpoint
CREATE INDEX `runner_workers_pool_heartbeat_idx` ON `runner_workers` (`pool_id`,`last_heartbeat_at`);--> statement-breakpoint
CREATE TABLE `test_case_datasets` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text NOT NULL,
	`name` text,
	`columns_json` text DEFAULT '[]' NOT NULL,
	`rows_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_case_datasets_case_idx` ON `test_case_datasets` (`test_case_id`);--> statement-breakpoint
CREATE TABLE `test_case_evidences` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`run_id` text,
	`relation` text DEFAULT 'run' NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_case_evidences_case_evidence_unique` ON `test_case_evidences` (`test_case_id`,`evidence_id`);--> statement-breakpoint
CREATE INDEX `test_case_evidences_evidence_idx` ON `test_case_evidences` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `test_case_evidences_run_idx` ON `test_case_evidences` (`run_id`);--> statement-breakpoint
CREATE TABLE `test_case_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`test_case_id` text NOT NULL,
	`version` integer NOT NULL,
	`transcript` text NOT NULL,
	`steps_json` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`change_note` text,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_case_versions_case_version_unique` ON `test_case_versions` (`test_case_id`,`version`);--> statement-breakpoint
CREATE TABLE `test_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`key` text NOT NULL,
	`created_by` text,
	`updated_by` text,
	`title` text NOT NULL,
	`description` text,
	`links_json` text DEFAULT '[]' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`tags_text` text DEFAULT '' NOT NULL,
	`environment_id` text,
	`transcript` text NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`transcript_version` integer DEFAULT 1 NOT NULL,
	`params_schema_json` text DEFAULT '[]' NOT NULL,
	`dataset_json` text,
	`lint_json` text DEFAULT '[]' NOT NULL,
	`lint_errors` integer DEFAULT 0 NOT NULL,
	`lint_warnings` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`status_reason` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_ref` text,
	`duplicated_from_id` text,
	`external_id` text,
	`fingerprint` text NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`environment_id`) REFERENCES `test_environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`duplicated_from_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_cases_status_check" CHECK("test_cases"."status" in ('draft', 'review', 'active', 'archived')),
	CONSTRAINT "test_cases_source_check" CHECK("test_cases"."source" in ('manual', 'import', 'ai', 'duplicate', 'recording'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_cases_org_key_unique` ON `test_cases` (`org_id`,`key`);--> statement-breakpoint
CREATE INDEX `test_cases_org_status_idx` ON `test_cases` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `test_cases_org_updated_idx` ON `test_cases` (`org_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `test_cases_org_fingerprint_idx` ON `test_cases` (`org_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `test_cases_org_external_idx` ON `test_cases` (`org_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `test_cases_duplicated_from_idx` ON `test_cases` (`duplicated_from_id`);--> statement-breakpoint
CREATE INDEX `test_cases_environment_idx` ON `test_cases` (`environment_id`);--> statement-breakpoint
CREATE TABLE `test_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`profile` text NOT NULL,
	`kind` text DEFAULT 'login' NOT NULL,
	`environment_id` text,
	`fields_json` text DEFAULT '{}' NOT NULL,
	`secret_fields_enc` text,
	`secret_field_names_json` text DEFAULT '[]' NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`last_used_at` integer,
	`login_macro_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `test_environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`login_macro_id`) REFERENCES `test_macros`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_credentials_kind_check" CHECK("test_credentials"."kind" in ('login', 'model_key', 'jira', 'github_app', 'gitlab_token', 'slack_webhook'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_credentials_org_profile_env_unique` ON `test_credentials` (`org_id`,`profile`,coalesce("environment_id", '')) WHERE "test_credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `test_credentials_org_idx` ON `test_credentials` (`org_id`);--> statement-breakpoint
CREATE INDEX `test_credentials_org_kind_idx` ON `test_credentials` (`org_id`,`kind`);--> statement-breakpoint
CREATE TABLE `test_environments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`variables_json` text DEFAULT '{}' NOT NULL,
	`runner_pool` text DEFAULT 'cloud' NOT NULL,
	`agent_instructions` text,
	`notes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_environments_org_name_unique` ON `test_environments` (`org_id`,`name`) WHERE "test_environments"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `test_environments_org_idx` ON `test_environments` (`org_id`);--> statement-breakpoint
CREATE TABLE `test_import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`created_by` text,
	`source_kind` text NOT NULL,
	`file_name` text,
	`file_artifact_id` text,
	`mapping_json` text DEFAULT '{}' NOT NULL,
	`options_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'parsing' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_import_batches_org_created_idx` ON `test_import_batches` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_import_items` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`external_id` text,
	`title` text DEFAULT '' NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`source_json` text,
	`parsed_json` text,
	`lint_json` text DEFAULT '[]' NOT NULL,
	`similar_json` text DEFAULT '[]' NOT NULL,
	`decision` text DEFAULT 'create' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`result_test_case_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `test_import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`result_test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_import_items_batch_ordinal_unique` ON `test_import_items` (`batch_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `test_macros` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`params_json` text DEFAULT '[]' NOT NULL,
	`transcript` text NOT NULL,
	`steps_json` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_macros_status_check" CHECK("test_macros"."status" in ('draft', 'active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_macros_org_name_unique` ON `test_macros` (`org_id`,lower("name")) WHERE "test_macros"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `test_macros_org_idx` ON `test_macros` (`org_id`);--> statement-breakpoint
CREATE TABLE `test_model_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text,
	`model_id` text NOT NULL,
	`input_usd_per_mtok` real NOT NULL,
	`cached_input_usd_per_mtok` real NOT NULL,
	`output_usd_per_mtok` real NOT NULL,
	`version` text NOT NULL,
	`effective_from` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_model_prices_scope_model_from_unique` ON `test_model_prices` (coalesce("org_id", ''),`model_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `test_model_prices_model_idx` ON `test_model_prices` (`model_id`);--> statement-breakpoint
CREATE TABLE `test_rate_buckets` (
	`org_id` text NOT NULL,
	`bucket_key` text NOT NULL,
	`tokens` real NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `bucket_key`),
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `test_run_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`test_case_id` text,
	`suite_id` text,
	`trigger` text NOT NULL,
	`trigger_ref` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`blocked` integer DEFAULT 0 NOT NULL,
	`pending` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`suite_id`) REFERENCES `test_suites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_run_batches_org_created_idx` ON `test_run_batches` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `test_run_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`max_concurrent_runs` integer DEFAULT 1 NOT NULL,
	`dedupe_window_seconds` integer DEFAULT 120 NOT NULL,
	`max_queued_runs` integer DEFAULT 20 NOT NULL,
	`max_queued_per_case` integer DEFAULT 3 NOT NULL,
	`token_bucket_size` integer DEFAULT 30 NOT NULL,
	`token_bucket_window_seconds` integer DEFAULT 600 NOT NULL,
	`daily_budget_usd` real,
	`retention_failed_days` integer DEFAULT 180 NOT NULL,
	`retention_passed_days` integer DEFAULT 30 NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `test_run_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_id` text NOT NULL,
	`parent_step_id` text,
	`ordinal` integer NOT NULL,
	`type` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`checkpoint_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`mode` text,
	`cache_reason` text,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`video_offset_ms` integer,
	`observed` text,
	`error_code` text,
	`error_message` text,
	`screenshot_artifact_id` text,
	`screenshot_key` text,
	`screenshot_mime_type` text,
	`script_version` integer,
	`model_id` text,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`actions` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`vision_input` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`screenshot_artifact_id`) REFERENCES `evidence_artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_run_steps_run_step_unique` ON `test_run_steps` (`run_id`,`step_id`);--> statement-breakpoint
CREATE TABLE `test_run_subscribers` (
	`run_id` text NOT NULL,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `user_id`),
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_run_subscribers_user_idx` ON `test_run_subscribers` (`user_id`);--> statement-breakpoint
CREATE TABLE `test_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`test_case_id` text NOT NULL,
	`created_by` text,
	`requested_by_token_id` text,
	`transcript_version` integer NOT NULL,
	`environment_id` text,
	`params_json` text DEFAULT '{}' NOT NULL,
	`params_hash` text NOT NULL,
	`cache_mode` text DEFAULT 'read-write' NOT NULL,
	`dedupe_key` text NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`priority` integer DEFAULT 30 NOT NULL,
	`runner_affinity` text DEFAULT 'cloud' NOT NULL,
	`runner_pool` text DEFAULT 'cloud' NOT NULL,
	`runner_pool_id` text,
	`runner` text,
	`runner_info_json` text,
	`worker_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`outcome` text,
	`blocked_reason` text,
	`flaky` integer DEFAULT false NOT NULL,
	`retry_attempt` integer DEFAULT 1 NOT NULL,
	`retry_of_run_id` text,
	`batch_id` text,
	`queued_at` integer NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`evidence_id` text,
	`error` text,
	`current_step_id` text,
	`cancel_requested_at` integer,
	`cancelled_by` text,
	`model_id` text,
	`judge_model_id` text,
	`provider` text,
	`model_calls` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`price_table_version` text,
	`duration_ms` integer,
	`steps_total` integer DEFAULT 0 NOT NULL,
	`steps_replayed` integer DEFAULT 0 NOT NULL,
	`steps_agent` integer DEFAULT 0 NOT NULL,
	`steps_handoff` integer DEFAULT 0 NOT NULL,
	`worker_lease_owner` text,
	`worker_lease_expires_at` integer,
	`worker_heartbeat_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_token_hash` text,
	`run_token_expires_at` integer,
	`live_available` integer DEFAULT false NOT NULL,
	`live_takeover_by` text,
	`live_paused` integer DEFAULT false NOT NULL,
	`live_frame_key` text,
	`live_frame_at` integer,
	`takeover_requested_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`environment_id`) REFERENCES `test_environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`runner_pool_id`) REFERENCES `runner_pools`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`worker_id`) REFERENCES `runner_workers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`batch_id`) REFERENCES `test_run_batches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidences`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`live_takeover_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_runs_status_check" CHECK("test_runs"."status" in ('queued', 'claimed', 'running', 'paused', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `test_runs_queue_idx` ON `test_runs` (`runner_pool_id`,`status`,`priority`,`queued_at`);--> statement-breakpoint
CREATE INDEX `test_runs_org_status_idx` ON `test_runs` (`org_id`,`status`);--> statement-breakpoint
CREATE INDEX `test_runs_org_dedupe_idx` ON `test_runs` (`org_id`,`dedupe_key`,`status`);--> statement-breakpoint
CREATE INDEX `test_runs_case_queued_idx` ON `test_runs` (`test_case_id`,`queued_at`);--> statement-breakpoint
CREATE INDEX `test_runs_batch_idx` ON `test_runs` (`batch_id`);--> statement-breakpoint
CREATE INDEX `test_runs_evidence_idx` ON `test_runs` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `test_runs_org_finished_idx` ON `test_runs` (`org_id`,`finished_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_runs_run_token_unique` ON `test_runs` (`run_token_hash`);--> statement-breakpoint
CREATE TABLE `test_step_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`test_case_id` text NOT NULL,
	`step_id` text NOT NULL,
	`step_ids_json` text DEFAULT '[]' NOT NULL,
	`instruction_key` text,
	`environment_id` text,
	`key_hash` text NOT NULL,
	`entry_json` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`actions_json` text,
	`end_state_json` text,
	`rendered_code` text DEFAULT '' NOT NULL,
	`recorded_from_run_id` text,
	`inherited_from_script_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`stale_reason` text,
	`verified_count` integer DEFAULT 0 NOT NULL,
	`last_replayed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `test_environments`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "test_step_scripts_status_check" CHECK("test_step_scripts"."status" in ('active', 'stale', 'invalid'))
);
--> statement-breakpoint
CREATE INDEX `test_step_scripts_case_key_idx` ON `test_step_scripts` (`test_case_id`,`key_hash`);--> statement-breakpoint
CREATE INDEX `test_step_scripts_case_step_idx` ON `test_step_scripts` (`test_case_id`,`step_id`,`status`);--> statement-breakpoint
CREATE INDEX `test_step_scripts_org_idx` ON `test_step_scripts` (`org_id`);--> statement-breakpoint
CREATE TABLE `test_suite_members` (
	`suite_id` text NOT NULL,
	`test_case_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`suite_id`, `test_case_id`),
	FOREIGN KEY (`suite_id`) REFERENCES `test_suites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`test_case_id`) REFERENCES `test_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `test_suite_members_case_idx` ON `test_suite_members` (`test_case_id`);--> statement-breakpoint
CREATE TABLE `test_suites` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`filter_json` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_suites_org_idx` ON `test_suites` (`org_id`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`org_id` text NOT NULL,
	`event_type` text NOT NULL,
	`signature_valid` integer NOT NULL,
	`payload_sha256` text NOT NULL,
	`trigger_ref` text,
	`batch_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_created_idx` ON `webhook_deliveries` (`endpoint_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_trigger_ref_idx` ON `webhook_deliveries` (`org_id`,`trigger_ref`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`secret_enc` text NOT NULL,
	`key_version` integer DEFAULT 1 NOT NULL,
	`rules_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `webhook_endpoints_org_idx` ON `webhook_endpoints` (`org_id`);