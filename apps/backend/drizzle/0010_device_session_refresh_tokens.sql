ALTER TABLE `device_sessions` ADD `refresh_token_hash` text;
--> statement-breakpoint
ALTER TABLE `device_sessions` ADD `refresh_expires_at` integer;
--> statement-breakpoint
CREATE INDEX `device_sessions_refresh_token_hash_idx` ON `device_sessions` (`refresh_token_hash`);
