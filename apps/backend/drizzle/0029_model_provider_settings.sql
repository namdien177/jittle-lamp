ALTER TABLE `organization_model_settings` ADD `judge_key_credential_id` text REFERENCES `test_credentials` (`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `organization_model_settings` ADD `judge_key_last4` text;--> statement-breakpoint
ALTER TABLE `organization_model_settings` ADD `base_url` text;