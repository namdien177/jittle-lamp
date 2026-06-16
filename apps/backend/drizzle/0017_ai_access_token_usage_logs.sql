CREATE TABLE `ai_access_token_usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`user_id` text NOT NULL,
	`evidence_id` text,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `ai_access_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidences`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_access_token_usage_logs_token_id_idx` ON `ai_access_token_usage_logs` (`token_id`);
--> statement-breakpoint
CREATE INDEX `ai_access_token_usage_logs_user_id_idx` ON `ai_access_token_usage_logs` (`user_id`);
--> statement-breakpoint
CREATE INDEX `ai_access_token_usage_logs_evidence_id_idx` ON `ai_access_token_usage_logs` (`evidence_id`);
--> statement-breakpoint
CREATE INDEX `ai_access_token_usage_logs_created_at_idx` ON `ai_access_token_usage_logs` (`created_at`);
