-- Roadmap 2026-10-13 phases D and E: API replay, outputs and Postgres queries.
-- Hand-edited from drizzle-kit output: test_runs and test_step_scripts gain columns with
-- ALTER TABLE ADD (column-level CHECKs) instead of a table rebuild, because the generated
-- rebuild selected the new columns from the old table. test_credentials is rebuilt to widen
-- its kind CHECK; the libsql migrator runs the batch with foreign_keys=off, so the DROP does
-- not fire ON DELETE actions on organization_model_accounts.credential_id.
CREATE TABLE `test_queries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`name` text NOT NULL,
	`sql_text` text NOT NULL,
	`params_json` text DEFAULT '[]' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `test_credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`deleted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `test_queries_org_credential_name_unique` ON `test_queries` (`org_id`,`credential_id`,lower("name")) WHERE "test_queries"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `test_queries_org_idx` ON `test_queries` (`org_id`);--> statement-breakpoint
CREATE INDEX `test_queries_credential_idx` ON `test_queries` (`credential_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_test_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`profile` text NOT NULL,
	`kind` text DEFAULT 'login' NOT NULL,
	`environment_id` text,
	`fields_json` text DEFAULT '{}' NOT NULL,
	`login_field` text,
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
	CONSTRAINT "test_credentials_kind_check" CHECK("__new_test_credentials"."kind" in ('login', 'model_key', 'jira', 'github_app', 'gitlab_token', 'slack_webhook', 'postgres'))
);
--> statement-breakpoint
INSERT INTO `__new_test_credentials`("id", "org_id", "profile", "kind", "environment_id", "fields_json", "login_field", "secret_fields_enc", "secret_field_names_json", "key_version", "last_used_at", "login_macro_id", "created_by", "created_at", "updated_at", "deleted_at", "deleted_by") SELECT "id", "org_id", "profile", "kind", "environment_id", "fields_json", "login_field", "secret_fields_enc", "secret_field_names_json", "key_version", "last_used_at", "login_macro_id", "created_by", "created_at", "updated_at", "deleted_at", "deleted_by" FROM `test_credentials`;--> statement-breakpoint
DROP TABLE `test_credentials`;--> statement-breakpoint
ALTER TABLE `__new_test_credentials` RENAME TO `test_credentials`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `test_credentials_org_profile_env_unique` ON `test_credentials` (`org_id`,`profile`,coalesce("environment_id", '')) WHERE "test_credentials"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX `test_credentials_org_idx` ON `test_credentials` (`org_id`);--> statement-breakpoint
CREATE INDEX `test_credentials_org_kind_idx` ON `test_credentials` (`org_id`,`kind`);--> statement-breakpoint
ALTER TABLE `test_cases` ADD `outputs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `test_cases` ADD `reuse_policy_json` text;--> statement-breakpoint
ALTER TABLE `test_environments` ADD `api_origins_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `test_environments` ADD `openapi_url` text;--> statement-breakpoint
ALTER TABLE `test_environments` ADD `api_policy_json` text;--> statement-breakpoint
ALTER TABLE `test_run_steps` ADD `outputs_json` text;--> statement-breakpoint
ALTER TABLE `test_run_steps` ADD `requests_json` text;--> statement-breakpoint
ALTER TABLE `test_runs` ADD `execution_mode` text DEFAULT 'full' NOT NULL CHECK("execution_mode" in ('full', 'hybrid', 'api'));--> statement-breakpoint
ALTER TABLE `test_runs` ADD `evidence_policy` text DEFAULT 'full' NOT NULL CHECK("evidence_policy" in ('full', 'light'));--> statement-breakpoint
ALTER TABLE `test_runs` ADD `reused_from_run_ids_json` text;--> statement-breakpoint
ALTER TABLE `test_step_scripts` ADD `kind` text DEFAULT 'ui-actions' NOT NULL CHECK("kind" in ('ui-actions', 'api-requests', 'assert-check', 'sql'));--> statement-breakpoint
ALTER TABLE `test_step_scripts` ADD `requests_json` text;--> statement-breakpoint
ALTER TABLE `test_step_scripts` ADD `check_json` text;--> statement-breakpoint
ALTER TABLE `test_step_scripts` ADD `sql_text` text;--> statement-breakpoint
ALTER TABLE `test_step_scripts` ADD `review_flags_json` text;
