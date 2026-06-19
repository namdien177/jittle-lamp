CREATE TABLE `automation_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`label` text NOT NULL,
	`token_secret` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT 'evidence:upload' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `automation_api_tokens_user_id_idx` ON `automation_api_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `automation_api_tokens_org_id_idx` ON `automation_api_tokens` (`org_id`);
--> statement-breakpoint
CREATE INDEX `automation_api_tokens_token_secret_idx` ON `automation_api_tokens` (`token_secret`);
--> statement-breakpoint
CREATE INDEX `automation_api_tokens_expires_at_idx` ON `automation_api_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `automation_api_tokens_revoked_at_idx` ON `automation_api_tokens` (`revoked_at`);
