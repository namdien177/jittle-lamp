ALTER TABLE `notification_channels` ADD `secret_enc` text;--> statement-breakpoint
ALTER TABLE `notification_channels` ADD `key_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_events` ADD `channels_dispatched_at` integer;--> statement-breakpoint
ALTER TABLE `webhook_batches` ADD `report_stage` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
-- Events dispatched before channels moved to the worker were already sent to their channels.
UPDATE `notification_events` SET `channels_dispatched_at` = coalesce(`dispatched_at`, `created_at`);
