ALTER TABLE `share_links` ADD `slug` text;
--> statement-breakpoint
UPDATE `share_links` SET `slug` = `id` WHERE `slug` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_slug_unique` ON `share_links` (`slug`);
