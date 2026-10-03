ALTER TABLE `notification_events` ADD `channels_lease_owner` text;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `channels_lease_expires_at` integer;--> statement-breakpoint
ALTER TABLE `webhook_batches` ADD `report_lease_owner` text;--> statement-breakpoint
ALTER TABLE `webhook_batches` ADD `report_lease_expires_at` integer;