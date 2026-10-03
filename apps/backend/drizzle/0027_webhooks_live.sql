CREATE TABLE `webhook_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`endpoint_id` text NOT NULL,
	`rule_key` text NOT NULL,
	`rule_index` integer NOT NULL,
	`trigger_ref` text NOT NULL,
	`batch_id` text NOT NULL,
	`context_json` text DEFAULT '{}' NOT NULL,
	`pending_reported_at` integer,
	`final_reported_at` integer,
	`report_attempts` integer DEFAULT 0 NOT NULL,
	`report_next_at` integer,
	`report_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_batches_rule_ref_unique` ON `webhook_batches` (`endpoint_id`,`rule_key`,`trigger_ref`);--> statement-breakpoint
CREATE INDEX `webhook_batches_batch_idx` ON `webhook_batches` (`batch_id`);--> statement-breakpoint
ALTER TABLE `test_runs` ADD `base_url_override` text;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD `delivery_id` text;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_endpoint_payload_idx` ON `webhook_deliveries` (`endpoint_id`,`payload_sha256`);