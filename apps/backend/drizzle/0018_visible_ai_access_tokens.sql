PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_ai_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text,
	`token_secret` text,
	`token_version` text DEFAULT 'v1' NOT NULL,
	`token_prefix` text NOT NULL,
	`scopes` text DEFAULT 'evidence:debug' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_ai_access_tokens` (
	`id`,
	`user_id`,
	`label`,
	`token_hash`,
	`token_secret`,
	`token_version`,
	`token_prefix`,
	`scopes`,
	`created_at`,
	`expires_at`,
	`last_used_at`,
	`revoked_at`
)
SELECT
	`id`,
	`user_id`,
	`label`,
	`token_hash`,
	NULL,
	'v1',
	`token_prefix`,
	`scopes`,
	`created_at`,
	`expires_at`,
	`last_used_at`,
	`revoked_at`
FROM `ai_access_tokens`;
--> statement-breakpoint
DROP TABLE `ai_access_tokens`;
--> statement-breakpoint
ALTER TABLE `__new_ai_access_tokens` RENAME TO `ai_access_tokens`;
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_access_tokens_token_hash_unique` ON `ai_access_tokens` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_user_id_idx` ON `ai_access_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_expires_at_idx` ON `ai_access_tokens` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `ai_access_tokens_revoked_at_idx` ON `ai_access_tokens` (`revoked_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
