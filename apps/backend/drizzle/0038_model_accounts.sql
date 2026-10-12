CREATE TABLE `organization_model_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`label` text NOT NULL,
	`credential_id` text,
	`key_last4` text,
	`base_url` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`paused_until` integer,
	`daily_budget_usd` real,
	`monthly_budget_usd` real,
	`over_budget` text DEFAULT 'finish' NOT NULL,
	`cooldown_until` integer,
	`last_error_code` text,
	`last_error_message` text,
	`last_error_at` integer,
	`last_used_at` integer,
	`created_by` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `test_credentials`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organization_model_accounts_over_budget_check" CHECK("organization_model_accounts"."over_budget" in ('finish', 'stop'))
);
--> statement-breakpoint
CREATE INDEX `organization_model_accounts_org_provider_idx` ON `organization_model_accounts` (`org_id`,`provider`,`priority`);--> statement-breakpoint
CREATE TABLE `test_run_model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text,
	`model_id` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`finished_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `test_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `organization_model_accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_run_model_usage_org_finished_idx` ON `test_run_model_usage` (`org_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `test_run_model_usage_account_finished_idx` ON `test_run_model_usage` (`account_id`,`finished_at`);--> statement-breakpoint
CREATE INDEX `test_run_model_usage_run_idx` ON `test_run_model_usage` (`run_id`);
