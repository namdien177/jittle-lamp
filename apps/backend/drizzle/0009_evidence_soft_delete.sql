ALTER TABLE `evidences` ADD `deleted_at` integer;
--> statement-breakpoint
ALTER TABLE `evidences` ADD `deleted_by` text REFERENCES `users` (`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `evidences` ADD `delete_purges_at` integer;
--> statement-breakpoint
CREATE INDEX `evidences_org_deleted_at_idx` ON `evidences` (`org_id`, `deleted_at`);
--> statement-breakpoint
CREATE INDEX `evidences_delete_purges_at_idx` ON `evidences` (`delete_purges_at`);
