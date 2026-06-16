CREATE TABLE `ai_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT 'evidence:debug' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_access_tokens_token_hash_unique` ON `ai_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_user_id_idx` ON `ai_access_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_expires_at_idx` ON `ai_access_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_revoked_at_idx` ON `ai_access_tokens` (`revoked_at`);
