CREATE TABLE `test_explorations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`item_id` text NOT NULL,
	`environment_id` text,
	`runner_pool` text DEFAULT 'cloud' NOT NULL,
	`runner_pool_id` text,
	`title` text NOT NULL,
	`instructions` text NOT NULL,
	`goal` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`lease_expires_at` integer,
	`result_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `test_import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `test_import_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `test_environments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`runner_pool_id`) REFERENCES `runner_pools`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `test_explorations_pool_status_idx` ON `test_explorations` (`runner_pool_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `test_explorations_item_unique` ON `test_explorations` (`item_id`);--> statement-breakpoint
CREATE INDEX `test_explorations_batch_idx` ON `test_explorations` (`batch_id`);